#!/usr/bin/env node
/**
 * OpenAI-compatible API server wrapping DeepSeek Web API
 * Supports BOTH streaming (SSE) and non-streaming modes
 * Includes tool calling: injects tool definitions into system prompt,
 * parses LLM text responses for TOOL_CALL patterns, returns OpenAI tool_calls format.
 * 
 * Per-agent sessions: each unique `user` field gets its own DeepSeek web session.
 * Auto-reset: sessions reset on a real context-overflow error, when the message
 * chain reaches DEEPSEEK_MAX_MESSAGE_DEPTH (default 0 = no cap), or when age
 * exceeds DEEPSEEK_SESSION_TTL_MS (default 6 hours).
 * Listens on 127.0.0.1:9655 by default (HOST is configurable)
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { solvePOW } = require('./lib/pow');
const authConfig = require('./lib/auth_config');

// === File logging ===
// Every console.* call is teed to a rotating log file, so a long proxy run can be
// analyzed after the fact (session resets, throttles, delta prompts, recovery).
// Enabled by default when the server runs as the entry point; a bare `require`
// (unit tests) does not create a file. Override the path with DEEPSEEK_LOG_FILE
// or turn it off with DEEPSEEK_LOG_TO_FILE=0.
const LOG_FILE_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.DEEPSEEK_LOG_TO_FILE ?? '1'));
const LOG_FILE_PATH = process.env.DEEPSEEK_LOG_FILE || path.join(__dirname, 'logs', 'proxy.log');
const configuredLogMax = Number(process.env.DEEPSEEK_LOG_MAX_BYTES);
const LOG_FILE_MAX_BYTES = Number.isFinite(configuredLogMax) && configuredLogMax > 0
    ? Math.floor(configuredLogMax)
    : 20 * 1024 * 1024;
let fileLoggingInstalled = false;

// Keep one previous file (proxy.log.1) so a rotation never loses the window that
// immediately precedes the interesting event.
// Synchronous appends: log volume is per-turn, not per-token, so the cost is
// negligible and it makes size tracking, rotation and crash-durability exact
// (an async WriteStream may not have created the file yet when rotating).
function createFileLogger(filePath, maxBytes) {
    let bytes = null;
    const size = () => {
        if (bytes !== null) return bytes;
        try { bytes = fs.statSync(filePath).size; } catch (e) { bytes = 0; }
        return bytes;
    };
    const rotate = () => {
        try {
            fs.renameSync(filePath, `${filePath}.1`);
        } catch (e) { /* first run: nothing to rotate */ }
        bytes = 0;
    };
    const write = (line) => {
        try {
            if (maxBytes > 0 && size() >= maxBytes) rotate();
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.appendFileSync(filePath, line, { mode: 0o600 });
            bytes = size() + Buffer.byteLength(line);
        } catch (e) { /* logging must never take the server down */ }
    };
    const close = () => { bytes = null; };
    return { write, close };
}

const fileLogger = createFileLogger(LOG_FILE_PATH, LOG_FILE_MAX_BYTES);
function writeLogFile(line) { fileLogger.write(line); }

let logLineHook = null;
// Test seam: capture the exact stamped line the tee would write to disk without
// touching the real log file.
function setLogLineHook(fn) { logLineHook = typeof fn === 'function' ? fn : null; }

function stampLogText(text) {
    return String(text)
        .split('\n')
        .map(line => (line.length ? `[${new Date().toISOString()}] ${line}` : line))
        .join('\n');
}

function installFileLogging() {
    if (fileLoggingInstalled || !LOG_FILE_ENABLED) return;
    fileLoggingInstalled = true;
    const util = require('util');
    const emit = (text) => {
        const payload = `${stampLogText(text)}\n`;
        writeLogFile(payload);
        if (typeof logLineHook === 'function') { try { logLineHook(payload); } catch (e) {} }
    };
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        if (typeof console[level] !== 'function') continue;
        const original = console[level].bind(console);
        console[level] = (...args) => {
            original(...args);
            try { emit(util.format(...args)); } catch (e) {}
        };
    }
    writeLogFile(stampLogText(`[DS-API] file logging started -> ${LOG_FILE_PATH}`) + '\n');
}

// Per-DeepSeek-request network timeout. Plain fetch() has NO default timeout, so a
// stalled upstream would hang the inbound request (and pin the account) forever.
const DS_FETCH_TIMEOUT_MS = Number(process.env.DEEPSEEK_FETCH_TIMEOUT_MS || 180000);
function dsFetch(url, options = {}, timeoutMs = DS_FETCH_TIMEOUT_MS) {
    return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
}

const SERVER_HOST = os.hostname();  // Dynamic hostname detection
const SERVER_PUBLIC_IP = (() => {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
    } catch (e) {}
    return 'localhost';
})();

const FORGETMEAI_WATERMARK = 't.me/forgetmeai';
const PORT = Number(process.env.PORT || 9655);
const HOST = process.env.HOST || '127.0.0.1';

function loadProxyApiKey(env = process.env) {
    if (env.PROXY_API_KEY) return String(env.PROXY_API_KEY);
    const secretPath = String(env.PROXY_API_KEY_FILE || '').trim();
    if (!secretPath) return '';
    try {
        return fs.readFileSync(secretPath, 'utf8').trim();
    } catch (error) {
        // A missing optional secret is equivalent to an unset key. Container
        // deployments set REQUIRE_PROXY_API_KEY=1 and fail closed in main().
        if (error.code === 'ENOENT') return '';
        throw new Error(`Could not read PROXY_API_KEY_FILE (${secretPath}): ${error.message}`);
    }
}

function requireProxyApiKey(key, required) {
    if (required && !key) {
        throw new Error('PROXY_API_KEY is required. Set PROXY_API_KEY or mount a secret and set PROXY_API_KEY_FILE.');
    }
}

const PROXY_API_KEY = loadProxyApiKey();
const PROXY_CORS_ORIGINS = new Set(String(process.env.PROXY_CORS_ORIGINS || '')
    .split(',')
    .map(value => normalizeOrigin(value))
    .filter(Boolean));
function formatWatermark(prefix = 'ForgetMeAI') { return `${prefix}: ${FORGETMEAI_WATERMARK}`; }
function printBanner() {
    console.log(`
███████ ██████  ███████ ███████ ██████  ███████ ███████ ███████ ██   ██
██      ██   ██ ██      ██      ██   ██ ██      ██      ██      ██  ██
█████   ██████  █████   █████   ██   ██ █████   █████   █████   █████
██      ██   ██ ██      ██      ██   ██ ██      ██      ██      ██  ██
██      ██   ██ ███████ ███████ ██████  ███████ ███████ ███████ ██   ██

   FreeDeepseekAPI — API-прокси для DeepSeek Web Chat
   ${formatWatermark()}
`);
}
function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function isTruthy(value) { return typeof value === 'string' && ['1','true','yes','on'].includes(value.trim().toLowerCase()); }

function isProxyAuthorized(authorization, expectedKey = PROXY_API_KEY) {
    if (!expectedKey) return true;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(authorization.slice('Bearer '.length), 'utf8');
    const expected = Buffer.from(String(expectedKey), 'utf8');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function isLoopbackHost(host) {
    const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1'
        || normalized === 'localhost';
}

function normalizeOrigin(origin) {
    const value = String(origin || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        return parsed.origin === 'null' ? value : parsed.origin;
    } catch (e) {
        return value;
    }
}

function isBrowserOriginAllowed(origin, allowedOrigins = PROXY_CORS_ORIGINS) {
    if (!origin) return true; // curl, SDKs, and other non-browser clients
    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.has(normalized)) return true;
    try {
        const parsed = new URL(normalized);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && isLoopbackHost(parsed.hostname);
    } catch (e) {
        return false;
    }
}

const CONTEXT_COMPACTED_HEADER = 'X-FreeDeepseek-Context-Compacted';
function setCorsResponseHeaders(res) {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', CONTEXT_COMPACTED_HEADER);
}
function markContextCompacted(res) {
    res.setHeader(CONTEXT_COMPACTED_HEADER, 'true');
}

// === Per-Agent Session Store ===
const sessions = new Map();  // keyed by agent ID (from `user` field)
// Fingerprint-derived ids get announced once so a new chat is visible in the log
// without repeating the notice on every turn of that chat.
const announcedConversations = new Map();
// Recovery buffer: replayed only when a remote chat is missing, so the remote
// session is the primary context. Kept small on purpose — an agent can re-read
// what it needs through tools, and a big buffer bloats every fresh prompt.
const MAX_HISTORY_LENGTH = Number(process.env.DEEPSEEK_MAX_HISTORY_LENGTH || 3);
const MAX_HISTORY_CHARS = Number(process.env.DEEPSEEK_MAX_HISTORY_CHARS || 2000);
// Depth cap for the remote chat. 0 disables it: the session is then reset only
// on a real context-overflow error, a TTL expiry, account rotation or a chat-id
// error — not on a timer. The old default of 100 reset a chat while it was still
// perfectly healthy and then re-seeded it from a truncated transcript, which is
// what made long sessions suddenly lose the plot. Set DEEPSEEK_MAX_MESSAGE_DEPTH
// to a positive number to bring back the proactive reset.
const configuredDepth = Number(process.env.DEEPSEEK_MAX_MESSAGE_DEPTH);
const MAX_MESSAGE_DEPTH = Number.isFinite(configuredDepth) ? Math.max(0, Math.floor(configuredDepth)) : 0;
const SESSION_TTL_MS = Number(process.env.DEEPSEEK_SESSION_TTL_MS || 6 * 60 * 60 * 1000);  // 6 hours

// === DeepSeek Web API Config — loaded from external config file ===
const DS_CONFIG_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, 'deepseek-auth.json');
const DEFAULT_ACCOUNT_COOLDOWN_MS = Number(process.env.DEEPSEEK_ACCOUNT_COOLDOWN_MS || 10 * 60 * 1000);
let DS_CONFIG = {};
let dsHeaders = {};
const accounts = [];
let accountRoundRobin = 0;
let inFlight = 0;  // concurrent in-flight completions (backpressure cap)
// Overall wall-clock budget for one inbound request (caps the retry/continuation
// loops), max concurrent completions, and the empty-response retry cap.
const REQUEST_DEADLINE_MS = Number(process.env.DEEPSEEK_REQUEST_DEADLINE_MS || 300000);
const MAX_CONCURRENT = Number(process.env.DEEPSEEK_MAX_CONCURRENT || 24);
// Minimum pause between logical upstream requests on the same account. Spaces out
// PoW + session-create + completion bursts so DeepSeek is less likely to 429.
// Minimum pause between logical upstream requests on the same account. Spaces out
// PoW + session-create + completion bursts so DeepSeek is less likely to 429.
// 8000 (+ up to 2000ms jitter) is what the web endpoint tolerates for a single
// account: at 5000 it started answering "Слишком частые сообщения" inside a 200
// stream, which then escalated to a 5- then 10-minute block. Raise it further
// before adding accounts — a stalled account blocks its whole conversation.
const MIN_REQUEST_INTERVAL_MS = Math.max(0, Number(process.env.DEEPSEEK_MIN_REQUEST_INTERVAL_MS ?? 8000));
// Extra random pause (0..this) added on top of the interval so several agents
// never march upstream in lockstep and look like a scripted burst.
const REQUEST_JITTER_MS = Math.max(0, Number(process.env.DEEPSEEK_REQUEST_JITTER_MS ?? 2000));
// Gap between the individual upstream calls of one logical turn (PoW challenge,
// chat_session/create, completion).
const UPSTREAM_CALL_GAP_MS = Math.max(0, Number(process.env.DEEPSEEK_UPSTREAM_CALL_GAP_MS ?? 700));
// Base cooldown applied when DeepSeek reports "sending too often" inside the
// response stream; it doubles on every repeat up to DEEPSEEK_ACCOUNT_COOLDOWN_MS.
// Long by default: this notice is an account-level throttle, not a 1s burst, so
// retrying within a minute only extends the block.
const RATE_LIMIT_COOLDOWN_MS = Math.max(1000, Number(process.env.DEEPSEEK_RATE_LIMIT_COOLDOWN_MS || 300000));
// A stream that came back with no response object at all is only a *suspected*
// throttle: DeepSeek also answers an aborted or hiccupped turn that way. It gets a
// short hold that never feeds the escalation streak, so one unlucky upstream hiccup
// cannot park an account for ten minutes. An account that really is throttled says so
// explicitly ("Слишком частые сообщения") on the next attempt and escalates then.
const INFERRED_THROTTLE_COOLDOWN_MS = Math.max(1000, Number(process.env.DEEPSEEK_INFERRED_THROTTLE_COOLDOWN_MS || 30000));
// How long to wait for a sticky account that is cooling down (e.g. after 429)
// before giving up with 429. Waiting preserves the remote chat session instead
// of rotating accounts and forcing a brand-new chat.
const STICKY_WAIT_MS = Math.max(0, Number(process.env.DEEPSEEK_STICKY_WAIT_MS ?? 60000));
const configuredEmptyRetries = Number(process.env.DEEPSEEK_MAX_RETRIES);
const MAX_EMPTY_RETRIES = Number.isFinite(configuredEmptyRetries)
    ? Math.max(0, Math.min(10, Math.floor(configuredEmptyRetries)))
    : 2;
// Floor for both prompt caps. It has to sit below the fresh-session cap, otherwise
// a configured DEEPSEEK_FRESH_SESSION_PROMPT_CHARS below this value is silently
// clamped back up and the fresh-session lever does nothing.
const MIN_UPSTREAM_PROMPT_CHARS = 8000;
// Below this assembled size a retry prompt is left intact — see buildRetryBudget.
const MIN_SHRINKABLE_PROMPT_CHARS = 8000;
const configuredPromptChars = Number(process.env.DEEPSEEK_MAX_PROMPT_CHARS);
const MAX_UPSTREAM_PROMPT_CHARS = Number.isFinite(configuredPromptChars)
    ? Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(configuredPromptChars))
    : 80000;
// A brand-new chat is the riskiest upstream call: the whole client transcript plus
// the injected tool definitions land in one first message, and DeepSeek answers that
// with an empty stream. New sessions therefore start from a much smaller budget.
// What gets cut is the tool markup — buildBoundedPrompt hands the unused share of a
// short conversation back to the system prompt, so the task itself stays intact.
// 12000 keeps roughly a third of the tool definitions, which is enough for the first
// turn to call a tool while halving the payload DeepSeek sees as a chat seed.
const configuredFreshChars = Number(process.env.DEEPSEEK_FRESH_SESSION_PROMPT_CHARS);
const FRESH_SESSION_PROMPT_CHARS = Number.isFinite(configuredFreshChars)
    ? Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(configuredFreshChars))
    : 12000;

// === Context-reduction experiments ===
// The proxy already sends only the new delta tail on a live remote chat, but it
// re-injected the whole tool definition block (descriptions + JSON schemas) on
// every turn. Those definitions went out on the first message and stay in the
// remote chat's context, so on a delta turn only the names and the output
// contract need repeating. Set DEEPSEEK_COMPACT_TOOL_REMINDER=0 to go back to
// the full block on every turn.
const COMPACT_TOOL_REMINDER = !/^(0|false|no|off)$/i.test(String(process.env.DEEPSEEK_COMPACT_TOOL_REMINDER ?? '1'));
// A live chat remembers the transcript, but a long one eventually compacts it
// away. A small state block (the latest todo list) prepended to a delta keeps
// the plan anchored. It is emitted only when the transcript actually carries a
// todo list, so it costs nothing for clients that do not use one.
const STATE_BLOCK_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.DEEPSEEK_STATE_BLOCK ?? '1'));
const TODO_MAX_ITEMS = 20;
const STATE_BLOCK_MAX_SUMMARY_CHARS = 800;
// When a remote chat is recreated (TTL/depth rollover, account rotation, chat-id
// error) the recovery buffer held only the last few exchanges, so a long session
// restarted almost blind. A rolling digest of every user task asked in the
// session is kept beside it and replayed on reset.
const ROLLING_SUMMARY_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.DEEPSEEK_ROLLING_SUMMARY ?? '1'));
const configuredSummaryChars = Number(process.env.DEEPSEEK_ROLLING_SUMMARY_CHARS);
const ROLLING_SUMMARY_CHARS = Number.isFinite(configuredSummaryChars) && configuredSummaryChars > 0
    ? Math.max(500, Math.floor(configuredSummaryChars))
    : 4000;
const ROLLING_SUMMARY_MAX_TASKS = Number(process.env.DEEPSEEK_ROLLING_SUMMARY_TASKS || 40);
// A recreated chat is not a brand-new one: the caller already has a transcript to
// seed it with, so the tiny first-message cap (FRESH_SESSION_PROMPT_CHARS) would
// throw most of it away — exactly the "reset made it dumb" symptom. Recovery gets
// its own, much larger budget. DEEPSEEK_ROLLOVER_PROMPT_CHARS=0 falls back to the
// fresh cap.
const configuredRolloverChars = Number(process.env.DEEPSEEK_ROLLOVER_PROMPT_CHARS);
const ROLLOVER_PROMPT_CHARS = Number.isFinite(configuredRolloverChars) && configuredRolloverChars > 0
    ? Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(configuredRolloverChars))
    : 60000;
// Two-step priming: a very large first message to a brand-new chat often comes
// back as an empty stream, which is why the fresh cap exists. Warming the chat
// with a tiny exchange first lets the large recovery prompt be sent as an
// ordinary follow-up. Set DEEPSEEK_PRIME_LARGE_PROMPT=0 to disable.
const PRIME_LARGE_FIRST_MESSAGE = !/^(0|false|no|off)$/i.test(String(process.env.DEEPSEEK_PRIME_LARGE_PROMPT ?? '1'));
const PRIME_MESSAGE = 'We are resuming a long session. Reply with the single word: ready.';
// On a proxy-driven reset, ask the model for a real handover summary of the work
// so far instead of replaying the crude list of user requests. Set
// DEEPSEEK_LLM_SUMMARY=0 to keep the digest.
const LLM_SUMMARY_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.DEEPSEEK_LLM_SUMMARY ?? '1'));
const configuredSummaryInput = Number(process.env.DEEPSEEK_SUMMARY_INPUT_CHARS);
const SUMMARY_INPUT_CHARS = Number.isFinite(configuredSummaryInput) && configuredSummaryInput > 0
    ? Math.floor(configuredSummaryInput)
    : 24000;

function buildBaseHeaders(config = DS_CONFIG) {
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "x-client-platform": "web",
        "x-client-version": "2.0.0",
        "x-client-locale": "ru",
        "x-client-timezone-offset": "14400",
        "x-app-version": "2.0.0",
        "Authorization": `Bearer ${config.token || ''}`,
        "x-hif-dliq": config.hif_dliq || '',
        "x-hif-leim": config.hif_leim || '',
        "Origin": "https://chat.deepseek.com",
        "Referer": "https://chat.deepseek.com/",
        "Cookie": config.cookie || '',
        "Content-Type": "application/json",
    };
}
function discoverAuthPaths() {
    if (process.env.DEEPSEEK_AUTH_DIR) {
        try {
            return fs.readdirSync(process.env.DEEPSEEK_AUTH_DIR)
                .filter(f => f.endsWith('.json'))
                .sort()
                .map(f => path.join(process.env.DEEPSEEK_AUTH_DIR, f));
        } catch (e) {
            console.error(`[DS-API] Could not read DEEPSEEK_AUTH_DIR: ${e.message}`);
            return [];
        }
    }
    if (process.env.DEEPSEEK_AUTH_PATH) {
        if (process.env.DEEPSEEK_AUTH_PATH.includes(',')) {
            return process.env.DEEPSEEK_AUTH_PATH.split(',').map(s => s.trim()).filter(Boolean);
        }
        return [DS_CONFIG_PATH];
    }
    // Multi-account pool wins by default so `npm start` needs no env at all:
    // every data/accounts/*.json becomes an account. The single-file path stays
    // the fallback for a fresh checkout.
    const pool = authConfig.accountFiles();
    if (pool.length > 0) return pool;
    return [DS_CONFIG_PATH];
}
function loadDeepSeekConfig({ fatal = true } = {}) {
    accounts.length = 0;
    const paths = discoverAuthPaths();
    for (const file of paths) {
        try {
            const raw = fs.readFileSync(file, 'utf8');
            const config = JSON.parse(raw);
            const id = `account_${accounts.length + 1}`;
            accounts.push({ id, file, config, headers: buildBaseHeaders(config), cooldownUntil: 0, failures: 0, lastUsedAt: 0, nextSlotAt: 0, lastUpstreamCallAt: 0, rateLimitStreak: 0 });
        } catch (e) {
            console.error(`[DS-API] Could not load auth config ${file}: ${e.message}`);
        }
    }
    DS_CONFIG = accounts[0]?.config || {};
    dsHeaders = accounts[0]?.headers || buildBaseHeaders({});
    if (accounts.length > 0) {
        console.log(`[DS-API] Loaded ${accounts.length} auth account(s): ${accounts.map(a => a.id).join(', ')}`);
        return true;
    }
    if (fatal) {
        console.error(`[DS-API] FATAL: Could not load any auth config. Expected ${paths.join(', ') || DS_CONFIG_PATH}`);
        process.exit(1);
    }
    return false;
}
function hasAuthConfig() { return accounts.some(a => a.config.token && a.config.cookie); }
function accountStatus(account) {
    return {
        id: account.id,
        ready: !!(account.config.token && account.config.cookie),
        cooldown: account.cooldownUntil > Date.now(),
        cooldown_remaining_sec: Math.max(0, Math.ceil((account.cooldownUntil - Date.now()) / 1000)),
        failures: account.failures,
        last_used_at: account.lastUsedAt || null,
        rate_limit_streak: account.rateLimitStreak || 0,
    };
}
// setTimeout is allowed to fire a tick early. Sleeping exactly the remaining
// cooldown and re-checking the clock would then turn a cooldown that is about to
// expire into a spurious 429, so wait until the timestamp has really passed.
async function waitUntilCooldown(timestamp) {
    for (;;) {
        const remaining = timestamp - Date.now();
        if (remaining <= 0) return;
        await new Promise(r => setTimeout(r, remaining + 5));
    }
}

// A ready account other than the one that just got rate-limited. Used to keep
// serving a turn from a free account instead of parking the whole conversation
// behind a 5-minute cooldown. Returns null when every other account is cooling.
function findAlternateReadyAccount(excludeId, now = Date.now()) {
    const ready = accounts.filter(a =>
        a.id !== excludeId
        && a.config.token && a.config.cookie
        && a.cooldownUntil <= now);
    if (ready.length === 0) return null;
    const account = ready[accountRoundRobin % ready.length];
    accountRoundRobin++;
    return account;
}

