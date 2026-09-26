const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const serverInternals = require('../server.js').__test;
const authConfig = require('../lib/auth_config');

test('multi-account pool is the default auth source so npm start needs no env', () => {
  const files = authConfig.accountFiles();
  assert.ok(Array.isArray(files));
  // Every pool entry is a real file inside the gitignored data/accounts dir.
  for (const file of files) {
    assert.ok(file.startsWith(authConfig.ACCOUNT_DIR + path.sep), `${file} is outside the pool dir`);
    assert.ok(fs.existsSync(file));
  }
  // Scripts that write auth must target the pool once it exists, otherwise
  // `npm run auth` would refresh a file the server never loads.
  if (files.length > 0) {
    assert.equal(authConfig.defaultAuthPath(), path.join(authConfig.ACCOUNT_DIR, 'main.json'));
  } else {
    assert.equal(authConfig.defaultAuthPath(), authConfig.LEGACY_AUTH_FILE);
  }
});

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-test-'));
}

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
}

test('auth import copies valid deepseek-auth.json and chmods it to 0600', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'source-auth.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify({
    token: 'tok_123',
    cookie: 'ds_session_id=abc; other=def',
    hif_dliq: 'dliq',
    hif_leim: 'leim',
    wasmUrl: 'https://example.com/sha3.wasm',
  }));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_123');
  assert.match(imported.cookie, /ds_session_id=abc/);
  if (process.platform !== 'win32') {
    assert.equal((fs.statSync(dst).mode & 0o777), 0o600);
  }
});

