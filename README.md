# SiteGuard: AI Website Health Monitor

SiteGuard checks every client website around the clock. When a site goes down, it sends a WhatsApp or email alert. It also sends reminders before SSL certificates and domains expire, and a monthly branded health report to each client.

**Stack:** Node.js + Express, LangGraph (daily AI page-scan agent), LangChain OpenAI-compatible LLM (Groq / OpenAI / Ollama), React + Vite, MySQL.

## What it checks

| Check | How often | Alert |
|---|---|---|
| Uptime (HTTP status, response time) | every 5 min (every 1 min while failing) | After **2 failed checks in a row** (no false alarms), plus a "back up" alert with the downtime length |
| SSL certificate expiry and validity | every 12 h | 30 / 14 / 7 / 1 days before expiry, once each |
| Domain expiry (RDAP, official registry data) | daily | 30 / 14 / 7 / 1 days before expiry, once each |
| **Daily AI page scan** (LangGraph agent) | once a day at `DAILY_SCAN_HOUR` | One summary alert to the web team |
| Monthly client report | 1st of every month | Branded HTML email to the client |

### The daily AI page-scan agent

`server/scanAgent.js` runs a LangGraph pipeline:

```
crawl ─► checkLinks ─► ruleChecks ─► aiReview ─► summarize ─► save + notify web team
```

- **crawl:** visits up to `SCAN_MAX_PAGES` same-site pages and flags pages that return errors.
- **checkLinks:** tests every unique link once. A link counts as broken only if it fails twice. Social sites that block bots are skipped.
- **ruleChecks:** finds visible error messages (PHP / WordPress / database / gateway), past event or offer dates, and a stale © year.
- **aiReview:** the LLM reads each page and flags **outdated event banners and pop-ups, expired dates, and stale content**. Each finding must quote the page, which guards against hallucination. With `AI_MODE=free`, only the rule checks run.
- The same issue in a shared header or footer is reported once, as "on N pages".

## Plans

`PLAN` in `.env` limits how many sites can be added:

| Plan | Sites | Price |
|---|---|---|
| starter | 5 | ₹799/mo |
| growth | 15 | ₹1,499/mo |
| agency | 50 | ₹2,499/mo |

## Setup

1. Copy `.env.example` to `.env` and fill in MySQL, the AI key, SMTP and WhatsApp settings. The database and tables are created automatically.
2. Run:

```
npm install
npm run dev        # API on :4100, dashboard on http://localhost:5174
npm test
```

Production: `npm run build && npm start` (serves the dashboard at http://localhost:4100).

### Alerts

- **Email:** any SMTP server (Gmail app password, Zoho, Brevo, SES). Set `SMTP_*`, `MAIL_FROM` and `TEAM_EMAIL`.
- **WhatsApp:**
  - **Twilio:** `WHATSAPP_PROVIDER=twilio`. The sandbox works for testing.
  - **Meta WhatsApp Cloud API:** `WHATSAPP_PROVIDER=meta`. Business-initiated messages need an approved template. See the note in `server/notify.js`.
- Alerts always go to the web team. Tick **"Also alert the client"** on a site to copy the client on down and expiry alerts.
- Without a channel configured, alerts are still saved and shown on the dashboard.

## Roadmap (not built yet)
- Backup checks (after uptime, SSL and domain are proven, as planned)
- Keyword or content-change checks, multi-location checks
- Login, multiple agencies, billing
