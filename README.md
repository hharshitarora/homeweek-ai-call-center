# AI Voice Agent for Real Estate Lead Qualification

An end-to-end outbound calling system that qualifies real estate leads using conversational voice AI. Leads are imported in bulk, dialed automatically by an AI agent that speaks naturally (English/Hinglish), and every call is classified into an actionable outcome — with hot leads instantly escalated to a human agent over WhatsApp.

Built as a production system for a live real estate sales operation, handling real buyer conversations at scale.

## What it does

1. **Ingest leads** — upload a CSV of leads (name, phone, email, interest) or add them one at a time. Phone numbers are validated and normalized to E.164; each upload is tracked as a dataset.
2. **Dial automatically** — trigger a single call, or run the bulk dialer to call up to 50 queued leads in one scheduled batch. Leads are retried up to 3 times, with no-answers and voicemails queued for callback.
3. **Converse naturally** — the voice agent follows a structured qualification script: opening → interest check → project introduction → qualification questions (budget, timeline, purpose) → Q&A → soft close. It mirrors the lead's language (switching to Hinglish when they speak Hindi), speaks numbers as words for natural TTS, and never re-pitches after a "no".
4. **Classify every call** — webhooks stream call events back in real time. A classification layer combines provider disposition tags, transcript signal detection (English and Hindi phrases), and status mapping to produce an outcome (`interested`, `not_interested`, `opt_out`, `no_answer`, `voicemail`, `human_followup`) and a next action.
5. **Escalate hot leads** — when a call ends classified as `interested`, a WhatsApp alert (via Twilio) goes to a senior agent immediately, deduplicated to one alert per lead per day.
6. **Manage everything from a dashboard** — a web UI with a dataset library, searchable/filterable leads table, per-lead call buttons, bulk dialing, transcripts and recordings, live stats (interested / follow-up / completion rate), and CSV export.

## Architecture

```
                 ┌──────────────────────┐
   CSV upload ──▶│                      │──▶ Bolna API ─────┐
   Dashboard  ──▶│   Express server     │──▶ Ringg AI API ──┤  outbound
                 │   (Node 20, ESM)     │                   │  AI calls
                 │                      │◀── /webhooks/* ◀──┘
                 └─────────┬────────────┘
                           │
              ┌────────────┼──────────────┐
              ▼            ▼              ▼
          Supabase      Twilio        Email (OTP)
        (leads, calls,  WhatsApp     Resend / SendGrid
         datasets)      alerts       / Gmail SMTP
```

- **Dual voice providers** — Bolna is the primary provider (single calls + scheduled batch dialing); Ringg AI runs in parallel as an optional second provider, enabled purely by configuration. A provider-agnostic webhook layer correlates events back to leads by call ID, lead ID, or phone number.
- **Terminal-event discipline** — providers fire webhooks on every status change; only terminal events (call completed, failed, etc.) write final outcomes, so transient updates never clobber results.
- **Guardrailed classification** — explicit disinterest phrases in the transcript (in either English or Hindi) hard-override the outcome to `not_interested`, even if the provider's own analysis says "interested". Provider optimism doesn't pollute the pipeline.
- **Batch scheduling with retry** — the bulk dialer builds a CSV batch, submits it to the provider's batch API, and schedules it with the required lead time; if the provider rejects the timestamp, it retries once with a corrected format and a larger buffer.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20, ES modules |
| Server | Express 5 |
| Database | Supabase (Postgres) with SQL migrations |
| Voice AI | Bolna (primary), Ringg AI (optional secondary) |
| Alerts | Twilio WhatsApp |
| Auth email | Resend / SendGrid / Gmail SMTP (nodemailer) |
| Validation | Zod, csv-parse, multer |
| Logging | Pino |
| Frontend | Vanilla HTML/CSS/JS dashboard (no build step) |
| Deploy | Nixpacks (Railway-compatible) |

## Project structure

```
├── src/
│   ├── server.js              # Express app: API, webhooks, dialer, classification, auth
│   └── test-connections.js    # Connectivity diagnostics for external services
├── public/
│   ├── index.html             # Dataset library (landing page + login)
│   └── dashboard.html         # Leads dashboard
├── supabase/migrations/       # SQL migrations (leads, calls, datasets, login_attempts)
├── nixpacks.toml              # Deployment build config
└── BOLNA_*.md                 # Voice agent tuning write-ups
```