test('auth import accepts browser cookie export plus token env', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([
    { domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' },
    { domain: 'chat.deepseek.com', name: 'smidV2', value: 'smid' },
    { domain: 'example.com', name: 'ignored', value: 'nope' },
  ]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst], { env: { DEEPSEEK_TOKEN: 'tok_env' } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_env');
  assert.equal(imported.cookie, 'ds_session_id=abc; smidV2=smid');
});

test('auth import rejects token passed as CLI arg before prompting or reading files', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([{ domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' }]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst, '--token', 'tok_cli']);
  assert.equal(res.status, 2);
  assert.match(res.stderr + res.stdout, /Refusing --token/i);
  assert.equal(fs.existsSync(dst), false);

  const noInput = runNode(['scripts/auth_import.js', '--token', 'tok_cli']);
  assert.equal(noInput.status, 2);
  assert.match(noInput.stderr + noInput.stdout, /Refusing --token/i);

  const badInput = runNode(['scripts/auth_import.js', '--input', path.join(dir, 'missing.json'), '--token', 'tok_cli']);
  assert.equal(badInput.status, 2);
  assert.match(badInput.stderr + badInput.stdout, /Refusing --token/i);
});

test('auth import help ignores comma-list DEEPSEEK_AUTH_PATH as default output', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  const res = runNode(['scripts/auth_import.js', '--help'], { env: { DEEPSEEK_AUTH_PATH: `${a},${b}` } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, new RegExp(`${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`));
  assert.match(res.stdout, /deepseek-auth\.json/);
});

test('doctor reports auth problems without requiring Chrome or network', () => {
  const dir = tmpdir();
  const authPath = path.join(dir, 'broken-auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ token: '', cookie: '' }));
  const res = runNode(['scripts/doctor.js', '--offline'], { env: { DEEPSEEK_AUTH_PATH: authPath } });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /token missing/i);
  assert.match(res.stdout + res.stderr, /cookie missing/i);
});

test('chrome auth prints actionable OS instructions when Chrome is missing', () => {
  const dir = tmpdir();
  const fakeChrome = path.join(dir, 'missing-chrome');
  const res = runNode(['scripts/deepseek_chrome_auth.js'], { env: { CHROME_PATH: fakeChrome } });
  assert.notEqual(res.status, 0);
  const out = res.stdout + res.stderr;
  assert.match(out, /Windows/i);
  assert.match(out, /macOS/i);
  assert.match(out, /Linux/i);
  assert.match(out, /CHROME_PATH/i);
});

test('chrome extension manifest only declares icon files that exist', () => {
  const manifestPath = path.join(ROOT, 'chrome-extension', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const iconPaths = [];

  function collectIconPaths(value, key = '') {
    if (typeof value === 'string') {
      if (key === 'icons' || key === 'default_icon') iconPaths.push(value);
      return;
    }

    if (!value || typeof value !== 'object') return;

    if ((key === 'icons' || key === 'default_icon') && !Array.isArray(value)) {
      for (const iconPath of Object.values(value)) {
        if (typeof iconPath === 'string') iconPaths.push(iconPath);
      }
      return;
    }

    for (const [childKey, childValue] of Object.entries(value)) {
      collectIconPaths(childValue, childKey);
    }
  }

  collectIconPaths(manifest);

  for (const iconPath of iconPaths) {
    assert.equal(
      fs.existsSync(path.join(path.dirname(manifestPath), iconPath)),
      true,
      `Missing extension icon declared in manifest: ${iconPath}`,
    );
  }
});

test('DeepSeek stream parser treats SEARCH fragments as assistant output', () => {
  const rebuilt = serverInternals.rebuildFragmentText([
    { type: 'SEARCH', content: 'The official Reuters website is ' },
    { type: 'SEARCH', content: 'https://www.reuters.com/.' },
  ]);

  assert.equal(rebuilt.responseText, 'The official Reuters website is https://www.reuters.com/.');
  assert.equal(rebuilt.thinkText, '');
});

test('DeepSeek stream parser applies response-level fragment append patches', () => {
  const fragments = [];
  const appendFragments = (value) => {
    const incoming = Array.isArray(value) ? value : [value];
    for (const fragment of incoming) fragments.push({ ...fragment });
  };

  const applied = serverInternals.applyResponsePatchOperations([
    { p: 'fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'The' }] },
    { p: 'has_pending_fragment', o: 'SET', v: false },
  ], appendFragments);

  assert.equal(applied, true);
  assert.deepEqual(fragments, [{ type: 'RESPONSE', content: 'The' }]);
  assert.equal(serverInternals.rebuildFragmentText(fragments).responseText, 'The');
});

test('DeepSeek stream parser does not treat service content chunks as model errors', () => {
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ content: 'Official Reuters website URL' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ finish_reason: 'stop' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ type: 'error', content: 'backend error' }), true);
});

test('consumed upstream HTTP errors retain status, type, and retry hints', () => {
  const limited = serverInternals.createUpstreamHttpError(429, '  Rate limited\ntry later  ', '12');
  assert.equal(limited.status, 429);
  assert.equal(limited.type, 'rate_limit_error');
  assert.equal(limited.retryAfter, '12');
  assert.match(limited.message, /Rate limited try later/);

  const unauthorized = serverInternals.createUpstreamHttpError(401, 'expired');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.type, 'authentication_error');
});

test('sweepIdleSessions evicts only idle entries', () => {
  serverInternals.sessions.set('stale-x', { lastActivityAt: 1 });
  serverInternals.sessions.set('fresh-x', { lastActivityAt: Date.now() });
  serverInternals.sweepIdleSessions(60 * 1000);
  assert.equal(serverInternals.sessions.has('stale-x'), false);
  assert.equal(serverInternals.sessions.has('fresh-x'), true);
  serverInternals.sessions.delete('fresh-x');
});

test('proxy API key authentication is optional and uses exact bearer tokens', () => {
  assert.equal(serverInternals.isProxyAuthorized(undefined, ''), true);
  assert.equal(serverInternals.isProxyAuthorized('Bearer secret', 'secret'), true);
  assert.equal(serverInternals.isProxyAuthorized('Bearer wrong', 'secret'), false);
  assert.equal(serverInternals.isProxyAuthorized('Basic secret', 'secret'), false);
  assert.equal(serverInternals.isProxyAuthorized('Bearer secret ', 'secret'), false);
});

test('proxy API key can be loaded from a mounted secret and required explicitly', () => {
  const dir = tmpdir();
  const secretPath = path.join(dir, 'proxy-api-key');
  fs.writeFileSync(secretPath, 'mounted-secret\n');

  assert.equal(serverInternals.loadProxyApiKey({ PROXY_API_KEY_FILE: secretPath }), 'mounted-secret');
  assert.equal(serverInternals.loadProxyApiKey({ PROXY_API_KEY: 'env-secret', PROXY_API_KEY_FILE: secretPath }), 'env-secret');
  assert.equal(serverInternals.loadProxyApiKey({ PROXY_API_KEY_FILE: path.join(dir, 'missing') }), '');
  assert.doesNotThrow(() => serverInternals.requireProxyApiKey('mounted-secret', true));
  assert.throws(
    () => serverInternals.requireProxyApiKey('', true),
    /PROXY_API_KEY is required/,
  );
});

test('Containerfile keeps the rootless Podman runtime minimal and fail-closed', () => {
  const containerfile = fs.readFileSync(path.join(ROOT, 'Containerfile'), 'utf8');
  const containerignore = fs.readFileSync(path.join(ROOT, '.containerignore'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const copyLines = containerfile
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('COPY '));

  assert.deepEqual(copyLines, [
    'COPY --chown=1000:1000 package.json server.js ./',
    'COPY --chown=1000:1000 lib/pow.js ./lib/pow.js',
  ]);
  assert.doesNotMatch(containerfile, /^\s*(?:COPY|ADD)\s+\.\s/m);
  assert.match(containerfile, /^USER 1000:1000$/m);
  assert.match(containerfile, /HOST=0\.0\.0\.0/);
  assert.match(containerfile, /NON_INTERACTIVE=1/);
  assert.match(containerfile, /REQUIRE_PROXY_API_KEY=1/);
  assert.match(containerfile, /PROXY_API_KEY_FILE=\/run\/secrets\/proxy-api-key/);
  assert.match(containerfile, /^HEALTHCHECK /m);
  assert.match(containerfile, /path:'\/health'/);
  assert.match(containerfile, /^CMD \["node", "server\.js"\]$/m);

  assert.match(containerignore, /^\*$/m);
  assert.doesNotMatch(containerignore, /^!.*(?:auth|secret|\.env)/mi);
  assert.match(readme, /--publish 127\.0\.0\.1:9655:9655/);
  assert.match(readme, /--secret free-deepseek-auth[^\n]*mode=0400/);
  assert.match(readme, /--secret free-deepseek-proxy-key[^\n]*mode=0400/);
  assert.match(readme, /--read-only/);
  assert.match(readme, /--cap-drop=ALL/);
  assert.match(readme, /--security-opt=no-new-privileges/);
});

test('loopback host detection covers supported local bind addresses', () => {
  assert.equal(serverInternals.isLoopbackHost('127.0.0.1'), true);
  assert.equal(serverInternals.isLoopbackHost('::1'), true);
  assert.equal(serverInternals.isLoopbackHost('[::1]'), true);
  assert.equal(serverInternals.isLoopbackHost('::ffff:127.0.0.1'), true);
  assert.equal(serverInternals.isLoopbackHost('localhost'), true);
  assert.equal(serverInternals.isLoopbackHost('0.0.0.0'), false);
});

test('browser origin guard allows local UIs and exact configured origins only', () => {
  const allowed = new Set(['https://ui.example.com', 'chrome-extension://trusted-id']);
  assert.equal(serverInternals.isBrowserOriginAllowed(undefined, allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('http://localhost:3000', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('http://127.0.0.1:8080', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('http://[::1]:3000', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('https://ui.example.com/path', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('chrome-extension://trusted-id', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('https://evil.example', allowed), false);
  assert.equal(serverInternals.isBrowserOriginAllowed('chrome-extension://other-id', allowed), false);
  assert.equal(serverInternals.isBrowserOriginAllowed('null', allowed), false);
});

test('parseToolCall converts canonical DeepSeek DSML into an OpenAI tool call', () => {
  const dsml = [
    'I will inspect it.',
    '<｜DSML｜tool_calls>',
    '<｜DSML｜invoke name="execute_code">',
    '<｜DSML｜parameter name="code" string="true">print("ok")</｜DSML｜parameter>',
    '<｜DSML｜parameter name="timeout" string="false">30</｜DSML｜parameter>',
    '<｜DSML｜parameter name="capture" string="false">true</｜DSML｜parameter>',
    '</｜DSML｜invoke>',
    '</｜DSML｜tool_calls>',
  ].join('\n');

  const call = serverInternals.parseToolCall(dsml);
  assert.equal(call.name, 'execute_code');
  assert.deepEqual(JSON.parse(call.arguments), {
    code: 'print("ok")',
    timeout: 30,
    capture: true,
  });
});

test('parseToolCall accepts the doubled-bar DSML Web variant from issue #19', () => {
  const dsml = [
    '<｜｜DSML｜｜ Tool Calls>',
    '<｜｜DSML｜｜ name="web_search">{"query":"DeepSeek DSML"}',
    '</｜｜DSML｜｜ Tool Calls>',
  ].join('\n');

  const call = serverInternals.parseToolCall(dsml);
  assert.equal(call.name, 'web_search');
  assert.deepEqual(JSON.parse(call.arguments), { query: 'DeepSeek DSML' });
});

test('parseToolCall accepts zero-argument, CDATA, legacy, collapsed, and prefixed wrappers', () => {
  const zeroArg = serverInternals.parseToolCall(
    '<|DSML|tool_calls><|DSML|invoke name="ping"></|DSML|invoke></|DSML|tool_calls>'
  );
  assert.deepEqual(zeroArg, { name: 'ping', arguments: '{}' });

  const cdata = serverInternals.parseToolCall(
    '<tool_calls><invoke name="write_file"><parameter name="content"><![CDATA[line 1\n<line 2>\n</parameter>\n</invoke>\n</tool_calls>]]></parameter></invoke></tool_calls>'
  );
  assert.deepEqual(JSON.parse(cdata.arguments), { content: 'line 1\n<line 2>\n</parameter>\n</invoke>\n</tool_calls>' });

  const collapsed = serverInternals.parseToolCall(
    '<DSMLtool_calls><DSMLinvoke name="read_file"><DSMLparameter name="path">/tmp/a</DSMLparameter></DSMLinvoke></DSMLtool_calls>'
  );
  assert.deepEqual(JSON.parse(collapsed.arguments), { path: '/tmp/a' });

  const prefixed = serverInternals.parseToolCall(
    '<abc:tool_calls><abc:invoke name="read_file"><abc:parameter name="path">/tmp/b</abc:parameter></abc:invoke></abc:tool_calls>'
  );
  assert.deepEqual(JSON.parse(prefixed.arguments), { path: '/tmp/b' });
});

test('parseToolCall normalizes fullwidth delimiters and narrowly repairs a missing opening wrapper', () => {
  const fullwidth = serverInternals.parseToolCall(
    '＜｜DSML｜Tool Calls＞＜｜DSML｜Invoke name=“read_file”＞＜｜DSML｜Parameter name=“path”＞/tmp/c＜/｜DSML｜Parameter＞＜/｜DSML｜Invoke＞＜/｜DSML｜Tool Calls＞'
  );
  assert.deepEqual(JSON.parse(fullwidth.arguments), { path: '/tmp/c' });

  const repaired = serverInternals.parseToolCall(
    '<invoke name="read_file"><parameter name="path">/tmp/d</parameter></invoke></tool_calls>'
  );
  assert.deepEqual(JSON.parse(repaired.arguments), { path: '/tmp/d' });
});

test('parseToolCall rejects bare invokes and bare JSON examples', () => {
  const bareInvoke = '<|DSML|invoke name="execute_code"><|DSML|parameter name="code">danger()</|DSML|parameter></|DSML|invoke>';
  assert.equal(serverInternals.parseToolCall(bareInvoke), null);
  assert.equal(serverInternals.looksLikeToolCallMarkup(bareInvoke), true);

  const prose = 'For example return {"name":"execute_code","arguments":{"code":"danger()"}} when appropriate.';
  assert.equal(serverInternals.parseToolCall(prose), null);
  assert.equal(serverInternals.parseToolCall('```json\n{"name":"execute_code","arguments":{"code":"danger()"}}\n```'), null);
});

test('parseToolCall accepts only explicit JSON envelopes with valid object arguments', () => {
  const explicit = serverInternals.parseToolCall(
    'Use this: {"tool_call":{"name":"read_file","arguments":{"path":"/tmp/a"}}}'
  );
  assert.deepEqual(JSON.parse(explicit.arguments), { path: '/tmp/a' });

  const openai = serverInternals.parseToolCall(JSON.stringify({
    tool_calls: [{
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/b' }) },
    }],
  }));
  assert.deepEqual(JSON.parse(openai.arguments), { path: '/tmp/b' });

  assert.equal(serverInternals.parseToolCall('{"tool_call":{"name":"read_file","arguments":"not-json"}}'), null);
  assert.equal(serverInternals.parseToolCall(JSON.stringify({
    tool_calls: [
      { function: { name: 'read_file', arguments: '{}' } },
      { function: { name: 'write_file', arguments: '{}' } },
    ],
  })), null);
});

test('parseToolCall bounds tool markup and scans unmatched braces in linear time', () => {
  const oversized = `<|DSML|tool_calls>${'x'.repeat(256 * 1024)}</|DSML|tool_calls>`;
  assert.equal(serverInternals.parseToolCall(oversized), null);

  const started = Date.now();
  assert.equal(serverInternals.parseToolCall('{'.repeat(64 * 1024)), null);
  assert.ok(Date.now() - started < 1000, 'unmatched JSON braces should not block the event loop');

  const malformedTagStarted = Date.now();
  const malformedTags = `<tool_calls><invoke name="${'<invoke name="'.repeat(16000)}</tool_calls>`;
  assert.equal(serverInternals.parseToolCall(malformedTags), null);
  assert.ok(Date.now() - malformedTagStarted < 1000, 'malformed quoted DSML tags should be rejected in bounded time');
});

test('parseToolCall refuses incomplete DSML instead of executing JSON found inside it', () => {
  const malformed = [
    '<｜DSML｜tool_calls>',
    '<｜DSML｜invoke name="execute_code">',
    '{"name":"dangerous_fallback","code":"rm -rf /"}',
    '</｜DSML｜tool_calls>',
  ].join('\n');

  assert.equal(serverInternals.parseToolCall(malformed), null);
  assert.equal(serverInternals.looksLikeToolCallMarkup(malformed), true);
});

test('parseToolCall rejects partially consumed DSML parameters and wrapper scope', () => {
  const truncatedSecondParameter = '<tool_calls><invoke name="write_file"><parameter name="path">/tmp/a</parameter><parameter name="content">truncated</invoke></tool_calls>';
  const trailingInvokeJunk = '<tool_calls><invoke name="write_file"><parameter name="path">/tmp/a</parameter>GARBAGE</invoke></tool_calls>';
  const truncatedSecondInvoke = '<tool_calls><invoke name="ping"></invoke><invoke name="write_file"><parameter name="path">/tmp/a</tool_calls>';
  const twoCompleteInvokes = '<tool_calls><invoke name="ping"></invoke><invoke name="ping"></invoke></tool_calls>';
  const secondInvokeOutsideWrapper = '<tool_calls><invoke name="ping"></invoke></tool_calls><invoke name="write_file"><parameter name="path">/tmp/a</parameter></invoke>';
  const trailingWrapperJunk = '<tool_calls><invoke name="ping"></invoke>GARBAGE</tool_calls>';
  const unclosedCdata = '<tool_calls><invoke name="write_file"><parameter name="content"><![CDATA[truncated</parameter></invoke></tool_calls>';
  const tooManyParameters = `<tool_calls><invoke name="write_file">${Array.from({ length: 129 }, (_, i) => `<parameter name="p${i}">${i}</parameter>`).join('')}</invoke></tool_calls>`;

  for (const malformed of [
    truncatedSecondParameter,
    trailingInvokeJunk,
    truncatedSecondInvoke,
    twoCompleteInvokes,
    secondInvokeOutsideWrapper,
    trailingWrapperJunk,
    unclosedCdata,
    tooManyParameters,
  ]) {
    assert.equal(serverInternals.parseToolCall(malformed), null, malformed);
    assert.equal(serverInternals.looksLikeToolCallMarkup(malformed), true, malformed);
  }
});

test('severe compaction preserves the last user task and flags the dropped context', () => {
  const pad = 'z'.repeat(50000);
  let conv = 'User: первая задача\n\nAssistant: ок\n\n';
  for (let i = 0; i < 6; i++) conv += `Tool: ${pad}\n\nAssistant: продолжаю\n\n`;
  conv += 'User: ГЛАВНАЯ ЗАДАЧА: переименуй экспорт\n\nAssistant: Принял\n\n';
  for (let i = 0; i < 6; i++) conv += `Tool: ${pad}\n\nAssistant: продолжаю\n\n`;

  const built = serverInternals.buildBoundedPrompt('system prompt', '', conv, 24000);
  assert.equal(built.compacted, true);
  assert.equal(built.taskRescued, true, 'the task sat in the dropped middle and must be rescued');
  assert.ok(built.prompt.length <= 24000, `prompt ${built.prompt.length} exceeded the budget`);
  assert.match(built.prompt, /ГЛАВНАЯ ЗАДАЧА/);
  assert.match(built.prompt, /\[CONTEXT NOTE\]/);
  // The rescued task terminates the prompt, so the length clamp can never cut it.
  assert.ok(built.prompt.trimEnd().endsWith('переименуй экспорт'), built.prompt.slice(-120));
});

test('a prompt that already fits is sent untouched', () => {
  const conv = 'User: короткая задача\n\nAssistant: ок\n\n';
  const built = serverInternals.buildBoundedPrompt('system', '', conv, 24000);
  assert.equal(built.compacted, false);
  assert.equal(built.taskRescued, undefined);
  assert.equal(built.prompt, 'system\n\nUser: короткая задача\n\nAssistant: ок');
});

test('last user turn extraction stops at the assistant reply', () => {
  assert.equal(serverInternals.extractLastUserTurn('User: первый\n\nAssistant: ок\n\nUser: второй\n\nAssistant: да'), 'User: второй');
  assert.equal(serverInternals.extractLastUserTurn('User: единственный\n\nAssistant: да'), 'User: единственный');
  assert.equal(serverInternals.extractLastUserTurn('Assistant: без запроса'), '');
  assert.equal(serverInternals.extractLastUserTurn(''), '');
});

test('each conversation gets its own DeepSeek chat when the client sends no id', () => {
  const chatA = [
    { role: 'system', content: 'you are opencode' },
    { role: 'user', content: 'почини пайплайн деплоя в backend' },
    { role: 'assistant', content: 'смотрю' },
    { role: 'user', content: 'а теперь тесты' },
  ];
  const chatB = [
    { role: 'system', content: 'you are opencode' },
    { role: 'user', content: 'напиши компонент кнопки' },
  ];
  // Same client, same address, no identity header — exactly what opencode does.
  const a1 = serverInternals.resolveAgentId({ remoteAddr: '127.0.0.1', messages: chatA });
  const a2 = serverInternals.resolveAgentId({ remoteAddr: '127.0.0.1', messages: [...chatA, { role: 'user', content: 'ещё' }] });
  const b1 = serverInternals.resolveAgentId({ remoteAddr: '127.0.0.1', messages: chatB });

  assert.equal(a1.source, 'conversation');
  assert.match(a1.agentId, /^conv-[0-9a-f]{16}$/);
  assert.equal(a1.agentId, a2.agentId, 'the same chat must keep its key as the transcript grows');
  assert.notEqual(a1.agentId, b1.agentId, 'a different chat must not share the DeepSeek conversation');
  assert.notEqual(a1.agentId, 'dev-agent', 'conversations no longer collapse into dev-agent');
});

test('an explicit identity always wins over the fingerprint', () => {
  const messages = [{ role: 'user', content: 'один и тот же первый вопрос' }];
  const header = serverInternals.resolveAgentId({ headerValue: 'my-project', remoteAddr: '127.0.0.1', messages });
  assert.deepEqual(header, { agentId: 'my-project', source: 'header' });
  const param = serverInternals.resolveAgentId({ paramValue: 'user-42', remoteAddr: '127.0.0.1', messages });
  assert.deepEqual(param, { agentId: 'user-42', source: 'param' });
});

test('no conversation to fingerprint falls back to the peer identity', () => {
  assert.deepEqual(
    serverInternals.resolveAgentId({ remoteAddr: '127.0.0.1', messages: [{ role: 'system', content: 'only system' }] }),
    { agentId: 'dev-agent', source: 'loopback' },
  );
  assert.deepEqual(
    serverInternals.resolveAgentId({ remoteAddr: '10.0.0.5', messages: [] }),
    { agentId: '10.0.0.5', source: 'peer' },
  );
  // A trivially short opening message is not a usable fingerprint.
  assert.equal(serverInternals.conversationFingerprint([{ role: 'user', content: 'ok' }]), '');
  assert.equal(serverInternals.conversationFingerprint([{ role: 'user', content: [] }]), '');
  assert.equal(serverInternals.conversationFingerprint(null), '');
});

test('fingerprint ignores later turns but respects a rewritten opening', () => {
  const first = serverInternals.conversationFingerprint([{ role: 'user', content: 'исходная задача' }]);
  const grown = serverInternals.conversationFingerprint([
    { role: 'user', content: 'исходная задача' },
    { role: 'assistant', content: 'ответ' },
    { role: 'user', content: 'другой вопрос' },
  ]);
  assert.equal(first, grown);
  // Compaction rewrites the opening turn, which is a different conversation.
  const compacted = serverInternals.conversationFingerprint([
    { role: 'user', content: '[compacted] пересказ прежнего диалога' },
  ]);
  assert.notEqual(first, compacted);
});

test('stream rate limits escalate until a real turn proves the account healthy', () => {
  const account = { id: 'account_1', cooldownUntil: 0, failures: 0, rateLimitStreak: 0 };
  const base = 300;

  // Repeated 429s must escalate instead of restarting at the base cooldown.
  const first = serverInternals.markRateLimited(account, 'too often');
  const second = serverInternals.markRateLimited(account, 'too often');
  const third = serverInternals.markRateLimited(account, 'too often');
  assert.equal(first, base);
  assert.equal(second, base * 2);
  assert.equal(third, base * 2, 'cooldown is capped');
  assert.equal(account.rateLimitStreak, 3);

  // A completed turn is the only thing that clears the streak.
  serverInternals.markAccountHealthy(account);
  assert.equal(account.rateLimitStreak, 0);
  assert.equal(account.failures, 0);
  assert.equal(serverInternals.markRateLimited(account, 'too often'), base, 'escalation restarts from the base cooldown');
});

test('markAccountHealthy tolerates a missing account and a clean one', () => {
  assert.doesNotThrow(() => serverInternals.markAccountHealthy(null));
  const clean = { id: 'account_2', cooldownUntil: 0, failures: 0, rateLimitStreak: 0 };
  serverInternals.markAccountHealthy(clean);
  assert.equal(clean.rateLimitStreak, 0);
});

test('upstream token counter overrides the chars/4 estimate', () => {
  const estimated = { promptTokens: 11, completionTokens: 3, reasoningTokens: 0 };

  // Live chat: the counter grew 450 -> 770, so the request really cost 320
  // tokens even though the delta prompt alone looks like 14.
  const live = serverInternals.resolveUpstreamUsage({ start: 450, total: 770 }, estimated);
  assert.equal(live.source, 'upstream');
  assert.equal(live.total_tokens, 320);
  assert.equal(live.prompt_tokens + live.completion_tokens, live.total_tokens);
  assert.ok(live.prompt_tokens > 0 && live.completion_tokens > 0);

  // First message of a chat starts the counter at zero.
  const fresh = serverInternals.resolveUpstreamUsage({ start: 0, total: 360 }, estimated);
  assert.equal(fresh.source, 'upstream');
  assert.equal(fresh.total_tokens, 360);
  assert.equal(fresh.prompt_tokens + fresh.completion_tokens, 360);

  // A counter that did not advance yields no information, so the estimate stands.
  for (const upstream of [null, undefined, {}, { start: 5, total: 5 }, { start: 9, total: 3 }, { start: 'x', total: 'y' }]) {
    const fallback = serverInternals.resolveUpstreamUsage(upstream, estimated);
    assert.equal(fallback.source, 'estimate', JSON.stringify(upstream));
    assert.equal(fallback.prompt_tokens, 11);
    assert.equal(fallback.completion_tokens, 3);
    assert.equal(fallback.total_tokens, 14);
  }
});

test('reported reasoning tokens never exceed the reported completion', () => {
  const usage = serverInternals.buildUsage('prompt', 'ok', 'x'.repeat(4000), { start: 100, total: 120 });
  assert.equal(usage.total_tokens, 20);
  assert.ok(usage.completion_tokens_details.reasoning_tokens <= usage.completion_tokens);
  assert.equal(usage.prompt_tokens + usage.completion_tokens, usage.total_tokens);
});

test('session persistence round-trips remote chat ids and drops expired entries', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'sessions.json');
  const now = Date.now();
  const saved = {
    version: 1,
    savedAt: now,
    sessions: [
      ['keep-me', {
        id: 'chat-abc', parentMessageId: 42, createdAt: now - 1000, messageCount: 7,
        accountId: 'account_1', history: [{ user: 'hi', assistant: 'yo' }],
        lastActivityAt: now - 60_000,
      }],
      ['too-old', {
        id: 'chat-gone', parentMessageId: 1, createdAt: now - 10_000_000, messageCount: 99,
        accountId: 'account_1', history: [], lastActivityAt: now - 10 * 60 * 60 * 1000,
      }],
    ],
  };
  fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });

  const sessions = serverInternals.sessions;
  sessions.clear();
  const restored = serverInternals.loadPersistedSessions(file);
  assert.equal(restored, 1);
  assert.ok(sessions.has('keep-me'));
  assert.equal(sessions.get('keep-me').id, 'chat-abc');
  assert.equal(sessions.get('keep-me').parentMessageId, 42);
  assert.equal(sessions.get('keep-me').messageCount, 7);
  assert.equal(sessions.get('keep-me').accountId, 'account_1');
  // An entry past the session TTL points at a remote chat DeepSeek has dropped.
  assert.equal(sessions.has('too-old'), false);

  // Serialization must keep exactly the fields a restored session needs.
  const round = serverInternals.serializeSession(sessions.get('keep-me'));
  assert.equal(round.id, 'chat-abc');
  assert.equal(round.parentMessageId, 42);
  assert.equal(round.messageCount, 7);
  assert.deepEqual(round.history, [{ user: 'hi', assistant: 'yo' }]);
  sessions.clear();
});

test('a corrupt session file is ignored instead of breaking startup', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'sessions.json');
  fs.writeFileSync(file, '{ this is not json');
  const sessions = serverInternals.sessions;
  sessions.clear();
  assert.equal(serverInternals.loadPersistedSessions(file), 0);
  assert.equal(sessions.size, 0);
  // A missing file is the normal first-boot case, not an error.
  assert.equal(serverInternals.loadPersistedSessions(path.join(dir, 'missing.json')), 0);
  sessions.clear();
});

test('failed tool markup is dumped to a file so the format can be fixed offline', () => {
  const first = 'half-written tool call: {"tool_call": {"name": "read_file"';
  const repair = '{"tool_call":{"name":"read_file","argu';
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('deepseek_response_')));
  const file = serverInternals.dumpFailedToolMarkup('unit-test', first, repair);
  assert.ok(file, 'dump path must be returned');
  const saved = fs.readFileSync(file, 'utf8');
  assert.match(saved, /unit-test/);
  assert.match(saved, /half-written tool call/);
  assert.match(saved, /"argu/);
  fs.rmSync(file, { force: true });
  const after = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('deepseek_response_') && !before.has(f));
  assert.deepEqual(after, [], 'no dump files may be left behind');
});