async function selectAccountForSession(session) {
    const now = Date.now();
    if (session.accountId) {
        const sticky = accounts.find(a => a.id === session.accountId);
        if (sticky && sticky.config.token && sticky.config.cookie) {
            if (sticky.cooldownUntil <= now) return sticky;
            // Sticky account is cooling down (429/401/403). A DeepSeek chat_session
            // belongs to the auth account that created it, but the conversation
            // itself survives locally: rotating to another ready account recreates
            // the remote chat from recovery history. Prefer that over parking the
            // whole turn — the 5-minute cooldown is only correct once every account
            // is locked.
            const alternate = accounts.find(a =>
                a.id !== sticky.id
                && a.config.token && a.config.cookie
                && a.cooldownUntil <= now);
            if (alternate) {
                console.log(`[account:${sticky.id}] cooling down; rotating to ready account ${alternate.id} (remote chat recreated from recovery history)`);
                resetRemoteSession(session);
                session.accountId = alternate.id;
                return alternate;
            }
            // No other ready account: wait out short cooldowns, otherwise surface
            // 429 with Retry-After and leave the session untouched.
            const remainingMs = sticky.cooldownUntil - now;
            if (remainingMs <= STICKY_WAIT_MS) {
                console.log(`[account:${sticky.id}] sticky cooldown ${Math.ceil(remainingMs / 1000)}s ≤ wait cap ${Math.ceil(STICKY_WAIT_MS / 1000)}s; waiting (session preserved)`);
                await waitUntilCooldown(sticky.cooldownUntil);
                if (sticky.cooldownUntil <= Date.now()) return sticky;
            }
            const waitSec = Math.max(1, Math.ceil((sticky.cooldownUntil - Date.now()) / 1000));
            const err = new Error(`Sticky account ${sticky.id} is cooling down. Retry in ~${waitSec}s (session preserved).`);
            err.status = 429; err.retryAfter = waitSec; err.type = 'rate_limit';
            throw err;
        }
        // Account disappeared from the pool or lost credentials — only then is it
        // safe to drop its session id and pick another account.
        resetRemoteSession(session);
        session.accountId = null;
    }
    const ready = accounts.filter(a => a.config.token && a.config.cookie && a.cooldownUntil <= Date.now());
    if (ready.length === 0) {
        const waiting = accounts.filter(a => a.config.token && a.config.cookie).sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
        if (waiting) {
            const waitSec = Math.max(1, Math.ceil((waiting.cooldownUntil - Date.now()) / 1000));
            // Tagged so the request handler returns 429 + Retry-After instead of a
            // generic 500 (integrator backoff keys on the status code, not the text).
            const err = new Error(`All DeepSeek auth accounts are cooling down. Retry in ~${waitSec}s or import a fresh account with npm run auth:import.`);
            err.status = 429; err.retryAfter = waitSec; err.type = 'rate_limit';
            throw err;
        }
        const noAuth = new Error('No valid DeepSeek auth accounts. Run npm run auth or npm run auth:import.');
        noAuth.status = 503; noAuth.type = 'no_auth';
        throw noAuth;
    }
    const account = ready[accountRoundRobin % ready.length];
    accountRoundRobin++;
    session.accountId = account.id;
    return account;
}
// DeepSeek also throttles the individual HTTP calls inside one logical turn
// (PoW challenge, chat_session/create, completion). Keep a small gap between
// them so a single request never looks like a scripted burst.
async function paceUpstreamCall(account, gapMs = UPSTREAM_CALL_GAP_MS) {
    if (!account || !(gapMs > 0)) return 0;
    const now = Date.now();
    const waitMs = Math.max(0, (account.lastUpstreamCallAt || 0) + gapMs - now);
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    account.lastUpstreamCallAt = Date.now();
    return waitMs;
}
// Reserve the next upstream slot on an account so consecutive logical requests
// are at least intervalMs apart (plus optional jitter). Atomic in Node's
// single-threaded model: each caller claims earliest = max(nextSlotAt, now) and
// advances the pointer, so concurrent callers queue up spaced by the interval.
async function acquireAccountSlot(account, intervalMs = MIN_REQUEST_INTERVAL_MS, jitterMs = REQUEST_JITTER_MS) {
    if (!account || !(intervalMs > 0)) return 0;
    const now = Date.now();
    const earliest = Math.max(account.nextSlotAt || 0, now);
    const waitMs = earliest - now;
    if (waitMs > REQUEST_DEADLINE_MS) {
        const waitSec = Math.max(1, Math.ceil(waitMs / 1000));
        const err = new Error(`Upstream pacing queue is full. Retry in ~${waitSec}s.`);
        err.status = 429; err.retryAfter = waitSec; err.type = 'rate_limit';
        throw err;
    }
    // Jitter is always additive: it can only lengthen the gap, never shorten it
    // below the configured interval.
    const spread = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
    const gapMs = intervalMs + spread;
    account.nextSlotAt = earliest + gapMs;
    const totalWaitMs = waitMs > 0 ? waitMs + spread : 0;
    if (totalWaitMs > 0) await new Promise(r => setTimeout(r, totalWaitMs));
    return totalWaitMs;
}
// Parse a Retry-After header value into a cooldown duration in ms, or null if
// absent/unparseable. Supports both forms: delta-seconds (e.g. "120") and an
// HTTP-date (e.g. "Wed, 21 Oct 2025 07:28:00 GMT"). Clamped to >= 1s.
function parseRetryAfterMs(retryAfterRaw) {
    if (!retryAfterRaw) return null;
    const raw = String(retryAfterRaw).trim();
    if (/^\d+$/.test(raw)) return Math.max(1000, Number(raw) * 1000);
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return Math.max(1000, t - Date.now());
    return null;
}
function markAccountFailure(account, status, reason = '', retryAfterRaw = null) {
    if (!account) return;
    account.failures++;
    if ([401, 403, 429].includes(Number(status))) {
        // On 429, honor a valid Retry-After header (seconds or HTTP-date) when present;
        // otherwise fall back to the fixed env-configured cooldown.
        const retryMs = Number(status) === 429 ? parseRetryAfterMs(retryAfterRaw) : null;
        const cooldownMs = retryMs != null ? retryMs : DEFAULT_ACCOUNT_COOLDOWN_MS;
        account.cooldownUntil = Date.now() + cooldownMs;
        console.log(`[account:${account.id}] cooldown for ${Math.round(cooldownMs / 1000)}s after HTTP ${status}${reason ? ` (${reason})` : ''}${retryMs != null ? ' (Retry-After)' : ''}`);
    }
}
async function readDeepSeekJsonResponse(resp, label, account) {
    const text = await resp.text();
    let json = null;
    if (text) {
        try { json = JSON.parse(text); }
        catch (e) {
            markAccountFailure(account, resp.status, label);
            throw new Error(`DeepSeek returned non-JSON ${label} response (HTTP ${resp.status}). Run npm run doctor. First chars: ${text.substring(0, 120)}`);
        }
    }
    if (!resp.ok) markAccountFailure(account, resp.status, label);
    return { json, text };
}
if (require.main === module) {
    loadDeepSeekConfig({ fatal: false });
}

function createSession() {
    return {
        id: null,
        parentMessageId: null,
        createdAt: null,
        messageCount: 0,
        accountId: null,
        history: [],
        summary: '',
        summaryLines: [],
        handover: '',
        lastActivityAt: Date.now(),
    };
}

function resetRemoteSession(session) {
    const failed = {
        failedSessionId: session.id,
        failedMessageCount: session.messageCount,
        accountId: session.accountId,
    };
    session.id = null;
    session.parentMessageId = null;
    session.createdAt = null;
    session.messageCount = 0;
    // Keep local recovery history and the sticky account assignment. A remote
    // chat can be unhealthy without invalidating either of those local hints.
    return failed;
}

// Non-mutating check: what would make this session roll over right now. Kept
// separate so the caller can generate a handover summary before the remote chat
// (and its context) is dropped.
function sessionRolloverReason(session, now = Date.now(), maxDepth = MAX_MESSAGE_DEPTH) {
    if (!session || !session.id) return null;
    if (maxDepth > 0 && session.messageCount >= maxDepth) return 'max_message_depth';
    if (session.createdAt && now - session.createdAt > SESSION_TTL_MS) return 'session_ttl';
    return null;
}

function prepareSessionForPrompt(session, now = Date.now(), maxDepth = MAX_MESSAGE_DEPTH) {
    const reason = sessionRolloverReason(session, now, maxDepth);
    if (!reason) return null;
    return { reason, ...resetRemoteSession(session) };
}

// A recreated chat that already has a conversation behind it may seed far more
// context than a genuinely first-ever turn, which has to stay inside the small
// fresh cap (a large first message tends to come back as an empty stream).
function selectSeedBudget(hasHistory) {
    return hasHistory ? ROLLOVER_PROMPT_CHARS : FRESH_SESSION_PROMPT_CHARS;
}

function getOrCreateAgentSession(agentId) {
    if (!sessions.has(agentId)) {
        sessions.set(agentId, createSession());
    }
    const session = sessions.get(agentId);
    session.lastActivityAt = Date.now();
    scheduleSessionPersist();
    return session;
}

// Evict idle sessions so the Map (keyed by client IP / user id) can't grow without
// bound on a long-running process. Drops entries untouched for 2× the session TTL.
function sweepIdleSessions(maxIdleMs = SESSION_TTL_MS * 2) {
    const now = Date.now();
    let removed = 0;
    for (const [agentId, session] of sessions) {
        if (now - (session.lastActivityAt || 0) > maxIdleMs) { sessions.delete(agentId); removed++; }
    }
    if (removed) {
        console.log(`[DS-API] swept ${removed} idle session(s); ${sessions.size} remain`);
        scheduleSessionPersist();
    }
    return removed;
}

// A DeepSeek chat is strictly sequential: every turn has to name the message it
// continues from. Two requests for the same conversation running at once both read
// session.parentMessageId, and the second overwrites it while the first turn is
// still streaming — the first then continues from a message that is no longer the
// thread tip, and DeepSeek answers that with an empty stream. Serializing per
// conversation removes the race; separate conversations stay fully parallel.
const agentTurnLocks = new Map();

async function acquireAgentTurnLock(agentId, maxQueueMs = REQUEST_DEADLINE_MS) {
    const previous = agentTurnLocks.get(agentId) || Promise.resolve();
    let unlock;
    const held = new Promise(resolve => { unlock = resolve; });
    agentTurnLocks.set(agentId, held);
    const queuedAt = Date.now();
    let startedAt = 0;
    await previous.then(() => { startedAt = Date.now(); });
    const queueWaitMs = startedAt - queuedAt;
    if (queueWaitMs > Math.max(0, maxQueueMs)) {
        unlock();
        if (agentTurnLocks.get(agentId) === held) agentTurnLocks.delete(agentId);
        const waitSec = Math.max(1, Math.ceil((queueWaitMs - Math.max(0, maxQueueMs)) / 1000));
        const err = new Error(`Conversation is busy with an earlier turn (queued ${Math.round(queueWaitMs / 1000)}s). Retry in ~${waitSec}s.`);
        err.status = 429; err.retryAfter = Math.min(waitSec, 60); err.type = 'rate_limit';
        throw err;
    }
    return {
        queueWaitMs,
        release() {
            unlock();
            if (agentTurnLocks.get(agentId) === held) agentTurnLocks.delete(agentId);
        },
    };
}

// === Session persistence ===
// The remote chat id is the expensive part of a session: it keeps DeepSeek's own
// context alive, which is what makes delta prompts possible at all. Keeping it in
// RAM only meant every restart silently started a brand-new chat and re-sent the
// whole transcript. Persisting the map (never auth material) lets a restarted
// proxy pick the same conversation back up.
const SESSION_PERSIST_ENABLED = /^(0|false|no|off)$/i.test(String(process.env.DEEPSEEK_PERSIST_SESSIONS ?? '')) ? false : true;
const SESSIONS_FILE = process.env.DEEPSEEK_SESSIONS_FILE || path.join(__dirname, 'data', 'sessions.json');
const SESSION_PERSIST_DEBOUNCE_MS = 500;
let sessionPersistTimer = null;

function serializeSession(session) {
    return {
        id: session.id || null,
        parentMessageId: session.parentMessageId ?? null,
        createdAt: session.createdAt || null,
        messageCount: Number(session.messageCount) || 0,
        accountId: session.accountId || null,
        history: Array.isArray(session.history) ? session.history : [],
        summary: typeof session.summary === 'string' ? session.summary : '',
        summaryLines: Array.isArray(session.summaryLines) ? session.summaryLines : [],
        handover: typeof session.handover === 'string' ? session.handover : '',
        lastActivityAt: session.lastActivityAt || Date.now(),
    };
}

