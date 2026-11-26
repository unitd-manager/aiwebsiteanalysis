import { pool, toSql } from './db.js';
import { sendEmail } from './notify.js';
import { renderReportPdf, fetchLogo, reportFileName } from './reportPdf.js';
import { brandName, brandColor, brandLogo } from './settings.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const daysLeft = (d) => (d ? Math.ceil((new Date(d) - Date.now()) / 86_400_000) : null);

export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

export function previousMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

export async function buildReport(siteId, month) {
  const { from, to } = monthRange(month);
  const [[site]] = await pool.query('SELECT * FROM sites WHERE id = ?', [siteId]);
  if (!site) return null;
  const [[stats]] = await pool.query('SELECT COUNT(*) AS total, SUM(ok) AS up, AVG(CASE WHEN ok THEN response_ms END) AS avgMs FROM checks WHERE site_id = ? AND checked_at >= ? AND checked_at < ?', [siteId, toSql(from), toSql(to)]);
  const [incidents] = await pool.query('SELECT * FROM incidents WHERE site_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at', [siteId, toSql(from), toSql(to)]);
  const [[scan]] = await pool.query('SELECT * FROM scans WHERE site_id = ? AND finished_at IS NOT NULL AND error IS NULL AND started_at < ? ORDER BY started_at DESC LIMIT 1', [siteId, toSql(to)]);
  // Clients see open issues only (not ones the team marked fixed or ignored).
  const [issues] = scan ? await pool.query(`SELECT si.type, si.severity, si.page_url, si.detail, si.evidence FROM scan_issues si
      LEFT JOIN issue_status st ON st.site_id = si.site_id AND st.fingerprint = si.fingerprint
      WHERE si.scan_id = ? AND st.status IS NULL ORDER BY FIELD(si.severity, "high", "medium", "low") LIMIT 25`, [scan.id]) : [[]];

  const total = Number(stats.total || 0);
  const uptime = total ? (Number(stats.up) / total) * 100 : null;
  const downMs = incidents.reduce((sum, i) => sum + ((i.resolved_at ? new Date(i.resolved_at) : new Date(Math.min(Date.now(), to))) - new Date(i.started_at)), 0);
  return {
    site, month, uptime, checks: total, avgMs: stats.avgMs ? Math.round(stats.avgMs) : null,
    incidents, downtimeMinutes: Math.round(downMs / 60_000), scan, issues,
    sslExpires: site.ssl_expires_at, domainExpires: site.domain_expires_at
  };
}

export function renderReportHtml(r) {
  const brand = esc(brandName());
  const color = brandColor();
  const logo = /^https?:\/\//i.test(brandLogo()) ? `<img src="${esc(brandLogo())}" alt="${brand}" style="height:36px">` : `<strong style="font-size:20px">${brand}</strong>`;
  const monthName = new Date(`${r.month}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const uptimeTxt = r.uptime === null ? 'No data' : `${r.uptime.toFixed(2)}%`;
  const renew = (label, d) => {
    const left = daysLeft(d);
    const warn = left !== null && left <= 30;
    return `<tr><td>${label}</td><td>${day(d)}</td><td style="color:${warn ? '#b91c1c' : 'inherit'}">${left === null ? 'Unknown' : left <= 0 ? 'EXPIRED' : `${left} days`}</td></tr>`;
  };
  const card = (label, value) => `<td style="padding:16px;border:1px solid #e5e7eb;border-radius:8px;text-align:center"><div style="font-size:24px;font-weight:700;color:${color}">${value}</div><div style="color:#6b7280;font-size:13px">${label}</div></td>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.site.name)} – ${monthName} health report</title></head>
