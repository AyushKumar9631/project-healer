# Lovable Plivo + Sarvam Bridge

Parallel test stack to the Twilio + ElevenLabs bridge. Lets you A/B cost per
minute without touching the production flow.

## Stack
- **Telephony**: Plivo (PSTN + AudioStream — bidirectional PCM Lin16 @ 8kHz)
- **STT**: Sarvam Saaras (batch over VAD-segmented audio)
- **TTS**: Sarvam Bulbul v3 streaming (MP3 → decoded → PCM 8kHz)
- **Agent**: same Lovable agent endpoints (`/api/public/agent/{greeting,turn}`)
  used by the Twilio bridge — single source of truth for dialog logic.

## Plivo console setup (one-time)
1. **Voice → XML Applications → New App**
   - Public URI: **OFF**
   - Default Endpoint Application: **OFF**
   - Answer URL: `https://hospitalker-ai.lovable.app/api/public/plivo/voice` (POST)
   - Hangup URL: `https://hospitalker-ai.lovable.app/api/public/plivo/status` (POST)
2. **Phone Numbers → DID → assign** the Plivo XML Application to your number.

## Required env
Configure these in Lovable Cloud (for the API routes) AND on the bridge host:

| Var | Where | Purpose |
|-----|-------|---------|
| `PLIVO_AUTH_ID` | Lovable | Plivo REST auth |
| `PLIVO_AUTH_TOKEN` | Lovable | Plivo REST auth |
| `PLIVO_PHONE_NUMBER` | Lovable | E.164 caller ID (must be a Plivo DID) |
| `PLIVO_BRIDGE_PUBLIC_HOST` | Lovable | Public host of THIS bridge (e.g. `lovable-plivo-bridge.fly.dev`) |
| `BRIDGE_SHARED_SECRET` | Lovable + bridge | Auth between bridge and Lovable agent endpoints |
| `SARVAM_API_KEY` | bridge | Sarvam TTS + STT |
| `LOVABLE_BASE_URL` | bridge | URL of the Lovable app |

## Run locally
```sh
cp .env.example .env
# edit .env
npm install
npm run dev
```

## Deploy (Fly.io)
```sh
flyctl launch --no-deploy
flyctl secrets set BRIDGE_SHARED_SECRET=... SARVAM_API_KEY=... LOVABLE_BASE_URL=...
flyctl deploy
```
Then set `PLIVO_BRIDGE_PUBLIC_HOST` in Lovable Cloud secrets to the resulting host.