test('tool schema compaction drops prose annotations but preserves validation shape', () => {
  const compact = serverInternals.compactToolSchema({
    type: 'object',
    description: 'large top-level description',
    properties: {
      command: { type: 'string', description: 'large property description' },
      count: { type: 'integer', minimum: 1 },
      description: { type: 'string', description: 'annotation, not the property name' },
      title: { type: 'boolean', title: 'annotation, not the property name' },
      nested: {
        anyOf: [
          { type: 'string', description: 'remove from array item one' },
          { type: 'integer', title: 'remove from array item two' },
        ],
      },
    },
    required: ['command', 'description', 'title'],
  });

  assert.deepEqual(compact, {
    type: 'object',
    properties: {
      command: { type: 'string' },
      count: { type: 'integer', minimum: 1 },
      description: { type: 'string' },
      title: { type: 'boolean' },
      nested: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    },
    required: ['command', 'description', 'title'],
  });
});

test('tool schema compaction preserves literal const, enum, and default values', () => {
  const literals = {
    type: 'object',
    description: 'drop this annotation',
    const: { description: 'literal field', title: 'literal title', nested: { examples: ['literal'] } },
    enum: [
      { description: 'first', value: 1 },
      { title: 'second', value: 2 },
    ],
    default: { description: 'default literal', title: 'default title' },
    properties: {
      choice: {
        description: 'drop nested annotation',
        const: { description: 'required argument value', title: 'keep me' },
      },
    },
  };

  assert.deepEqual(serverInternals.compactToolSchema(literals), {
    type: 'object',
    const: literals.const,
    enum: literals.enum,
    default: literals.default,
    properties: {
      choice: { const: literals.properties.choice.const },
    },
  });
});