## Getting started

```bash
npm install
cp .env.example .env   # or create .env with the variables below
npm run dev            # development
npm start              # production
```

Apply the SQL migrations in `supabase/migrations/` to your Supabase project, then verify connectivity:

```bash
npm run test:connections
```

### Environment variables

**Required**

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key |
| `BOLNA_API_KEY` | Primary voice provider API key |
| `BOLNA_AGENT_ID` | Voice agent to use for calls |
| `PUBLIC_WEBHOOK_URL` | Public base URL providers post webhooks to (required in production) |

**Optional**

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 3000) |
| `BOLNA_BATCH_SCHEDULE_DELAY_SECONDS` | Batch dial lead time (default 150, min 120) |
| `RINGG_API_KEY`, `RINGG_AGENT_ID`, `RINGG_FROM_NUMBER_ID` | Set all three to enable the second voice provider |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `SENIOR_AGENT_WHATSAPP` | WhatsApp hot-lead alerts |
| `LOGIN_USERNAME`, `LOGIN_PASSWORD`, `SESSION_SECRET` | Dashboard password login (signed session cookies) |
| `LOGIN_EMAIL` | Enables email OTP login instead of/alongside password |
| `RESEND_API_KEY`/`RESEND_FROM`, `SENDGRID_API_KEY`/`SENDGRID_FROM`, `GMAIL_USER`/`GMAIL_APP_PASSWORD` | OTP email delivery (any one) |
| `TRIGGER_API_KEY` | API key for server-to-server calls (`Bearer` / `X-API-Key`) |

## API overview

| Endpoint | Purpose |
|---|---|
| `GET /rows`, `POST /add-row`, `PUT /update-row`, `DELETE /delete-row` | Lead CRUD (plus bulk update/delete variants) |
| `POST /upload-csv` | Bulk lead import (creates a dataset) |
| `GET /datasets`, `DELETE /datasets/:id` | Dataset library |
| `POST /trigger-call` | Call one lead via a chosen provider |
| `POST /run-dialer` | Bulk batch dialing of queued leads |
| `POST /webhooks/bolna`, `POST /webhooks/ringg` | Provider call-event webhooks |
| `POST /auth/login`, `/auth/request-otp`, `/auth/verify-otp`, `/auth/logout` | Dashboard auth (password or email OTP) |
| `GET /health` | Health check |

## Data model

- **`leads`** — lead identity and contact info, property context, call state machine (`call_status`, `call_attempts`, `last_call_at`), provider call IDs, final `outcome` / `next_action`, transcript, recording URL, and summary. Linked to a dataset.
- **`calls`** — one row per call attempt with full event history, duration, transcript, recording, and the raw webhook payload (JSONB) for auditability.
- **`datasets`** — one row per CSV upload (filename, row count, status).
- **`login_attempts`** — OTP request audit log.

## Voice agent engineering

The repository documents the prompt engineering and tuning work behind the agent, which is where most of the conversational quality comes from:

- **Structured qualification script** with strict turn limits (2–3 sentences max), bilingual mirroring rules, and number-to-words conversion for natural speech ("8 point 5 crores", never "8.5cr").
- **Disinterest handling at three layers**: prompt-level rules (one polite goodbye, never re-pitch), a provider-level hangup trigger, and a transcript-level classification override in code — so a "no" is respected even if any single layer misses it.
- **Interruption tuning**: documented endpointing and delay configuration (~800–1200 ms) so the agent waits for complete sentences and doesn't treat backchannels ("hmm", "haan") as interruptions.

See `BOLNA_DISINTEREST_SETUP.md` and `BOLNA_INTERRUPTION_SETUP.md` for the full write-ups.

## Deployment

Deploys to any Nixpacks-compatible host (e.g. Railway): `nixpacks.toml` handles a production install (`npm ci --omit=dev`) and the app starts with `npm start`. The static dashboard is served by the same Express process, so a single service is sufficient; CORS is configured to also support hosting the frontend separately.
