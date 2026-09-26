# FreeDeepseekAPI

<p align="center">
  <strong>Локальный OpenAI-compatible API proxy для DeepSeek Web Chat</strong>
</p>

<p align="center">
  <a href="https://github.com/ForgetMeAI/FreeDeepseekAPI/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
  <img alt="Node.js 18 plus" src="https://img.shields.io/badge/node-18%2B-339933.svg" />
  <img alt="No npm dependencies" src="https://img.shields.io/badge/dependencies-0-blue.svg" />
  <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-111111.svg" />
</p>

<p align="center">
  <a href="#-быстрый-старт">Быстрый старт</a> •
  <a href="#-возможности">Возможности</a> •
  <a href="#-примеры-запросов">Примеры</a> •
  <a href="#-модели">Модели</a> •
  <a href="#-endpoints">Endpoints</a> •
  <a href="#-open-webui">Open WebUI</a>
</p>

FreeDeepseekAPI поднимает локальный API-сервер для **DeepSeek Web Chat** (`chat.deepseek.com`) и позволяет подключать DeepSeek Web к Open WebUI, LiteLLM, Hermes, Claude Code, OpenAI SDK-style клиентам и другим OpenAI-compatible инструментам.

Проект работает через ваш обычный залогиненный аккаунт DeepSeek в отдельном Chrome-профиле. Локальный сервер принимает API-запросы, а дальше сам ходит в DeepSeek Web через сохранённую browser-сессию.

> ⚠️ Это экспериментальный web-chat proxy. DeepSeek может менять внутренний Web API без предупреждения. Для production-кейсов надёжнее официальный платный API DeepSeek.

ForgetMeAI: https://t.me/forgetmeai

---

## Навигация

