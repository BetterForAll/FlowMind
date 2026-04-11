# FlowMind Backend Proxy on Vercel

## Context

FlowMind currently calls the Gemini API directly from the Electron app using an API key in `.env`. For a public release, the API key must be hidden behind a backend. We'll create a Vercel serverless proxy with stateless HMAC license keys — zero database, zero storage.

**Local dev:** You keep using `GEMINI_API_KEY` in `.env` as-is. No backend needed for development.

---

## Auth Model: Stateless HMAC License Keys

### The full flow — no storage needed:

**You (selling):**
1. User pays you (Gumroad, Stripe, manual, whatever)
2. You run a one-liner: `HMAC-SHA256("buyer@gmail.com", YOUR_MASTER_SECRET)` → `fm_a8f3e2...`
3. You send them: "Your license key is `fm_a8f3e2...`"

**User (in the app):**
1. Opens FlowMind Settings
2. Enters two fields: **Email** + **License Key**
3. Clicks save — app starts working

**Backend (on each API call):**
1. Receives email + key from the app (via headers)
2. Recomputes `HMAC-SHA256(email, MASTER_SECRET)` → `fm_a8f3e2...`
3. Compares recomputed hash with the key they sent (timing-safe)
4. Match → proxy to Gemini. No match → 401.

**Why this works:** The same email + the same secret always produces the same hash. Nobody can generate a valid key without knowing your secret. There's nothing to store — the math IS the validation.

**To revoke?** Tiny `BLOCKED_EMAILS` env var (rare edge case).

**Priority in the Electron app:**
1. User has their own Gemini API key → use it directly (free for you)
2. User has email + license key → call backend proxy
3. Neither → show "Enter a Gemini API key or purchase a FlowMind license"

---

## Step 1: Install Vercel CLI

```bash
npm i -g vercel
vercel login
```

## Step 2: Create the backend project

Create `flowmind-proxy/` (separate repo) with 4 files:

### `package.json`
```json
{
  "private": true,
  "dependencies": {
    "@google/genai": "^1.29.0"
  }
}
```

### `tsconfig.json`
Standard strict TS config targeting ES2020.

### `vercel.json`
```json
{
  "functions": {
    "api/generate.ts": {
      "maxDuration": 120,
      "memory": 256
    }
  }
}
```

### `api/generate.ts` (~50 lines)
Single endpoint that:
1. Reads `X-License-Email` and `X-License-Key` headers
2. Computes `HMAC-SHA256(email, process.env.MASTER_SECRET)`
3. Compares with provided key using timing-safe comparison
4. If valid: parses body `{ model, contents, config? }`, calls Gemini with server-side `GEMINI_API_KEY`, returns `{ text: response.text }`
5. If invalid: returns 401

Uses Node.js built-in `crypto.createHmac()` and `crypto.timingSafeEqual()` — no extra dependencies.

## Step 3: Deploy to Vercel (paid project)

```bash
cd flowmind-proxy
npm install
vercel link          # link to your paid project
vercel deploy        # preview deploy to test
```

Set env vars on the Vercel project:
- `GEMINI_API_KEY` — your Gemini key (from current .env)
- `MASTER_SECRET` — random secret for HMAC (`openssl rand -hex 32`)

## Step 4: Generate a license key (for testing / selling)

```bash
node -e "const c=require('crypto'); console.log('fm_'+c.createHmac('sha256','YOUR_MASTER_SECRET').update('buyer@email.com').digest('hex'))"
```

You send the buyer: their email + the `fm_...` key. That's it.

## Step 5: Create proxy client in FlowMind

### New file: `src/ai/proxy-genai.ts` (~30 lines)

Drop-in replacement for `GoogleGenAI`:

```ts
class ProxyGenAI {
  models: {
    generateContent(params: { model, contents, config? }): Promise<{ text: string }>
  }
}
```

Internally: `fetch(PROXY_ENDPOINT + '/api/generate', { body, headers: { 'X-License-Email': email, 'X-License-Key': key } })`

## Step 6: Update FlowMind to support both modes

### `src/config.ts`
Add two config fields:
- `licenseEmail: string | null`
- `licenseKey: string | null`

