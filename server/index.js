import express from 'express';
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, initializeDatabase, deleteSite, toSql } from './db.js';
import { runUptimeCheck, runSslCheck, runDomainCheck } from './monitor.js';
import { runSiteScan } from './scanAgent.js';
import { buildReport, renderReportHtml, sendMonthlyReport, previousMonth } from './report.js';
import { renderReportPdf, fetchLogo, reportFileName } from './reportPdf.js';
import { startScheduler } from './scheduler.js';
import { getAiMode, isAiEnabled } from './ai.js';
import { loadSettings, saveSettings, setting, EDITABLE } from './settings.js';
import { raiseAlert, channelStatus } from './notify.js';
import { setIssueStatus, OPEN_ISSUES_SQL, backfillFingerprints } from './issues.js';
import { newBackupToken, recordBackupCheckin } from './backups.js';

export const PLANS = {
  starter: { label: 'Starter', sites: 5, price: 799 },
  growth: { label: 'Growth', sites: 15, price: 1499 },
  agency: { label: 'Agency', sites: 50, price: 2499 }
};
const plan = () => PLANS[(process.env.PLAN || 'starter').toLowerCase()] || PLANS.starter;

export const app = express();
app.use(express.json({ limit: '100kb' }));

class BadRequest extends Error {}
const str = (v, name, max, required = false) => {
  if (v === undefined || v === null || v === '') { if (required) throw new BadRequest(`${name} is required.`); return null; }
  if (typeof v !== 'string') throw new BadRequest(`${name} must be text.`);
  const t = v.trim();
  if (t.length > max) throw new BadRequest(`${name} is too long.`);
  if (required && !t) throw new BadRequest(`${name} is required.`);
  return t || null;
};
export function normalizeUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new BadRequest('Website URL is required.');
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch { throw new BadRequest('That does not look like a website address.'); }
  if (!u.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|0\.)/.test(u.hostname)) throw new BadRequest('Use a public website address.');
  return u.toString();
}
function siteInput(body) {
  const email = str(body.client_email, 'Client email', 255);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequest('Client email is not valid.');
  const phone = str(body.client_whatsapp, 'Client WhatsApp', 32);
  if (phone && !/^\+?[\d\s-]{8,20}$/.test(phone)) throw new BadRequest('WhatsApp number should look like +919876543210.');
  const url = normalizeUrl(body.url);
  return {
    // Name is optional: "www.acme.co.in" becomes "acme.co.in".
    name: str(body.name, 'Site name', 160) || new URL(url).hostname.replace(/^www\./, ''),
    url,
    client_name: str(body.client_name, 'Client name', 160),
    client_email: email,
    client_whatsapp: phone,
    alert_client: body.alert_client ? 1 : 0,
    paused: body.paused ? 1 : 0
  };
}
const wrap = (fn) => (req, res) => fn(req, res).catch((error) => {
  if (error instanceof BadRequest) return res.status(400).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Check the server log.' });
});
async function getSite(id) {
  const [[site]] = await pool.query('SELECT * FROM sites WHERE id = ?', [Number(id)]);
  return site;
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/overview', wrap(async (req, res) => {
  const [[counts]] = await pool.query("SELECT COUNT(*) AS total, SUM(status = 'up') AS up, SUM(status = 'down') AS down, SUM(status = 'degraded') AS degraded FROM sites WHERE paused = 0");
  const [[expiring]] = await pool.query('SELECT SUM(ssl_expires_at < UTC_TIMESTAMP() + INTERVAL 30 DAY) AS ssl_soon, SUM(domain_expires_at < UTC_TIMESTAMP() + INTERVAL 30 DAY) AS domain_soon FROM sites');
  const [[openIssues]] = await pool.query(`SELECT COALESCE(SUM(n), 0) AS n FROM (${OPEN_ISSUES_SQL}) o`);
  res.json({
    plan: { ...plan(), key: (process.env.PLAN || 'starter').toLowerCase() },
    ai: { mode: getAiMode(), enabled: isAiEnabled() },
    channels: { email: channelStatus().email.ready, whatsapp: channelStatus().whatsapp.ready },
    brand: { name: setting('brand_name', 'SiteGuard'), color: setting('brand_color', '#0f766e') },
    scheduler: process.env.SCHEDULER_ENABLED !== '0',
    sites: { total: Number(counts.total || 0), up: Number(counts.up || 0), down: Number(counts.down || 0), degraded: Number(counts.degraded || 0) },
    expiringSoon: { ssl: Number(expiring.ssl_soon || 0), domain: Number(expiring.domain_soon || 0) },
    openIssues: Number(openIssues.n || 0)
  });
}));