function persistSessions() {
    sessionPersistTimer = null;
    if (!SESSION_PERSIST_ENABLED) return;
    try {
        const payload = { version: 1, savedAt: Date.now(), sessions: [...sessions.entries()].map(([agentId, s]) => [agentId, serializeSession(s)]) };
        fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
        const tmp = `${SESSIONS_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
        // Atomic swap: a crash mid-write must not leave a truncated session file
        // that would strand every remote chat on the next boot.
        fs.renameSync(tmp, SESSIONS_FILE);
    } catch (e) {
        console.log(`[DS-API] Could not persist sessions: ${e.message}`);
    }
}

function scheduleSessionPersist() {
    if (!SESSION_PERSIST_ENABLED || sessionPersistTimer) return;
    sessionPersistTimer = setTimeout(persistSessions, SESSION_PERSIST_DEBOUNCE_MS);
    if (typeof sessionPersistTimer.unref === 'function') sessionPersistTimer.unref();
}

function loadPersistedSessions(file = SESSIONS_FILE) {
    if (!SESSION_PERSIST_ENABLED) return 0;
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e.code !== 'ENOENT') console.log(`[DS-API] Could not read ${file}: ${e.message}`);
        return 0;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        console.log(`[DS-API] Ignoring corrupt session file ${file}: ${e.message}`);
        return 0;
    }
    const entries = Array.isArray(parsed && parsed.sessions) ? parsed.sessions : [];
    const now = Date.now();
    let restored = 0;
    let skipped = 0;
    for (const entry of entries) {
        if (!Array.isArray(entry) || !entry[0] || !entry[1] || typeof entry[1] !== 'object') continue;
        const [agentId, saved] = entry;
        // A session past its TTL is a dead remote chat; restoring it would only
        // resurrect an id DeepSeek has likely dropped.
        if (now - (Number(saved.lastActivityAt) || 0) > SESSION_TTL_MS) { skipped++; continue; }
        const fresh = createSession();
        fresh.id = saved.id ?? null;
        fresh.parentMessageId = saved.parentMessageId ?? null;
        fresh.createdAt = saved.createdAt ?? null;
        fresh.messageCount = Number(saved.messageCount) || 0;
        fresh.accountId = saved.accountId ?? null;
        fresh.history = Array.isArray(saved.history) ? saved.history : [];
        fresh.summary = typeof saved.summary === 'string' ? saved.summary : '';
        fresh.summaryLines = Array.isArray(saved.summaryLines) ? saved.summaryLines : [];
        fresh.handover = typeof saved.handover === 'string' ? saved.handover : '';
        fresh.lastActivityAt = Number(saved.lastActivityAt) || now;
        sessions.set(String(agentId), fresh);
        restored++;
    }
    if (restored > 0 || skipped > 0) {
        console.log(`[DS-API] Restored ${restored} session(s) from ${path.basename(file)}${skipped ? `, skipped ${skipped} expired` : ''}`);
    }
    return restored;
}

// solvePOW() lives in lib/pow (compiled-module cache + WASM-fetch timeout),
// shared with client.js. Called as solvePOW(challenge, wasmUrl).

const MODEL_CONFIGS = {
    // DeepSeek Web real model_type: default / UI name: "Быстрый".
    // Public model family: DeepSeek-V3.2-Exp chat mode (fast, no visible reasoning).
    'deepseek-chat': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'deepseek-flash': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'deepseek-v3': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'deepseek-default': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    // Same DeepSeek Web default model, but with thinking_enabled=true. UI exposes it as thinking/reasoning mode.
    'deepseek-reasoner': {
        model_type: 'default', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash thinking mode (DeepSeek Web “Быстрый” + thinking_enabled)',
        capabilities: { reasoning: true, web_search: false, files: true },
        supported: true,
    },
    'deepseek-r1': {
        model_type: 'default', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash thinking mode; R1-compatible alias, not a separate R1 model_type in current Web API',
        capabilities: { reasoning: true, web_search: false, files: true },
        supported: true,
    },
    'deepseek-chat-search': {
        model_type: 'default', thinking_enabled: false, search_enabled: true,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default) + web search',
        capabilities: { reasoning: false, web_search: true, files: true },
        supported: true,
    },
    'deepseek-default-search': {
        model_type: 'default', thinking_enabled: false, search_enabled: true,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default) + web search',
        capabilities: { reasoning: false, web_search: true, files: true },
        supported: true,
    },
    'deepseek-reasoner-search': {
        model_type: 'default', thinking_enabled: true, search_enabled: true,
        real_model: 'DeepSeek-V4-Flash thinking mode + web search',
        capabilities: { reasoning: true, web_search: true, files: true },
        supported: true,
    },
    'deepseek-r1-search': {
        model_type: 'default', thinking_enabled: true, search_enabled: true,
        real_model: 'DeepSeek-V4-Flash thinking mode + web search; R1-compatible alias',
        capabilities: { reasoning: true, web_search: true, files: true },
        supported: true,
    },
    // DeepSeek Web UI name: “Эксперт”. Requires current web client headers (x-client-version=2.0.0).
    'deepseek-expert': {
        model_type: 'expert', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek Web “Эксперт” (limited resources)',
        capabilities: { reasoning: false, web_search: false, files: false },
        supported: true,
    },
    'deepseek-v4-pro': {
        model_type: 'expert', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek Web “Эксперт” + thinking mode (exposed as deepseek-v4-pro alias)',
        capabilities: { reasoning: true, web_search: false, files: false },
        supported: true,
    },
    'deepseek-expert-search': {
        model_type: 'expert', thinking_enabled: false, search_enabled: true,
        real_model: 'DeepSeek Web “Эксперт” + search requested, but Expert has search_feature=null in remote config',
        capabilities: { reasoning: false, web_search: false, files: false },
        supported: false,
        unavailable_reason: 'Expert mode is rejected; remote config says search is not available for Expert.',
    },
    'deepseek-vision': {
        model_type: 'vision', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek Web “Распознавание” / image understanding beta',
        capabilities: { reasoning: false, web_search: false, files: true, vision: true },
        supported: false,
        unavailable_reason: 'Current Web API returns: Vision is temporarily unavailable (backend_err_by_model).',
    },
};

const SUPPORTED_MODEL_IDS = Object.keys(MODEL_CONFIGS).filter(id => MODEL_CONFIGS[id].supported);
const ALL_MODEL_CAPABILITIES = Object.fromEntries(Object.entries(MODEL_CONFIGS).map(([id, cfg]) => [id, {
    id,
    real_model: cfg.real_model,
    model_type: cfg.model_type,
    thinking_enabled: cfg.thinking_enabled,
    search_enabled: cfg.search_enabled,
    capabilities: cfg.capabilities,
    supported: cfg.supported,
    unavailable_reason: cfg.unavailable_reason || null,
}]));

// Upstream fragment types are not a stable contract: DeepSeek ships new ones and
// has shipped typeless fragments, and an allowlist of 'RESPONSE'/'SEARCH' made the
// parser drop the whole answer (0 chars after a full generation) the first time the
// type changed. Classify reasoning explicitly and treat every other text-carrying
// fragment as output, so a new or renamed type still reaches the client.
function isAssistantOutputFragment(fragment) {
    if (!fragment || typeof fragment.content !== 'string') return false;
    const type = fragment.type;
    if (type === 'THINK' || type === 'REASONING') return false;
    if (type === 'SEARCH_INFO' || type === 'SUGGESTION') return false;
    return true;
}

function isReasoningFragment(fragment) {
    return fragment
        && (fragment.type === 'THINK' || fragment.type === 'REASONING')
        && typeof fragment.content === 'string';
}

function isDeepSeekModelErrorEvent(event) {
    return event && event.type === 'error';
}

function createUpstreamHttpError(status, body = '', retryAfter = null) {
    const code = Number(status) || 502;
    const detail = String(body || '').replace(/\s+/g, ' ').trim().substring(0, 300);
    const type = code === 429
        ? 'rate_limit_error'
        : ((code === 401 || code === 403) ? 'authentication_error' : 'upstream_http_error');
    const error = new Error(`DeepSeek upstream HTTP ${code}${detail ? `: ${detail}` : ''}`);
    error.status = code;
    error.type = type;
    if (retryAfter) error.retryAfter = retryAfter;
    return error;
}

function rebuildFragmentText(fragments) {
    const responseText = fragments
        .filter(isAssistantOutputFragment)
        .map(f => f.content)
        .join('');
    const thinkText = fragments
        .filter(isReasoningFragment)
        .map(f => f.content)
        .join('');
    return { responseText, thinkText };
}

function applyResponsePatchOperations(ops, appendFragments) {
    if (!Array.isArray(ops)) return false;
    let applied = false;
    for (const op of ops) {
        if (!op || typeof op !== 'object') continue;
        if (op.p === 'fragments' && op.o === 'APPEND' && op.v !== undefined) {
            appendFragments(op.v);
            applied = true;
        }
    }
    return applied;
}

// Splits the upstream SSE body into `data:` lines. DeepSeek terminates the
// stream without a final newline, so the buffered tail is a real event (it
// carries the end of the answer, the finish_reason and the closing token
// totals) and must be flushed after the loop.
async function readDeepSeekSseLines(readable, onLine) {
    const decoder = new TextDecoder();  // one instance: preserves multi-byte (Cyrillic/emoji) split across chunks
    let buffer = '';
    for await (const chunk of readable) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) onLine(line);
    }
    buffer += decoder.decode();
    if (buffer) onLine(buffer);
}

// Accumulates one DeepSeek Web JSON-patch SSE stream. Kept out of the request
// handler so the line handling is testable on its own: the upstream protocol is
// a JSON-patch stream, so finish_reason and token totals only appear in the
// last event, which is the one a naive line split throws away.
function createDeepSeekStreamAccumulator() {
    const state = {
        lastPath: null,
        fragments: [],
        content: '',
        reasoning: '',
        messageId: null,
        finishReason: null,
        modelError: null,
        tokenUsageStart: null,
        tokenUsageTotal: null,
    };

    const rebuild = () => {
        const { responseText, thinkText } = rebuildFragmentText(state.fragments);
        if (responseText) state.content = responseText;
        state.reasoning = thinkText;
    };

    const appendFragments = (value) => {
        const incoming = Array.isArray(value) ? value : [value];
        for (const fragment of incoming) {
            if (fragment && typeof fragment === 'object') state.fragments.push({ ...fragment });
        }
        rebuild();
    };

    const handleEvent = (d) => {
        if (d.response_message_id !== undefined && !state.messageId) state.messageId = d.response_message_id;
        if (isDeepSeekModelErrorEvent(d)) {
            state.modelError = { type: d.type || 'error', content: d.content || '', finish_reason: d.finish_reason || null };
        }
        if (d.finish_reason) state.finishReason = d.finish_reason;
        if (d.p !== undefined) state.lastPath = d.p;
        if (d.v && typeof d.v === 'object' && d.v.response) {
            if (d.v.response.message_id !== undefined) state.messageId = d.v.response.message_id;
            if (d.v.response.content !== undefined) state.content = d.v.response.content;
            if (Array.isArray(d.v.response.fragments)) {
                state.fragments.length = 0;
                appendFragments(d.v.response.fragments);
            }
            if (d.v.response.finish_reason !== undefined) state.finishReason = d.v.response.finish_reason;
            if (Number.isFinite(d.v.response.accumulated_token_usage)) {
                if (state.tokenUsageStart === null) state.tokenUsageStart = d.v.response.accumulated_token_usage;
                state.tokenUsageTotal = d.v.response.accumulated_token_usage;
            }
        }
        if (state.lastPath === 'response/fragments' && d.v !== undefined) {
            appendFragments(d.v);
        }
        if (state.lastPath === 'response' && d.v !== undefined) {
            if (Array.isArray(d.v)) {
                for (const op of d.v) {
                    if (op && op.p === 'accumulated_token_usage' && Number.isFinite(op.v)) {
                        if (state.tokenUsageStart === null) state.tokenUsageStart = op.v;
                        state.tokenUsageTotal = op.v;
                    }
                }
            }
            applyResponsePatchOperations(d.v, appendFragments);
        }
        // Streamed content arrives as one patch per token at
        // response/fragments/<index>/content. The index used to be pinned to -1
        // (which means "last fragment"); a layout change (text moving to index 0,
        // or a reasoning fragment taking -1) used to drop every token and yield a
        // 0-char answer. Resolve the target by index — negatives relative to the
        // end, as upstream means them — and create it when never seeded.
        const contentPatch = /^(?:response\/)?fragments\/(-?\d+)\/content$/.exec(state.lastPath || '');
        if (contentPatch && d.v !== undefined && typeof d.v !== 'object') {
            const rawIndex = Number(contentPatch[1]);
            // -1 means "last fragment"; a negative slot must never be used as an
            // array key, because Array.prototype.filter skips holes and the text
            // would be lost again — so it resolves to the current end.
            const index = rawIndex < 0 ? state.fragments.length + rawIndex : rawIndex;
            let fragment = state.fragments[index];
            if (!fragment) {
                fragment = { type: 'RESPONSE', content: '' };
                state.fragments[index < 0 ? state.fragments.length : index] = fragment;
            }
            fragment.content = `${fragment.content || ''}${d.v}`;
            rebuild();
        }
        if (state.lastPath === 'response/content' && d.v !== undefined && typeof d.v !== 'object') {
            state.content += d.v;
        }
        if (state.lastPath === 'response/finish_reason' && d.v !== undefined) {
            state.finishReason = d.v;
        }
        if (state.lastPath === 'response/status' && d.v !== undefined && d.v !== 'FINISHED') {
            state.finishReason = d.v;
        }
    };

    return {
        state,
        handleLine(line) {
            if (!line || !line.startsWith('data: ')) return;
            let d;
            try { d = JSON.parse(line.slice(6)); } catch (e) { return; }
            try { handleEvent(d); } catch (e) { }
        },
        result() {
            const upstreamTokens = state.tokenUsageTotal === null
                ? null
                : { start: state.tokenUsageStart === null ? 0 : state.tokenUsageStart, total: state.tokenUsageTotal };
            return {
                content: state.content,
                reasoningContent: state.reasoning,
                messageId: state.messageId,
                finishReason: state.finishReason,
                modelError: state.modelError,
                upstreamTokens,
            };
        },
    };
}

function resolveModelConfig(model) {
    const requested = String(model || 'deepseek-chat').toLowerCase();
    return MODEL_CONFIGS[requested] || MODEL_CONFIGS['deepseek-chat'];
}
function isKnownModel(model) { return Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, String(model || '').toLowerCase()); }
function isSupportedModel(model) { return resolveModelConfig(model).supported === true; }

// Minimal upstream reader for internal calls (priming, summarization) that only
// need the reply text and the message id.
async function readUpstreamText(readable) {
    const acc = createDeepSeekStreamAccumulator();
    await readDeepSeekSseLines(readable, (line) => {
        if (line && line.startsWith('data: ')) acc.handleLine(line);
    });
    return acc.result();
}

const SUMMARY_INSTRUCTION = [
    'You are compacting a coding/agent session so a fresh chat can continue it.',
    'Write a dense handover note covering: the overall goal, what has been done,',
    'key files or paths, decisions made, the current state, and what still remains.',
    'Use short bullets. No pleasantries. Never invent facts that are not in the',
    'transcript below.',
].join(' ');

// Summarize a session on an isolated throwaway chat so generating the handover
// can never desync the user's live thread. Returns '' if the upstream call fails
// or returns nothing, and the caller keeps the rolling digest instead.
async function summarizeConversation(agentId, model, conversation) {
    const transcript = String(conversation || '').trim();
    if (transcript.length < 200) return '';
    const clipped = transcript.length > SUMMARY_INPUT_CHARS
        ? transcript.slice(transcript.length - SUMMARY_INPUT_CHARS)
        : transcript;
    const prompt = `${SUMMARY_INSTRUCTION}\n\n--- SESSION TRANSCRIPT ---\n${clipped}\n--- END TRANSCRIPT ---\n\nHandover note:`;
    const summaryAgentId = `${agentId}#summary`;
    try {
        const call = await askDeepSeekStream(prompt, summaryAgentId, model);
        const result = await readUpstreamText(call.resp.body);
        return sanitizeContent(result.content || '').trim();
    } finally {
        sessions.delete(summaryAgentId);
        scheduleSessionPersist();
    }
}

async function askDeepSeekStream(prompt, agentId, model = 'deepseek-default', freshSessionPrompt = prompt) {
    const modelCfg = resolveModelConfig(model);
    const session = getOrCreateAgentSession(agentId);
    const hadRemoteSession = Boolean(session.id);
    const account = await selectAccountForSession(session);
    await acquireAccountSlot(account);
    const dsHeaders = account.headers;
    account.lastUsedAt = Date.now();
    const agentTag = `[${agentId}/acct:${account.id}]`;

    // Normally this rollover is performed before the prompt is built, so local
    // recovery history can be injected. Keep this guard for direct callers and
    // concurrent requests that may have advanced the same session meanwhile.
    const rollover = prepareSessionForPrompt(session);
    const accountRotationReset = hadRemoteSession && !session.id;
    const recoveredFreshSession = accountRotationReset || Boolean(rollover);
    let effectivePrompt = recoveredFreshSession ? freshSessionPrompt : prompt;
    if (accountRotationReset) {
        console.log(`${agentTag} Account rotation reset the previous remote session; using recovery prompt.`);
    }
    if (rollover) {
        console.log(`${agentTag} Session ${rollover.failedSessionId} reset before upstream call (${rollover.reason}).`);
    }

    await paceUpstreamCall(account);
    const cr = await dsFetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
        method: 'POST', headers: dsHeaders,
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' })
    });
    const chalText = await cr.text();
    if (!cr.ok) {
        markAccountFailure(account, cr.status, 'pow challenge');
        throw new Error(`DeepSeek auth/network error while creating PoW challenge: HTTP ${cr.status}. Run npm run doctor. If auth expired, run npm run auth or npm run auth:import.`);
    }
    let chalJson;
    try { chalJson = JSON.parse(chalText); }
    catch (e) { throw new Error(`DeepSeek returned non-JSON PoW response. Run npm run doctor. First chars: ${chalText.substring(0, 120)}`); }
    const challenge = chalJson?.data?.biz_data?.challenge;
    if (!challenge) {
        throw new Error('DeepSeek PoW response has no data.biz_data.challenge. Auth may be expired, captcha may be required, or DeepSeek changed Web API. Run npm run doctor, then npm run auth.');
    }
    const answer = await solvePOW(challenge, account.config.wasmUrl);

    const powB64 = Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer: answer,
        signature: challenge.signature, target_path: '/api/v0/chat/completion'
    })).toString('base64');

    if (!session.id) {
        await paceUpstreamCall(account);
        const sr = await dsFetch('https://chat.deepseek.com/api/v0/chat_session/create', {
            method: 'POST', headers: dsHeaders, body: '{}'
        });
        const { json: sessionData, text: sessionText } = await readDeepSeekJsonResponse(sr, 'session create', account);
        const createdSessionId = sessionData?.data?.biz_data?.chat_session?.id || sessionData?.data?.biz_data?.id;
        if (!sr.ok || !createdSessionId) {
            throw new Error(`Could not create DeepSeek chat session (HTTP ${sr.status}). Auth may be expired/captcha-blocked. Run npm run doctor, then npm run auth. First chars: ${String(sessionText || '').substring(0, 120)}`);
        }
        session.id = createdSessionId;
        session.accountId = account.id;
        session.parentMessageId = null;
        session.createdAt = Date.now();
        session.messageCount = 0;
        console.log(`${agentTag} Created new session: ${session.id}`);

        // Two-step priming: a large first message to a brand-new chat tends to
        // come back as an empty stream (that is why FRESH_SESSION_PROMPT_CHARS is
        // small). Warm the chat with a tiny exchange, capture its reply id, then
        // let the large recovery prompt go out as an ordinary follow-up.
        if (PRIME_LARGE_FIRST_MESSAGE && effectivePrompt.length > FRESH_SESSION_PROMPT_CHARS) {
            try {
                await paceUpstreamCall(account);
                const primeResp = await dsFetch('https://chat.deepseek.com/api/v0/chat/completion', {
                    method: 'POST',
                    headers: { ...dsHeaders, 'X-DS-PoW-Response': powB64 },
                    body: JSON.stringify({
                        chat_session_id: session.id,
                        parent_message_id: null,
                        model_type: modelCfg.model_type,
                        prompt: PRIME_MESSAGE, ref_file_ids: [],
                        thinking_enabled: false, search_enabled: false,
                        action: null, preempt: false,
                    }),
                });
                if (primeResp.ok) {
                    const primeResult = await readUpstreamText(primeResp.body);
                    if (primeResult.messageId) {
                        session.parentMessageId = primeResult.messageId;
                        session.messageCount++;
                        console.log(`${agentTag} Primed new chat before the ${effectivePrompt.length}-char recovery prompt.`);
                    }
                } else {
                    await primeResp.text().catch(() => {});
                    console.log(`${agentTag} Priming returned HTTP ${primeResp.status}; sending the recovery prompt as the first message.`);
                }
            } catch (e) {
                console.log(`${agentTag} Priming failed (${e.message}); sending the recovery prompt as the first message.`);
            }
        }
    } else {
        console.log(`${agentTag} Reusing session: ${session.id} (parent: ${session.parentMessageId}, msg#${session.messageCount})`);
    }

    await paceUpstreamCall(account);
    const resp = await dsFetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { ...dsHeaders, 'X-DS-PoW-Response': powB64 },
        body: JSON.stringify({
            chat_session_id: session.id,
            parent_message_id: session.parentMessageId,
            model_type: modelCfg.model_type,
            prompt: effectivePrompt, ref_file_ids: [],
            thinking_enabled: modelCfg.thinking_enabled, search_enabled: modelCfg.search_enabled,
            action: null, preempt: false,
        })
    });

    // If session expired, reset and retry once
    if (resp.status !== 200) {
        // Pass Retry-After so a 429 honors the server-requested cooldown (#16).
        const retryAfter = resp.headers.get('retry-after');
        markAccountFailure(account, resp.status, 'completion', retryAfter);
        const errText = await resp.text();
        console.log(`${agentTag} Session error (${resp.status}): ${errText.substring(0, 100)}`);
        if (resp.status === 400 || resp.status === 404 || resp.status === 500) {
            console.log(`${agentTag} Session ${session.id} expired. Creating new session...`);
            resetRemoteSession(session);

            const sr2 = await dsFetch('https://chat.deepseek.com/api/v0/chat_session/create', {
                method: 'POST', headers: dsHeaders, body: '{}'
            });
            const { json: sessionData2, text: sessionText2 } = await readDeepSeekJsonResponse(sr2, 'session recreate', account);
            const createdSessionId2 = sessionData2?.data?.biz_data?.chat_session?.id || sessionData2?.data?.biz_data?.id;
            if (!sr2.ok || !createdSessionId2) {
                throw new Error(`Could not recreate DeepSeek chat session (HTTP ${sr2.status}). Run npm run doctor, then npm run auth. First chars: ${String(sessionText2 || '').substring(0, 120)}`);
            }
            session.id = createdSessionId2;
            session.accountId = account.id;
            session.parentMessageId = null;
            session.createdAt = Date.now();
            console.log(`${agentTag} Created new session: ${session.id}`);

            const newPowB64 = Buffer.from(JSON.stringify({
                algorithm: challenge.algorithm, challenge: challenge.challenge,
                salt: challenge.salt, answer: answer,
                signature: challenge.signature, target_path: '/api/v0/chat/completion'
            })).toString('base64');
            await paceUpstreamCall(account);
            const resp2 = await dsFetch('https://chat.deepseek.com/api/v0/chat/completion', {
                method: 'POST',
                headers: { ...dsHeaders, 'X-DS-PoW-Response': newPowB64 },
                body: JSON.stringify({
                    chat_session_id: session.id,
                    parent_message_id: null,
                    model_type: modelCfg.model_type,
                    prompt: freshSessionPrompt, ref_file_ids: [],
                    thinking_enabled: modelCfg.thinking_enabled, search_enabled: modelCfg.search_enabled,
                    action: null, preempt: false,
                })
            });
            if (!resp2.ok) {
                const retryAfter2 = resp2.headers.get('retry-after');
                markAccountFailure(account, resp2.status, 'completion after session recreate', retryAfter2);
                const errText2 = await resp2.text();
                throw createUpstreamHttpError(resp2.status, errText2, retryAfter2);
            }
            effectivePrompt = freshSessionPrompt;
            return { resp: resp2, agentId, account, promptUsed: effectivePrompt, freshSessionReset: true };
        }
        // The body was consumed for diagnostics, so returning this Response
        // would hand a locked stream to readDeepSeekResponse. Surface a typed
        // error instead and retain the real upstream status/Retry-After.
        throw createUpstreamHttpError(resp.status, errText, retryAfter);
    }

    // A completed turn proves the account is healthy again: forget any earlier
    // rate-limit streak so the next escalation restarts from the base cooldown.
    // This must NOT run on the HTTP 200 alone — DeepSeek reports "sending too
    // often" *inside* a 200 stream, so resetting here would zero the streak
    // immediately before every stream-level rate limit is counted, pinning the
    // cooldown at the base value forever. The reset belongs after a non-empty
    // response, in markAccountHealthy.
    return { resp, agentId, account, promptUsed: effectivePrompt, freshSessionReset: recoveredFreshSession };
}

// === Tool Calling Support ===

const TOOL_SCHEMA_ANNOTATION_KEYS = new Set(['description', 'examples', '$comment', 'title']);
const TOOL_SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const TOOL_SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const TOOL_SCHEMA_SINGLE_KEYS = new Set([
    'additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if',
    'items', 'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
]);

function compactToolSchema(value) {
    if (Array.isArray(value)) return value.map(compactToolSchema);
    if (!value || typeof value !== 'object') return value;
    const compact = {};
    for (const [key, child] of Object.entries(value)) {
        // Descriptions/examples dominate large agent tool payloads but do not
        // affect argument validation. Traverse only keywords whose values are
        // themselves schemas. Literal instance values under const/enum/default
        // must remain byte-for-byte equivalent, even when they contain fields
        // named "description" or "title".
        if (TOOL_SCHEMA_ANNOTATION_KEYS.has(key)) continue;
        if (TOOL_SCHEMA_MAP_KEYS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
            compact[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, compactToolSchema(schema)]));
        } else if (TOOL_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
            compact[key] = child.map(compactToolSchema);
        } else if (TOOL_SCHEMA_SINGLE_KEYS.has(key)) {
            compact[key] = Array.isArray(child) ? child.map(compactToolSchema) : compactToolSchema(child);
        } else if (key === 'dependencies' && child && typeof child === 'object' && !Array.isArray(child)) {
            compact[key] = Object.fromEntries(Object.entries(child).map(([name, dependency]) => [
                name,
                Array.isArray(dependency) ? dependency : compactToolSchema(dependency),
            ]));
        } else {
            compact[key] = child;
        }
    }
    return compact;
}

function formatToolDefinitions(tools, { compact = false } = {}) {
    if (!tools || tools.length === 0) return '';
    // On a live chat the full schemas are already in the remote context, so a
    // delta turn repeats only the names and the output contract. Dropping the
    // per-turn descriptions + JSON schemas is the single largest saving on the
    // hot path of a long agent session.
    if (compact) {
        const names = tools
            .filter(tool => tool && tool.type === 'function' && tool.function)
            .map(tool => tool.function.name);
        let reminder = '\n\n--- TOOL REQUEST REMINDER ---\n';
        reminder += 'The full tool definitions from the start of this chat still apply. Use the same output format:\n';
        reminder += '{"tool_call":{"name":"<function_name>","arguments":{...}}}\n';
        reminder += 'Legacy format: TOOL_CALL: <function_name>\narguments: <JSON arguments>\n';
        reminder += `Available functions: ${names.join(', ')}\n`;
        reminder += 'Never simulate tool output — emit the request and wait for the result.\n';
        reminder += '--- END TOOL REQUEST REMINDER ---\n';
        return reminder;
    }
    const rawSchemaChars = tools.reduce((total, tool) => {
        try { return total + JSON.stringify(tool?.function?.parameters || {}).length; }
        catch (e) { return total; }
    }, 0);
    const compactSchemas = rawSchemaChars > Math.floor(MAX_UPSTREAM_PROMPT_CHARS * 0.4);
    let text = '\n\n--- TOOL REQUEST SYSTEM ---\n';
    text += 'You are an AI that ONLY REASONS and REQUESTS tool executions. You do NOT run any commands yourself.\n';
    text += 'When you need data from the local server, REQUEST exactly one tool call. Prefer strict JSON:\n';
    text += '{"tool_call":{"name":"<function_name>","arguments":{...}}}\n\n';
    text += 'Legacy format is also accepted: TOOL_CALL: <function_name>\narguments: <JSON arguments>\n\n';
    text += 'Your response will be sent to the local gateway, which executes the command and sends the output back in the next message.\n\n';
    text += 'RULES:\n';
    text += '1. You ONLY output the tool request — you never run anything yourself\n';
    text += '2. Do NOT simulate, guess, or fabricate command output — wait for the actual result\n';
    text += '3. The tool runs on ' + SERVER_HOST + ' (' + SERVER_PUBLIC_IP + '), the local server — NOT on DeepSeek\n';
    text += '4. After the tool executes, the result will be sent to you as a new user/tool message\n';
    text += '5. Say briefly what you are about to do and why, then emit the tool request. Keep it to a few lines — no file dumps, no command output\n';
    text += '6. Keep arguments compact. Do not include large file contents unless the tool schema requires it.\n\n';
    text += 'Available functions:\n';
    for (const tool of tools) {
        if (tool.type === 'function' && tool.function) {
            const fn = tool.function;
            text += `\n## ${fn.name}\n`;
            const description = String(fn.description || '').replace(/\s+/g, ' ').trim();
            text += `${description.length > 500 ? description.substring(0, 497) + '...' : description}\n`;
            if (fn.parameters) {
                text += `Parameters: ${JSON.stringify(compactSchemas ? compactToolSchema(fn.parameters) : fn.parameters)}\n`;
            }
        }
    }
    text += '\n--- END TOOL REQUEST SYSTEM ---\n';
    text += '\nREMEMBER: Request tools only with strict JSON or TOOL_CALL legacy format. Never simulate results.';
    text += ' Plain prose before the tool request is shown to the user as your answer, so write it for them.';
    return text;
}

const MAX_TOOL_MARKUP_CHARS = 256 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 128 * 1024;
const MAX_TOOL_JSON_CANDIDATES = 32;
const MAX_DSML_PARAMETERS = 128;
const MAX_DSML_STRUCTURAL_TAGS = MAX_DSML_PARAMETERS * 2 + 16;
const MAX_DSML_TAG_CHARS = 2048;

function extractBalancedJsonAt(text, startIndex) {
    if (text[startIndex] !== '{') return null;
    let braceDepth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (!inString) {
            if (ch === '{') braceDepth++;
            if (ch === '}') {
                braceDepth--;
                if (braceDepth === 0) return text.substring(startIndex, i + 1);
            }
        }
    }
    return null;
}

function extractBalancedJsonSpans(text, maxObjects = MAX_TOOL_JSON_CANDIDATES) {
    const spans = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (start === -1) {
            if (ch === '{') {
                start = i;
                depth = 1;
                inString = false;
                escape = false;
            }
            continue;
        }
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                spans.push({ start, raw: text.substring(start, i + 1) });
                if (spans.length >= maxObjects) return spans;
                start = -1;
            }
        }
    }
    return spans;
}

function extractBalancedJsonObjects(text, maxObjects = MAX_TOOL_JSON_CANDIDATES) {
    return extractBalancedJsonSpans(text, maxObjects).map(span => span.raw);
}

function buildToolCall(name, args = {}) {
    const toolName = typeof name === 'string' ? name.trim() : '';
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(toolName)) return null;
    let parsedArgs = args;
    if (typeof parsedArgs === 'string') {
        if (parsedArgs.length > MAX_TOOL_ARGUMENT_CHARS) return null;
        try { parsedArgs = JSON.parse(parsedArgs); } catch (e) { return null; }
    }
    if (parsedArgs === null || parsedArgs === undefined) parsedArgs = {};
    if (typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) return null;
    let serialized;
    try { serialized = JSON.stringify(parsedArgs); } catch (e) { return null; }
    if (serialized.length > MAX_TOOL_ARGUMENT_CHARS) return null;
    return { name: toolName, arguments: serialized };
}

function coerceToolCallObject(obj, { allowBare = false } = {}) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    let candidate = null;
    if (Object.prototype.hasOwnProperty.call(obj, 'tool_call')) {
        candidate = obj.tool_call;
    } else if (Object.prototype.hasOwnProperty.call(obj, 'function_call')) {
        candidate = obj.function_call;
    } else if (Object.prototype.hasOwnProperty.call(obj, 'tool_calls')) {
        if (!Array.isArray(obj.tool_calls) || obj.tool_calls.length !== 1) return null;
        candidate = obj.tool_calls[0];
    } else if (allowBare) {
        candidate = obj;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const fn = candidate.function && typeof candidate.function === 'object'
        ? candidate.function
        : candidate;
    return buildToolCall(
        fn.name ?? candidate.name,
        fn.arguments ?? candidate.arguments ?? candidate.input ?? {}
    );
}

const MAX_TOOL_MARKUP_REPAIR_CLOSERS = 8;

function missingJsonClosers(raw) {
    const scan = scanUnclosedJsonContainers(raw);
    if (!scan) return null;
    return scan.closers;
}

function scanUnclosedJsonContainers(text) {
    const stack = [];
    const openers = [];
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{' || ch === '[') { stack.push(ch); openers.push(i); }
        else if (ch === '}' || ch === ']') { stack.pop(); openers.pop(); }
    }
    if (inString || stack.length === 0 || stack.length > MAX_TOOL_MARKUP_REPAIR_CLOSERS) return null;
    let closers = '';
    for (let i = stack.length - 1; i >= 0; i--) closers += stack[i] === '{' ? '}' : ']';
    return { start: openers[0], raw: text.substring(openers[0]), closers };
}

function parseJsonToolCandidate(raw, label = 'json', options = {}) {
    if (!raw) return null;
    const candidates = [raw];
    // A reply cut mid-envelope is only ever missing the tail braces, and the
    // argument payload is already complete, so closing the open containers is a
    // lossless repair. Bounded to a few closers and an explicit envelope so
    // half-written prose can never be promoted into an executable call.
    const closers = missingJsonClosers(raw);
    if (closers && /"tool_calls?"\s*:|"function_calls?"\s*:/.test(raw)) candidates.push(raw + closers);
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            const tc = coerceToolCallObject(parsed, options);
            if (tc) {
                if (candidate !== raw) console.log(`[parseToolCall] ${label} repaired truncated envelope (+${closers.length} closers)`);
                console.log(`[parseToolCall] SUCCESS ${label}: ${tc.name} (args=${tc.arguments.length} chars)`);
                return tc;
            }
        } catch (e) {
            if (candidate === raw) console.log(`[parseToolCall] ${label} JSON.parse failed: ${e.message.substring(0, 100)}`);
        }
    }
    return null;
}

function canonicalizeToolMarkupTag(rawTag) {
    let token = String(rawTag || '').trim()
        .replace(/｜/g, '|')
        .replace(/[“”＂]/g, '"')
        .replace(/[‘’＇]/g, "'");
    let closing = false;
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    token = token.replace(/^\|+\s*DSML\s*\|+\s*/i, '');
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    token = token.replace(/^DSML(?=(?:tool[\s_-]*calls|function[\s_-]*calls|calls|invoke|parameter)\b)/i, '');

    if (!closing && /^name\s*=/i.test(token)) return `<direct ${token}>`;

    const semantic = token.match(/^(?:(?:[A-Za-z_][\w.-]*):)?(tool[\s_-]*calls|function[\s_-]*calls|calls|invoke|parameter)\b([\s\S]*)$/i);
    if (!semantic) return null;
    const localName = semantic[1].replace(/[\s_-]/g, '').toLowerCase();
    const canonicalName = (localName === 'toolcalls' || localName === 'functioncalls' || localName === 'calls')
        ? 'tool_calls'
        : localName;
    const attrs = closing ? '' : semantic[2];
    return `<${closing ? '/' : ''}${canonicalName}${attrs}>`;
}