test('delta prompt sends only the new tail once the remote chat is in sync', () => {
  const session = serverInternals.createSession();
  session.id = 'remote-1';
  session.messageCount = 4;
  session.history.push({ user: 'q1', assistant: 'a1' });
  session.history.push({ user: 'q2', assistant: 'final answer' });

  const messages = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'final answer' },
    { role: 'user', content: 'next question' },
  ];
  const delta = serverInternals.selectDeltaMessages(messages, session);
  assert.deepEqual(delta, [{ role: 'user', content: 'next question' }]);
  assert.equal(serverInternals.formatMessages(delta, []).prompt, 'User: next question');
});

test('delta prompt falls back to the full transcript on any divergence', () => {
  const session = serverInternals.createSession();
  session.id = 'remote-1';
  session.history.push({ user: 'q2', assistant: 'final answer' });

  // No remote session yet — nothing to continue.
  const noSession = serverInternals.createSession();
  assert.equal(serverInternals.selectDeltaMessages([{ role: 'user', content: 'q' }], noSession), null);

  // Empty history — cannot prove sync.
  const emptyHistory = serverInternals.createSession();
  emptyHistory.id = 'remote-1';
  assert.equal(serverInternals.selectDeltaMessages([{ role: 'user', content: 'q' }], emptyHistory), null);

  // Last assistant turn differs (client edited/compacted it) — full transcript.
  const diverged = [
    { role: 'assistant', content: 'final answer' },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: 'some other reply' },
    { role: 'user', content: 'newest' },
  ];
  assert.equal(serverInternals.selectDeltaMessages(diverged, session), null);

  // Matching turn but no new user/tool input after it — full transcript.
  const noNewInput = [
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'final answer' },
  ];
  assert.equal(serverInternals.selectDeltaMessages(noNewInput, session), null);

  // Client history without any assistant turn at all — full transcript.
  assert.equal(serverInternals.selectDeltaMessages([{ role: 'user', content: 'q2' }], session), null);
});

