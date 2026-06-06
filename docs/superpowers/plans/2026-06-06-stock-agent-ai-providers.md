# 股票小作手 AI Provider Plugins Implementation Plan (Plan 3 of phase-1)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Per-user AI provider configuration. The system ships a catalog of providers (DeepSeek / Qwen / OpenAI / Claude / MiniMax / Ollama). A user applies for their own API key at the provider, returns to the app, picks the provider + model, enters the key, **tests the connection**, saves, and marks it active. The active config is what every later AI call (analysis, review) uses.

**Architecture:** Static provider catalog in code (`ai/providers.ts`). Per-user configs in a new `ai_configs` table (one row per user×provider; exactly one `is_active` per user). API keys are **encrypted at rest** (AES-256-GCM, key derived from the JWT secret) and never returned to the client (masked only). A `chat()` dispatcher in `ai/manager.ts` speaks each provider's API style (openai / anthropic / ollama) so "test connection" makes a real tiny call. Unlike easy-Reader (global, plaintext), this is per-user and encrypted.

**Tech Stack:** same as before. Node 20 global `fetch` for provider calls. Reuse `authMiddleware`, `getDb()`, response helpers, `JWT_SECRET`.

---

## Provider catalog (`backend/src/ai/providers.ts`)

```ts
type ApiStyle = 'openai' | 'anthropic' | 'ollama';
interface ProviderDef {
  name: string; label: string;
  apiStyle: ApiStyle;
  needsApiKey: boolean;
  defaultBaseUrl: string; baseUrlEditable: boolean;
  models: string[]; allowCustomModel: boolean;
}
```

| name | label | apiStyle | needsApiKey | defaultBaseUrl | models |
|---|---|---|---|---|---|
| deepseek | DeepSeek | openai | yes | https://api.deepseek.com/v1 | deepseek-chat, deepseek-reasoner |
| qwen | 通义千问（阿里云） | openai | yes | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-plus, qwen-max, qwen-turbo, qwen-long |
| openai | OpenAI / ChatGPT | openai | yes | https://api.openai.com/v1 | gpt-4o, gpt-4o-mini, o3-mini |
| claude | Anthropic Claude | anthropic | yes | https://api.anthropic.com | claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-20251001 |
| minimax | MiniMax | openai | yes | https://api.minimaxi.com/v1 | MiniMax-M2, abab6.5s-chat |
| ollama | Ollama 本地模型 | ollama | no | http://localhost:11434 | qwen2.5, llama3.1, deepseek-r1 |

All `allowCustomModel: true`, `baseUrlEditable: true`.

## Data model — table `ai_configs`
```
id TEXT PK
user_id TEXT NOT NULL
provider TEXT NOT NULL
api_key_enc TEXT          -- AES-GCM ciphertext (nullable for ollama)
base_url TEXT
model TEXT
is_active INTEGER DEFAULT 0
updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
UNIQUE(user_id, provider)
```
Index `(user_id, is_active)`.

---

## Tasks

### Task 1: crypto util + schema
- `backend/src/utils/crypto.ts`: `encryptSecret(plain): string` / `decryptSecret(enc): string` using AES-256-GCM, key = `crypto.createHash('sha256').update(JWT_SECRET).digest()`, output `ivHex:tagHex:cipherHex`. Empty input → ''.
- Add `ai_configs` table + index to `db.ts initSchema()`.
- Tests: `crypto.test.ts` — round-trip encrypt→decrypt returns original; ciphertext ≠ plaintext; '' → ''. `db.test.ts` — table exists.

### Task 2: provider catalog + chat dispatcher
- `ai/providers.ts`: export `PROVIDERS: ProviderDef[]` and `getProvider(name)`.
- `ai/manager.ts`: `export async function chat(style, { baseUrl, model, apiKey }, prompt, maxTokens=64): Promise<string>` — openai: POST `${baseUrl}/chat/completions`; anthropic: POST `${baseUrl}/v1/messages` (headers x-api-key + anthropic-version: 2023-06-01, body max_tokens); ollama: POST `${baseUrl}/api/chat` (stream:false). Returns the text; throws Error(message) on non-2xx.
- Test `manager.test.ts`: mock `global.fetch`; assert openai path posts to `/chat/completions` with Bearer header and parses `choices[0].message.content`; anthropic path posts to `/v1/messages` with `x-api-key` and parses `content[0].text`; non-2xx throws.