app.get('/api/sites', wrap(async (req, res) => {
  const [sites] = await pool.query(`SELECT s.*,
      (SELECT ROUND(100 * AVG(ok), 2) FROM checks c WHERE c.site_id = s.id AND c.checked_at > UTC_TIMESTAMP() - INTERVAL 30 DAY) AS uptime30,
      CASE WHEN EXISTS (SELECT 1 FROM scans sc WHERE sc.site_id = s.id AND sc.finished_at IS NOT NULL AND sc.error IS NULL) THEN COALESCE(o.n, 0) END AS issue_count
    FROM sites s LEFT JOIN (${OPEN_ISSUES_SQL}) o ON o.site_id = s.id ORDER BY FIELD(s.status, 'down', 'degraded', 'unknown', 'up'), s.name`);
  res.json(sites);
}));

app.post('/api/sites', wrap(async (req, res) => {
  const data = siteInput(req.body || {});
  // Same website entered again (with or without www / https): open the existing one instead of a duplicate.
  const host = new URL(data.url).hostname.replace(/^www\./, '');
  const [existing] = await pool.query('SELECT id, url FROM sites');
  const dup = existing.find((s) => new URL(s.url).hostname.replace(/^www\./, '') === host);
  if (dup) return res.status(200).json({ ...(await getSite(dup.id)), existing: true });

  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM sites');
  if (n >= plan().sites) throw new BadRequest(`Your ${plan().label} plan allows ${plan().sites} sites. Upgrade the plan to add more.`);
  const [r] = await pool.query('INSERT INTO sites SET ?', [data]);
  const site = await getSite(r.insertId);
  // Check and analyze right away so results appear without waiting for the schedule.
  Promise.allSettled([runUptimeCheck(site), runSslCheck(site), runDomainCheck(site)]);
  if (req.body?.scan !== false) runSiteScan(site).catch((e) => console.error('[scan]', e.message));
  res.status(201).json(site);
}));

app.put('/api/sites/:id', wrap(async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found.' });
  const data = siteInput(req.body || {});
  await pool.query('UPDATE sites SET ? WHERE id = ?', [data, site.id]);
  res.json(await getSite(site.id));
}));

app.delete('/api/sites/:id', wrap(async (req, res) => {
  await deleteSite(Number(req.params.id));
  res.json({ ok: true });
}));

app.get('/api/sites/:id', wrap(async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found.' });
  const [checks] = await pool.query('SELECT checked_at, ok, status_code, response_ms, error FROM checks WHERE site_id = ? ORDER BY id DESC LIMIT 288', [site.id]);
  const [incidents] = await pool.query('SELECT * FROM incidents WHERE site_id = ? ORDER BY started_at DESC LIMIT 20', [site.id]);
  const [alerts] = await pool.query('SELECT kind, subject, channels, created_at FROM alerts WHERE site_id = ? ORDER BY id DESC LIMIT 20', [site.id]);
  const [[scan]] = await pool.query('SELECT * FROM scans WHERE site_id = ? ORDER BY id DESC LIMIT 1', [site.id]);
  // Show issues from the latest successful scan (a scan that failed or is running has none yet).
  const [[lastGood]] = await pool.query('SELECT id, started_at, summary FROM scans WHERE site_id = ? AND finished_at IS NOT NULL AND error IS NULL ORDER BY id DESC LIMIT 1', [site.id]);
  const [issues] = lastGood ? await pool.query(`SELECT si.*, st.status FROM scan_issues si
      LEFT JOIN issue_status st ON st.site_id = si.site_id AND st.fingerprint = si.fingerprint
      WHERE si.scan_id = ? ORDER BY si.is_new DESC, FIELD(si.severity, "high", "medium", "low"), si.type`, [lastGood.id]) : [[]];
  res.json({ site, checks: checks.reverse(), incidents, alerts, scan: scan || null, lastGoodScan: lastGood || null, issues });
}));

app.post('/api/sites/:id/check', wrap(async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found.' });
  const [uptime, ssl, domain] = await Promise.all([runUptimeCheck(site), runSslCheck(site), runDomainCheck(site)]);
  res.json({ uptime, ssl, domain });
}));

app.post('/api/sites/:id/scan', wrap(async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found.' });
  // Scans take minutes: start it and let the dashboard poll.
  runSiteScan(site).catch((e) => console.error('[scan]', e.message));
  res.status(202).json({ started: true });
}));

app.get('/api/sites/:id/report', wrap(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const report = await buildReport(Number(req.params.id), month);
  if (!report) return res.status(404).send('Site not found');
  res.type('html').send(renderReportHtml(report));
}));

app.get('/api/sites/:id/report.pdf', wrap(async (req, res) => {
  const month = /^d{4}-d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const report = await buildReport(Number(req.params.id), month);
  if (!report) return res.status(404).send('Site not found');
  const pdf = await renderReportPdf(report, await fetchLogo());
  res.type('pdf').attachment(reportFileName(report.site, month)).send(pdf);
}));