function normalizeToolMarkupTags(text) {
    const withAsciiAngles = String(text || '').replace(/＜/g, '<').replace(/＞/g, '>');
    return withAsciiAngles.replace(/<([^<>]{0,1024})>/g, (whole, rawTag) => {
        const canonical = canonicalizeToolMarkupTag(rawTag);
        return canonical || whole;
    });
}

function decodeDsmlValue(value) {
    return String(value || '')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

function decodeDsmlParameterValue(value) {
    const raw = String(value || '');
    const cdata = raw.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
    return cdata ? cdata[1] : decodeDsmlValue(raw);
}

function getMarkupAttribute(attrs, attribute) {
    const match = String(attrs || '').match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([^"']+)\\1`, 'i'));
    return match ? match[2] : null;
}

function readDsmlTagAt(text, start) {
    if (text[start] !== '<') return null;
    const prefix = text.substring(start + 1, Math.min(text.length, start + 40)).trimStart();
    if (!/^\/?(?:tool[\s_-]*calls|function[\s_-]*calls|calls|invoke|parameter|direct)\b/i.test(prefix)) return null;
    let quote = null;
    let end = -1;
    const scanEnd = Math.min(text.length, start + MAX_DSML_TAG_CHARS + 1);
    for (let i = start + 1; i < scanEnd; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '>') {
            end = i;
            break;
        }
    }
    if (end === -1) return { invalid: true };

    let token = text.substring(start + 1, end).trim();
    let closing = false;
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    let selfClosing = false;
    if (!closing && token.endsWith('/')) {
        selfClosing = true;
        token = token.substring(0, token.length - 1).trim();
    }
    const match = token.match(/^(tool[\s_-]*calls|function[\s_-]*calls|calls|invoke|parameter|direct)\b([\s\S]*)$/i);
    if (!match) return null;
    const localName = match[1].replace(/[\s_-]/g, '').toLowerCase();
    return {
        name: (localName === 'calls' || localName === 'toolcalls' || localName === 'functioncalls')
            ? 'tool_calls'
            : localName,
        attrs: closing ? '' : match[2],
        closing,
        selfClosing,
        start,
        end: end + 1,
    };
}

function scanDsmlStructuralTags(text) {
    const tags = [];
    const value = String(text || '');
    for (let i = 0; i < value.length;) {
        if (value.substring(i, i + 9).toUpperCase() === '<![CDATA[') {
            const cdataEnd = value.indexOf(']]>', i + 9);
            if (cdataEnd === -1) return null;
            i = cdataEnd + 3;
            continue;
        }
        if (value[i] !== '<') {
            i++;
            continue;
        }
        const tag = readDsmlTagAt(value, i);
        if (!tag) {
            i++;
            continue;
        }
        if (tag.invalid) return null;
        tags.push(tag);
        if (tags.length > MAX_DSML_STRUCTURAL_TAGS) return null;
        i = tag.end;
    }
    return tags;
}

function parseDsmlParameter(attrs, rawBody, args, seenNames) {
    const parameterName = getMarkupAttribute(attrs, 'name');
    if (!parameterName || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(parameterName) || seenNames.has(parameterName)) return false;
    seenNames.add(parameterName);
    const stringMode = getMarkupAttribute(attrs, 'string');
    const rawValue = decodeDsmlParameterValue(rawBody);
    if (rawValue.length > MAX_TOOL_ARGUMENT_CHARS) return false;
    let value = rawValue;
    if (stringMode && stringMode.toLowerCase() === 'false') {
        try { value = JSON.parse(rawValue.trim()); } catch (e) { return false; }
    }
    args[parameterName] = value;
    return true;
}

function parseDsmlInvoke(name, body) {
    const structuralTags = scanDsmlStructuralTags(body);
    if (!structuralTags) return null;
    const parameterTags = structuralTags.filter(tag => tag.name === 'parameter');
    if (structuralTags.some(tag => tag.name !== 'parameter')) return null;

    const args = {};
    let parameterCount = 0;
    const seenNames = new Set();
    let cursor = 0;
    for (let i = 0; i < parameterTags.length; i += 2) {
        const opening = parameterTags[i];
        const closing = parameterTags[i + 1];
        if (!opening || opening.closing || opening.selfClosing || !closing || !closing.closing) return null;
        if (body.substring(cursor, opening.start).trim()) return null;
        parameterCount++;
        if (parameterCount > MAX_DSML_PARAMETERS) return null;
        if (!parseDsmlParameter(opening.attrs, body.substring(opening.end, closing.start), args, seenNames)) return null;
        cursor = closing.end;
    }
    if (parameterCount > 0) {
        if (body.substring(cursor).trim()) return null;
        return buildToolCall(name, args);
    }

    const decodedBody = decodeDsmlValue(body).trim();
    if (!decodedBody) return buildToolCall(name, {});
    const objects = extractBalancedJsonObjects(decodedBody, 2);
    if (objects.length !== 1 || decodedBody !== objects[0]) return null;
    try { return buildToolCall(name, JSON.parse(objects[0])); }
    catch (e) { return null; }
}

function extractToolCallScope(normalized) {
    const tags = scanDsmlStructuralTags(normalized);
    if (!tags) return null;
    const wrappers = tags.filter(tag => tag.name === 'tool_calls');
    const openings = wrappers.filter(tag => !tag.closing);
    const closings = wrappers.filter(tag => tag.closing);
    if (openings.length > 0) {
        if (openings.length !== 1 || openings[0].selfClosing || closings.length === 0) return null;
        const opening = openings[0];
        const closing = closings[closings.length - 1];
        if (wrappers.some(tag => tag.closing && tag.start < opening.end) || closing.start < opening.end) return null;
        if (tags.some(tag => tag.name !== 'tool_calls' && (tag.start < opening.end || tag.start >= closing.start))) return null;
        return normalized.substring(opening.end, closing.start);
    }
    // Narrow repair: tolerate a missing opening wrapper only when a closing
    // wrapper exists. A bare invoke without this sentinel is never executable.
    if (closings.length > 0) {
        const closing = closings[closings.length - 1];
        const invokeOpenings = tags.filter(tag => tag.name === 'invoke' && !tag.closing && tag.start < closing.start);
        if (invokeOpenings.length === 1 && !invokeOpenings[0].selfClosing) {
            if (tags.some(tag => tag.name !== 'tool_calls' && (tag.start < invokeOpenings[0].start || tag.start >= closing.start))) return null;
            return normalized.substring(invokeOpenings[0].start, closing.start);
        }
    }
    return null;
}

// The body of a DSML wrapper must be nothing but one explicit tool-call
// envelope — balanced, or missing only its tail closers. Anything else stays
// unparseable, so the wrapper cannot smuggle extra text into an executable call.
function parseSingleEnvelopeBody(body, label) {
    const start = body.indexOf('{');
    if (start === -1 || body.substring(0, start).trim()) return null;
    const rest = body.substring(start);
    const objects = extractBalancedJsonObjects(rest);
    if (objects.length === 1 && !rest.substring(objects[0].length).trim()) {
        const tc = parseJsonToolCandidate(objects[0], label);
        if (tc) return tc;
    }
    const truncated = scanUnclosedJsonContainers(rest);
    if (truncated && truncated.start === 0 && /"tool_calls?"\s*:|"function_calls?"\s*:/.test(rest)) {
        return parseJsonToolCandidate(rest, label);
    }
    return null;
}

// Wrapper tag with no closing sibling and no invoke/parameter children: the
// model opened the DSML block and then wrote a plain JSON envelope into it.
function parseDsmlUnterminatedJsonBody(normalized) {
    const tags = scanDsmlStructuralTags(normalized);
    if (!tags || tags.length !== 1) return null;
    const opening = tags[0];
    if (opening.name !== 'tool_calls' || opening.closing || opening.selfClosing) return null;
    return parseSingleEnvelopeBody(normalized.substring(opening.end), 'dsml-json-unterminated');
}

// The model occasionally emits DSML that is not well-formed: the sentinel
// itself leaks (|DSML|) without its wrapping angle brackets, so parameter tags
// run together on one line and wrapper/invoke closers are mangled. The strict
// parser above rejects that, which used to reset the session and retry. This
// salvage path recovers the first invoke and whatever parameters stay readable
// so one corrupted token does not destroy the whole turn. It only runs after
// strict parsing has already failed.
function salvageDsmlToolCall(text) {
    const source = String(text || '');
    if (source.length > MAX_TOOL_MARKUP_CHARS) return null;
    const normalized = source.replace(/｜/g, '|');
    // Salvage still requires the DSML wrapper sentinel: a bare invoke is never
    // executable, however readable its parameters happen to be.
    if (!/\|+\s*DSML\s*\|+[\s<>]*calls\b/i.test(normalized)) return null;

    const invoke = normalized.match(/\|+\s*DSML\s*\|+[\s<>]*invoke\b([\s\S]*?)>/i);
    if (!invoke) return null;
    const name = getMarkupAttribute(invoke[1], 'name');
    if (!name) return null;

    let tail = normalized.substring(invoke.index + invoke[0].length);
    const nextInvoke = tail.search(/\|+\s*DSML\s*\|+[\s<>]*invoke\b/i);
    if (nextInvoke !== -1) tail = tail.substring(0, nextInvoke);

    const chunks = tail.split(/\|+\s*DSML\s*\|+/i);
    const args = {};
    const seenNames = new Set();
    for (const chunk of chunks) {
        if (seenNames.size >= MAX_DSML_PARAMETERS) break;
        const match = chunk.match(/^\s*(\/)?\s*parameter\b([\s\S]*)$/i);
        if (!match || match[1]) continue;
        const rest = match[2];
        const angle = rest.indexOf('>');
        if (angle === -1) continue;
        const attrs = rest.substring(0, angle);
        let key = getMarkupAttribute(attrs, 'name');
        if (!key) {
            const bare = attrs.match(/["']([A-Za-z0-9_][A-Za-z0-9_.:-]{0,127})["']/);
            if (bare) key = bare[1];
        }
        if (!key || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(key) || seenNames.has(key)) continue;
        seenNames.add(key);
        let value = rest.substring(angle + 1).replace(/<\s*\/[\s\S]*$/, '').trim();
        if (value.length > MAX_TOOL_ARGUMENT_CHARS) continue;
        const stringMode = (getMarkupAttribute(attrs, 'string') || '').toLowerCase();
        if (stringMode === 'false') {
            try { value = JSON.parse(value); } catch (e) { /* keep as string */ }
        } else if (stringMode !== 'true') {
            if (/^-?\d+$/.test(value)) value = Number(value);
            else if (value === 'true' || value === 'false') value = value === 'true';
            else value = decodeDsmlValue(value);
        } else {
            value = decodeDsmlValue(value);
        }
        args[key] = value;
    }
    if (seenNames.size === 0) return null;
    const built = buildToolCall(name, args);
    if (built) console.log(`[parseToolCall] SUCCESS dsml-salvage: ${built.name} (args=${built.arguments.length} chars)`);
    return built;
}

function parseDsmlToolCallStrict(text) {
    if (String(text || '').length > MAX_TOOL_MARKUP_CHARS) return null;
    const normalized = normalizeToolMarkupTags(text);
    const unterminated = parseDsmlUnterminatedJsonBody(normalized);
    if (unterminated) return unterminated;
    const scope = extractToolCallScope(normalized);
    if (scope === null) return null;
    const tags = scanDsmlStructuralTags(scope);
    if (!tags) return null;

    // Hybrid: the wrapper is present but the body is a plain JSON envelope
    // instead of invoke/parameter tags. A body with no structural tags at all
    // is exactly this case.
    if (tags.every(tag => tag.name === 'tool_calls')) {
        const parsed = parseSingleEnvelopeBody(scope, 'dsml-json');
        if (parsed) return parsed;
    }
    if (tags.length === 0) return null;
    const first = tags[0];
    if (scope.substring(0, first.start).trim()) return null;

    if (first.name === 'invoke' && !first.closing && !first.selfClosing) {
        const invokeTags = tags.filter(tag => tag.name === 'invoke');
        if (invokeTags.length !== 2 || invokeTags[0] !== first || invokeTags[1].closing !== true) return null;
        const closing = invokeTags[1];
        if (scope.substring(closing.end).trim()) return null;
        if (tags.some(tag => (tag.name === 'tool_calls' || tag.name === 'direct'))) return null;
        const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end, closing.start));
        if (parsed) {
            console.log(`[parseToolCall] SUCCESS dsml: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
    }

    if (first.name === 'direct' && !first.closing && !first.selfClosing) {
        if (tags.some((tag, index) => index > 0 && (tag.name === 'direct' || tag.name === 'invoke' || tag.name === 'tool_calls'))) return null;
        const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end));
        if (parsed) {
            console.log(`[parseToolCall] SUCCESS dsml-direct: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
    }
    return null;
}

function parseDsmlToolCall(text) {
    return parseDsmlToolCallStrict(text) || salvageDsmlToolCall(text);
}

function looksLikeToolCallMarkup(text) {
    return /TOOL_CALL:\s*[\w-]+|^[ \t]*Tool:\s*[A-Za-z0-9_][A-Za-z0-9_.:-]*[ \t]*$|<\s*tool_call\b|[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b|["'](?:tool_call|tool_calls|function_call)["']\s*:/im.test(String(text || ''));
}

// Unparseable tool markup is the one failure we cannot diagnose from the logs
// alone, and it is rare enough to be worth keeping. Drop the raw model output
// next to the other debug artifacts so the format can be fixed offline.
function dumpFailedToolMarkup(label, ...parts) {
    try {
        const os = require('os');
        const dir = path.join(os.tmpdir(), 'deepseek_response_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
        const body = parts
            .filter(p => typeof p === 'string' && p.trim())
            .map((p, i) => `--- part ${i + 1} (${p.length} chars) ---\n${p}`)
            .join('\n\n');
        fs.writeFileSync(dir, `[${label}]\n\n${body}`);
        console.log(`[tool-markup] Raw output saved: ${dir}`);
        return dir;
    } catch (e) {
        console.log(`[tool-markup] Could not save raw output: ${e.message}`);
        return null;
    }
}

// The models that drive this proxy explain themselves in prose and then append
// the tool call, and that prose is the only trace of their reasoning a user
// ever sees. Surfacing it is the whole point, so the parsers report where the
// executable markup starts: everything before that offset is model prose by
// construction, never payload, and can be shown as normal assistant text.
const MAX_TOOL_PREAMBLE_CHARS = 8000;
const TOOL_MARKUP_START_PATTERNS = {
    dsml: /[<＜]?[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i,
    xml: /<\s*tool_call\b/i,
    fence: /```/,
    legacy: /TOOL_CALL\s*:/i,
    json: /["'](?:tool_call|tool_calls|function_call)["']\s*:/i,
};
// Markdown fences are legitimate inside an explanation, so they do not veto the
// preamble; an unparsed envelope or a DSML tag left above the executable markup
// does, because showing it as prose would put markup back on screen.
const TOOL_MARKUP_VETO_PATTERNS = [
    TOOL_MARKUP_START_PATTERNS.dsml,
    TOOL_MARKUP_START_PATTERNS.xml,
    TOOL_MARKUP_START_PATTERNS.legacy,
    TOOL_MARKUP_START_PATTERNS.json,
];

function toolCallPreamble(text, markupStart) {
    if (!Number.isInteger(markupStart) || markupStart <= 0) return '';
    const head = text.substring(0, markupStart);
    for (const pattern of TOOL_MARKUP_VETO_PATTERNS) {
        if (pattern.test(head)) return '';
    }
    const value = head.trim();
    if (!value) return '';
    if (value.length <= MAX_TOOL_PREAMBLE_CHARS) return value;
    return value.substring(0, MAX_TOOL_PREAMBLE_CHARS - 3).trimEnd() + '...';
}

function parseToolCallDetailed(text) {
    if (!text || typeof text !== 'string') return null;
    if (text.length > MAX_TOOL_MARKUP_CHARS) {
        console.log(`[parseToolCall] Refusing oversized tool markup candidate (${text.length} chars)`);
        return null;
    }

    if (TOOL_MARKUP_START_PATTERNS.dsml.test(text)) {
        const dsml = parseDsmlToolCall(text);
        if (dsml) {
            const start = text.search(TOOL_MARKUP_START_PATTERNS.dsml);
            return { toolCall: dsml, preamble: toolCallPreamble(text, start) };
        }
        console.log('[parseToolCall] Tool markup found but wrapper/invoke was incomplete or malformed');
        return null;
    }

    // XML-ish wrappers used by some agent prompts.
    const xmlMatch = text.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
    if (xmlMatch) {
        const inner = xmlMatch[1].trim();
        const tc = parseJsonToolCandidate(inner, 'xml', { allowBare: true });
        if (tc) return { toolCall: tc, preamble: toolCallPreamble(text, xmlMatch.index) };
    }

    // Fenced JSON blocks. A reply often contains ```bash / ```yaml blocks that
    // merely show a command to the user, so every fence used to be fed to
    // JSON.parse and logged a failure that meant nothing. A JSON envelope always
    // starts with { or [, so anything else cannot be a tool call — skip it
    // silently instead of reporting a bogus parse error.
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fence;
    while ((fence = fenceRe.exec(text)) !== null) {
        const fenced = fence[1].trim();
        if (!/^[[{]/.test(fenced)) continue;
        const tc = parseJsonToolCandidate(fenced, 'fenced');
        if (tc) return { toolCall: tc, preamble: toolCallPreamble(text, fence.index) };
    }

    // Legacy TOOL_CALL: name + first balanced JSON object after it.
    const match = text.match(/TOOL_CALL:\s*([\w-]+)\s*/i);
    if (match) {
        const name = match[1];
        const payloadStart = match.index + match[0].length;
        const afterMatch = text.substring(payloadStart);
        const braceIdx = afterMatch.indexOf('{');
        if (braceIdx !== -1) {
            const rawJson = extractBalancedJsonAt(afterMatch, braceIdx);
            if (rawJson) {
                try {
                    const args = JSON.parse(rawJson);
                    const tc = buildToolCall(name, args);
                    if (tc) {
                        console.log(`[parseToolCall] SUCCESS legacy: ${name} (args=${rawJson.length} chars)`);
                        return { toolCall: tc, preamble: toolCallPreamble(text, match.index) };
                    }
                } catch (e) {
                    console.log(`[parseToolCall] legacy JSON.parse failed: ${e.message.substring(0,100)}`);
                }
            } else {
                console.log(`[parseToolCall] TOOL_CALL:${name} found but JSON braces are unbalanced`);
            }
        } else {
            console.log(`[parseToolCall] TOOL_CALL:${name} found but no { after it`);
        }
    }

    // Anthropic-style plain-text tool blocks: "Tool: <name>" on one line,
    // "Input:" (optionally) and the JSON arguments on the following lines.
    // DeepSeek Web often imitates this shape verbatim, and every brace inside it
    // would otherwise be fed to JSON.parse and logged as a bogus failure.
    const nameLine = text.match(/^[ \t]*Tool:\s*([A-Za-z0-9_][A-Za-z0-9_.:-]*)[ \t]*$/mi);
    if (nameLine) {
        const toolName = nameLine[1];
        const afterName = text.substring(nameLine.index + nameLine[0].length);
        const inputLabel = afterName.match(/^[ \t]*Input:\s*/mi);
        const jsonSearchFrom = inputLabel ? inputLabel.index + inputLabel[0].length : 0;
        const braceIdx = afterName.indexOf('{', jsonSearchFrom);
        if (braceIdx !== -1) {
            const rawJson = extractBalancedJsonAt(afterName, braceIdx);
            if (rawJson) {
                try {
                    const args = JSON.parse(rawJson);
                    const tc = buildToolCall(toolName, args);
                    if (tc) {
                        console.log(`[parseToolCall] SUCCESS tool-block: ${toolName} (args=${rawJson.length} chars)`);
                        return { toolCall: tc, preamble: toolCallPreamble(text, nameLine.index) };
                    }
                } catch (e) {
                    console.log(`[parseToolCall] tool-block JSON.parse failed: ${e.message.substring(0,100)}`);
                }
            }
        }
    }

    // Scan each top-level balanced object once (linear time). Only explicit
    // tool-call envelopes are executable; bare {name, arguments} examples are not.
    for (const span of extractBalancedJsonSpans(text)) {
        const tc = parseJsonToolCandidate(span.raw, 'inline');
        if (tc) return { toolCall: tc, preamble: toolCallPreamble(text, span.start) };
    }

    // A reply the stream cut mid-envelope never yields a balanced object, so the
    // scan above sees nothing. Retry from the outermost unclosed container with
    // its missing tail closers appended.
    const truncated = scanUnclosedJsonContainers(text);
    if (truncated && /"tool_calls?"\s*:|"function_calls?"\s*:/.test(truncated.raw)) {
        const tc = parseJsonToolCandidate(truncated.raw, 'inline-truncated');
        if (tc) return { toolCall: tc, preamble: toolCallPreamble(text, truncated.start) };
    }

    console.log(`[parseToolCall] No tool call match in ${text.length} chars`);
    return null;
}

function parseToolCall(text) {
    const parsed = parseToolCallDetailed(text);
    return parsed ? parsed.toolCall : null;
}

/**
 * Strip surrogate characters and other problematic Unicode from text
 * to prevent httpx/urlencode crashes when the gateway sends to Telegram.
 */
function sanitizeContent(text) {
    return text.replace(/[\ud800-\udfff]/g, '');
}

function estimateTokens(text) {
    return text ? Math.ceil(String(text).length / 4) : 0;
}

// DeepSeek Web reports a cumulative `accumulated_token_usage` counter per remote
// chat, delivered in the final JSON-patch batch. The growth a request causes is
// real accounting, unlike the chars/4 guess, which is off by an order of
// magnitude on long agent chats: the live prompt is a two-message delta on top
// of a large remote chat the estimator never sees.
//
// The counter is cumulative and prompt caching means its growth does not split
// cleanly into input and output, so only the total is treated as exact. The
// estimated ratio is used to divide that exact total between the two buckets,
// which keeps `prompt + completion === total` for cost maths in harnesses.
//
// `upstream` is { start, total }. Anything missing or non-advancing falls back
// to the plain estimate.
function resolveUpstreamUsage(upstream, estimated = {}) {
    const promptTokens = Math.max(0, Math.floor(Number(estimated.promptTokens) || 0));
    const completionEstimate = Math.max(0, Math.floor(Number(estimated.completionTokens) || 0));
    const reasoningEstimate = Math.max(0, Math.floor(Number(estimated.reasoningTokens) || 0));
    const fallback = () => ({
        prompt_tokens: promptTokens,
        completion_tokens: completionEstimate,
        total_tokens: promptTokens + completionEstimate,
        completion_tokens_details: { reasoning_tokens: Math.min(reasoningEstimate, completionEstimate) },
        source: 'estimate',
    });

    const start = Number(upstream && upstream.start);
    const total = Number(upstream && upstream.total);
    if (!Number.isFinite(start) || !Number.isFinite(total) || total <= 0) return fallback();
    const spent = Math.floor(total - start);
    if (spent <= 0) return fallback();

    const estimatedTotal = promptTokens + completionEstimate;
    const realPrompt = estimatedTotal > 0
        ? Math.min(spent, Math.round((spent * promptTokens) / estimatedTotal))
        : spent;
    const realCompletion = spent - realPrompt;
    return {
        prompt_tokens: realPrompt,
        completion_tokens: realCompletion,
        total_tokens: spent,
        completion_tokens_details: { reasoning_tokens: Math.min(reasoningEstimate, realCompletion) },
        source: 'upstream',
    };
}

function buildUsage(prompt, content, reasoningContent = '', upstream = null) {
    return buildUsageReport(prompt, content, reasoningContent, upstream).usage;
}

function buildUsageReport(prompt, content, reasoningContent = '', upstream = null) {
    const resolved = resolveUpstreamUsage(upstream, {
        promptTokens: estimateTokens(prompt),
        completionTokens: estimateTokens(content) + estimateTokens(reasoningContent),
        reasoningTokens: estimateTokens(reasoningContent),
    });
    return {
        usage: {
            prompt_tokens: resolved.prompt_tokens,
            completion_tokens: resolved.completion_tokens,
            total_tokens: resolved.total_tokens,
            completion_tokens_details: {
                reasoning_tokens: resolved.completion_tokens_details.reasoning_tokens
            }
        },
        // Logged separately so a non-advancing upstream counter is reported as
        // the estimate it actually is, not as real accounting.
        source: resolved.source,
    };
}

function buildToolCallResponse(toolCall, model = 'deepseek-default', prompt = '', reasoningContent = '', upstreamTokens = null, content = '') {
    const id = 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const text = typeof content === 'string' ? content : '';
    const message = {
        role: 'assistant',
        // A tool turn may legitimately carry the model's own preamble next to
        // the call, which is what the user actually reads. Reasoning stays out:
        // some agent clients treat any reasoning payload on a tool turn as a
        // final answer and stop their tool loop.
        content: text || null,
        tool_calls: [{
            id: id,
            type: 'function',
            function: { name: toolCall.name, arguments: toolCall.arguments }
        }]
    };
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: 'tool_calls'
        }],
        usage: buildUsage(prompt, text, reasoningContent, upstreamTokens),
        watermark: FORGETMEAI_WATERMARK
    };
}

function buildTextResponse(content, prompt, model = 'deepseek-default', reasoningContent = '', finishReason = null, upstreamTokens = null) {
    const message = { role: 'assistant', content };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            // Surface truncation: a 'length' finish lets length-aware clients re-request
            // instead of silently treating a cut-off answer as a clean stop.
            finish_reason: finishReason === 'length' ? 'length' : 'stop'
        }],
        usage: buildUsage(prompt, content, reasoningContent, upstreamTokens),
        watermark: FORGETMEAI_WATERMARK
    };
}

function normalizeMessageContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
            if (part.type === 'tool_result') return `[Tool Result ${part.tool_use_id || ''}]\n${normalizeMessageContent(part.content)}`;
            if (part.type === 'image_url') return `[Image: ${part.image_url?.url || ''}]`;
            return part.text || part.content || JSON.stringify(part);
        }).filter(Boolean).join('\n');
    }
    return String(content);
}

function normalizeAnthropicTools(tools = []) {
    return (tools || []).map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
        }
    })).filter(tool => tool.function.name);
}

function normalizeResponsesTools(tools = []) {
    return (tools || []).map(tool => {
        if (tool.type === 'function' && tool.function) return tool;
        if (tool.type === 'function' && tool.name) {
            return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} } } };
        }
        return null;
    }).filter(Boolean);
}

function normalizeResponsesInput(input) {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (!Array.isArray(input)) return [];
    const messages = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'message') {
            messages.push({ role: item.role || 'user', content: normalizeMessageContent(item.content) });
        } else if (item.role) {
            messages.push({ role: item.role, content: normalizeMessageContent(item.content) });
        } else if (item.type === 'function_call_output') {
            messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output || '' });
        } else if (item.type === 'input_text') {
            messages.push({ role: 'user', content: item.text || '' });
        }
    }
    return messages;
}

function normalizeApiParams(params, apiMode) {
    if (apiMode === 'anthropic') {
        const messages = [];
        if (params.system) messages.push({ role: 'system', content: normalizeMessageContent(params.system) });
        for (const msg of params.messages || []) {
            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                const toolUses = msg.content.filter(part => part && part.type === 'tool_use');
                const text = normalizeMessageContent(msg.content.filter(part => !part || part.type !== 'tool_use'));
                if (text) messages.push({ role: 'assistant', content: text });
                for (const tu of toolUses) {
                    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) } }] });
                }
            } else if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(part => part && part.type === 'tool_result')) {
                for (const part of msg.content) {
                    if (part && part.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: normalizeMessageContent(part.content) });
                    else messages.push({ role: 'user', content: normalizeMessageContent(part) });
                }
            } else {
                messages.push({ role: msg.role || 'user', content: normalizeMessageContent(msg.content) });
            }
        }
        return {
            ...params,
            model: params.model || 'deepseek-chat',
            messages,
            tools: normalizeAnthropicTools(params.tools || []),
            stream: params.stream === true,
            user: params.metadata?.user_id || params.user,
        };
    }
    if (apiMode === 'responses') {
        const messages = normalizeResponsesInput(params.input);
        if (params.instructions) messages.unshift({ role: 'system', content: params.instructions });
        return {
            ...params,
            model: params.model || 'deepseek-chat',
            messages,
            tools: normalizeResponsesTools(params.tools || []),
            stream: params.stream === true,
            user: params.user,
        };
    }
    return params;
}

function safeJsonParseObject(text, fallback = {}) {
    try {
        const parsed = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

function toAnthropicResponse(openaiResp) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const content = [];
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeJsonParseObject(tc.function.arguments) });
        }
    } else {
        content.push({ type: 'text', text: msg.content || '' });
    }
    const response = {
        id: 'msg_' + openaiResp.id,
        type: 'message',
        role: 'assistant',
        model: openaiResp.model,
        content,
        stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
        },
        watermark: FORGETMEAI_WATERMARK,
    };
    if (!hasToolCalls && msg.reasoning_content) response.reasoning_content = msg.reasoning_content;
    return response;
}

function writeSse(res, event, data) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendAnthropicStream(res, openaiResp) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const message = toAnthropicResponse(openaiResp);
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    writeSse(res, 'message_start', { type: 'message_start', message: { ...message, content: [] } });

    // Anthropic-compatible clients expect a tool turn to be made of tool_use
    // content blocks. If we emit DeepSeek reasoning as a text block before the
    // tool_use block, some agents treat the turn as a normal text answer and do
    // not execute the tool. Keep tool streaming clean: tool_use blocks only.
    if (hasToolCalls) {
        msg.tool_calls.forEach((tc, i) => {
            writeSse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } });
            writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: tc.function.arguments || '{}' } });
            writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
        });
        writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: message.usage });
    } else {
        if (msg.reasoning_content) {
            writeSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `[reasoning]\n${msg.reasoning_content}\n[/reasoning]\n` } });
            writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        }
        const offset = msg.reasoning_content ? 1 : 0;
        writeSse(res, 'content_block_start', { type: 'content_block_start', index: offset, content_block: { type: 'text', text: '' } });
        const text = msg.content || '';
        for (let i = 0; i < text.length; i += 80) {
            writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: offset, delta: { type: 'text_delta', text: text.substring(i, i + 80) } });
        }
        writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: offset });
        writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: message.usage });
    }
    writeSse(res, 'message_stop', { type: 'message_stop' });
    res.end();
}

function toResponsesResponse(openaiResp) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const output = [];
    if (!hasToolCalls && msg.reasoning_content) {
        output.push({ id: 'rs_' + Date.now(), type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }] });
    }
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            output.push({ type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
        }
        // A tool turn can still carry the model's own preamble, which is a
        // separate message item ahead of the function call.
        if (msg.content) {
            output.unshift({ id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content, annotations: [] }] });
        }
    } else {
        output.push({ id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content || '', annotations: [] }] });
    }
    return {
        id: openaiResp.id.replace(/^ds-/, 'resp_'),
        object: 'response',
        created_at: openaiResp.created,
        status: 'completed',
        model: openaiResp.model,
        output,
        output_text: msg.content || '',
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
            total_tokens: openaiResp.usage?.total_tokens || 0,
            output_tokens_details: { reasoning_tokens: openaiResp.usage?.completion_tokens_details?.reasoning_tokens || 0 },
        },
        watermark: FORGETMEAI_WATERMARK,
    };
}

function sendResponsesStream(res, openaiResp) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const response = toResponsesResponse(openaiResp);
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    writeSse(res, 'response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    writeSse(res, 'response.in_progress', { type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [] } });
    let outputIndex = 0;
    if (!hasToolCalls && msg.reasoning_content) {
        const reasoningItem = { id: 'rs_' + Date.now(), type: 'reasoning', summary: [], status: 'completed' };
        writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...reasoningItem, status: 'in_progress' } });
        writeSse(res, 'response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: outputIndex, summary_index: 0, delta: msg.reasoning_content });
        writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { ...reasoningItem, summary: [{ type: 'summary_text', text: msg.reasoning_content }] } });
        outputIndex++;
    }
    if (hasToolCalls) {
        if (msg.content) {
            const text = msg.content;
            const item = { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
            writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } });
            writeSse(res, 'response.content_part.added', { type: 'response.content_part.added', output_index: outputIndex, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
            for (let i = 0; i < text.length; i += 80) {
                writeSse(res, 'response.output_text.delta', { type: 'response.output_text.delta', output_index: outputIndex, content_index: 0, item_id: item.id, delta: text.substring(i, i + 80) });
            }
            writeSse(res, 'response.output_text.done', { type: 'response.output_text.done', output_index: outputIndex, content_index: 0, item_id: item.id, text });
            writeSse(res, 'response.content_part.done', { type: 'response.content_part.done', output_index: outputIndex, content_index: 0, item_id: item.id, part: item.content[0] });
            writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
            outputIndex++;
        }
        msg.tool_calls.forEach((tc) => {
            const item = { type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}', status: 'completed' };
            writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, arguments: '', status: 'in_progress' } });
            writeSse(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: outputIndex, item_id: item.id, delta: item.arguments });
            writeSse(res, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: outputIndex, item_id: item.id, arguments: item.arguments });
            writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
            outputIndex++;
        });
    } else {
        const text = msg.content || '';
        const item = { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } });
        writeSse(res, 'response.content_part.added', { type: 'response.content_part.added', output_index: outputIndex, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
        for (let i = 0; i < text.length; i += 80) {
            writeSse(res, 'response.output_text.delta', { type: 'response.output_text.delta', output_index: outputIndex, content_index: 0, item_id: item.id, delta: text.substring(i, i + 80) });
        }
        writeSse(res, 'response.output_text.done', { type: 'response.output_text.done', output_index: outputIndex, content_index: 0, item_id: item.id, text });
        writeSse(res, 'response.content_part.done', { type: 'response.content_part.done', output_index: outputIndex, content_index: 0, item_id: item.id, part: item.content[0] });
        writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
    }
    writeSse(res, 'response.completed', { type: 'response.completed', response });
    res.write('data: [DONE]\n\n');
    res.end();
}

// OpenAI-compatible streaming has no usage field on the terminal chunk, so a
// harness that only ever streams would otherwise see zero cost. Emitting the
// documented usage-only chunk (empty `choices`) keeps accounting native for
// streaming clients; those that ignore it are unaffected.
function sendOpenAIStream(res, openaiResp, includeUsage = true) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const id = openaiResp.id;
    const created = openaiResp.created;
    const model = openaiResp.model;
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    if (!hasToolCalls && msg.reasoning_content) {
        for (let i = 0; i < msg.reasoning_content.length; i += 50) {
            const chunk = msg.reasoning_content.substring(i, i + 50);
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }] })}\n\n`);
        }
    }
    // The model's preamble goes out as ordinary content before the call, so the
    // client renders the explanation and then runs the tool.
    const preamble = hasToolCalls ? (msg.content || '') : '';
    for (let i = 0; i < preamble.length; i += 50) {
        const chunk = preamble.substring(i, i + 50);
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
    }
    const done = () => {
        if (includeUsage && openaiResp.usage) {
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: openaiResp.usage })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
    };
    if (hasToolCalls) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: msg.tool_calls }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        done();
    } else {
        for (let i = 0; i < (msg.content || '').length; i += 50) {
            const chunk = msg.content.substring(i, i + 50);
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        done();
    }
    res.end();
}

function storeHistory(agentId, prompt, content, toolCall, toolCallPreamble = '') {
    const session = getOrCreateAgentSession(agentId);
    // The preamble is what the user saw, so the next turn must see it too —
    // otherwise the model forgets it already explained itself and repeats it.
    const preamble = typeof toolCallPreamble === 'string' && toolCallPreamble ? `${toolCallPreamble}\n\n` : '';
    const assistantResponse = toolCall
        ? `${preamble}TOOL_CALL: ${toolCall.name}\narguments: ${toolCall.arguments}`
        : content;
    // Save last 500 chars of the prompt for history context
    const shortPrompt = prompt.length > 500 ? '...' + prompt.substring(prompt.length - 500) : prompt;
    session.history.push({ user: shortPrompt, assistant: assistantResponse });
    while (session.history.length > MAX_HISTORY_LENGTH) session.history.shift();
    let historyChars = session.history.reduce((sum, e) => sum + e.user.length + e.assistant.length, 0);
    while (historyChars > MAX_HISTORY_CHARS && session.history.length > 1) {
        const removed = session.history.shift();
        historyChars -= removed.user.length + removed.assistant.length;
    }
    updateRollingSummary(session, prompt);
}

// Extract MEDIA: paths from tool results that contain screenshot paths
function extractScreenshotPaths(messages) {
    const paths = [];
    const fs = require('fs');
    for (const msg of messages) {
        if (msg.role === 'tool' && msg.content) {
            // Look for screenshot_path or path fields in JSON tool results
            // These come DIRECTLY from browser_vision — always the real path
            const pngMatch = msg.content.match(/["'](screenshot_path|path)["']\s*:\s*["']([^"']+\.(?:png|jpg|jpeg|webp|gif))["']/i);
            if (pngMatch) {
                const filePath = pngMatch[2];
                if (filePath.startsWith('/') && fs.existsSync(filePath)) {
                    paths.push(`MEDIA:${filePath}`);
                }
            }
            // Also catch plain MEDIA: tags
            const mediaMatch = msg.content.match(/MEDIA:(\S+)/g);
            if (mediaMatch) {
                for (const tag of mediaMatch) {
                    const extractedPath = tag.replace(/^MEDIA:/, '');
                    if (fs.existsSync(extractedPath) && !paths.includes(tag)) {
                        paths.push(tag);
                    }
                }
            }
        }
        // Check user/assistant messages for paths mentioned in conversation text
        // Only include if the file ACTUALLY EXISTS (DeepSeek hallucinates paths)
        if ((msg.role === 'user' || msg.role === 'assistant') && msg.content) {
            const content = typeof msg.content === 'string' ? msg.content : '';
            const pathRegex = /(\/[^\s<>"']+\.(?:png|jpg|jpeg|webp|gif))/gi;
            let match;
            while ((match = pathRegex.exec(content)) !== null) {
                const filePath = match[1];
                if (filePath.startsWith('/') && fs.existsSync(filePath) && !paths.includes(`MEDIA:${filePath}`)) {
                    paths.push(`MEDIA:${filePath}`);
                }
            }
        }
    }
    return paths;
}

const PROMPT_COMPACTION_MARKER = '\n\n[Earlier context compacted by FreeDeepseekAPI]\n\n';

function truncatePromptMiddle(text, maxChars, headRatio = 0.35) {
    const value = String(text || '');
    if (value.length <= maxChars) return value;
    if (maxChars <= 0) return '';
    if (maxChars <= PROMPT_COMPACTION_MARKER.length) return value.substring(value.length - maxChars);
    const payloadChars = maxChars - PROMPT_COMPACTION_MARKER.length;
    const headChars = Math.max(0, Math.min(payloadChars, Math.floor(payloadChars * headRatio)));
    const tailChars = payloadChars - headChars;
    return value.substring(0, headChars) + PROMPT_COMPACTION_MARKER + value.substring(value.length - tailChars);
}

function hasExplicitConversationHistory(messages) {
    const turns = (messages || []).filter(msg => msg && msg.role !== 'system');
    return turns.length > 1 || turns.some(msg => msg.role === 'assistant' || msg.role === 'tool');
}

function buildRecoveryHistoryPrefix(history, summary = '') {
    const hasHistory = Array.isArray(history) && history.length > 0;
    const summaryText = String(summary || '').trim();
    if (!hasHistory && !summaryText) return '';
    let prefix = '[Previous conversation]\n';
    if (summaryText) {
        prefix += `Session progress (tasks asked earlier in this session, oldest first):\n${summaryText}\n\n`;
    }
    if (hasHistory) {
        for (const exchange of history) {
            prefix += `User: ${String(exchange?.user || '')}\nAssistant: ${String(exchange?.assistant || '')}\n\n`;
        }
    }
    return prefix + '[Continue from here]\n\n';
}

// === Agent / conversation identity ===
// Harnesses without a per-conversation header (opencode sends none) collapse every
// project onto one key, so all of a user's chats end up interleaved in a single
// DeepSeek conversation. The harness does resend the whole transcript on every turn,
// and the first user message is the one part of it that never changes for the life
// of a chat: hashing it separates conversations without asking the client to
// cooperate. A key that does change — an explicit header, a compaction that rewrites
// the opening turn, a new chat — simply starts a new remote conversation, which is
// the correct behaviour for what is now a different conversation.
const AGENT_FINGERPRINT_CHARS = 4000;

function messageText(content) {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    try { return JSON.stringify(content); } catch (e) { return String(content); }
}

function conversationFingerprint(messages) {
    const turns = (Array.isArray(messages) ? messages : []).filter(m => m && m.role === 'user');
    const first = turns[0];
    if (!first) return '';
    const seed = messageText(first.content).slice(0, AGENT_FINGERPRINT_CHARS).trim();
    if (seed.length < 8) return '';
    return 'conv-' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

// Which header carries a conversation id. Configurable because harnesses disagree
// on the name; point this at whichever one the client actually sends.
const AGENT_HEADER_NAME = String(process.env.DEEPSEEK_AGENT_HEADER || 'x-agent-session').toLowerCase();
const AGENT_FINGERPRINT_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.DEEPSEEK_AGENT_FINGERPRINT ?? '1'));

function resolveAgentId({ headerValue, paramValue, remoteAddr, messages }) {
    const header = headerValue ? String(headerValue) : '';
    if (header) return { agentId: header, source: 'header' };
    const param = paramValue ? String(paramValue) : '';
    if (param) return { agentId: param, source: 'param' };
    const pinned = String(process.env.DEEPSEEK_AGENT_ID || '');
    if (pinned) return { agentId: pinned, source: 'env' };
    if (AGENT_FINGERPRINT_ENABLED) {
        const fingerprint = conversationFingerprint(messages);
        if (fingerprint) return { agentId: fingerprint, source: 'conversation' };
    }
    const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
    return { agentId: isLoopback ? 'dev-agent' : String(remoteAddr || 'unknown'), source: isLoopback ? 'loopback' : 'peer' };
}

// Added when compaction is severe enough that the task itself may be gone. Without
// it a model that receives a marker plus a wall of tool output tends to answer with
// a token or two ("ok") instead of admitting the context is insufficient.
const PROMPT_COMPACTION_NOTICE = '[CONTEXT NOTE] Earlier turns of this conversation were dropped to fit the upstream limit. Continue from the most recent messages below. If the current task is not clear from what remains, say exactly what you need instead of guessing.\n\n';

// The conversation is serialized as "User: …\n\nAssistant: …\n\n" blocks, so the
// last task the user asked for is the final "User: " segment. Truncation keeps the
// tail of the text, which after a long tool loop is all tool output — the request
// itself would be dropped, leaving the model nothing to act on. Only the request
// text is returned; everything the assistant and tools said after it is the noise
// that pushed the task out of the budget in the first place.
function extractLastUserTurn(conversation) {
    const value = String(conversation || '');
    const marker = '\nUser: ';
    const lastIndex = value.lastIndexOf(marker);
    const start = lastIndex === -1 ? (value.startsWith('User: ') ? 0 : -1) : lastIndex + 1;
    if (start === -1) return '';
    const segment = value.substring(start);
    const reply = segment.search(/\n+Assistant: /);
    return (reply === -1 ? segment : segment.substring(0, reply)).trim();
}

function buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const system = String(systemPrompt || '').trim();
    const history = String(historyPrefix || '');
    const conversation = String(conversationPrompt || '').trim();
    const original = system ? `${system}\n\n${history}${conversation}` : `${history}${conversation}`;
    const safeMax = Math.max(1, Math.floor(Number(maxChars) || MAX_UPSTREAM_PROMPT_CHARS));
    if (original.length <= safeMax) {
        return { prompt: original, compacted: false, historyDropped: false, originalChars: original.length, promptChars: original.length };
    }

    // Server-side history is only a recovery hint. Drop it before truncating
    // client-provided messages, which may already contain the same turns.
    const historyDropped = history.length > 0;
    const currentConversation = conversation;
    const separatorLength = system && currentConversation ? 2 : 0;
    let systemBudget = system ? Math.floor((safeMax - separatorLength) * 0.5) : 0;
    let conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);

    // Give unused capacity from a short side to the other side.
    if (system.length < systemBudget) {
        systemBudget = system.length;
        conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);
    } else if (currentConversation.length < conversationBudget) {
        conversationBudget = currentConversation.length;
        systemBudget = Math.max(0, safeMax - separatorLength - conversationBudget);
    }

    // Reserve room for the last user request and the context notice before
    // handing out the conversation budget, otherwise they could be squeezed out.
    const lastUserTurn = extractLastUserTurn(currentConversation);
    const needsTaskRescue = lastUserTurn.length > 0 && truncatePromptMiddle(currentConversation, conversationBudget, 0.25).indexOf(lastUserTurn.substring(0, 200)) === -1;
    if (needsTaskRescue) {
        const reserve = Math.min(lastUserTurn.length, Math.floor(safeMax * 0.4));
        conversationBudget = Math.max(0, conversationBudget - reserve - PROMPT_COMPACTION_NOTICE.length);
        systemBudget = Math.max(0, safeMax - separatorLength - conversationBudget);
    }

    // Preserve the start of the task/system instructions and the most recent
    // tool loop. The injected tool adapter lives at the end of systemPrompt.
    const boundedSystem = truncatePromptMiddle(system, systemBudget, 0.35);
    const boundedConversation = truncatePromptMiddle(currentConversation, conversationBudget, 0.25);
    const head = boundedSystem && boundedConversation
        ? `${boundedSystem}\n\n${boundedConversation}`
        : (boundedSystem || boundedConversation);

    // The rescue block is appended last and must never be the thing that gets cut,
    // so the compacted head absorbs the clamp instead.
    let rescueBlock = '';
    if (needsTaskRescue) {
        const reserve = Math.min(lastUserTurn.length, Math.floor(safeMax * 0.4));
        rescueBlock = `\n\n${PROMPT_COMPACTION_NOTICE}The task you were working on, preserved verbatim:\n${truncatePromptMiddle(lastUserTurn, reserve, 0.6)}`;
    }
    let bounded;
    if (rescueBlock && head.length + rescueBlock.length > safeMax) {
        if (rescueBlock.length >= safeMax) {
            bounded = rescueBlock.substring(rescueBlock.length - safeMax);
        } else {
            bounded = head.substring(0, safeMax - rescueBlock.length) + rescueBlock;
        }
    } else {
        bounded = head + rescueBlock;
    }
    if (bounded.length > safeMax) bounded = bounded.substring(0, safeMax);
    return {
        prompt: bounded,
        compacted: true,
        historyDropped,
        taskRescued: needsTaskRescue,
        originalChars: original.length,
        promptChars: bounded.length,
    };
}

// `treatShrinkAsCompaction` is false when the retry sends less than the failed
// prompt on purpose — a delta-only retry on a live chat is smaller because the
// chat already holds the earlier turns, not because context was dropped. Flagging
// that as compaction would make the client believe it lost context and resend it.
function buildRetryPrompt(systemPrompt, historyPrefix, conversationPrompt, currentPrompt, maxChars, treatShrinkAsCompaction = true) {
    const retryBuild = buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars);
    const current = String(currentPrompt || '');
    return {
        ...retryBuild,
        compacted: retryBuild.compacted || (treatShrinkAsCompaction && retryBuild.prompt.length < current.length),
        originalChars: retryBuild.originalChars,
        promptChars: retryBuild.prompt.length,
        previousPromptChars: current.length,
    };
}

// A retry is only worth an upstream call if it asks DeepSeek something new. The
// budget used to be a share of DEEPSEEK_MAX_PROMPT_CHARS, so whenever the failed
// prompt already fit inside that share the retry was byte-identical to the attempt
// that had just failed: three identical uploads per empty response, which is
// exactly what drives the account into "sending too often". Sizing the budget from
// the prompt that actually failed makes every retry a different, smaller request.
function buildRetryBudget(sourceChars, retryAttempt) {
    const current = Math.max(0, Math.floor(Number(sourceChars) || 0));
    if (current <= 0) return MAX_UPSTREAM_PROMPT_CHARS;
    const attempt = Math.max(1, Math.floor(Number(retryAttempt) || 1));
    // Shrinking only makes sense when size is what DeepSeek choked on. A prompt
    // this small is retried as-is: truncating it cannot fix an empty response and
    // only throws away task context the retry needs to succeed.
    if (current <= MIN_SHRINKABLE_PROMPT_CHARS) return current;
    const ratio = Math.max(0.4, 0.75 - (attempt - 1) * 0.2);
    const floor = Math.max(MIN_SHRINKABLE_PROMPT_CHARS, Math.floor(current * 0.2));
    return Math.max(floor, Math.min(MAX_UPSTREAM_PROMPT_CHARS, Math.floor(current * ratio)));
}

// The exact length buildBoundedPrompt computes for a triple (server.js:2296). A
// retry budget has to be derived from this and not from the conversation slice:
// the injected tool definitions are usually the bulk of the prompt, and budgeting
// against the conversation alone handed a 26k prompt a 2k budget, which cut the
// tool definitions out of the retry and made every retry fail for a new reason.
function assembledPromptLength(systemPrompt, historyPrefix, conversationPrompt) {
    const system = String(systemPrompt || '').trim();
    const history = String(historyPrefix || '');
    const conversation = String(conversationPrompt || '').trim();
    return (system ? system.length + 2 : 0) + history.length + conversation.length;
}

// DeepSeek rejects a throttled turn with HTTP 200 and a stream that carries no
// response object at all — no fragments, no message id, no error event. Reported
// as the rate limit it is, so the account is cooled down on the first offence
// instead of the third.
function isSilentUpstreamRejection(result) {
    if (!result) return false;
    if (result.messageId) return false;
    if (result.modelError) return false;
    const content = String(result.content || '').trim();
    const reasoning = String(result.reasoningContent || '').trim();
    return content.length === 0 && reasoning.length === 0;
}

// An empty stream with no message id is not one event but two, and they need
// opposite handling — the old code treated both as a throttle and never retried,
// so an aborted generation surfaced to the client as a 429 it had to handle.
// Elapsed time separates them, because it is the one signal that says whether
// DeepSeek ever started generating: a refusal lands in about a second, while a
// generation that was aborted mid-flight had already been working for seconds.
//   throttle — refused up front. Retrying immediately repeats the burst, so the
//              cooldown has to be served first.
//   aborted  — started and then dropped. Ordinary empty response, so it goes
//              through the normal retry-on-the-same-session path.
const SILENT_REJECTION_MIN_GENERATION_MS = 2500;

function classifySilentUpstreamRejection(result, elapsedMs) {
    if (!isSilentUpstreamRejection(result)) return null;
    return Number(elapsedMs) >= SILENT_REJECTION_MIN_GENERATION_MS ? 'aborted' : 'throttle';
}

function appendPromptInstruction(promptText, instruction, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const suffix = `\n\n${String(instruction || '').trim()}`;
    const baseBudget = Math.max(0, maxChars - suffix.length);
    return truncatePromptMiddle(promptText, baseBudget, 0.35) + suffix;
}

function isContinuationRecoverySafe(previousAccountId, continuationCall) {
    const nextAccountId = continuationCall?.account?.id;
    return !previousAccountId
        || !nextAccountId
        || nextAccountId === previousAccountId
        || continuationCall?.freshSessionReset === true;
}

function isContextTooLongError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`;
    return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|maximum.{0,30}(?:context|token)|too\s+many\s+tokens|содержани[ея]\s+слишком\s+длин|контекст.{0,30}(?:длин|лимит)|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)/i.test(message);
}

// An invalid, expired or foreign chat id comes back as a plain error string on
// the completion call ("chat session not found", "invalid chat id", an HTTP 400
// with a session message). It is recoverable by recreating the remote chat and
// resending the full transcript, so it must not surface to the client as a hard
// failure — that is what broke long dialogs and cancelled requests.
function isChatIdError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`;
    return /chat[\s_-]?(?:session|id|chat)|会话|对话|会话不存在|聊天|invalid\s+chat|session\s+not\s+found|session\s+expired|not\s+found|does\s+not\s+exist|不存在|已过期|无效|无效的?会话/i.test(message)
        && /(?:not\s+found|invalid|expired|不存在|已过期|无效|会话|chat|session)/i.test(message);
}

// DeepSeek reports "sending too often" as an error fragment inside an HTTP 200
// stream rather than a 429, so the text has to be recognised explicitly.
// Without this the account is never cooled down and the chat is reset on sight.
function isRateLimitMessage(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`;
    return /too\s+(?:many|often|frequent|soon)|rate[\s_-]?limit|request\s+limit|请求过于频繁|请求太频繁|操作过于频繁|过于频繁|稍后再试|请稍后|слишком\s+(?:част|много)|слишком\s+часто|слишком\s+часто\s+повтор/i.test(message);
}

// Cool an account down after a stream-level rate-limit notice, escalating while
// the abuse repeats so a single unlucky burst does not park the account for the
// full cooldown. Returns the cooldown in whole seconds for Retry-After.
function markRateLimited(account, reason = 'stream rate limit', { explicit = true } = {}) {
    if (!account) return Math.max(1, Math.ceil(DEFAULT_ACCOUNT_COOLDOWN_MS / 1000));
    account.failures++;
    // An inferred throttle is a guess, so it only holds the account briefly and
    // leaves rateLimitStreak alone. Escalating on a guess is what turned a single
    // empty upstream stream into a 5-minute block, then a 10-minute one.
    if (!explicit) {
        account.cooldownUntil = Date.now() + INFERRED_THROTTLE_COOLDOWN_MS;
        console.log(`[account:${account.id}] suspected throttle (${reason}); brief cooldown ${Math.round(INFERRED_THROTTLE_COOLDOWN_MS / 1000)}s (streak ${account.rateLimitStreak || 0} unchanged)`);
        return Math.max(1, Math.ceil(INFERRED_THROTTLE_COOLDOWN_MS / 1000));
    }
    account.rateLimitStreak = (account.rateLimitStreak || 0) + 1;
    const cooldownMs = Math.min(DEFAULT_ACCOUNT_COOLDOWN_MS, RATE_LIMIT_COOLDOWN_MS * Math.pow(2, account.rateLimitStreak - 1));
    account.cooldownUntil = Date.now() + cooldownMs;
    console.log(`[account:${account.id}] stream rate limit (${reason}); cooldown ${Math.round(cooldownMs / 1000)}s (streak ${account.rateLimitStreak})`);
    return Math.max(1, Math.ceil(cooldownMs / 1000));
}

// Only a turn that actually produced content counts as proof of health. Called
// once the stream carried a real answer, never on the HTTP 200 that opened it,
// so a run of stream-level rate limits keeps escalating to the cap.
function markAccountHealthy(account) {
    if (!account) return;
    if (account.rateLimitStreak || account.failures) {
        account.rateLimitStreak = 0;
        account.failures = 0;
    }
}

function normalizeRetryResponse(result) {
    return {
        content: result?.content ? sanitizeContent(result.content) : '',
        reasoningContent: result?.reasoningContent ? sanitizeContent(result.reasoningContent) : '',
        finishReason: result?.finishReason ?? null,
        modelError: result?.modelError || null,
    };
}

function classifyRecoveryFailure(modelError, timedOut = false) {
    if (isRateLimitMessage(modelError)) return { status: 429, type: 'rate_limit_error' };
    if (isContextTooLongError(modelError)) return { status: 400, type: 'context_length_exceeded' };
    if (timedOut) return { status: 504, type: 'request_timeout' };
    return { status: 502, type: modelError?.type || 'empty_response' };
}

function isTimeoutError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name === 'TimeoutError' || name === 'AbortError' || /(?:timed?\s*out|timeout)/i.test(message);
}

// Serialize an assistant turn the same way storeHistory persists it, so a
// client-echoed assistant message can be compared against our last reply.
function serializeAssistantTurn(msg) {
    if (!msg || msg.role !== 'assistant') return null;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
        return msg.tool_calls
            .map(tc => `TOOL_CALL: ${tc?.function?.name || ''}\narguments: ${tc?.function?.arguments || ''}`)
            .join('\n');
    }
    return msg.content ? normalizeMessageContent(msg.content) : null;
}

// A live remote chat already holds the conversation, so only the new tail is
// sent. Replaying the whole transcript on every turn grows the remote context
// quadratically — that is what used to kill long-lived chats after ~17-34
// messages. Returns null whenever our view of the chain cannot be proven, and
// the caller falls back to the full transcript.
function selectDeltaMessages(messages, session) {
    if (!session || !session.id) return null;
    const lastEntry = session.history[session.history.length - 1];
    const expected = lastEntry && lastEntry.assistant ? String(lastEntry.assistant).trim() : '';
    if (!expected) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const serialized = serializeAssistantTurn(messages[i]);
        if (!serialized) continue;
        if (serialized.trim() !== expected) return null;  // diverged chain
        const tail = messages.slice(i + 1);
        const hasNewInput = tail.some(m => m && (m.role === 'user' || m.role === 'tool'));
        return hasNewInput ? tail : null;
    }
    return null;
}

function formatMessages(messages, tools, options = {}) {
    let systemPrompt = '';
    for (const msg of messages) {
        if (msg.role === 'system' && msg.content) {
            systemPrompt += normalizeMessageContent(msg.content) + '\n';
        }
    }
    systemPrompt += formatToolDefinitions(tools, options);

    // Build full conversation history for DeepSeek's context
    let conversation = '';
    for (const msg of messages) {
        if (msg.role === 'system') continue;  // already in systemPrompt
        if (msg.role === 'user' && msg.content) {
            conversation += `User: ${normalizeMessageContent(msg.content)}\n\n`;
        } else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                // This was a tool call response from a previous turn
                for (const tc of msg.tool_calls) {
                    conversation += `Assistant: TOOL_CALL: ${tc.function.name}\narguments: ${tc.function.arguments}\n\n`;
                }
            } else if (msg.content) {
                conversation += `Assistant: ${normalizeMessageContent(msg.content)}\n\n`;
            }
        } else if (msg.role === 'tool' && msg.content) {
            // Tool execution result — send back to DeepSeek as context
            const toolContent = normalizeMessageContent(msg.content);
            // Do not impose a second, per-result 8k limit: one large tool result
            // may be the essential input. buildBoundedPrompt applies the single
            // global request cap while preserving the latest conversation tail.
            conversation += `[Tool Result]\n${toolContent}\n\n`;
        }
    }
    // The last user message + full conversation context
    return { prompt: conversation.trim(), systemPrompt: systemPrompt.trim() };
}

// === Session state block + rolling summary ===
// Both features read the client transcript, which arrives complete on every
// turn, so nothing has to be stored upstream to reconstruct them.
const TODO_CHECKBOX_RE = /^\s*[-*]\s*\[([ xX~>])\]\s+(\S.*)$/;

function stringifyTodoValue(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
        return value.content || value.text || value.task || value.title || value.description || value.subject || '';
    }
    return '';
}

// Normalise one parsed todo entry (opencode's todowrite shape, or a loose
// {content, status} pair) into a checkbox line. Returns null when the object
// does not look like a todo at all, so unrelated JSON is never mistaken for one.
function formatTodoEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const text = String(stringifyTodoValue(entry)).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const status = String(entry.status || entry.state || '').toLowerCase();
    const done = status === 'completed' || status === 'complete' || status === 'done' || status === 'x'
        || entry.done === true || entry.completed === true;
    const active = status === 'in_progress' || status === 'active' || status === 'doing' || status === 'running';
    const box = done ? 'x' : (active ? '>' : ' ');
    return `- [${box}] ${text}`;
}

// Parse a JSON string that is either a todo array or an object wrapping one under
// `todos`. Returns checkbox lines, or null when it is not a todo container.
function parseTodoContainer(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return null;
    }
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.todos) ? parsed.todos : null);
    if (!list || list.length === 0) return null;
    const formatted = list.map(formatTodoEntry).filter(Boolean);
    return formatted.length > 0 ? formatted : null;
}

function extractTodosFromMessages(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg || typeof msg.content !== 'string') continue;
        if (msg.role !== 'tool' && msg.role !== 'assistant') continue;
        const text = msg.content.trim();
        if (!text) continue;
        const direct = parseTodoContainer(text);
        if (direct) return direct.slice(0, TODO_MAX_ITEMS);
        for (const candidate of extractBalancedJsonObjects(text, 8)) {
            const parsed = parseTodoContainer(candidate);
            if (parsed) return parsed.slice(0, TODO_MAX_ITEMS);
        }
    }
    return [];
}

// Prefer a structured todo list; fall back to markdown checkboxes in the newest
// message that carries any. Always from the tail so an old completed list cannot
// shadow the current one.
function extractTodoLines(messages, limit = TODO_MAX_ITEMS) {
    const structured = extractTodosFromMessages(messages);
    if (structured.length > 0) return structured.slice(0, limit);
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg || typeof msg.content !== 'string') continue;
        const lines = [];
        for (const raw of msg.content.split('\n')) {
            const m = TODO_CHECKBOX_RE.exec(raw);
            if (m) lines.push(`- [${/[xX]/.test(m[1]) ? 'x' : (/[~>]/.test(m[1]) ? '>' : ' ')}] ${m[2].trim()}`);
        }
        if (lines.length > 0) return lines.slice(0, limit);
    }
    return [];
}

// The session's accumulated "what happened" text: the LLM handover summary when
// we have one, plus the rolling user-task digest. Kept in separate fields so the
// digest (updated every turn) never overwrites the handover summary.
function sessionProgressText(session) {
    const handover = session && typeof session.handover === 'string' ? session.handover.trim() : '';
    const digest = session && typeof session.summary === 'string' ? session.summary.trim() : '';
    return [handover, digest].filter(Boolean).join('\n\n');
}

// A compact anchor prepended to a delta: the plan (todos) plus the tail of the
// rolling progress digest. Returns '' when the transcript has neither, so
// clients without todos pay nothing for the feature.
function buildSessionStateBlock(messages, session) {
    if (!STATE_BLOCK_ENABLED) return '';
    const todos = extractTodoLines(messages || []);
    const summary = sessionProgressText(session);
    if (todos.length === 0 && !summary) return '';
    let block = '[SESSION STATE]\nEarlier turns, full instructions and tool schemas are already above in this chat.\n';
    if (summary) {
        const tail = summary.length > STATE_BLOCK_MAX_SUMMARY_CHARS
            ? '...' + summary.slice(summary.length - STATE_BLOCK_MAX_SUMMARY_CHARS)
            : summary;
        block += `Progress so far:\n${tail}\n`;
    }
    if (todos.length > 0) block += `Todo:\n${todos.join('\n')}\n`;
    block += '[END SESSION STATE]';
    return block;
}

// The last "User: ..." task in a serialized conversation, collapsed to one line.
function extractTaskLine(conversation, maxChars = 200) {
    const segment = extractLastUserTurn(conversation).replace(/^User:\s*/, '').replace(/\s+/g, ' ').trim();
    if (!segment) return '';
    return segment.length > maxChars ? segment.slice(0, maxChars - 3) + '...' : segment;
}

// Accumulate a bounded digest of the tasks asked in this session. It is replayed
// as recovery history when the remote chat is recreated, so a reset no longer
// drops everything before the last few exchanges.
function updateRollingSummary(session, conversation) {
    if (!ROLLING_SUMMARY_ENABLED || !session) return;
    const task = extractTaskLine(conversation);
    if (!task) return;
    if (!Array.isArray(session.summaryLines)) session.summaryLines = [];
    if (session.summaryLines[session.summaryLines.length - 1] === task) return;
    session.summaryLines.push(task);
    while (session.summaryLines.length > ROLLING_SUMMARY_MAX_TASKS) session.summaryLines.shift();
    let text = session.summaryLines.join('\n');
    while (text.length > ROLLING_SUMMARY_CHARS && session.summaryLines.length > 1) {
        session.summaryLines.shift();
        text = session.summaryLines.join('\n');
    }
    session.summary = text;
}

// === HTTP Server ===
const server = http.createServer(async (req, res) => {
    const requestOrigin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (!isBrowserOriginAllowed(requestOrigin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Browser origin is not allowed', type: 'cors_error' } }));
        return;
    }
    if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', normalizeOrigin(requestOrigin));
    setCorsResponseHeaders(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isPublicProbe = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/readyz');
    if (!isPublicProbe && !isProxyAuthorized(req.headers.authorization)) {
        res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ error: { message: 'Invalid or missing proxy API key', type: 'authentication_error' } }));
        return;
    }

    // Health check
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        const includePrivateStatus = !PROXY_API_KEY || isProxyAuthorized(req.headers.authorization);
        const health = { status: 'ok', service: 'FreeDeepseekAPI', watermark: FORGETMEAI_WATERMARK };
        if (includePrivateStatus) Object.assign(health, {
            models: SUPPORTED_MODEL_IDS,
            unsupported_models: Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported),
            agents: sessions.size,
            in_flight: inFlight,
            accounts: accounts.map(accountStatus),
            config_ready: hasAuthConfig(),
            session_reuse: { strategy: `sticky per ${AGENT_HEADER_NAME}/user, else per-conversation fingerprint`, ttl_minutes: Math.round(SESSION_TTL_MS / 60000), max_messages: MAX_MESSAGE_DEPTH, reset_all: 'POST /reset-session?agent=all' },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
        return;
    }

    // Readiness probe (distinct from the liveness check above): 503 unless at least
    // one account can serve right now, so an aggregator/LB won't route to a cold pool.
    if (req.method === 'GET' && url.pathname === '/readyz') {
        const now = Date.now();
        const ready = accounts.filter(a => a.config.token && a.config.cookie && a.cooldownUntil <= now).length;
        res.writeHead(ready > 0 ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: ready > 0, ready_accounts: ready, total_accounts: accounts.length }));
        return;
    }

    // Models: OpenAI-compatible list exposes only aliases verified to work through this proxy.
    if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: SUPPORTED_MODEL_IDS.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'deepseek-web', real_model: MODEL_CONFIGS[id].real_model, capabilities: MODEL_CONFIGS[id].capabilities })) }));
        return;
    }

    // Full mapping, including Web models observed but not currently usable through the direct API.
    if (req.method === 'GET' && (url.pathname === '/v1/model-capabilities' || url.pathname === '/api/model-capabilities')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'model_capabilities', watermark: FORGETMEAI_WATERMARK, data: ALL_MODEL_CAPABILITIES }));
        return;
    }

    // Sessions status
    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        const agentList = [];
        for (const [agentId, session] of sessions) {
            agentList.push({
                agent: agentId,
                session_id: session.id,
                message_count: session.messageCount,
                account: session.accountId,
                history_size: session.history.length,
                age_min: session.createdAt ? Math.round((Date.now() - session.createdAt) / 60000) : 0,
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: agentList, total: agentList.length }));
        return;
    }

    // Reset session for a specific agent (or all if no agent specified)
    if (req.method === 'POST' && url.pathname === '/reset-session') {
        const agentId = url.searchParams.get('agent') || 'default';
        if (agentId === 'all') {
            const count = sessions.size;
            sessions.clear();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'all_sessions_cleared', count }));
            return;
        }
        const session = sessions.get(agentId);
        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `No session for agent: ${agentId}` }));
            return;
        }
        const historyCount = session.history.length;
        const historyPreview = session.history.map(e => e.user.substring(0, 40)).join(' | ');
        session.id = null;
        session.parentMessageId = null;
        session.createdAt = null;
        session.messageCount = 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'session_reset', agent: agentId, history_preserved: historyCount, history: historyPreview }));
        return;
    }

    const apiMode = url.pathname === '/v1/messages'
        ? 'anthropic'
        : (url.pathname === '/v1/responses' ? 'responses' : 'openai');
    const acceptedPostPaths = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
    if (req.method !== 'POST' || !acceptedPostPaths.includes(url.pathname)) {
        res.writeHead(404); res.end('Not found'); return;
    }

    // Backpressure: reject rather than fan out unbounded concurrent upstream work.
    if (inFlight >= MAX_CONCURRENT) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
        res.end(JSON.stringify({ error: { message: `Server busy (${inFlight}/${MAX_CONCURRENT} requests in flight). Retry shortly.`, type: 'overloaded' } }));
        return;
    }

    let body = '';
    let bodyTooLarge = false;
    const MAX_BODY_BYTES = 10 * 1024 * 1024;  // chat payloads are small; cap memory before JSON.parse
    req.on('data', chunk => { body += chunk; if (body.length > MAX_BODY_BYTES) { bodyTooLarge = true; req.destroy(); } });
    req.on('end', async () => {
        if (bodyTooLarge) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Request body too large', type: 'payload_too_large' } }));
            return;
        }
        inFlight++;
        let clientGone = false;
        res.on('close', () => { clientGone = true; });
        const requestStartedAt = Date.now();
        const deadlineHit = () => Date.now() - requestStartedAt > REQUEST_DEADLINE_MS;
        let activeSession = null;
        let activeAgentId = null;
        let releaseAgentLock = null;
        try {
            const rawParams = JSON.parse(body || '{}');
            const params = normalizeApiParams(rawParams, apiMode);
            const messages = params.messages || [];
            const tools = params.tools || [];
            const stream = params.stream === true;
            const requestedModel = String(params.model || 'deepseek-chat').toLowerCase();
            if (!isKnownModel(requestedModel)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Unknown model: ${requestedModel}`, type: 'invalid_model', supported_models: SUPPORTED_MODEL_IDS, model_capabilities_url: '/v1/model-capabilities' } }));
                return;
            }
            if (!isSupportedModel(requestedModel)) {
                const cfg = resolveModelConfig(requestedModel);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `${requestedModel} is not currently supported through this DeepSeek Web API path`, type: 'unsupported_model', model: requestedModel, real_model: cfg.real_model, reason: cfg.unavailable_reason, capabilities: cfg.capabilities, supported_models: SUPPORTED_MODEL_IDS } }));
                return;
            }
            // Resolve which conversation this turn belongs to. Without a real id
            // every local client shares one DeepSeek chat, so a fingerprint of the
            // opening user message is used instead of collapsing them all together.
            const remoteAddr = req.socket.remoteAddress || 'unknown';
            const requestedSession = req.headers[AGENT_HEADER_NAME] || params.session || params.user;
            // Harnesses differ in what they identify a conversation with. Log what
            // actually arrives so session isolation can be keyed on a real header
            // instead of guessing, and so one local client does not silently
            // collapse every project into a single remote chat.
            if (/^(1|true|yes|on)$/i.test(String(process.env.DEEPSEEK_DEBUG_SESSION || ''))) {
                const identity = Object.keys(req.headers)
                    .filter(h => /session|conversation|chat|user|agent|thread/i.test(h))
                    .map(h => `${h}=${JSON.stringify(String(req.headers[h]).slice(0, 60))}`);
                console.log(`[session-debug] identity headers: ${identity.length ? identity.join(' ') : '(none — falling back to conversation fingerprint)'}`);
            }
            const { agentId, source: agentIdSource } = resolveAgentId({
                headerValue: req.headers[AGENT_HEADER_NAME],
                paramValue: params.session || params.user,
                remoteAddr,
                messages,
            });
            if (agentIdSource === 'conversation' && !announcedConversations.has(agentId)) {
                announcedConversations.set(agentId, Date.now());
                console.log(`[${agentId}] new conversation detected (fingerprint of the opening message); it gets its own DeepSeek chat. Send ${AGENT_HEADER_NAME}: <name> to name it yourself.`);
            }
            const agentTag = `[${agentId}]`;
            activeAgentId = agentId;

            // "/new" command: if the latest user message is exactly "/new" (whitespace-insensitive),
            // reset this agent's DeepSeek session/history instead of forwarding anything to DeepSeek.
            const lastUserMessage = [...messages].reverse().find(m => m && m.role === 'user');
            const lastUserText = lastUserMessage && typeof lastUserMessage.content === 'string'
                ? lastUserMessage.content.trim()
                : '';
            if (lastUserText === '/new') {
                const existing = sessions.get(agentId);
                const historyCount = existing ? existing.history.length : 0;
                sessions.set(agentId, createSession());
                console.log(`${agentTag} /new received — session reset (history cleared: ${historyCount})`);
                const confirmation = buildTextResponse('Started a new chat. Session and history have been reset.', '/new', requestedModel);
                if (stream) {
                    if (apiMode === 'anthropic') {
                        sendAnthropicStream(res, confirmation);
                    } else if (apiMode === 'responses') {
                        sendResponsesStream(res, confirmation);
                    } else {
                        sendOpenAIStream(res, confirmation);
                    }
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    if (apiMode === 'anthropic') {
                        res.end(JSON.stringify(toAnthropicResponse(confirmation)));
                    } else if (apiMode === 'responses') {
                        res.end(JSON.stringify(toResponsesResponse(confirmation)));
                    } else {
                        res.end(JSON.stringify(confirmation));
                    }
                }
                return;
            }

            // For usage accounting, count the CLIENT's original input — not the
            // proxy-expanded fullPrompt (system + injected tools + history) — so
            // prompt_tokens reflects what the caller actually sent.
            const clientPromptText = messages.map(m => normalizeMessageContent(m.content)).join('\n');

            const session = getOrCreateAgentSession(agentId);
            activeSession = session;

            // One turn at a time per conversation, held until the local history is
            // written: a concurrent request for the same chat would otherwise
            // continue from a parent id this turn is about to move past.
            const agentLock = await acquireAgentTurnLock(agentId, REQUEST_DEADLINE_MS - (Date.now() - requestStartedAt));
            releaseAgentLock = agentLock.release;
            if (agentLock.queueWaitMs > 1000) {
                console.log(`${agentTag} waited ${Math.round(agentLock.queueWaitMs / 1000)}s for the previous turn of this conversation to finish`);
            }
            // The session object itself is stable (resets mutate it in place), but an
            // earlier queued turn may have moved the remote chat while this request
            // waited, so everything below reads it only after the lock is held.
            session.lastActivityAt = Date.now();

            // Before a proxy-driven reset drops the remote context, take the chance
            // to distill the work into a real handover summary. It is generated on an
            // isolated chat, so it cannot desync this conversation; on any failure the
            // rolling digest is kept instead.
            const rolloverReason = sessionRolloverReason(session);
            if (rolloverReason && LLM_SUMMARY_ENABLED && messages.length > 1) {
                const transcript = formatMessages(messages, []).prompt;
                try {
                    const summary = await summarizeConversation(agentId, requestedModel, transcript);
                    if (summary) {
                        session.handover = summary;
                        console.log(`${agentTag} Handover summary generated for ${rolloverReason} reset (${summary.length} chars).`);
                    } else {
                        console.log(`${agentTag} Handover summary came back empty; keeping the task digest.`);
                    }
                } catch (e) {
                    console.log(`${agentTag} Handover summary failed (${e.message}); keeping the task digest.`);
                }
            }

            // Roll over TTL/depth-limited sessions before deciding whether to
            // inject local recovery history into the newly built prompt.
            const promptRollover = prepareSessionForPrompt(session);
            if (promptRollover) {
                console.log(`${agentTag} Session ${promptRollover.failedSessionId} reset before prompt build (${promptRollover.reason}); recovery history preserved.`);
            }

            // Send only the new tail when the remote chat is provably in sync;
            // otherwise fall back to the whole transcript. The recovery path keeps
            // using the full transcript so a recreated chat never loses context.
            const deltaMessages = selectDeltaMessages(messages, session);
            const useDelta = Boolean(deltaMessages);
            const { prompt, systemPrompt } = formatMessages(deltaMessages || messages, tools, {
                compact: COMPACT_TOOL_REMINDER && useDelta,
            });
            // A recreated chat has no memory of the schemas, so every recovery path
            // must fall back to the full tool definitions, never the compact reminder.
            const fullFormat = deltaMessages ? formatMessages(messages, tools) : null;
            const recoveryPromptSource = fullFormat ? fullFormat.prompt : prompt;
            const recoverySystemPrompt = fullFormat ? fullFormat.systemPrompt : systemPrompt;
            if (deltaMessages) {
                console.log(`${agentTag} Delta prompt: ${deltaMessages.length} new message(s) instead of ${messages.length} (remote session ${session.id})${COMPACT_TOOL_REMINDER ? ', compact tool reminder' : ''}.`);
            }

            // The state block (plan + progress) rides in front of a delta only.
            let livePrompt = prompt;
            if (useDelta) {
                const stateBlock = buildSessionStateBlock(messages, session);
                if (stateBlock) livePrompt = `${stateBlock}\n\n${prompt}`;
            }

            // Keep a recovery prompt available even while the upstream session
            // is healthy. If that remote chat expires mid-request, its opaque
            // state disappears and the replacement must receive local history.
            const recoveryHistoryPrefix = hasExplicitConversationHistory(messages)
                ? ''
                : buildRecoveryHistoryPrefix(session.history, sessionProgressText(session));
            const historyPrefix = !session.id ? recoveryHistoryPrefix : '';

            // A recreated chat that already has a conversation behind it is not a
            // brand-new one, so it may seed far more context than the tiny fresh cap.
            // Only a genuinely first-ever turn gets FRESH_SESSION_PROMPT_CHARS.
            const conversationHasHistory = session.history.length > 0 || Boolean(session.summary) || Boolean(session.handover) || useDelta;
            const recoverySeedBudget = selectSeedBudget(conversationHasHistory);
            const livePromptBudget = session.id ? MAX_UPSTREAM_PROMPT_CHARS : recoverySeedBudget;
            const promptBuild = buildBoundedPrompt(systemPrompt, historyPrefix, livePrompt, livePromptBudget);
            const freshPromptBuild = buildBoundedPrompt(recoverySystemPrompt, recoveryHistoryPrefix, recoveryPromptSource, recoverySeedBudget);
            let fullPrompt = promptBuild.prompt;
            let promptCompacted = promptBuild.compacted;
            if (promptBuild.compacted) {
                markContextCompacted(res);
                console.log(`${agentTag} Compacted upstream prompt ${promptBuild.originalChars} -> ${promptBuild.promptChars} chars${promptBuild.historyDropped ? ' (recovery history dropped)' : ''}${session.id ? '' : ` (seed budget ${livePromptBudget})`}`);
            } else if (!session.id) {
                console.log(`${agentTag} Recovery seed ${fullPrompt.length} chars (budget ${livePromptBudget}${conversationHasHistory ? ', rollover' : ', fresh'}).`);
            }

            const startTime = Date.now();
            const initialCall = await askDeepSeekStream(fullPrompt, agentId, requestedModel, freshPromptBuild.prompt);
            const dsResp = initialCall.resp;
            if (initialCall.promptUsed !== fullPrompt) {
                fullPrompt = initialCall.promptUsed;
                if (freshPromptBuild.compacted) {
                    promptCompacted = true;
                    markContextCompacted(res);
                }
            }

            // Process streaming response from DeepSeek — returns { content, reasoningContent, messageId, finishReason }
            async function readDeepSeekResponse(readable) {
                const acc = createDeepSeekStreamAccumulator();
                const debugStream = /^(1|true|yes|on)$/i.test(String(process.env.DEEPSEEK_DEBUG_STREAM || ''));
                const debugPaths = debugStream ? new Set() : null;
                const debugNumerics = debugStream ? new Set() : null;
                const debugRaw = [];
                const scanDebugNumerics = (obj, prefix, depth) => {
                    if (!obj || typeof obj !== 'object' || depth > 4) return;
                    for (const [key, value] of Object.entries(obj)) {
                        if (typeof value === 'number') {
                            if (/token|usage|cost|quota|credit/i.test(key)) debugNumerics.add(`${prefix}${key}=${value}`);
                        } else if (value && typeof value === 'object') {
                            scanDebugNumerics(value, `${prefix}${key}.`, depth + 1);
                        }
                    }
                };
                const recordDebugLine = (line) => {
                    if (debugRaw.length < 5000) debugRaw.push(line);
                    if (!debugStream) return;
                    let d;
                    try { d = JSON.parse(line.slice(6)); } catch (e) { return; }
                    if (!d || typeof d !== 'object') return;
                    for (const key of Object.keys(d)) debugPaths.add(key);
                    if (d.p) debugPaths.add(`p=${d.p}`);
                    if (d.v && typeof d.v === 'object' && !Array.isArray(d.v)) {
                        for (const key of Object.keys(d.v)) debugPaths.add(`v.${key}`);
                    }
                    scanDebugNumerics(d, '', 0);
                };
                const handleLine = (line) => {
                    if (!line || !line.startsWith('data: ')) return;
                    recordDebugLine(line);
                    acc.handleLine(line);
                };
                // The raw stream is kept in memory even when debug mode is off, because
                // a 0-char answer with a message id means DeepSeek generated something the
                // parser did not extract — exactly the case where the protocol changed and
                // the dump is the only evidence. Dumping automatically on that case stops
                // the guess loop; there is no cost on healthy traffic.
                const finishDebugStream = (result) => {
                    const suspiciousEmpty = !!(result && result.messageId && !result.content && !result.reasoningContent);
                    if (!debugStream && !suspiciousEmpty) return;
                    try {
                        const suffix = suspiciousEmpty && !debugStream ? '_EMPTY' : '';
                        const file = path.join(os.tmpdir(), `deepseek_stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${suffix}.jsonl`);
                        fs.writeFileSync(file, debugRaw.join('\n'));
                        if (suspiciousEmpty) {
                            console.log(`[stream-debug] EMPTY ANSWER but message id present — protocol mismatch suspected. Raw stream: ${file}`);
                            return;
                        }
                        console.log(`[stream-debug] keys/paths: ${[...debugPaths].sort().join(' ')}`);
                        console.log(`[stream-debug] numeric usage fields: ${debugNumerics.size ? [...debugNumerics].sort().join(' ') : '(none)'}`);
                        console.log(`[stream-debug] raw stream: ${file}`);
                    } catch (e) {
                        console.log(`[stream-debug] could not save raw stream: ${e.message}`);
                    }
                };

                await readDeepSeekSseLines(readable, handleLine);

                const result = acc.result();
                if (result.messageId) {
                    session.parentMessageId = result.messageId;
                    session.messageCount++;
                } else {
                    console.log(`${agentTag} WARNING: could not extract message_id`);
                }

                finishDebugStream(result);
                return result;
            }

            const initialResult = await readDeepSeekResponse(dsResp.body);
            let { content: fullContent, reasoningContent, finishReason, modelError, upstreamTokens } = initialResult;
            fullContent = sanitizeContent(fullContent);
            reasoningContent = sanitizeContent(reasoningContent || '');
            const elapsed = Date.now() - startTime;
            console.log(`${agentTag} Got ${fullContent.length} chars (+${reasoningContent.length} reasoning chars) in ${elapsed}ms (msg#${session.messageCount})`);

            // Empty/context-overflow recovery. The first retry reuses the live
            // remote session with a smaller prompt — an empty response is usually
            // a transient upstream hiccup, not a dead chat. Only a second empty
            // response justifies throwing the chat away.
            //
            // A stream with no message id is split by elapsed time: refused before
            // any generation means a throttle, died after seconds of work means an
            // aborted generation that is retryable like any other empty response.
            const rejectionCause = classifySilentUpstreamRejection(initialResult, elapsed);
            let silentRejection = rejectionCause === 'throttle';
            if (rejectionCause) {
                console.log(
                    `${agentTag} empty stream with no message id in ${elapsed}ms — ${rejectionCause === 'throttle' ? 'refused before generating (throttle)' : 'generation aborted mid-flight (retryable)'}`,
                );
            }
            // Retry payloads are the delta tail on a live chat and the whole transcript on
            // a recreated one, but both are sent together with the injected tool
            // definitions, so the budget is measured over the assembled prompt.
            let retryAttempt = 0;
            let throttleWaits = 0;
            let keptSessionForRetry = false;
            let contextEmergencyTried = false;
            while (!fullContent || fullContent.trim().length === 0) {
                // Stop early if the client hung up or we've blown the request budget —
                // no point burning more PoW solves + account quota for a dead socket.
                if (clientGone) { console.log(`${agentTag} client disconnected; abandoning empty-retry loop`); return; }
                if (deadlineHit()) { console.log(`${agentTag} request deadline hit; stopping empty-retry loop`); break; }
                // A throttled turn is served its cooldown here and then retried once in
                // place, so a transient burst stays invisible to the client instead of
                // surfacing as a 429 it has to handle. Given up only when the request
                // budget cannot cover the wait.
                if (silentRejection) {
                    const cooldownMs = INFERRED_THROTTLE_COOLDOWN_MS;
                    const affordable = Date.now() - requestStartedAt + cooldownMs < REQUEST_DEADLINE_MS;
                    if (!affordable || throttleWaits >= 1) break;
                    throttleWaits++;
                    console.log(`${agentTag} throttle detected; waiting ${Math.round(cooldownMs / 1000)}s and retrying once in place (chat kept)`);
                    await new Promise(r => setTimeout(r, cooldownMs));
                    if (clientGone) { console.log(`${agentTag} client disconnected during throttle wait; abandoning`); return; }
                    if (deadlineHit()) { console.log(`${agentTag} request deadline hit during throttle wait; stopping`); break; }
                    // The cooldown has been served, so a second refusal is final.
                    silentRejection = false;
                }
                const contextTooLong = isContextTooLongError(modelError);
                if (modelError && !contextTooLong) break;
                if (retryAttempt >= MAX_EMPTY_RETRIES) break;
                retryAttempt++;

                // Reuse the live chat only when its thread position is known. With a
                // parent id the chat still holds every turn before the delta tail, so
                // the retry sends that tail alone; without one the chat already took
                // the whole transcript as its first message and cannot be continued,
                // so it gets recreated instead of being fed the transcript twice.
                const reuseSession = !keptSessionForRetry
                    && Boolean(session.id)
                    && session.parentMessageId != null;
                // Budget from the payload this retry will actually send: the delta tail
                // when continuing a live chat, the full transcript when recreating one.
                // Sizing it from the previous attempt instead would clamp a replayed
                // transcript to the size of the delta that preceded it.
                const retrySource = reuseSession ? livePrompt : recoveryPromptSource;
                const retryHistory = reuseSession ? '' : recoveryHistoryPrefix;
                const retrySystem = reuseSession ? systemPrompt : recoverySystemPrompt;
                const retryBudget = buildRetryBudget(
                    assembledPromptLength(retrySystem, retryHistory, retrySource),
                    retryAttempt,
                );
                const retryBuild = buildRetryPrompt(
                    retrySystem,
                    retryHistory,
                    retrySource,
                    fullPrompt,
                    retryBudget,
                    !reuseSession,
                );
                const retryPrompt = retryBuild.prompt;
                if (retryBuild.compacted) {
                    promptCompacted = true;
                    markContextCompacted(res);
                }
                const reason = contextTooLong ? 'context-too-long response' : 'empty response';
                if (reuseSession) {
                    keptSessionForRetry = true;
                    console.log(`${agentTag} ${reason} (msg#${session.messageCount}, retry ${retryAttempt}/${MAX_EMPTY_RETRIES}, prompt=${retryPrompt.length} chars). Retrying on the same session...`);
                } else {
                    console.log(`${agentTag} ${reason} (msg#${session.messageCount}, retry ${retryAttempt}/${MAX_EMPTY_RETRIES}, prompt=${retryPrompt.length} chars). Resetting session...`);
                    resetRemoteSession(session);
                }
                // Brief delay before retry to let DeepSeek breathe
                await new Promise(r => setTimeout(r, Math.min(500 * retryAttempt, 1500)));
                const retryCallStart = Date.now();
                const { resp: retryResp } = await askDeepSeekStream(retryPrompt, agentId, requestedModel);
                const retryResult = await readDeepSeekResponse(retryResp.body);
                const retryElapsed = Date.now() - retryCallStart;
                const retryState = normalizeRetryResponse(retryResult);
                fullPrompt = retryPrompt;
                modelError = retryState.modelError;
                // The retried call is the one the client is paying for, so its
                // counter is the one that belongs in the usage report.
                upstreamTokens = retryResult.upstreamTokens || upstreamTokens;
                // A previous empty response may have carried finish_reason=length.
                // Never leak it into a successful retry that supplied no reason.
                finishReason = retryState.finishReason;
                const retryRejection = classifySilentUpstreamRejection(retryResult, retryElapsed);
                if (retryRejection) {
                    console.log(
                        `${agentTag} retry ${retryAttempt} also empty with no message id in ${retryElapsed}ms — ${retryRejection === 'throttle' ? 'still refused, cooldown did not clear it' : 'aborted again'}`,
                    );
                    // A refusal this soon after the cooldown was already served is final.
                    // An aborted generation is not: it is an ordinary empty response and
                    // stays inside the loop's own retry budget.
                    silentRejection = retryRejection === 'throttle';
                    if (silentRejection) break;
                }
                if (retryState.content && retryState.content.trim().length > 0) {
                    console.log(`${agentTag} Retry ${retryAttempt} succeeded`);
                    fullContent = retryState.content;
                    reasoningContent = retryState.reasoningContent;
                }
            }

            if (!fullContent || fullContent.trim().length === 0) {
                const timedOut = deadlineHit();
                // "Sending too often" arrives as a stream error inside HTTP 200, and a
                // throttled turn can also come back as a stream with no response object
                // in it at all. Cool the account down, keep the chat, and let the client
                // retry — resetting here is what used to spawn a new chat per complaint.
                if (silentRejection || isRateLimitMessage(modelError)) {
                    const limitedAccount = accounts.find(a => a.id === session.accountId) || null;
                    const notice = silentRejection
                        ? 'empty response stream, no message id'
                        : String(modelError?.content || '').slice(0, 80);
                    // Cool the offending account down and immediately try any other
                    // free account. The remote chat is recreated from local recovery
                    // history, so a rate limit on one account no longer parks the
                    // whole conversation — the 5-minute cooldown only applies once
                    // every account is locked.
                    markRateLimited(limitedAccount, notice, { explicit: !silentRejection });
                    let rotatedAccount = null;
                    for (let rotation = 0; rotation < accounts.length && !fullContent; rotation++) {
                        const alternate = findAlternateReadyAccount(session.accountId);
                        if (!alternate) break;
                        rotatedAccount = alternate;
                        console.log(`${agentTag} account ${session.accountId} rate-limited; switching to free account ${alternate.id} (${rotation + 1}).`);
                        resetRemoteSession(session);
                        session.accountId = alternate.id;
                        await new Promise(r => setTimeout(r, Math.min(500 * (rotation + 1), 1500)));
                        try {
                            const altCall = await askDeepSeekStream(freshPromptBuild.prompt, agentId, requestedModel);
                            const altResult = await readDeepSeekResponse(altCall.resp.body);
                            const altState = normalizeRetryResponse(altResult);
                            if (altState.content && altState.content.trim().length > 0) {
                                fullContent = altState.content;
                                reasoningContent = altState.reasoningContent;
                                finishReason = altState.finishReason;
                                upstreamTokens = altResult.upstreamTokens || upstreamTokens;
                                promptCompacted = promptCompacted || freshPromptBuild.compacted;
                                console.log(`${agentTag} free account ${alternate.id} answered after rotation (${fullContent.length} chars).`);
                                break;
                            }
                            // The alternate is throttled too: cool it and try the next one.
                            if (isRateLimitMessage(altState.modelError)) {
                                markRateLimited(alternate, String(altState.modelError?.content || '').slice(0, 80), { explicit: true });
                                modelError = altState.modelError;
                                continue;
                            }
                            modelError = altState.modelError || modelError;
                            finishReason = altState.finishReason || finishReason;
                            break;
                        } catch (rotationErr) {
                            console.log(`${agentTag} free account ${alternate.id} rotation failed: ${rotationErr.message}`);
                            const failedAlternate = accounts.find(a => a.id === alternate.id) || null;
                            if (failedAlternate) markAccountFailure(failedAlternate, rotationErr.status || 429, 'rotation', rotationErr.retryAfter);
                            modelError = { content: rotationErr.message, type: rotationErr.type } || modelError;
                        }
                    }
                    if (!fullContent || fullContent.trim().length === 0) {
                        const waitAccount = accounts.find(a => a.id === session.accountId) || limitedAccount;
                        const waitSec = waitAccount
                            ? Math.max(1, Math.ceil((waitAccount.cooldownUntil - Date.now()) / 1000))
                            : Math.max(1, Math.ceil(DEFAULT_ACCOUNT_COOLDOWN_MS / 1000));
                        console.log(`${agentTag} every account is rate-limited; session ${session.id} preserved, retry in ${waitSec}s.`);
                        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(waitSec) });
                        res.end(JSON.stringify({
                            error: {
                                message: `All DeepSeek auth accounts are rate-limited right now (the last one reported "${String(modelError?.content || 'too many requests').substring(0, 120)}"). The chat was kept — retry in ~${waitSec}s, or add another account (npm run auth:import, DEEPSEEK_AUTH_DIR=./accounts).`,
                                type: 'rate_limit_error',
                                agent: agentId,
                                session_preserved: true,
                                account: session.accountId,
                                retry_after_sec: waitSec,
                                suspected_throttle: silentRejection,
                                model: requestedModel,
                                real_model: resolveModelConfig(requestedModel).real_model,
                            }
                        }));
                        return;
                    }
                }
                // Context overflow that survived every shrinking retry: instead of
                // handing the client a 400 and a dead chat, make one last emergency
                // attempt with only the newest user turn on a fresh session. The old
                // transcript is gone, but the current request still gets an answer.
                if (isContextTooLongError(modelError) && !contextEmergencyTried) {
                    contextEmergencyTried = true;
                    const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
                    // Carry the handover summary (when we have one) so the emergency
                    // chat keeps the gist of the work instead of only the last question.
                    const progress = sessionProgressText(session);
                    const summarySeed = progress ? `[Session handover]\n${progress}\n\n` : '';
                    const emergencyPrompt = appendPromptInstruction(
                        summarySeed + formatMessages(lastUser ? [lastUser] : messages.slice(-1), tools).prompt,
                        'The earlier conversation was too long to include. Answer the latest user request on its own; if it depends on dropped context, say what is missing.',
                        Math.floor(FRESH_SESSION_PROMPT_CHARS * 0.5) + summarySeed.length
                    );
                    resetRemoteSession(session);
                    console.log(`${agentTag} context too long after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}; emergency fresh-session attempt with the last user turn${summarySeed ? ' + handover summary' : ' only'}`);
                    const emergencyCall = await askDeepSeekStream(emergencyPrompt, agentId, requestedModel);
                    const emergencyResult = await readDeepSeekResponse(emergencyCall.resp.body);
                    const emergencyState = normalizeRetryResponse(emergencyResult);
                    if (emergencyState.content && emergencyState.content.trim().length > 0) {
                        fullContent = emergencyState.content;
                        reasoningContent = emergencyState.reasoningContent;
                        promptCompacted = true;
                        markContextCompacted(res);
                        console.log(`${agentTag} emergency fresh-session attempt succeeded (${fullContent.length} chars)`);
                    } else {
                        modelError = emergencyState.modelError;
                        finishReason = emergencyState.finishReason;
                    }
                }
                if (!fullContent || fullContent.trim().length === 0) {
                const failureClass = classifyRecoveryFailure(modelError, timedOut);
                // The chat already lost every retry attempt: a fresh upstream turn
                // is the only way forward, so the dead session id is dropped here.
                const failure = resetRemoteSession(session);
                const errorType = failureClass.type;
                const errorMessage = modelError?.content
                    || (timedOut
                        ? 'DeepSeek request deadline reached while recovering an empty response'
                        : `DeepSeek returned empty content after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}`);
                console.log(`${agentTag} ${errorType} after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}. Giving up.`);
                res.writeHead(failureClass.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: errorMessage,
                        type: errorType,
                        agent: agentId,
                        failed_session_id: failure.failedSessionId,
                        message_count: failure.failedMessageCount,
                        history_length: session.history.length,
                        account: failure.accountId,
                        retry_attempts: retryAttempt,
                        upstream_prompt_chars: fullPrompt.length,
                        prompt_compacted: promptCompacted,
                        model: requestedModel,
                        real_model: resolveModelConfig(requestedModel).real_model,
                    }
                }));
                return;
                }
            }

            // Non-empty content survived every recovery path, so the account just
            // served a real turn. Only now is it safe to clear the rate-limit
            // streak that markRateLimited escalated.
            markAccountHealthy(accounts.find(a => a.id === session.accountId) || null);

            // Auto-continuation: if finish_reason is 'length' or content is very long (>25000 chars),
            // send a continuation request to get the rest of the response
            let continuationRounds = 0;
            const MAX_CONTINUATION = 2;
            while ((finishReason === 'length' || fullContent.length > 25000) && continuationRounds < MAX_CONTINUATION) {
                if (clientGone || deadlineHit()) break;
                continuationRounds++;
                console.log(`${agentTag} Response ${fullContent.length} chars (finish=${finishReason}). Auto-continuing (${continuationRounds}/${MAX_CONTINUATION})...`);
                await new Promise(r => setTimeout(r, 500));
                const contBeforeId = session.accountId;
                const continuationRecoveryPrompt = appendPromptInstruction(
                    `${freshPromptBuild.prompt}\n\n[Assistant response so far]\n${fullContent}`,
                    'Continue the assistant response from exactly where it stopped. Do not restart or repeat completed sections.'
                );
                const continuationCall = await askDeepSeekStream(
                    'continue',
                    agentId,
                    requestedModel,
                    continuationRecoveryPrompt
                );
                const { resp: contResp, account: contAccount } = continuationCall;
                // A cross-account continuation is valid only when the call
                // detected that reset and sent the full recovery prompt. If an
                // unexpected rotation ever bypasses that guard, discard the new
                // remote session before returning to the client (#20).
                if (!isContinuationRecoverySafe(contBeforeId, continuationCall)) {
                    console.log(`${agentTag} continuation rotated to ${contAccount.id} ≠ ${contBeforeId} — skipping (foreign session)`);
                    resetRemoteSession(session);
                    break;
                }
                const contResult = await readDeepSeekResponse(contResp.body);
                const contContent = contResult && contResult.content ? sanitizeContent(contResult.content) : '';
                const contReasoning = contResult && contResult.reasoningContent ? sanitizeContent(contResult.reasoningContent) : '';
                if (contContent && contContent.trim().length > 0 && !contContent.includes('I am an AI')) {
                    fullContent += '\n' + contContent;
                    if (contReasoning) reasoningContent += (reasoningContent ? '\n' : '') + contReasoning;
                    finishReason = contResult.finishReason;
                    // A continuation is billable on top of the turn it extends, so
                    // fold its spend into the same usage report.
                    if (contResult.upstreamTokens) {
                        upstreamTokens = upstreamTokens
                            ? {
                                start: upstreamTokens.start,
                                total: Math.max(upstreamTokens.total, contResult.upstreamTokens.total),
                            }
                            : contResult.upstreamTokens;
                    }
                    console.log(`${agentTag} Continuation added ${contContent.length} chars (total: ${fullContent.length})`);
                } else {
                    console.log(`${agentTag} Continuation returned nothing useful, stopping`);
                    break;
                }
            }

            const allowedToolNames = new Set(tools
                .filter(tool => tool?.type === 'function' && tool.function?.name)
                .map(tool => tool.function.name));
            let toolCall = null;
            let toolCallPreambleText = '';
            if (allowedToolNames.size > 0) {
                const parsed = parseToolCallDetailed(fullContent);
                if (parsed && !allowedToolNames.has(parsed.toolCall.name)) {
                    console.log(`${agentTag} Model requested unknown tool ${parsed.toolCall.name}; attempting format repair.`);
                } else if (parsed) {
                    toolCall = parsed.toolCall;
                    toolCallPreambleText = parsed.preamble;
                }
            }
            
            // Retry once if legacy, XML, or DSML tool markup was truncated or
            // malformed. Never pass raw DSML through as a normal assistant turn.
            let repairContent = '';
            if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent) && !clientGone && !deadlineHit()) {
                console.log(`${agentTag} Tool-call markup detected but invalid/truncated (${fullContent.length} chars). Retrying with stricter prompt...`);
                // Formatting failure is the model's, not the chat's — retry on the
                // same session so the conversation survives the repair attempt.
                await new Promise(r => setTimeout(r, 1000));
                // Retry the exact prompt that produced the broken markup, so the
                // repair works whether the session was reused or recreated. The
                // allowed names and the hard size cap are what actually rescue a
                // truncated reply: the model stops trying to inline big payloads.
                const strictInstruction = [
                    '[STRICT INSTRUCTION] Your previous reply was discarded because its tool-call markup was incomplete or cut off.',
                    'Reply with EXACTLY ONE tool call and nothing else: no prose, no markdown fence, no explanation before or after.',
                    'Required JSON shape: {"tool_call":{"name":"<function_name>","arguments":{...}}}',
                    `Valid function names: ${[...allowedToolNames].join(', ')}`,
                    'Hard limit: 600 characters for the whole reply. Keep arguments minimal — pass short strings, file paths and small edits only; never inline large file contents or long command output.',
                ].join('\n');
                const strictPrompt = appendPromptInstruction(fullPrompt, strictInstruction);
                const { resp: retryResp2 } = await askDeepSeekStream(strictPrompt, agentId, requestedModel);
                const retryResult2 = await readDeepSeekResponse(retryResp2.body);
                const retryContent2 = retryResult2 && retryResult2.content ? sanitizeContent(retryResult2.content) : '';
                if (retryContent2 && retryContent2.trim()) {
                    repairContent = retryContent2;
                    const retryParsed = parseToolCallDetailed(retryContent2);
                    if (retryParsed && allowedToolNames.has(retryParsed.toolCall.name)) {
                        console.log(`${agentTag} Retry with strict prompt succeeded: ${retryParsed.toolCall.name}`);
                        fullContent = retryContent2;
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : '';
                        toolCall = retryParsed.toolCall;
                        toolCallPreambleText = retryParsed.preamble;
                        upstreamTokens = retryResult2.upstreamTokens || upstreamTokens;
                    } else {
                        console.log(`${agentTag} Retry still has broken tool markup. Returning a safe error instead of leaking it as text.`);
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : reasoningContent;
                    }
                }
            }

            if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent)) {
                dumpFailedToolMarkup(
                    `agent=${agentId} model=${requestedModel} real_model=${resolveModelConfig(requestedModel).real_model} account=${session.accountId} session=${session.id} msg#${session.messageCount} finish_reason=${finishReason} chars=${fullContent.length}`,
                    fullContent,
                    repairContent
                );
                console.log(`[tool-markup] finish_reason=${finishReason} chars=${fullContent.length} first 200: ${JSON.stringify(fullContent.slice(0, 200))}`);
                if (repairContent) console.log(`[tool-markup] repair finish_reason=${finishReason} chars=${repairContent.length} first 200: ${JSON.stringify(repairContent.slice(0, 200))}`);
                // A chat that has drifted into an unparseable tool format stays
                // broken: the same session just replays the same failure for the
                // client forever. Keep the local history and the sticky account,
                // but drop the remote chat so the next attempt re-primes the
                // format from a clean conversation.
                const failure = resetRemoteSession(session);
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: {
                    message: 'DeepSeek returned malformed tool-call markup after one repair attempt; the remote chat was reset, retry the request',
                    type: 'malformed_tool_call',
                    agent: agentId,
                    failed_session_id: failure.failedSessionId,
                    session_reset: true,
                    message_count: failure.failedMessageCount,
                    history_length: session.history.length,
                    account: failure.accountId,
                    prompt_compacted: promptCompacted,
                    model: requestedModel,
                    real_model: resolveModelConfig(requestedModel).real_model,
                } }));
                return;
            }
            
            // Check if any tool results in the current conversation contained a screenshot path.
            // If so, and the response doesn't already have MEDIA:, inject it so the gateway
            // delivers the file to Telegram.
            if (!fullContent.includes('MEDIA:')) {
                const screenshotPaths = extractScreenshotPaths(messages);
                if (screenshotPaths.length > 0) {
                    fullContent += '\n\n' + screenshotPaths.join('\n');
                    console.log(`${agentTag} Injected MEDIA paths into response: ${screenshotPaths.join(', ')}`);
                }
            }

            storeHistory(agentId, prompt, fullContent, toolCall, toolCallPreambleText);
            // The remote chat id and message count are final for this turn; make
            // them durable so a restart resumes instead of rebuilding.
            scheduleSessionPersist();

            const openaiResponse = toolCall
                ? buildToolCallResponse(toolCall, requestedModel, clientPromptText, reasoningContent, upstreamTokens, toolCallPreambleText)
                : buildTextResponse(fullContent, clientPromptText, requestedModel, reasoningContent, finishReason, upstreamTokens);
            const usageReport = buildUsageReport(clientPromptText, toolCall ? toolCallPreambleText : fullContent, reasoningContent, upstreamTokens);
            console.log(`${agentTag} usage: ${usageReport.source} prompt=${openaiResponse.usage.prompt_tokens} completion=${openaiResponse.usage.completion_tokens} total=${openaiResponse.usage.total_tokens}`);
            if (toolCall && toolCallPreambleText) console.log(`${agentTag} Tool-call preamble: ${toolCallPreambleText.length} chars surfaced as assistant text`);

            if (stream) {
                if (apiMode === 'anthropic') {
                    sendAnthropicStream(res, openaiResponse);
                } else if (apiMode === 'responses') {
                    sendResponsesStream(res, openaiResponse);
                } else {
                    // `stream_options.include_usage: false` is the only way to opt out.
                    sendOpenAIStream(res, openaiResponse, body?.stream_options?.include_usage !== false);
                }
                console.log(`${agentTag} Streamed ${apiMode} (tool=${!!toolCall}) in ${elapsed}ms`);
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (apiMode === 'anthropic') {
                    res.end(JSON.stringify(toAnthropicResponse(openaiResponse)));
                } else if (apiMode === 'responses') {
                    res.end(JSON.stringify(toResponsesResponse(openaiResponse)));
                } else {
                    res.end(JSON.stringify(openaiResponse));
                }
                console.log(`${agentTag} Response ${apiMode} (tool=${!!toolCall}, ${elapsed}ms, ${fullContent.length} chars)`);
            }
        } catch (e) {
            console.log('[DS-API] Error:', e.message);
            if (res.headersSent || clientGone) return;  // streamed/aborted: nothing to send
            // A stale/expired/foreign chat id is not the client's fault and is fully
            // recoverable: drop the dead remote chat so the next request recreates it
            // and resends the full transcript. This is the fallback that keeps long
            // dialogs and cancelled requests from dying on a chat-id error.
            if (activeSession && isChatIdError(e)) {
                const reset = resetRemoteSession(activeSession);
                console.log(`${agentTag} chat-id error ("${String(e.message || '').slice(0, 80)}") — remote chat reset, retry recreates it from local history`);
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: {
                    message: 'DeepSeek rejected the chat id (expired or already closed). The remote chat was reset — retry the request and it will be recreated from local history.',
                    type: 'chat_session_reset',
                    agent: activeAgentId,
                    failed_session_id: reset.failedSessionId,
                    session_reset: true,
                    message_count: reset.failedMessageCount,
                    history_length: activeSession.history.length,
                    account: reset.accountId,
                } }));
                return;
            }
            // Pool exhaustion / no-auth carry an explicit status so integrators see
            // 429/503 (not a generic 500) and can honor Retry-After.
            const timedOut = isTimeoutError(e);
            const status = e.status || (timedOut ? 504 : 500);
            const headers = { 'Content-Type': 'application/json' };
            if (status === 429 && e.retryAfter) headers['Retry-After'] = String(e.retryAfter);
            res.writeHead(status, headers);
            // A timeout consumes our wall-clock budget, not the remote chat's
            // validity — keep the session so the next request continues the same
            // conversation instead of forcing a brand-new chat.
            const failure = (timedOut && activeSession) ? {
                failedSessionId: activeSession.id,
                failedMessageCount: activeSession.messageCount,
                accountId: activeSession.accountId,
            } : null;
            res.end(JSON.stringify({ error: {
                message: e.message,
                type: e.type || (timedOut ? 'request_timeout' : 'server_error'),
                ...(failure ? {
                    agent: activeAgentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    history_length: activeSession.history.length,
                    account: failure.accountId,
                } : {}),
            } }));
        } finally {
            if (releaseAgentLock) releaseAgentLock();
            inFlight--;
        }
    });
});