test('delta prompt matches tool-call assistant turns and carries tool results', () => {
  const session = serverInternals.createSession();
  session.id = 'remote-1';
  session.history.push({
    user: 'read the file',
    assistant: 'TOOL_CALL: read_file\narguments: {"path":"a.txt"}',
  });

  const messages = [
    { role: 'user', content: 'read the file' },
    {
      role: 'assistant',
      tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'tool', content: 'file body' },
  ];
  const delta = serverInternals.selectDeltaMessages(messages, session);
  assert.deepEqual(delta, [{ role: 'tool', content: 'file body' }]);
  assert.match(serverInternals.formatMessages(delta, []).prompt, /\[Tool Result\]/);

  assert.equal(
    serverInternals.serializeAssistantTurn(messages[1]),
    'TOOL_CALL: read_file\narguments: {"path":"a.txt"}',
  );
  assert.equal(serverInternals.serializeAssistantTurn({ role: 'user', content: 'x' }), null);
});

test('recovery buffer and timeouts stay small and generous by default', () => {
  assert.equal(serverInternals.MAX_HISTORY_LENGTH, 3);
  assert.equal(serverInternals.MAX_HISTORY_CHARS, 2000);
  assert.equal(serverInternals.DS_FETCH_TIMEOUT_MS, 180000);
  assert.equal(serverInternals.REQUEST_DEADLINE_MS, 300000);
});