### Task 3: ai service (per-user CRUD)
`ai/service.ts`:
- `listConfigs(userId)` → rows mapped to `{ provider, base_url, model, is_active, apiKeySet, apiKeyMasked }` (NO raw key; masked = last 4).
- `saveConfig(userId, provider, { apiKey?, baseUrl, model })` → upsert; if apiKey is undefined/'' /contains '****' keep existing `api_key_enc`, else encrypt new. Validates provider exists; if provider.needsApiKey and no existing key and none provided → throw 'API_KEY_REQUIRED'.
- `activate(userId, provider)` → row must exist (and have key if needsApiKey) else throw; transaction sets all is_active=0 then this =1.
- `deleteConfig(userId, provider)`.
- `getActiveConfig(userId)` → `{ provider, baseUrl, model, apiKey }` (decrypted) or null — internal use by Plan 6.
- `getDecrypted(userId, provider)` → same for a specific provider (for test-connection of a saved provider).
- Tests `service.test.ts` (isolated DATA_DIR): save deepseek with key → listConfigs shows apiKeySet true + masked, not raw; re-save with masked key keeps original (getDecrypted unchanged); save for user A not visible to user B; activate switches; getActiveConfig returns decrypted key.

### Task 4: routes (`routes/ai.ts`, authMiddleware, per-user)
- `GET /api/ai/providers` → catalog (no secrets).
- `GET /api/ai/configs` → `listConfigs`.
- `PUT /api/ai/configs/:provider` → zod { apiKey?: string, baseUrl: string, model: string } → saveConfig → 200 (422 unknown provider / missing model; 400 API_KEY_REQUIRED).
- `POST /api/ai/configs/:provider/activate` → activate → 200 (400 if not usable).
- `POST /api/ai/configs/:provider/test` → body optional { apiKey?, baseUrl?, model? }: use provided values, else fall back to the saved (decrypted) config; call `chat()` with prompt '请只回复:OK'; return `{ ok:true, reply }` or `{ ok:false, error }` (200 with ok flag; 422 if provider unknown / no key).
- `GET /api/ai/active` → active `{ provider, model }` or null (no key).
- Mount `/api/ai` in `index.ts`.
- Tests `ai.test.ts` (supertest, mock global.fetch for the test endpoint): providers list; requires auth; save+list masks key; per-user isolation (two registered users); activate; test endpoint returns ok with mocked fetch; test with unknown provider 422.

### Task 5: frontend
- `frontend/src/api/ai.ts`: getProviders, getConfigs, saveConfig, activate, test, getActive.
- `frontend/src/views/AiSettingsView.vue` at `/ai` (requiresAuth):
  - Provider `<select>` from catalog → dynamic fields: API Key (password; placeholder "已设置（留空则不改）" when configured), Base URL (prefilled default, editable), Model (`<select>` from `models` + a "自定义" text input when allowCustomModel).
  - Buttons: "测试连通"(calls test, shows reply/error), "保存"(saveConfig), "设为当前使用"(activate).
  - Show list of configured providers with active badge + "切换/删除".
  - Banner showing current active provider+model.
- Home nav link → `/ai` ("AI 模型"). Add route.

### Task 6: verify
- `cd backend && npm test` twice (green, repeatable).
- `cd frontend && npx vue-tsc --noEmit`.
- `docker compose up -d --build`; smoke: login → GET /api/ai/providers (6) → PUT a deepseek config (dummy key) → GET /api/ai/configs (masked) → activate → GET /api/ai/active. (Real provider call only if a real key is supplied — not in smoke.)
- Commit per task.

## Done criteria
A logged-in user can pick a provider, enter their own API key, choose a model, test the connection, save, and activate it — all per-user, key encrypted at rest and never echoed back. `getActiveConfig(userId)` gives the analysis engine (Plan 6) the model + decrypted key to call.