Add build-time constant:
- `PROXY_ENDPOINT` — hardcoded to your Vercel deployment URL

### `src/ai/create-genai.ts` (new helper, ~15 lines)
Factory function:
```ts
function createGenAI(config): GoogleGenAI | ProxyGenAI {
  if (config.geminiApiKey) return new GoogleGenAI({ apiKey: config.geminiApiKey });
  if (config.licenseEmail && config.licenseKey)
    return new ProxyGenAI({ endpoint: PROXY_ENDPOINT, email: config.licenseEmail, key: config.licenseKey });
  throw new Error("No API key or license key configured");
}
```

### `src/main.ts` (lines 288-289) — CRITICAL
Currently both engines are constructed at startup and throw if no API key exists. The app crashes before even opening a window. Fix: **lazy-initialize** engines — don't construct them until first use, or wrap construction in a try/catch and re-create when settings change. The `createGenAI()` factory handles which mode to use; the engines just need to not crash the app on startup when no key is configured yet.

### `src/engine/flow-detection.ts` (lines 98-103)
Replace `new GoogleGenAI({ apiKey })` with `createGenAI(config)`.

### `src/engine/interview.ts` (lines 27-31)
Same change.

### `src/engine/audio-transcription.ts` (line 1)
Update type to accept `GoogleGenAI | ProxyGenAI` (shared interface).

### `src/renderer/views/SettingsView.tsx`
Add two fields below existing Gemini API Key field:
- **License Email**
- **License Key**
With helper text: "Enter your own Gemini API key OR your FlowMind license credentials"

## Step 7: Test end-to-end

1. Deploy backend: `vercel --prod`
2. Generate a test license key for your own email
3. Enter email + key in FlowMind settings (leave Gemini key empty)
4. Run a flow detection cycle — verify it works through the proxy
5. Enter a Gemini key — verify it uses direct mode instead
6. Test with wrong license key — verify 401 error is handled gracefully

---

## Future: Free Trial

Trial expiry should be usage-based (e.g., after first successful flow automation — the "wow moment"), not time-based. Stateless trial keys are possible by embedding expiry data in the key with HMAC signing. Design TBD.

---

## Key Design Decisions

- **HMAC license keys** — stateless, no database, infinite scalability, zero storage cost
- **Priority: own API key > license key** — saves you money when users BYO
- **No framework** — plain `api/` folder, Vercel auto-routes
- **Single endpoint** — all 5 Gemini call sites use `generateContent()`, one proxy handles all
- **4.5MB body limit** — fine because app already chunks large payloads
- **No streaming** — all call sites use non-streaming `generateContent()`
- **Timing-safe comparison** — prevents timing attacks on key validation

## Files to Create (Backend — `flowmind-proxy/`)

- `api/generate.ts` — the proxy function (~50 lines)
- `package.json`
- `tsconfig.json`
- `vercel.json`

## Files to Create/Modify (FlowMind — `FlowTracker/`)

- `src/ai/proxy-genai.ts` — **new** — proxy client class
- `src/ai/create-genai.ts` — **new** — factory function (direct vs proxy)
- `src/config.ts` — add `licenseEmail`, `licenseKey` fields
- `src/engine/flow-detection.ts` — use `createGenAI()` factory
- `src/engine/interview.ts` — use `createGenAI()` factory
- `src/engine/audio-transcription.ts` — update type annotation
- `src/renderer/views/SettingsView.tsx` — add license email/key fields

## Verification

```bash
# Generate test key
KEY=$(node -e "const c=require('crypto'); console.log('fm_'+c.createHmac('sha256','YOUR_MASTER_SECRET').update('test@test.com').digest('hex'))")

# Test valid key
curl -X POST https://your-proxy.vercel.app/api/generate \
  -H "X-License-Email: test@test.com" \
  -H "X-License-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","contents":[{"role":"user","parts":[{"text":"Say hello"}]}]}'
# → {"text":"Hello!..."}

# Test invalid key
curl -X POST https://your-proxy.vercel.app/api/generate \
  -H "X-License-Email: test@test.com" \
  -H "X-License-Key: fm_wrong" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","contents":[{"role":"user","parts":[{"text":"Say hello"}]}]}'
# → 401 {"error":"Invalid license key"}
```