async function runAuthScript() {
    const script = path.join(__dirname, 'scripts', 'deepseek_chrome_auth.js');
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
    loadDeepSeekConfig({ fatal: false });
    return result.status === 0 && hasAuthConfig();
}

function printStatus() {
    console.log(`\n${formatWatermark()}`);
    console.log(`Auth: ${hasAuthConfig() ? '✅ OK' : '❌ не найден deepseek-auth.json'}`);
    const authSource = process.env.DEEPSEEK_AUTH_DIR
        || (authConfig.hasAccountFiles() ? `data/accounts (${accounts.length} account(s))` : DS_CONFIG_PATH);
    console.log(`Auth source: ${authSource}`);
    console.log(`Аккаунты: ${accounts.length ? accounts.map(a => `${a.id}${a.cooldownUntil > Date.now() ? ' (cooldown)' : ''}`).join(', ') : 'нет'}`);
    console.log(`Рабочие модели: ${SUPPORTED_MODEL_IDS.join(', ')}`);
    console.log('Нерабочие/скрытые aliases: ' + Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported).join(', '));
    console.log('Capabilities: GET /v1/model-capabilities');
}

async function showStartupMenu() {
    if (isTruthy(process.env.SKIP_ACCOUNT_MENU) || isTruthy(process.env.NON_INTERACTIVE)) {
        if (!hasAuthConfig()) loadDeepSeekConfig({ fatal: true });
        return true;
    }
    while (true) {
        printStatus();
        console.log('\n=== Меню ===');
        console.log(`ForgetMeAI: ${FORGETMEAI_WATERMARK}`);
        console.log('1 - Авторизоваться / обновить DeepSeek login');
        console.log('2 - Импортировать auth-файл / cookies');
        console.log('3 - Показать модели и статусы');
        console.log('4 - Запустить прокси (по умолчанию)');
        console.log('5 - Выход');
        let choice = await prompt('Ваш выбор (Enter = 4): ');
        if (!choice) choice = '4';
        if (choice === '1') {
            await runAuthScript();
        } else if (choice === '2') {
            spawnSync(process.execPath, [path.join(__dirname, 'scripts', 'auth_import.js')], { stdio: 'inherit', env: process.env });
            loadDeepSeekConfig({ fatal: false });
        } else if (choice === '3') {
            console.log(JSON.stringify(ALL_MODEL_CAPABILITIES, null, 2));
            await prompt('\nНажмите Enter, чтобы вернуться в меню...');
        } else if (choice === '4') {
            if (!hasAuthConfig()) {
                console.log('Нужен deepseek-auth.json. Запустите пункт 1 или 2.');
                continue;
            }
            return true;
        } else if (choice === '5') {
            return false;
        }
    }
}

