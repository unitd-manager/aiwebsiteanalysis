// Backup monitoring by check-in ("dead man's switch").
//
// SiteGuard can't see inside a hosting account, so the backup job reports in instead:
// after each backup it calls the site's secret link, e.g.
//     curl -fsS https://siteguard.example.com/api/backup-checkin/<token>
//     curl -fsS "https://.../api/backup-checkin/<token>?status=fail&message=disk%20full"
// If no successful check-in arrives within the expected interval (+ a grace period), the web
// team is alerted. Works with cron, WordPress backup plugins that support webhooks, hosting
// panels, or any script.
import crypto from 'node:crypto';
import { pool, toSql } from './db.js';
import { raiseAlert } from './notify.js';

export const newBackupToken = () => crypto.randomBytes(24).toString('base64url');

const fmt = (d) => new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** Grace period: 10% of the interval, at least 1 hour, at most 6 hours. */
export const backupGraceHours = (hours) => Math.min(6, Math.max(1, Math.round(hours * 0.1)));

/** Is this site's backup overdue right now? Returns { overdue, dueAt } (dueAt includes grace). */
export function backupOverdue(site, now = new Date()) {
  const hours = Number(site.backup_expected_hours);
  if (!hours) return { overdue: false, dueAt: null };
  const since = site.last_backup_at || site.backup_since || site.created_at;
  if (!since) return { overdue: false, dueAt: null };
  const dueAt = new Date(new Date(since).getTime() + (hours + backupGraceHours(hours)) * 3_600_000);
  return { overdue: now > dueAt, dueAt };
}

export async function recordBackupCheckin(token, status, message) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [[site]] = await pool.query('SELECT * FROM sites WHERE backup_token = ?', [token]);
  if (!site) return null;
  const now = new Date();
  const previous = site.last_backup_status;
  if (status === 'ok') {
    await pool.query("UPDATE sites SET last_backup_at = ?, last_backup_status = 'ok', last_backup_message = ? WHERE id = ?", [toSql(now), message || null, site.id]);
    if (previous === 'missed' || previous === 'fail') {
      await raiseAlert(site, { kind: 'backup_ok', includeClient: false, subject: `✅ Backups for ${site.name} are working again`, message: `A successful backup checked in at ${fmt(now)}.` });
    }
  } else {
    await pool.query("UPDATE sites SET last_backup_status = 'fail', last_backup_message = ? WHERE id = ?", [message || null, site.id]);
    await raiseAlert(site, {
      kind: 'backup_fail', dedupeKey: `backup_fail:${site.id}:${now.toISOString().slice(0, 13)}`, includeClient: false,
      subject: `⛔ Backup FAILED for ${site.name}`,
      message: `The backup job reported a failure at ${fmt(now)}.${message ? `\nMessage: ${message}` : ''}\nCheck the backup job on the hosting server.`
    });
  }
  return site;
}

/** Called by the scheduler: one alert per missed backup window. */
export async function checkBackups(now = new Date()) {
  const [sites] = await pool.query('SELECT * FROM sites WHERE paused = 0 AND backup_expected_hours IS NOT NULL');
  for (const site of sites) {
    const { overdue } = backupOverdue(site, now);
    if (!overdue) continue;
    const result = await raiseAlert(site, {
      kind: 'backup_missed', includeClient: false,
      dedupeKey: `backup_missed:${site.id}:${site.last_backup_at ? new Date(site.last_backup_at).toISOString() : 'never'}`,
      subject: `⚠️ No backup received for ${site.name}`,
      message: site.last_backup_at
        ? `The last successful backup was at ${fmt(site.last_backup_at)}. A backup is expected every ${site.backup_expected_hours} h.\nCheck that the backup job is still running.`
        : `No backup has checked in since monitoring started. A backup is expected every ${site.backup_expected_hours} h.\nAdd the check-in link to the backup job (see the site page in SiteGuard).`
    });
    if (!result.skipped) await pool.query("UPDATE sites SET last_backup_status = 'missed' WHERE id = ?", [site.id]);
  }
}