test('stream-level "sending too often" notices are recognised in every locale', () => {
  assert.equal(serverInternals.isRateLimitMessage({ content: '请求过于频繁，请稍后再试' }), true);
  assert.equal(serverInternals.isRateLimitMessage({ content: 'You are sending messages too often' }), true);
  assert.equal(serverInternals.isRateLimitMessage({ content: 'rate limit exceeded' }), true);
  assert.equal(serverInternals.isRateLimitMessage({ content: 'Слишком часто повторяется запрос' }), true);
  assert.equal(serverInternals.isRateLimitMessage({ content: 'Maximum context length exceeded' }), false);
  assert.equal(serverInternals.isRateLimitMessage({ content: 'Temporary backend overload' }), false);
  assert.equal(serverInternals.isRateLimitMessage(null), false);

  assert.deepEqual(
    serverInternals.classifyRecoveryFailure({ content: '请求过于频繁' }, false),
    { status: 429, type: 'rate_limit_error' },
  );
});

test('stream rate limit cools the account down with escalating backoff', () => {
  const account = { id: 'rl', cooldownUntil: 0, failures: 0, rateLimitStreak: 0 };
  const baseSec = Math.ceil(serverInternals.RATE_LIMIT_COOLDOWN_MS / 1000);
  const first = serverInternals.markRateLimited(account, 'too often');
  assert.equal(first, baseSec);
  assert.ok(account.cooldownUntil > Date.now());
  assert.equal(account.rateLimitStreak, 1);

  const second = serverInternals.markRateLimited(account, 'too often');
  assert.equal(second, baseSec * 2);
  assert.equal(account.rateLimitStreak, 2);

  // Escalation is capped by the 10-minute account cooldown, never beyond it.
  account.rateLimitStreak = 20;
  const capped = serverInternals.markRateLimited(account, 'too often');
  assert.equal(capped, 600);
  assert.ok(account.cooldownUntil - Date.now() <= 10 * 60 * 1000);
});

test('a new chat starts from a smaller prompt budget than a live one', () => {
  assert.equal(serverInternals.FRESH_SESSION_PROMPT_CHARS, 24000);
  const big = `TASK\n${'x'.repeat(120000)}\nTAIL`;
  const fresh = serverInternals.buildBoundedPrompt('sys', '', big, serverInternals.FRESH_SESSION_PROMPT_CHARS);
  assert.equal(fresh.compacted, true);
  assert.ok(fresh.prompt.length <= 24000);
  assert.match(fresh.prompt, /TASK/);
  assert.match(fresh.prompt, /TAIL/);
});

test('upstream call pacing keeps a gap between the calls of one logical turn', async () => {
  const account = { id: 'gap', lastUpstreamCallAt: 0 };
  assert.equal(await serverInternals.paceUpstreamCall(account, 0), 0);

  const gapMs = 60;
  await serverInternals.paceUpstreamCall(account, gapMs);
  const startedAt = Date.now();
  const waited = await serverInternals.paceUpstreamCall(account, gapMs);
  assert.ok(waited >= gapMs - 10, `expected ~${gapMs}ms between upstream calls, got ${waited}ms`);
  assert.ok(Date.now() - startedAt >= gapMs - 10);
  assert.equal(serverInternals.UPSTREAM_CALL_GAP_MS, 700);
});

test('buildBoundedPrompt preserves task edges and drops duplicate recovery history', () => {
  const system = `SYSTEM_START\n${'s'.repeat(50000)}\nTOOL_ADAPTER_END`;
  const history = `[Previous conversation]\n${'h'.repeat(10000)}\n`;
  const conversation = `TASK_START\n${'c'.repeat(70000)}\nLATEST_TOOL_RESULT`;
  const bounded = serverInternals.buildBoundedPrompt(system, history, conversation, 20000);

  assert.equal(bounded.compacted, true);
  assert.equal(bounded.historyDropped, true);
  assert.ok(bounded.prompt.length <= 20000);
  assert.match(bounded.prompt, /SYSTEM_START/);
  assert.match(bounded.prompt, /TOOL_ADAPTER_END/);
  assert.match(bounded.prompt, /TASK_START/);
  assert.match(bounded.prompt, /LATEST_TOOL_RESULT/);
  assert.doesNotMatch(bounded.prompt, /Previous conversation/);
});

