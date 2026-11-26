import { pool, toSql } from './db.js';
import { checkUptime, nextSiteState, describeFetchError } from './checks/uptime.js';
import { checkSsl } from './checks/ssl.js';
import { checkDomain, dueReminder } from './checks/domain.js';
import { raiseAlert } from './notify.js';

const threshold = () => Math.max(1, Number(process.env.FAILURES_BEFORE_ALERT || 2));
const reminderDays = () => String(process.env.EXPIRY_REMINDER_DAYS || '30,14,7,1').split(',').map(Number).filter((n) => n > 0);
const fmtDate = (d) => new Date(d).toISOString().slice(0, 10);

export function formatDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`;
}

export async function runUptimeCheck(site) {
  const result = await checkUptime(site.url);
  const now = new Date();
  const state = nextSiteState({ status: site.status, consecutiveFailures: site.consecutive_failures }, result, threshold());
  await pool.query('INSERT INTO checks (site_id, checked_at, ok, status_code, response_ms, error) VALUES (?, ?, ?, ?, ?, ?)',
    [site.id, toSql(now), result.ok ? 1 : 0, result.statusCode, result.responseMs, result.error]);
  await pool.query('UPDATE sites SET status = ?, consecutive_failures = ?, last_checked_at = ?, last_status_code = ?, last_response_ms = ?, last_error = ? WHERE id = ?',
    [state.status, state.consecutiveFailures, toSql(now), result.statusCode, result.responseMs, result.error, site.id]);

  if (state.wentDown) {
    const [ins] = await pool.query('INSERT INTO incidents (site_id, started_at, cause) VALUES (?, ?, ?)', [site.id, toSql(now), result.error]);
    await raiseAlert(site, {
      kind: 'down', dedupeKey: `down:${site.id}:${ins.insertId}`,
      subject: `🔴 ${site.name} is DOWN`,
      message: `${site.url} failed ${state.consecutiveFailures} checks in a row.\nReason: ${result.error}\nDetected: ${now.toUTCString()}`
    });
  }
  if (state.recovered) {
    const [[open]] = await pool.query('SELECT * FROM incidents WHERE site_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1', [site.id]);
    let downtime = '';
    if (open) {
      await pool.query('UPDATE incidents SET resolved_at = ? WHERE id = ?', [toSql(now), open.id]);
      downtime = `\nDowntime: about ${formatDuration(now - new Date(open.started_at))}`;
    }
    await raiseAlert(site, {
      kind: 'up', dedupeKey: open ? `up:${site.id}:${open.id}` : null,
      subject: `✅ ${site.name} is back UP`,
      message: `${site.url} is responding again (HTTP ${result.statusCode}, ${result.responseMs} ms).${downtime}`
    });
  }
  return { ...result, status: state.status };
}

export async function runSslCheck(site) {
  const ssl = await checkSsl(site.url);
  await pool.query('UPDATE sites SET ssl_expires_at = ?, ssl_issuer = ?, ssl_checked_at = ? WHERE id = ?', [toSql(ssl.expiresAt), ssl.issuer || null, toSql(new Date()), site.id]);
  const due = dueReminder(ssl.expiresAt, new Date(), reminderDays());
  if (due) {
    const expired = due.daysLeft <= 0;
    await raiseAlert(site, {
      kind: 'ssl_expiry', dedupeKey: `ssl:${site.id}:${fmtDate(ssl.expiresAt)}:${due.threshold}`,
      subject: expired ? `⛔ SSL certificate EXPIRED for ${site.name}` : `⚠️ SSL certificate for ${site.name} expires in ${due.daysLeft} day(s)`,
      message: `${site.url}\nCertificate expiry: ${fmtDate(ssl.expiresAt)}${ssl.issuer ? `\nIssuer: ${ssl.issuer}` : ''}\nRenew it before visitors see a security warning.`
    });
  } else if (ssl.error && ssl.expiresAt) {
    await raiseAlert(site, {
      kind: 'ssl_invalid', dedupeKey: `sslbad:${site.id}:${fmtDate(new Date())}`,
      subject: `⚠️ SSL problem on ${site.name}`, message: `${site.url}\nCertificate problem: ${describeFetchError({ code: ssl.error })}.\nSome browsers, apps and APIs will refuse the connection. Ask the host to install the full certificate chain.`
    });
  }
  return ssl;
}

export async function runDomainCheck(site) {
  const domain = await checkDomain(site.url);
  await pool.query('UPDATE sites SET domain_expires_at = COALESCE(?, domain_expires_at), domain_checked_at = ? WHERE id = ?', [toSql(domain.expiresAt), toSql(new Date()), site.id]);
  const due = dueReminder(domain.expiresAt, new Date(), reminderDays());
  if (due) {
    await raiseAlert(site, {
      kind: 'domain_expiry', dedupeKey: `domain:${site.id}:${fmtDate(domain.expiresAt)}:${due.threshold}`,
      subject: due.daysLeft <= 0 ? `⛔ Domain ${domain.domain} has EXPIRED` : `⚠️ Domain ${domain.domain} expires in ${due.daysLeft} day(s)`,
      message: `Site: ${site.name} (${site.url})\nDomain expiry: ${fmtDate(domain.expiresAt)}\nRenew it at the registrar so the site and email keep working.`
    });
  }
  return domain;
}