<body style="margin:0;background:#f3f4f6;font-family:Segoe UI,Arial,sans-serif;color:#111827">
<div style="max-width:680px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden">
  <div style="background:${color};color:#fff;padding:20px 24px;display:flex;justify-content:space-between;align-items:center">${logo}<span>Monthly website health report</span></div>
  <div style="padding:24px">
    <h1 style="margin:0 0 4px;font-size:22px">${esc(r.site.name)}</h1>
    <p style="margin:0 0 20px;color:#6b7280">${esc(r.site.url)} · ${monthName}</p>
    <table style="width:100%;border-spacing:8px"><tr>${card('Uptime', uptimeTxt)}${card('Downtime incidents', r.incidents.length)}${card('Avg response', r.avgMs ? `${r.avgMs} ms` : '—')}</tr></table>
    <h2 style="font-size:17px;margin-top:24px">Renewal dates</h2>
    <table style="width:100%;border-collapse:collapse" cellpadding="8"><tr style="background:#f9fafb;text-align:left"><th>Item</th><th>Expires</th><th>Time left</th></tr>${renew('SSL certificate', r.sslExpires)}${renew('Domain name', r.domainExpires)}</table>
    ${r.site.backup_expected_hours ? `<h2 style="font-size:17px;margin-top:24px">Backups</h2>
    <p>Expected every ${r.site.backup_expected_hours} h. Last backup: <b>${r.site.last_backup_at ? new Date(r.site.last_backup_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'none received yet'}</b>${r.site.last_backup_status === 'fail' ? ' <span style="color:#b91c1c">(reported FAILED)</span>' : ''}</p>` : ''}
    <h2 style="font-size:17px;margin-top:24px">Downtime</h2>
    ${r.incidents.length ? `<table style="width:100%;border-collapse:collapse" cellpadding="8"><tr style="background:#f9fafb;text-align:left"><th>Started (UTC)</th><th>Resolved</th><th>Cause</th></tr>${r.incidents.map((i) => `<tr><td>${new Date(i.started_at).toISOString().slice(0, 16).replace('T', ' ')}</td><td>${i.resolved_at ? new Date(i.resolved_at).toISOString().slice(0, 16).replace('T', ' ') : 'Ongoing'}</td><td>${esc(i.cause)}</td></tr>`).join('')}</table><p style="color:#6b7280">Total downtime: about ${r.downtimeMinutes} minutes.</p>` : '<p>No downtime this month. 🎉</p>'}
    <h2 style="font-size:17px;margin-top:24px">Website issues</h2>
    ${r.scan ? `<p>${esc(r.scan.summary)} (last scan ${day(r.scan.started_at)})</p>${r.issues.length ? `<ul>${r.issues.map((i) => `<li><b>${esc(i.severity)}</b> – ${esc(i.detail)}${i.evidence ? `<br><small style="word-break:break-all">${esc(i.evidence)}</small>` : ''}<br><small style="color:#6b7280">${esc(i.page_url)}</small></li>`).join('')}</ul>` : ''}` : '<p>No page scan yet.</p>'}
  </div>
  <div style="padding:16px 24px;background:#f9fafb;color:#6b7280;font-size:12px">Monitored 24/7 by ${brand}. Checks run every ${Number(process.env.CHECK_INTERVAL_MINUTES || 5)} minutes.</div>
</div></body></html>`;
}

/** Email last month's report to the client once (dedupe via alerts table). */
export async function sendMonthlyReport(site, month = previousMonth()) {
  if (!site.client_email) return { skipped: 'no client email' };
  try {
    await pool.query('INSERT INTO alerts (site_id, kind, dedupe_key, subject, message, channels) VALUES (?, "report", ?, ?, ?, "email")',
      [site.id, `report:${site.id}:${month}`, `Monthly report ${month}`, `Sent to ${site.client_email}`]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return { skipped: 'already sent' };
    throw e;
  }
  const report = await buildReport(site.id, month);
  const html = renderReportHtml(report);
  const text = `${site.name} – ${month}\nUptime: ${report.uptime === null ? 'no data' : report.uptime.toFixed(2) + '%'}\nIncidents: ${report.incidents.length}\nSSL expires: ${day(report.sslExpires)}\nDomain expires: ${day(report.domainExpires)}`;
  const pdf = await renderReportPdf(report, await fetchLogo());
  const sent = await sendEmail(site.client_email, `${site.name}: website health report for ${month}`, text, html,
    [{ filename: reportFileName(site, month), content: pdf, contentType: 'application/pdf' }]);
  return { sent };
}