test('client-provided multi-turn history suppresses server recovery-history injection', () => {
  assert.equal(serverInternals.hasExplicitConversationHistory([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'hello' },
  ]), false);
  assert.equal(serverInternals.hasExplicitConversationHistory([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'tool', content: 'result' },
  ]), true);
});

test('context-too-long detector recognizes DeepSeek localized errors', () => {
  assert.equal(serverInternals.isContextTooLongError({ content: 'Содержание слишком длинное. Сократите его и попробуйте снова.' }), true);
  assert.equal(serverInternals.isContextTooLongError({ content: 'Maximum context length exceeded' }), true);
  assert.equal(serverInternals.isContextTooLongError({ content: 'Temporary backend overload' }), false);
});

test('empty-response retry keeps recovery history unless a smaller global cap requires compaction', () => {
  const system = 'SYSTEM';
  const history = '[Previous conversation]\nUser: old\nAssistant: answer\n\n[Continue from here]\n\n';
  const conversation = 'User: follow up';
  const initial = serverInternals.buildBoundedPrompt(system, history, conversation, 5000);
  const unchangedRetry = serverInternals.buildRetryPrompt(system, history, conversation, initial.prompt, 4000);

  assert.equal(unchangedRetry.compacted, false);
  assert.match(unchangedRetry.prompt, /Previous conversation/);
  assert.match(unchangedRetry.prompt, /Assistant: answer/);

  const largeConversation = `TASK_START\n${'x'.repeat(9000)}\nLATEST_RESULT`;
  const largeInitial = serverInternals.buildBoundedPrompt(system, history, largeConversation, 8000);
  const smallerRetry = serverInternals.buildRetryPrompt(system, history, largeConversation, largeInitial.prompt, 4000);
  assert.equal(smallerRetry.compacted, true);
  assert.ok(smallerRetry.prompt.length <= 4000);
  assert.match(smallerRetry.prompt, /TASK_START/);
  assert.match(smallerRetry.prompt, /LATEST_RESULT/);
});

test('fresh-session retry restores local history that a healthy remote session initially omitted', () => {
  const system = 'SYSTEM';
  const history = serverInternals.buildRecoveryHistoryPrefix([
    { user: 'original task', assistant: 'original answer' },
  ]);
  const conversation = 'User: follow up';
  const establishedSessionPrompt = serverInternals.buildBoundedPrompt(system, '', conversation, 5000).prompt;
  const freshSessionRetry = serverInternals.buildRetryPrompt(
    system,
    history,
    conversation,
    establishedSessionPrompt,
    5000,
  );

  assert.ok(freshSessionRetry.prompt.length > establishedSessionPrompt.length);
  assert.match(freshSessionRetry.prompt, /Previous conversation/);
  assert.match(freshSessionRetry.prompt, /original task/);
  assert.match(freshSessionRetry.prompt, /original answer/);
  assert.match(freshSessionRetry.prompt, /follow up/);
});

test('remote reset preserves local history and sticky account while returning failure diagnostics', () => {
  const session = serverInternals.createSession();
  session.id = 'failed-session';
  session.parentMessageId = 'parent';
  session.createdAt = 123;
  session.messageCount = 17;
  session.accountId = 'account_2';
  session.history.push({ user: 'old task', assistant: 'old answer' });

  const failure = serverInternals.resetRemoteSession(session);
  assert.deepEqual(failure, {
    failedSessionId: 'failed-session',
    failedMessageCount: 17,
    accountId: 'account_2',
  });
  assert.equal(session.id, null);
  assert.equal(session.parentMessageId, null);
  assert.equal(session.createdAt, null);
  assert.equal(session.messageCount, 0);
  assert.equal(session.accountId, 'account_2');
  assert.equal(session.history.length, 1);
});

test('short sticky cooldown waits it out and preserves the remote session', async (t) => {
  const originalAccounts = serverInternals.accounts.splice(0);
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
  });

  serverInternals.accounts.push(
    {
      id: 'cooling',
      config: { token: 'one', cookie: 'one' },
      cooldownUntil: Date.now() + 40,
      headers: {},
      nextSlotAt: 0,
    },
    {
      id: 'ready',
      config: { token: 'two', cookie: 'two' },
      cooldownUntil: 0,
      headers: {},
      nextSlotAt: 0,
    },
  );
  const session = serverInternals.createSession();
  session.id = 'sticky-session';
  session.parentMessageId = 'sticky-parent';
  session.accountId = 'cooling';
  session.messageCount = 7;
  session.history.push({ user: 'old task', assistant: 'old answer' });

  const selected = await serverInternals.selectAccountForSession(session);
  assert.equal(selected.id, 'cooling');
  assert.equal(session.accountId, 'cooling');
  assert.equal(session.id, 'sticky-session');
  assert.equal(session.parentMessageId, 'sticky-parent');
  assert.equal(session.messageCount, 7);
  assert.equal(session.history.length, 1);
});

test('long sticky cooldown returns 429 without resetting the session', async (t) => {
  const originalAccounts = serverInternals.accounts.splice(0);
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
  });

  serverInternals.accounts.push(
    {
      id: 'cooling-long',
      config: { token: 'one', cookie: 'one' },
      cooldownUntil: Date.now() + serverInternals.STICKY_WAIT_MS + 60_000,
      headers: {},
      nextSlotAt: 0,
    },
    {
      id: 'ready',
      config: { token: 'two', cookie: 'two' },
      cooldownUntil: 0,
      headers: {},
      nextSlotAt: 0,
    },
  );
  const session = serverInternals.createSession();
  session.id = 'sticky-session';
  session.parentMessageId = 'sticky-parent';
  session.accountId = 'cooling-long';
  session.messageCount = 7;
  session.history.push({ user: 'old task', assistant: 'old answer' });

  await assert.rejects(
    () => serverInternals.selectAccountForSession(session),
    (err) => err.status === 429 && err.type === 'rate_limit' && err.retryAfter > 0,
  );
  assert.equal(session.id, 'sticky-session');
  assert.equal(session.parentMessageId, 'sticky-parent');
  assert.equal(session.accountId, 'cooling-long');
  assert.equal(session.history.length, 1);
});

test('account rotation clears a foreign remote session only when the sticky account is gone', async (t) => {
  const originalAccounts = serverInternals.accounts.splice(0);
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
  });

  // Sticky account vanished from the pool entirely (not merely cooling down).
  serverInternals.accounts.push(
    {
      id: 'ready',
      config: { token: 'two', cookie: 'two' },
      cooldownUntil: 0,
      headers: {},
      nextSlotAt: 0,
    },
  );
  const session = serverInternals.createSession();
  session.id = 'foreign-session';
  session.parentMessageId = 'foreign-parent';
  session.accountId = 'missing';
  session.messageCount = 7;
  session.history.push({ user: 'old task', assistant: 'old answer' });

  const selected = await serverInternals.selectAccountForSession(session);
  assert.equal(selected.id, 'ready');
  assert.equal(session.accountId, 'ready');
  assert.equal(session.id, null);
  assert.equal(session.parentMessageId, null);
  assert.equal(session.messageCount, 0);
  assert.equal(session.history.length, 1);
});