async function main() {
    printBanner();
    requireProxyApiKey(PROXY_API_KEY, isTruthy(process.env.REQUIRE_PROXY_API_KEY));
    if (!isLoopbackHost(HOST) && !PROXY_API_KEY) {
        console.warn(`[DS-API] WARNING: HOST=${HOST} exposes the proxy without authentication. Set PROXY_API_KEY or bind to 127.0.0.1.`);
    }
    const shouldStart = await showStartupMenu();
    if (!shouldStart) process.exit(0);
    loadPersistedSessions();
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') console.error(`[DS-API] FATAL: port ${PORT} already in use. Set PORT=<other> or stop the other instance.`);
        else console.error('[DS-API] server error:', err);
        process.exit(1);
    });
    // Periodically evict idle sessions (unref'd so it never keeps the process alive).
    setInterval(sweepIdleSessions, 10 * 60 * 1000).unref();
    server.listen(PORT, HOST, () => {
        console.log(`[DS-API] Server on http://${HOST}:${PORT} (multi-agent sessions enabled)`);
        console.log(`[DS-API] ${formatWatermark()}`);
        console.log('[DS-API] POST /v1/chat/completions (OpenAI Chat Completions, stream=true|false)');
        console.log('[DS-API] POST /v1/messages — Anthropic Messages shim for Claude Code');
        console.log('[DS-API] POST /v1/responses — OpenAI Responses API shim');
        console.log('[DS-API] GET  /v1/models — supported OpenAI-compatible models');
        console.log('[DS-API] GET  /v1/model-capabilities — real model mapping and capabilities');
        console.log('[DS-API] GET  /v1/sessions — list active agent sessions');
        console.log('[DS-API] POST /reset-session?agent=<id> — reset agent session');
        console.log('[DS-API] POST /reset-session?agent=all — reset ALL sessions');
    });
}