- [Что это даёт](#-что-это-даёт)
- [Возможности](#-возможности)
- [Быстрый старт](#-быстрый-старт)
- [Windows запуск](#-windows-запуск)
- [Linux / Chromium запуск](#-linux--chromium-запуск)
- [VPS / headless запуск](#-vps--headless-запуск)
- [Rootless Podman](#-rootless-podman)
- [Diagnostics / doctor](#-diagnostics--doctor)
- [Session reuse и сброс чатов](#-session-reuse-и-сброс-чатов)
- [Multi-account pool](#-multi-account-pool)
- [Идеи для консольной авторизации](#-идеи-для-консольной-авторизации)
- [Проверка работы](#-проверка-работы)
- [Примеры запросов](#-примеры-запросов)
  - [Chat Completions](#chat-completions)
  - [Reasoning](#reasoning)
  - [Web search](#web-search)
  - [Streaming](#streaming)
  - [Anthropic Messages API](#anthropic-messages-api)
  - [OpenAI Responses API](#openai-responses-api)
  - [Tool calling](#tool-calling)
- [Модели](#-модели)
- [Endpoints](#-endpoints)
- [Open WebUI](#-open-webui)
- [Обновить логин](#-обновить-логин)
- [Статус проекта](#-статус-проекта)

---

## ✨ Что это даёт

- Использовать DeepSeek Web как локальный API endpoint.
- Подключать DeepSeek к Open WebUI и другим OpenAI-compatible клиентам.
- Получать обычные JSON-ответы или streaming SSE.
- Использовать reasoning-модели с отдельным `reasoning_content`.
- Работать с Anthropic Messages API shim для Claude Code / Anthropic SDK.
- Использовать OpenAI Responses API shim для новых OpenAI/Codex-style клиентов.
- Держать отдельные web-сессии для разных агентов/users.

## 🚀 Возможности

- **OpenAI-compatible API:** `POST /v1/chat/completions`
- **Anthropic-compatible shim:** `POST /v1/messages`
- **OpenAI Responses shim:** `POST /v1/responses`
- **Streaming:** SSE chunks и обычные non-stream JSON-ответы
- **Reasoning output:** отдельный `reasoning_content` для thinking-моделей
- **Tool calling:** парсинг OpenAI tools, Anthropic tools и Responses function tools
- **Model capabilities:** `GET /v1/model-capabilities` с alias → real web mode
- **Agent sessions:** отдельная DeepSeek-сессия на `user` / agent id
- **Session recovery:** авто-сброс устаревших chains/sessions
- **Zero dependencies:** Node.js 18+, без npm-зависимостей

---

## ⚡ Быстрый старт

```bash
git clone https://github.com/ForgetMeAI/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

`npm run auth` открывает меню авторизации:

1. выберите пункт `1`;
2. войдите в DeepSeek в отдельном Chrome-профиле;
3. отправьте короткое сообщение вроде `ok`;
4. вернитесь в терминал и нажмите Enter.

`npm start` показывает меню запуска:

- `1` — авторизоваться / обновить DeepSeek login
- `2` — показать модели и статусы
- `3` — запустить proxy
- `4` — выйти

Для headless/CI-запуска без меню:

```bash
NON_INTERACTIVE=1 npm start
# или
SKIP_ACCOUNT_MENU=1 npm start
```

По умолчанию сервер слушает:

```text
http://localhost:9655
```

По умолчанию proxy доступен только с этого компьютера. Для доступа из сети
явно задайте адрес и отдельный ключ proxy:

```bash
HOST=0.0.0.0 PROXY_API_KEY='replace-with-a-long-random-value' npm start
```

После этого передавайте ключ как `Authorization: Bearer <key>`. Без
`PROXY_API_KEY` non-health endpoints остаются без авторизации, поэтому не
публикуйте такой экземпляр в сеть.

Browser-запросы разрешены с loopback-origin. Если UI открыт на другом адресе,
добавьте его точный origin через запятую, например
`PROXY_CORS_ORIGINS=https://ui.example.com,http://192.168.1.20:3000`.

---

## 🪟 Windows запуск

```powershell
git clone https://github.com/ForgetMeAI/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

Если Chrome установлен нестандартно, явно укажите путь:

```powershell
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm run auth
```

Если Chrome не найден, `npm run auth` теперь печатает готовые инструкции для Windows/macOS/Linux вместо загадочного stack trace.

---

## 🐧 Linux / Chromium запуск

```bash
git clone https://github.com/ForgetMeAI/FreeDeepseekAPI.git
cd FreeDeepseekAPI
CHROME_PATH=$(which chromium) npm run auth
npm start
```

Если Chromium называется иначе:

```bash
CHROME_PATH=$(which chromium-browser) npm run auth
# или
CHROME_PATH=$(which google-chrome) npm run auth
```

---

## 🖥 VPS / headless запуск

Самый надёжный flow без Chrome на сервере:

1. На домашнем ПК, где есть GUI/Chrome:

```bash
npm run auth
```

2. Скопируйте `deepseek-auth.json` на VPS:

```bash
scp deepseek-auth.json user@your-vps:/opt/FreeDeepseekAPI/deepseek-auth.json
```

3. На VPS импортируйте/проверьте файл и выставьте безопасные права:

```bash
cd /opt/FreeDeepseekAPI
npm run auth:import -- --input ./deepseek-auth.json
npm run doctor -- --offline
```

4. Запускайте proxy без интерактивного меню:

```bash
NON_INTERACTIVE=1 npm start
```

Можно импортировать не только готовый `deepseek-auth.json`, но и browser cookie export:

```bash
DEEPSEEK_TOKEN="<token>" npm run auth:import -- --input ./cookies.json
```

> Важно: `deepseek-auth.json` — это доступ к вашему DeepSeek Web login. Не коммитьте, не публикуйте, храните с правами `0600`.

---

## 🦭 Rootless Podman

Контейнер предназначен только для non-interactive запуска proxy. Авторизацию
через браузер выполните на хосте командой `npm run auth`: auth-скрипты и
`deepseek-auth.json` в образ не копируются.

Запускайте Podman обычным пользователем, без `sudo`.

1. Соберите локальный образ:

```bash
podman build --tag localhost/free-deepseek-api:local --file Containerfile .
```

2. Передайте DeepSeek auth и отдельный ключ proxy через Podman secrets:

```bash
podman secret create --replace free-deepseek-auth ./deepseek-auth.json

printf 'Proxy API key: '
IFS= read -r -s PROXY_API_KEY
printf '\n'
printf '%s' "$PROXY_API_KEY" |
  podman secret create --replace free-deepseek-proxy-key -
```

Используйте длинный случайный ключ. Значение останется в переменной
`PROXY_API_KEY` текущего shell, чтобы проверить API; оно не попадает в образ или
командную строку Podman.

3. Запустите контейнер с минимальными привилегиями:

```bash
podman run --detach \
  --name free-deepseek-api \
  --publish 127.0.0.1:9655:9655 \
  --secret free-deepseek-auth,target=deepseek-auth.json,uid=1000,gid=1000,mode=0400 \
  --secret free-deepseek-proxy-key,target=proxy-api-key,uid=1000,gid=1000,mode=0400 \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  localhost/free-deepseek-api:local
```

Внутри контейнера заранее выставлены `NON_INTERACTIVE=1`, `HOST=0.0.0.0` и
пути к обоим secrets. `REQUIRE_PROXY_API_KEY=1` не даст контейнеру запуститься,
если secret с ключом отсутствует или пуст. На хосте порт публикуется только на
`127.0.0.1`; не убирайте этот адрес без отдельного сетевого firewall/access
policy.

4. Проверьте liveness, readiness аккаунта и защищённый endpoint:

```bash
podman healthcheck run free-deepseek-api
curl --fail http://127.0.0.1:9655/readyz
curl --fail \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  http://127.0.0.1:9655/v1/models
```

Встроенный healthcheck проверяет локальный `/health` (жив ли процесс).
`/readyz` дополнительно вернёт `503`, если ни один DeepSeek auth-аккаунт сейчас
не готов обслуживать запросы. Диагностика контейнера:

```bash
podman logs free-deepseek-api
podman inspect --format '{{.State.Health.Status}}' free-deepseek-api
```

Остановка и удаление контейнера вместе с сохранёнными Podman secrets:

```bash
podman stop free-deepseek-api
podman rm free-deepseek-api
podman secret rm free-deepseek-auth free-deepseek-proxy-key
unset PROXY_API_KEY
```

При ротации auth или proxy key замените соответствующий secret и пересоздайте
контейнер, чтобы поведение не зависело от версии Podman.

---

## 🩺 Diagnostics / doctor

```bash
npm run doctor
# без сетевых запросов к DeepSeek:
npm run doctor -- --offline
```

`doctor` проверяет:

- найден ли пул `data/accounts/*.json` / `DEEPSEEK_AUTH_DIR` / `deepseek-auth.json`;
- валидный ли JSON;
- есть ли `token`, `cookie`, `wasmUrl`;
- безопасные ли права файла на macOS/Linux (`0600`);
- при обычном запуске — доступен ли DeepSeek PoW endpoint.

Если видите `data.biz_data is null`, `fetch failed`, `401/403/429` или Hermes/OpenCode не видит модели — первым делом запускайте `npm run doctor`.

---

## ♻️ Session reuse и сброс чатов

FreeDeepseekAPI не создаёт новый DeepSeek чат на каждый HTTP-запрос без причины. Логика такая:

- один `x-agent-session`, `session` или `user` → одна DeepSeek chat session;
- если session id уже есть — proxy переиспользует его и продолжает chain через `parent_message_id`;
- auto-reset происходит при TTL, ошибке DeepSeek session или слишком длинной цепочке сообщений;
- локальная history сохраняется коротким контекстом, чтобы новая DeepSeek session могла продолжить разговор.
- длинные agent-запросы перед отправкой ограничиваются `DEEPSEEK_MAX_PROMPT_CHARS` (по умолчанию 80 000 символов): сохраняются начало задачи, свежие tool results и tool adapter;
- если клиент уже прислал multi-turn history, локальная recovery-history второй раз не добавляется;
- пустой ответ повторяется максимум `DEEPSEEK_MAX_RETRIES` раз (по умолчанию 2), причём на каждом retry контекст уменьшается.

### Сессии переживают рестарт прокси

Remote chat id — самая ценная часть сессии: именно он держит контекст на стороне DeepSeek и делает возможными delta-промпты. Поэтому он сохраняется на диск в `data/sessions.json` (права `0600`, файл в `.gitignore`) вместе с recovery-буфером и привязкой к аккаунту.

Перезапуск прокси теперь продолжает тот же разговор:

```
[DS-API] Restored 1 session(s) from sessions.json
[my-project/acct:account_1] Reusing session: af925b50-… (parent: 2, msg#1)
```

Запись атомарная (write + rename), при повреждённом файле прокси стартует с чистых сессий, а не падает. Сессии старше `DEEPSEEK_SESSION_TTL_MS` не восстанавливаются — такой remote chat DeepSeek всё равно выбросил. Отключить: `DEEPSEEK_PERSIST_SESSIONS=0`. Никакие токены и cookies в файл не пишутся, только идентификаторы чатов.

### Как клиент идентифицирует свою сессию

Прокси берёт ключ из первого доступного:

1. заголовок `x-agent-session` (имя можно сменить: `DEEPSEEK_AGENT_HEADER`);
2. `?session=` или поле `user`;
3. `DEEPSEEK_AGENT_ID` — жёстко закрепить один агент;
4. **отпечаток разговора** — хеш первой реплики пользователя;
5. адрес клиента (localhost без всего выше схлопывается в `dev-agent`).

Пункт 4 — то, что нужно opencode: он не шлёт заголовок сессии, но каждый ход отправляет **весь** транскрипт, а первая реплика пользователя в нём не меняется за всю жизнь чата. Поэтому каждый твой чат в opencode автоматически получает свой DeepSeek-чат (`conv-…` в логах) вместо общей ветки `dev-agent`. Компактизация opencode переписывает начало транскрипта — это считается новым разговором и начинает новый DeepSeek-чат, полный транскрипт уйдёт заново.

Отключить: `DEEPSEEK_AGENT_FINGERPRINT=0`. Увидеть, что реально присылает харнесс: `DEEPSEEK_DEBUG_SESSION=1` — в лог попадут все заголовки с `session|conversation|chat|user|agent|thread` в имени.

Своё имя сессии задаётся заголовком:

```bash
-H "x-agent-session: my-project-backend"
```

Явно задать agent/session:

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-agent-session: my-agent" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Привет"}]}'
```

Посмотреть активные sessions:

```bash
curl http://localhost:9655/v1/sessions
```

Сбросить одну session:

```bash
curl -X POST "http://localhost:9655/reset-session?agent=my-agent"
```

Сбросить все sessions:

```bash
curl -X POST "http://localhost:9655/reset-session?agent=all"
```

Почему чаты всё равно появляются в DeepSeek Web: proxy работает через внутренний Web Chat API, а DeepSeek хранит реальные chat sessions у себя. Это нормально для web-proxy. Задача session reuse — не плодить новые чаты без необходимости и аккуратно сбрасываться только когда chain протух/сломался.

Что делает proxy, чтобы чат жил максимально долго:

- **delta-промпты**: пока удалённый чат жив, отправляется только новая часть переписки, а не вся история заново (иначе контекст в облаке рос квадратично и чат умирал на 17-34 сообщениях). При любом расхождении — fallback на полную переписку, recovery-пути тоже всегда используют полную переписку;
- **таймаут не убивает чат**: истёкший бюджет времени не означает мёртвую сессию;
- **«слишком частые сообщения» лечатся**: DeepSeek часто отдаёт эту ошибку не как 429, а как текст ошибки внутри 200-ответа. Proxy её распознаёт (EN/RU/ZH), **охлаждает аккаунт** с нарастающей паузой (60с → 120с → …, потолок — cooldown аккаунта), **не трогает чат** и отдаёт клиенту `429` + `Retry-After`. Успешный ответ сбрасывает счётчик. Отдельные вызовы внутри одного хода (PoW, создание чата, completion) разнесены паузой `DEEPSEEK_UPSTREAM_CALL_GAP_MS`;
- **пустой ответ** сначала повторяется на том же чате, и только второй провал пересоздаёт сессию;
- **ремонт битой tool-разметки** тоже не пересоздаёт чат;
- **recovery-буфер маленький** (3 обмена / 2000 символов) — реальный контекст живёт в облаке DeepSeek, агент может перечитать нужное через tools. Настраивается `DEEPSEEK_MAX_HISTORY_LENGTH` / `DEEPSEEK_MAX_HISTORY_CHARS`.

---

## 👥 Multi-account pool

Можно подключить несколько auth-файлов. Правильная модель: sticky account per agent/session — proxy не переключает аккаунт внутри живой DeepSeek-сессии. Если аккаунт получил `401/403/429` и ушёл в cooldown, чат **не сбрасывается**: proxy ждёт выхода из cooldown (до `DEEPSEEK_STICKY_WAIT_MS`, дефолт 60с) либо отвечает `429` + `Retry-After`, чтобы клиент повторил позже на том же чате. Ротация на другой аккаунт (и сброс remote-сессии) происходит только если аккаунт пропал из пуля или потерял credentials.

Вариант 1 — пул в `data/accounts/` (дефолт, env не нужен):

```bash
mkdir -p data/accounts
chmod 700 data/accounts
mv deepseek-auth.json data/accounts/main.json
cp deepseek-auth-backup.json data/accounts/second.json
chmod 600 data/accounts/*.json
npm start
```

Каждый `data/accounts/*.json` = отдельный аккаунт. Скрипты авторизации пишут в тот же пул: `npm run auth` обновляет `data/accounts/main.json`, поэтому `npm run auth:import` / `npm run doctor` видят ровно те же файлы, что и сервер. Директория `data/accounts/` уже в `.gitignore` — токены не утекут в git (не используй `accounts/` в корне, он не игнорится).

Вариант 2 — произвольная директория через env:

```bash
DEEPSEEK_AUTH_DIR=/etc/deepseek-accounts NON_INTERACTIVE=1 npm start
```

Вариант 3 — список файлов:

```bash
DEEPSEEK_AUTH_PATH="./accounts/main.json,./accounts/backup.json" NON_INTERACTIVE=1 npm start
```

Как работает pool:

- новый agent/session получает доступный аккаунт round-robin;
- выбранный аккаунт закрепляется за session (`sticky`);
- при `401`, `403`, `429` аккаунт уходит в cooldown;
- если sticky-аккаунт session ушёл в cooldown — ждём его до `DEEPSEEK_STICKY_WAIT_MS` или отдаём `429` + `Retry-After`; **сессия не сбрасывается**, новый чат не создаётся;
- upstream-запросы на аккаунт разряжаются паузой `DEEPSEEK_MIN_REQUEST_INTERVAL_MS` (дефолт 5 сек) + случайный джиттер `DEEPSEEK_REQUEST_JITTER_MS` (0-2000 мс), чтобы реже ловить `429`;
- статус аккаунтов виден в `/health` без путей к auth-файлам и без имён файлов;
- auth-файлы должны храниться с правами `0600`.

Настроить cooldown и pacing:

```bash
DEEPSEEK_ACCOUNT_COOLDOWN_MS=600000 DEEPSEEK_MIN_REQUEST_INTERVAL_MS=5000 npm start
```

---

## 🔑 Идеи для консольной авторизации

Парольный flow из PR #3 можно делать, но безопаснее не хранить пароль и не делать это дефолтом. Нормальная реализация:

1. `npm run auth:console` спрашивает email/телефон и пароль через hidden prompt.
2. Пароль держится только в памяти процесса, не пишется в файлы/logs/history.
3. Скрипт повторяет Web login flow через `fetch`/CDP: получает captcha/verify challenge, отдаёт человеку ссылку/код, ждёт подтверждение.
4. После успешного login сохраняется только `deepseek-auth.json` стандартного формата.
5. Если DeepSeek просит captcha/2FA — скрипт честно говорит “открой ссылку, пройди проверку, нажми Enter”, а не пытается обходить защиту.
6. Для VPS лучше режим `auth:console --no-save-password --output deepseek-auth.json`.

Минимальный безопасный MVP: console auth только интерактивный, без env-пароля. Допустимый automation-вариант: `DEEPSEEK_EMAIL=... npm run auth:console`, но пароль всё равно вводится hidden prompt.

---

## ✅ Проверка работы

```bash
curl http://localhost:9655/
curl http://localhost:9655/v1/models
curl http://localhost:9655/v1/model-capabilities
```

Если всё ок, `/health` вернёт статус сервера, список поддерживаемых aliases и `config_ready: true`.

---

## 🧪 Примеры запросов

### Chat Completions

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Привет! Ответь одной фразой."}],
    "stream": false
  }'
```

### Reasoning

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "Реши коротко: почему небо голубое?"}],
    "stream": false
  }'
```

Для reasoning-моделей API отдаёт цепочку размышления отдельно от финального ответа:

- non-stream: `choices[0].message.reasoning_content`
- stream: `choices[0].delta.reasoning_content`
- usage: `usage.completion_tokens_details.reasoning_tokens`

`reasoning_tokens` — приблизительная оценка по извлечённому DeepSeek Web `THINK`-тексту, потому что web stream не отдаёт официальный token usage по reasoning отдельно.

### Учёт токенов

Прокси берёт **реальные** цифры от DeepSeek, а не оценивает их. В финальном patch-батче web-протокола приходит накопительный счётчик `accumulated_token_usage`; прирост счётчика за запрос — это фактически потраченные токены:

- `total_tokens` — точное значение от DeepSeek (накопительный счётчик чата минус его значение на старте хода);
- `prompt_tokens` / `completion_tokens` — пропорциональное деление этой точной суммы, потому что счётчик накопительный и из-за кэша промпта не делится однозначно на ввод и вывод; поэтому `prompt + completion === total` всегда сходится и подходит для расчёта стоимости;
- если счётчик не пришёл или не вырос — используется оценка `длина/4`.

Раньше оценка `длина/4` врала на порядок: дельта-промпт — это 2 сообщения поверх большого удалённого чата, который оценщик не видел. На живом примере ход стоил 348 токенов, а отдавалось 11.

Форматы ответа: OpenAI (`usage.prompt_tokens/completion_tokens/total_tokens`), Anthropic (`usage.input_tokens/output_tokens`), Responses (`usage.input_tokens/output_tokens/total_tokens`). В стриминге OpenAI-совместимый usage приходит отдельным чанком с пустым `choices` перед `data: [DONE]`; отключается `"stream_options": {"include_usage": false}`. Anthropic-стрим отдаёт usage в `message_start` и `message_delta`.

Оценить реальный расход по сессии можно так:

```bash
grep "usage:" logs/server.log
# [dev-agent] usage: upstream prompt=232 completion=116 total=348
```

### Web search

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat-search",
    "messages": [{"role": "user", "content": "Найди свежий факт про DeepSeek и ответь кратко."}],
    "stream": false
  }'
```

### Streaming

```bash
curl -N -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Напиши короткую шутку."}],
    "stream": true
  }'
```

### Anthropic Messages API

```bash
curl -X POST http://localhost:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Ответь ровно OK"}],
    "stream": false
  }'
```

Для Claude Code можно указывать backend напрямую:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
export ANTHROPIC_AUTH_TOKEN="dummy-key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model deepseek-chat
```

### OpenAI Responses API

```bash
curl -X POST http://localhost:9655/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": "Ответь ровно OK",
    "stream": false
  }'
```

### Tool calling

FreeDeepseekAPI принимает:

- OpenAI `tools`;
- Anthropic `tools`;
- Responses API function tools.

Прокси просит DeepSeek вернуть строгий JSON tool call, но также умеет парсить fallback-форматы:

- `TOOL_CALL:`
- fenced JSON with an explicit `tool_call`, `tool_calls`, or `function_call` envelope
- `<tool_call>...</tool_call>`
- DeepSeek DSML (`<｜DSML｜tool_calls>...`) и Web-вариант с `<｜｜DSML｜｜ Tool Calls>`

---

## 🧠 Модели

`GET /v1/models` возвращает только aliases, которые сейчас проверены и работают через этот proxy.

### Рабочие aliases

| Alias | Web mode | Reasoning | Web search | Комментарий |
| --- | --- | --- | --- | --- |
| `deepseek-chat` | `Быстрый` / `default` | нет | нет | базовый chat |
| `deepseek-v3` | `Быстрый` / `default` | нет | нет | совместимый alias |
| `deepseek-default` | `Быстрый` / `default` | нет | нет | совместимый alias |
| `deepseek-reasoner` | `Быстрый` / `default` | да | нет | `thinking_enabled=true` |
| `deepseek-r1` | `Быстрый` / `default` | да | нет | R1-compatible alias |
| `deepseek-chat-search` | `Быстрый` / `default` | нет | да | web search |
| `deepseek-default-search` | `Быстрый` / `default` | нет | да | web search alias |
| `deepseek-reasoner-search` | `Быстрый` / `default` | да | да | reasoning + search |
| `deepseek-r1-search` | `Быстрый` / `default` | да | да | R1-compatible + search |
| `deepseek-expert` | `Эксперт` / `expert` | нет | нет | Expert mode |
| `deepseek-v4-pro` | `Эксперт` / `expert` | да | нет | Expert + reasoning |

Полный маппинг:

```bash
curl http://localhost:9655/v1/model-capabilities
```

По официальной странице DeepSeek V4 Preview `deepseek-chat` и `deepseek-reasoner` сейчас route'ятся в `deepseek-v4-flash` non-thinking/thinking. В самом `chat.deepseek.com` direct stream точное имя чекпойнта не отдаётся (`model: ""`), поэтому proxy фиксирует одновременно web-режим (`default` / `Быстрый`) и актуальную официальную маршрутизацию (`DeepSeek-V4-Flash`).

Текущий вывод DeepSeek Web remote config показывает такие web-режимы:

- `default` / UI `Быстрый` — работает; поддерживает `thinking_enabled` и `search_enabled`.
- `expert` / UI `Эксперт` — работает через актуальный web-контракт (`x-client-version=2.0.0`) и поддерживает `thinking_enabled`. В `/v1/models` выдаются `deepseek-expert` без reasoning и `deepseek-v4-pro` как Expert + reasoning.
- `vision` / UI `Распознавание` — виден в remote config, но сейчас direct Web API возвращает `backend_err_by_model` (`Vision is temporarily unavailable`). Поэтому `deepseek-vision` скрыт из `/v1/models`.

Search для Expert по remote config недоступен, поэтому `deepseek-expert-search` остаётся unsupported.

---

## 🔌 Endpoints

| Method | Path | Назначение |
| --- | --- | --- |
| `GET` | `/` или `/health` | статус proxy |
| `GET` | `/v1/models` | список рабочих OpenAI-compatible aliases |
| `GET` | `/v1/model-capabilities` | полный маппинг aliases, real model, capabilities |
| `POST` | `/v1/chat/completions` | OpenAI-compatible Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages API shim |
| `POST` | `/v1/responses` | OpenAI Responses API shim |
| `GET` | `/v1/sessions` | активные локальные agent sessions |
| `POST` | `/reset-session?agent=<id>` | сбросить одну session |
| `POST` | `/reset-session?agent=all` | сбросить все sessions |

---

## 🖥 Open WebUI

Base URL для Open WebUI в Docker:

```text
http://host.docker.internal:9655/v1
```

Для локального запуска без Docker:

```text
http://localhost:9655/v1
```

Если `PROXY_API_KEY` не задан, API key можно указать любой. Если ключ задан,
клиент должен передавать именно его — proxy проверяет bearer token перед
доступом к моделям, сессиям и completions.

---

## 🔐 Обновить логин

```bash
npm run auth
npm start
```

Если DeepSeek начал отвечать `401`, `403` или просит новый PoW/session — повторите `npm run auth` и обновите сохранённую browser-сессию.

Локальные файлы авторизации не должны попадать в GitHub:

- `deepseek-auth.json`
- `.chrome-profile-deepseek/`
- `.env`

Они уже добавлены в `.gitignore`.

---

## 🧪 Тесты

Синтаксическая проверка проекта:

```bash
npm test
```

Live smoke-тесты против запущенного локального proxy:

```bash
BASE_URL=http://127.0.0.1:9655 MODEL=deepseek-chat npm run test:live
```

---

## 📌 Статус проекта

FreeDeepseekAPI — экспериментальный web-chat proxy для локального использования и интеграций. Он зависит от текущего контракта DeepSeek Web Chat, поэтому при изменениях на стороне DeepSeek может потребоваться обновление auth/session logic или model mapping.

Если что-то перестало работать:

1. обновите логин через `npm run auth`;
2. проверьте `/v1/model-capabilities`;
3. повторите запрос на свежей сессии;
4. если проблема сохраняется — вероятно, DeepSeek изменил внутренний Web API.

---

<p align="center">
  <strong>ForgetMeAI</strong> · <a href="https://t.me/forgetmeai">Telegram</a>
</p>
