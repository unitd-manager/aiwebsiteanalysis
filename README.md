# SiteGuard: AI Website Health Monitor

SiteGuard checks every client website around the clock. When a site goes down, it sends a WhatsApp or email alert. It also sends reminders before SSL certificates and domains expire, alerts when backups stop running, scans every page daily for content problems, and sends each client a monthly branded health report.

**Stack:** Node.js + Express, LangGraph (daily AI page-scan agent), LangChain OpenAI-compatible LLM (Groq / OpenAI / Ollama), React + Vite, MySQL.

## What it checks

| Check | How often | Alert |
|---|---|---|
| Uptime (HTTP status, response time) | every 5 min (every 1 min while failing) | After **2 failed checks in a row** (no false alarms), plus a "back up" alert with the downtime length |
| SSL certificate expiry and validity | every 12 h | 30 / 14 / 7 / 1 days before expiry, once each |
| Domain expiry (RDAP, official registry data) | daily | 30 / 14 / 7 / 1 days before expiry, once each |
| **Backups** (check-in link) | every minute | When a backup doesn't check in on time, or the backup job reports a failure |
| **Daily AI page scan** (LangGraph agent) | once a day at `DAILY_SCAN_HOUR` | Only **new** issues since the last scan |
| Monthly client report | 1st of every month | Branded email to the client, with the report attached as a PDF |

### The daily AI page-scan agent

`server/scanAgent.js` runs a LangGraph pipeline:

```
crawl ─► checkLinks ─► checkImages ─► ruleChecks ─► aiReview ─► summarize ─► save + notify web team
```

- **crawl:** visits up to `SCAN_MAX_PAGES` same-site pages and flags pages that return errors.
- **checkLinks:** tests every unique link once. A link counts as broken only if it fails twice. Social sites that block bots are skipped.
- **checkImages:** loads every image (including lazy-loaded images, `srcset`, CSS backgrounds and `og:image`) and flags missing or broken ones, plus images served from a dev or staging server.
- **ruleChecks:** finds visible error messages (PHP / WordPress / database / gateway), past event or offer dates (including dates written without a year, such as "October 26th"), and a stale © year.
- **aiReview:** the LLM reads each page and flags **outdated event banners and pop-ups, expired dates, and stale content**. Each finding must quote the page, which guards against hallucination. With `AI_MODE=free`, only the rule checks run.
- The same issue in a shared header or footer is reported once, as "on N pages".
- The dashboard shows live progress while a scan runs.

### Finding a broken link on the page

Each broken link shows:
- its **link text** (for example "Read The Whitepaper"),
- **where it sits**: in the menu, header or footer, or under which heading,
- **every page** that has it ("+ N more pages").

**Find on page ↗** opens the page and highlights the link (Chrome and Edge). Some sites, such as Next.js sites, drop the highlight after loading, so the link text is also copied: press **Ctrl+F**, then **Ctrl+V** on the page. Links inside images, icons or the page code have no visible text; use the heading shown, or right-click the page → **Inspect** and search for the broken address.

### Fixed / Ignore

Every issue has **✓ Fixed** and **Ignore** buttons.

- **Fixed** hides the issue. If the next scan still finds it, it comes back marked **NEW**.
- **Ignore** stops the issue from being counted or alerted again.

The daily alert lists only issues that are new since the previous scan, so the team isn't told about the same thing every day.

### Backups

SiteGuard can't see inside a hosting account, so the backup job reports in instead. On a site's page, click **Turn on backup monitoring** and choose how often a backup should run. Then add the check-in command it shows as the **last step of the backup job** (cron, a WordPress backup plugin webhook, or the hosting panel):

```
curl -fsS https://YOUR-SITEGUARD/api/backup-checkin/<secret-token>
curl -fsS "https://YOUR-SITEGUARD/api/backup-checkin/<secret-token>?status=fail&message=disk%20full"
```

The web team is alerted when no backup arrives within the interval plus a grace period, when the job reports a failure, and when backups start working again.

## Settings page

- **Team email and WhatsApp:** where alerts go.
- **Brand name, colour and logo:** used in alerts and the monthly client report.
- **Alert channel status:** shows what is missing.
- **Send test alert now:** shows exactly what was delivered or why it failed.

Mail-server and WhatsApp keys are secrets, so they stay in `.env`.

## Monthly report

On a site's page, **View monthly report** opens the report and **Download PDF** saves it as a branded PDF (uptime, downtime, renewal dates, backups, and the open issues with each broken link). The email sent to the client on the 1st of the month has the same PDF attached. A brand logo URL must point to a PNG or JPG for it to appear in the PDF.

## Plans

`PLAN` in `.env` limits how many sites can be added:

| Plan | Sites | Price |
|---|---|---|
| starter | 5 | ₹799/mo |
| growth | 15 | ₹1,499/mo |
| agency | 50 | ₹2,499/mo |

## Setup

1. Copy `.env.example` to `.env` and fill in MySQL and the AI key. The database and tables are created automatically, and older MyISAM tables are converted to InnoDB.
2. Run:

```
npm install
npm run dev        # API on :4100, dashboard on http://localhost:5174
npm test
```

**Production:**
- Build and start with `npm run build && npm start`, then open http://localhost:4100.
- Set `SCHEDULER_ENABLED=1` (24/7 checks) and `APP_URL`.
- Run **one** instance only. Several instances would each send alerts.

### Alerts

- **Email:** any SMTP server (Gmail app password, Zoho, Brevo, SES). Set `SMTP_*` and `MAIL_FROM` in `.env`, and the team email in Settings.
- **WhatsApp:**
  - **Twilio:** `WHATSAPP_PROVIDER=twilio`. The sandbox works for testing.
  - **Meta WhatsApp Cloud API:** `WHATSAPP_PROVIDER=meta`. Business-initiated messages need an approved template. See the note in `server/notify.js`.
- Alerts always go to the web team. Tick **"Also alert the client"** on a site to copy the client on down and expiry alerts.
- Without a channel configured, alerts are still saved and shown on the dashboard.

## Not included

- **Login:** the dashboard has no password. Anyone who can open its address can see and change everything, so keep it on a private network, behind a VPN, or behind your web server's own password (for example nginx basic auth).

- **Billing (Razorpay / Stripe):** needs a payment account.
- **Multiple agencies:** one installation serves one team.
- **Images inserted only by JavaScript after the page loads:** needs a headless browser.
- **Checks from several locations:** needs extra servers.