if (require.main === module) {
    installFileLogging();
    // Don't let a stray rejection/throw take the whole proxy down silently.
    process.on('unhandledRejection', (reason) => console.error('[DS-API] unhandledRejection:', reason));
    process.on('uncaughtException', (err) => console.error('[DS-API] uncaughtException:', err));
    // Graceful shutdown: stop accepting, drain, then exit (force-exit after 10s).
    const shutdown = (sig) => {
        console.log(`[DS-API] ${sig} received — shutting down…`);
        fileLogger.close();
        // Flush synchronously: the debounced writer may not have fired yet and
        // the remote chat ids in it are what make the next boot cheap.
        if (sessionPersistTimer) { clearTimeout(sessionPersistTimer); sessionPersistTimer = null; }
        persistSessions();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    main().catch(err => { console.error('[DS-API] FATAL:', err); process.exit(1); });
}

module.exports = {
    __test: {
        isAssistantOutputFragment,
        isReasoningFragment,
        isDeepSeekModelErrorEvent,
        createUpstreamHttpError,
        rebuildFragmentText,
        applyResponsePatchOperations,
        createDeepSeekStreamAccumulator,
        readDeepSeekSseLines,
        compactToolSchema,
        formatToolDefinitions,
        parseToolCall,
        parseToolCallDetailed,
        toolCallPreamble,
        parseDsmlToolCall,
        looksLikeToolCallMarkup,
        dumpFailedToolMarkup,
        resolveUpstreamUsage,
        buildUsage,
        buildUsageReport,
        buildToolCallResponse,
        extractLastUserTurn,
        conversationFingerprint,
        resolveAgentId,
        AGENT_HEADER_NAME,
        serializeSession,
        loadPersistedSessions,
        sessions,
        truncatePromptMiddle,
        hasExplicitConversationHistory,
        buildRecoveryHistoryPrefix,
        buildBoundedPrompt,
        buildRetryPrompt,
        buildRetryBudget,
        assembledPromptLength,
        MIN_SHRINKABLE_PROMPT_CHARS,
        isSilentUpstreamRejection,
        classifySilentUpstreamRejection,
        acquireAgentTurnLock,
        isContinuationRecoverySafe,
        isContextTooLongError,
        normalizeRetryResponse,
        classifyRecoveryFailure,
        isTimeoutError,
        formatMessages,
        serializeAssistantTurn,
        selectDeltaMessages,
        extractTodoLines,
        buildSessionStateBlock,
        extractTaskLine,
        updateRollingSummary,
        parseTodoContainer,
        formatTodoEntry,
        COMPACT_TOOL_REMINDER,
        STATE_BLOCK_ENABLED,
        ROLLING_SUMMARY_ENABLED,
        ROLLING_SUMMARY_CHARS,
        TODO_MAX_ITEMS,
        ROLLOVER_PROMPT_CHARS,
        PRIME_LARGE_FIRST_MESSAGE,
        LLM_SUMMARY_ENABLED,
        SUMMARY_INPUT_CHARS,
        sessionRolloverReason,
        selectSeedBudget,
        sessionProgressText,
        summarizeConversation,
        readUpstreamText,
        createFileLogger,
        writeLogFile,
        installFileLogging,
        setLogLineHook,
        stampLogText,
        LOG_FILE_PATH,
        LOG_FILE_ENABLED,
        LOG_FILE_MAX_BYTES,
        MAX_HISTORY_LENGTH,
        MAX_HISTORY_CHARS,
        DS_FETCH_TIMEOUT_MS,
        REQUEST_DEADLINE_MS,
        createSession,
        resetRemoteSession,
        prepareSessionForPrompt,
        sweepIdleSessions,
        sessions,
        accounts,
        selectAccountForSession,
        acquireAccountSlot,
        paceUpstreamCall,
        isRateLimitMessage,
        markRateLimited,
        markAccountHealthy,
        MIN_REQUEST_INTERVAL_MS,
        REQUEST_JITTER_MS,
        UPSTREAM_CALL_GAP_MS,
        RATE_LIMIT_COOLDOWN_MS,
        INFERRED_THROTTLE_COOLDOWN_MS,
        FRESH_SESSION_PROMPT_CHARS,
        MAX_UPSTREAM_PROMPT_CHARS,
        MIN_UPSTREAM_PROMPT_CHARS,
        STICKY_WAIT_MS,
        MAX_MESSAGE_DEPTH,
        SESSION_TTL_MS,
        isProxyAuthorized,
        loadProxyApiKey,
        requireProxyApiKey,
        isLoopbackHost,
        normalizeOrigin,
        isBrowserOriginAllowed,
        setCorsResponseHeaders,
        markContextCompacted,
        CONTEXT_COMPACTED_HEADER,
        sendAnthropicStream,
        sendResponsesStream,
        sendOpenAIStream,
    },
};