test('upstream pacing spaces consecutive slots on the same account', async () => {
  const account = { id: 'paced', nextSlotAt: 0 };
  const intervalMs = 80;

  const first = await serverInternals.acquireAccountSlot(account, intervalMs, 0);
  assert.equal(first, 0);
  assert.ok(account.nextSlotAt > Date.now() - intervalMs);

  const startedAt = Date.now();
  const second = await serverInternals.acquireAccountSlot(account, intervalMs, 0);
  const elapsed = Date.now() - startedAt;
  assert.ok(second >= intervalMs - 10, `expected ~${intervalMs}ms wait, got ${second}ms`);
  assert.ok(elapsed >= intervalMs - 10, `expected elapsed >= ${intervalMs}ms, got ${elapsed}ms`);

  const disabled = await serverInternals.acquireAccountSlot({ id: 'off', nextSlotAt: 0 }, 0);
  assert.equal(disabled, 0);
});

test('upstream pacing jitter only ever lengthens the gap', async () => {
  const account = { id: 'jittered', nextSlotAt: 0 };
  await serverInternals.acquireAccountSlot(account, 60, 0);
  const firstSlot = account.nextSlotAt;

  for (let i = 0; i < 5; i++) {
    const before = account.nextSlotAt;
    const wait = await serverInternals.acquireAccountSlot(account, 60, 400);
    assert.ok(wait >= 50, `jitter shortened the wait to ${wait}ms`);
    // Assert on the absolute reservation, not on a remaining-time measurement:
    // an event-loop stall elsewhere in the suite must not fail a scheduling test.
    assert.ok(account.nextSlotAt > before, `jitter did not push the slot out: ${before} -> ${account.nextSlotAt}`);
  }
  assert.ok(firstSlot > 0);
});

test('default upstream pacing leaves a wide, jittered gap', () => {
  assert.equal(serverInternals.MIN_REQUEST_INTERVAL_MS, 5000);
  assert.equal(serverInternals.REQUEST_JITTER_MS, 2000);
});

test('cross-account continuation is accepted only with a fresh recovery prompt', () => {
  assert.equal(serverInternals.isContinuationRecoverySafe('one', {
    account: { id: 'one' },
    freshSessionReset: false,
  }), true);
  assert.equal(serverInternals.isContinuationRecoverySafe('one', {
    account: { id: 'two' },
    freshSessionReset: true,
  }), true);
  assert.equal(serverInternals.isContinuationRecoverySafe('one', {
    account: { id: 'two' },
    freshSessionReset: false,
  }), false);
});

test('TTL and depth rollover happens before prompt construction and preserves recovery state', () => {
  const depthSession = serverInternals.createSession();
  depthSession.id = 'deep-session';
  depthSession.messageCount = serverInternals.MAX_MESSAGE_DEPTH;
  depthSession.accountId = 'account_1';
  depthSession.history.push({ user: 'u', assistant: 'a' });
  const depthReset = serverInternals.prepareSessionForPrompt(depthSession, Date.now());
  assert.equal(depthReset.reason, 'max_message_depth');
  assert.equal(depthSession.id, null);
  assert.equal(depthSession.history.length, 1);
  assert.equal(depthSession.accountId, 'account_1');

  const now = Date.now();
  const ttlSession = serverInternals.createSession();
  ttlSession.id = 'old-session';
  ttlSession.createdAt = now - serverInternals.SESSION_TTL_MS - 1;
  const ttlReset = serverInternals.prepareSessionForPrompt(ttlSession, now);
  assert.equal(ttlReset.reason, 'session_ttl');
  assert.equal(ttlReset.failedSessionId, 'old-session');

  const freshTtlSession = serverInternals.createSession();
  freshTtlSession.id = 'recent-session';
  freshTtlSession.createdAt = now - Math.floor(serverInternals.SESSION_TTL_MS / 2);
  assert.equal(serverInternals.prepareSessionForPrompt(freshTtlSession, now), null);
});

test('tool results use the global prompt cap instead of an unconditional 8k truncation', () => {
  const toolResult = `RESULT_START\n${'z'.repeat(12000)}\nRESULT_END`;
  const formatted = serverInternals.formatMessages([
    { role: 'user', content: 'inspect this' },
    { role: 'tool', content: toolResult },
  ], []);

  assert.match(formatted.prompt, /RESULT_START/);
  assert.match(formatted.prompt, /RESULT_END/);
  assert.ok(formatted.prompt.length > 12000);

  const bounded = serverInternals.buildBoundedPrompt(formatted.systemPrompt, '', formatted.prompt, 5000);
  assert.equal(bounded.compacted, true);
  assert.ok(bounded.prompt.length <= 5000);
  assert.match(bounded.prompt, /RESULT_END/);
});

test('retry state clears a stale finish reason and failure classes use protocol-appropriate status codes', () => {
  const retry = serverInternals.normalizeRetryResponse({ content: 'recovered', finishReason: null });
  assert.equal(retry.finishReason, null);

  assert.deepEqual(
    serverInternals.classifyRecoveryFailure({ content: 'Maximum context length exceeded' }, false),
    { status: 400, type: 'context_length_exceeded' },
  );
  assert.deepEqual(
    serverInternals.classifyRecoveryFailure(null, true),
    { status: 504, type: 'request_timeout' },
  );
  assert.deepEqual(
    serverInternals.classifyRecoveryFailure(null, false),
    { status: 502, type: 'empty_response' },
  );
  assert.equal(serverInternals.isTimeoutError({ name: 'TimeoutError', message: 'operation timed out' }), true);
  assert.equal(serverInternals.isTimeoutError(new Error('ordinary upstream error')), false);
});

test('context-compaction header is marked and exposed to browser clients', () => {
  const headers = new Map();
  const response = { setHeader: (name, value) => headers.set(name, value) };
  serverInternals.setCorsResponseHeaders(response);
  serverInternals.markContextCompacted(response);

  assert.equal(headers.get('Access-Control-Expose-Headers'), serverInternals.CONTEXT_COMPACTED_HEADER);
  assert.equal(headers.get(serverInternals.CONTEXT_COMPACTED_HEADER), 'true');
});

test('stream helpers preserve the request-level exact CORS origin', () => {
  const response = {
    id: 'ds-test',
    created: 1,
    model: 'deepseek-chat',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  for (const send of [
    serverInternals.sendAnthropicStream,
    serverInternals.sendResponsesStream,
    serverInternals.sendOpenAIStream,
  ]) {
    let writeHeadHeaders = null;
    const res = {
      writeHead: (_status, headers) => { writeHeadHeaders = headers; },
      write: () => {},
      end: () => {},
    };
    send(res, response);
    assert.equal(Object.hasOwn(writeHeadHeaders, 'Access-Control-Allow-Origin'), false);
  }
});
