# Lovable Twilio Bridge

A tiny Node service that bridges Twilio Media Streams ↔ ElevenLabs (Scribe STT + Matilda TTS) ↔ your Lovable agent.

This bridge holds the long-lived WebSockets that Lovable's serverless runtime cannot. It does **NOT** contain any agent logic — every patient utterance is POSTed to your Lovable app's `/api/public/agent/turn` endpoint.

## Deploy to Railway (free tier, ≈ 5 min)

Railway has a free $5/month trial credit — plenty for this idle-most-of-the-time bridge — and does not require a credit card to start.

### Option A — Dashboard (no CLI)

1. Push your Lovable project to GitHub (top-right in Lovable → **GitHub → Connect**).
2. Go to <https://railway.app> → sign up with GitHub (free).
3. **New Project → Deploy from GitHub repo** → pick your repo.
4. Open the created service → **Settings → Root Directory** → set to `lovable-twilio-bridge` → save. Railway will rebuild using the `Dockerfile` in that folder.
5. **Variables** tab → add:
   - `LOVABLE_BASE_URL` = `https://project--beafd7ee-687a-4a28-b665-75a3f8daa299.lovable.app`
   - `BRIDGE_SHARED_SECRET` = a long random string (save it — you'll paste it into Lovable too)
   - `ELEVENLABS_API_KEY` = your ElevenLabs API key
6. **Settings → Networking → Generate Domain** → Railway gives you something like `lovable-twilio-bridge-production.up.railway.app`.
7. Verify: open `https://<that-domain>/health` in a browser — should show `ok`.

### Option B — Railway CLI

```bash
npm i -g @railway/cli
railway login

cd lovable-twilio-bridge
railway init
railway up

railway variables set \
  LOVABLE_BASE_URL="https://project--beafd7ee-687a-4a28-b665-75a3f8daa299.lovable.app" \
  BRIDGE_SHARED_SECRET="$(openssl rand -hex 32)" \
  ELEVENLABS_API_KEY="<paste your ElevenLabs key>"

railway domain   # generates a public *.up.railway.app domain
```

### Wire it into Lovable

After deploy, set these runtime secrets in your Lovable project:

- `BRIDGE_PUBLIC_HOST` = your Railway domain, **no scheme** (e.g. `lovable-twilio-bridge-production.up.railway.app`)
- `BRIDGE_SHARED_SECRET` = the same value you set on Railway
- `TWILIO_PHONE_NUMBER` = your Twilio number in E.164 (e.g. `+19898535618`)

Done. Now click **Call patient now** in `/dashboard/patients/<list>` — the patient's phone will ring.

## How it works

```
Twilio Media Stream WS  ─►  this bridge  ─►  ElevenLabs Scribe (STT)
                                  │
                                  ▼ final transcript
                            POST {LOVABLE_BASE_URL}/api/public/agent/turn
                                  ▼ {agent_reply, end_call}
                            ElevenLabs TTS (ulaw_8000)
                                  ▼ μ-law audio frames
                              Twilio Media Stream WS
```

## Local dev

```bash
npm install
npm run dev   # listens on :8080
```

Use `ngrok http 8080` and set `BRIDGE_PUBLIC_HOST=<your-ngrok-host>` in Lovable to test without redeploying.

## Alternative: Fly.io

A `fly.toml` is also included if you'd rather deploy to Fly.io (`fly launch --copy-config && fly deploy`). Fly requires a $5 prepaid balance.

## Instant "Namaste" prelude (optional, recommended)

To cut time-to-first-audio from ~8–10s down to ~1s, the bridge can play a
pre-rendered "नमस्ते," clip the moment Twilio's media stream opens, while the
personalised greeting + LLM TTS load in parallel.

Setup (one-time):

1. From the Lovable app, generate the clip:
   ```bash
   curl -X POST -H "x-bridge-secret: $BRIDGE_SHARED_SECRET" \
        https://hospitalker-ai.lovable.app/api/public/admin/generate-prelude
   ```
   Copy the returned `public_url`.
2. Set `HELLO_PRELUDE_URL=<public_url>` on the bridge (Railway/Fly env vars) and restart.
3. On boot the bridge logs `[prelude] cached N bytes ...`. Done.

Leave `HELLO_PRELUDE_URL` unset to disable the prelude — the bridge falls back to today's behaviour.

### Cached BP/Glucose follow-up (`FOLLOWUP_PRELUDE_URL`)

After a positive consent reply the agent always asks the same question:
"क्या उसके बाद आपने BP और Glucose की जाँच दोबारा करवाई है? अब आप कैसे हैं?".
Pre-render this clip once and the bridge plays it instantly (no ElevenLabs round-trip).

1. Generate the clip:
   ```bash
   curl -X POST -H "x-bridge-secret: $BRIDGE_SHARED_SECRET" \
        https://hospitalker-ai.lovable.app/api/public/admin/generate-followup
   ```
2. Set `FOLLOWUP_PRELUDE_URL=<public_url>` on the bridge and restart.
3. On boot you should see `[followup] fetched N bytes ...`.

Leave `FOLLOWUP_PRELUDE_URL` unset to fall back to live TTS (slower but functionally identical).