app.post('/api/sites/:id/report/send', wrap(async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found.' });
  res.json(await sendMonthlyReport(site, req.body?.month || previousMonth()));
}));

// ---- Settings ----
app.get('/api/settings', wrap(async (req, res) => {
  res.json({
    values: Object.fromEntries(EDITABLE.map((k) => [k, setting(k)])),
    channels: channelStatus(),
    scheduler: process.env.SCHEDULER_ENABLED !== '0'
  });
}));

app.put('/api/settings', wrap(async (req, res) => {
  const body = req.body || {};
  const email = str(body.team_email, 'Team email', 500);
  if (email && !email.split(',').every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()))) throw new BadRequest('Team email is not valid (separate several with commas).');
  const phone = str(body.team_whatsapp, 'Team WhatsApp', 32);
  if (phone && !/^\+?[\d\s-]{8,20}$/.test(phone)) throw new BadRequest('WhatsApp number should look like +919876543210.');
  const color = str(body.brand_color, 'Brand colour', 9);
  if (color && !/^#[0-9a-f]{3,8}$/i.test(color)) throw new BadRequest('Brand colour should look like #0f766e.');
  const logo = str(body.brand_logo_url, 'Logo URL', 500);
  if (logo && !/^https?:\/\//i.test(logo)) throw new BadRequest('Logo URL must start with https://');
  await saveSettings({ brand_name: str(body.brand_name, 'Brand name', 80), brand_color: color, brand_logo_url: logo, team_email: email, team_whatsapp: phone });
  res.json({ ok: true });
}));

// Sends a real alert to the team contacts right now and reports exactly what happened.
app.post('/api/settings/test-alert', wrap(async (req, res) => {
  const result = await raiseAlert(null, {
    kind: 'test', includeClient: false,
    subject: '✅ Test alert from SiteGuard',
    message: `This is a test. If you can read this, ${setting('brand_name', 'SiteGuard')} alerts reach you.\nSent: ${new Date().toUTCString()}`
  });
  res.json({ ...result, channels: channelStatus() });
}));

// ---- Issues: mark fixed / ignored ----
app.post('/api/sites/:id/issues/:issueId/status', wrap(async (req, res) => {
  const status = req.body?.status;
  if (!['fixed', 'ignored', 'open'].includes(status)) throw new BadRequest('Status must be fixed, ignored or open.');
  const [[issue]] = await pool.query('SELECT * FROM scan_issues WHERE id = ? AND site_id = ?', [Number(req.params.issueId), Number(req.params.id)]);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  await setIssueStatus(issue.site_id, issue.fingerprint, status);
  res.json({ ok: true });
}));

// ---- Backups: check-in monitoring ----
app.put('/api/sites/:id/backup', wrap(async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found.' });
  const hours = req.body?.expected_hours === null ? null : Number(req.body?.expected_hours);
  if (hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 24 * 31)) throw new BadRequest('Expected backup interval must be 1 to 744 hours.');
  const token = hours === null ? site.backup_token : (site.backup_token || newBackupToken());
  // Turning monitoring on starts the clock now, so an old missed window doesn't alert at once.
  const since = hours !== null && !site.backup_expected_hours ? new Date() : site.backup_since;
  await pool.query('UPDATE sites SET backup_expected_hours = ?, backup_token = ?, backup_since = ? WHERE id = ?', [hours, token, toSql(since), site.id]);
  res.json(await getSite(site.id));
}));

app.post('/api/sites/:id/backup/new-link', wrap(async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found.' });
  await pool.query('UPDATE sites SET backup_token = ? WHERE id = ?', [newBackupToken(), site.id]);
  res.json(await getSite(site.id));
}));

// Public: called by the backup job itself (cron, WordPress plugin, hosting panel). The secret token is the key.
app.all('/api/backup-checkin/:token', wrap(async (req, res) => {
  const status = String(req.query.status || req.body?.status || 'ok').toLowerCase() === 'fail' ? 'fail' : 'ok';
  const message = String(req.query.message || req.body?.message || '').slice(0, 500);
  const result = await recordBackupCheckin(String(req.params.token), status, message);
  if (!result) return res.status(404).json({ error: 'Unknown backup link.' });
  res.json({ ok: true, site: result.name, status });
}));

app.get('/api/alerts', wrap(async (req, res) => {
  const [alerts] = await pool.query('SELECT a.*, s.name AS site_name FROM alerts a LEFT JOIN sites s ON s.id = a.site_id ORDER BY a.id DESC LIMIT 100');
  res.json(alerts);
}));

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
app.use(express.static(dist));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html'), (e) => e && res.status(404).send('Run "npm run build" first, or use "npm run dev".')));

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await initializeDatabase();
  await loadSettings();
  await backfillFingerprints();
  const port = Number(process.env.PORT || 4100);
  app.listen(port, () => console.log(`SiteGuard running on http://localhost:${port}`));
  startScheduler();
}
