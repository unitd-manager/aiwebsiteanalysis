// Remembering issues across daily scans, so the team only hears about NEW problems.
//
// Each issue gets a stable fingerprint (what is wrong, not where the crawler happened to see it
// first). The team can mark an issue:
//   fixed   - hidden now; if the next scan still finds it, it comes back as NEW ("came back")
//   ignored - never counted or alerted again (e.g. a link that only fails for bots)
import crypto from 'node:crypto';
import { pool } from './db.js';

export function issueFingerprint(issue) {
  const norm = (s) => String(s || '').toLowerCase().replace(/^ai:\s*/, '').replace(/\W+/g, '').slice(0, 120);
  let key;
  if (issue.type === 'page_error') key = `page_error|${issue.page_url}`;
  else if (issue.type === 'broken_link' || issue.type === 'broken_image') key = `${issue.type}|${issue.evidence || issue.detail}`;
  // Rule and AI findings about the same text share one fingerprint (quote, not the AI's wording).
  else key = `content|${norm(issue.evidence || issue.detail)}`;
  return crypto.createHash('sha1').update(key).digest('hex');
}

/**
 * Decide for each issue of a new scan whether it is new, still open, or ignored.
 * prevFingerprints: fingerprints from the site's previous successful scan.
 * statuses: Map fingerprint -> 'fixed' | 'ignored'.
 */
export function classifyIssues(issues, prevFingerprints, statuses) {
  const reopened = [];
  const out = issues.map((issue) => {
    const fingerprint = issueFingerprint(issue);
    const status = statuses.get(fingerprint);
    if (status === 'ignored') return { ...issue, fingerprint, is_new: 0, ignored: true };
    if (status === 'fixed') { reopened.push(fingerprint); return { ...issue, fingerprint, is_new: 1, reopened: true }; }
    return { ...issue, fingerprint, is_new: prevFingerprints.has(fingerprint) ? 0 : 1 };
  });
  return { issues: out, reopened };
}

export async function loadIssueMemory(siteId) {
  const [rows] = await pool.query('SELECT fingerprint, status FROM issue_status WHERE site_id = ?', [siteId]);
  const [[prev]] = await pool.query('SELECT id FROM scans WHERE site_id = ? AND finished_at IS NOT NULL AND error IS NULL ORDER BY id DESC LIMIT 1', [siteId]);
  const [prevRows] = prev ? await pool.query('SELECT fingerprint FROM scan_issues WHERE scan_id = ?', [prev.id]) : [[]];
  return { statuses: new Map(rows.map((r) => [r.fingerprint, r.status])), prevFingerprints: new Set(prevRows.map((r) => r.fingerprint)) };
}

export async function setIssueStatus(siteId, fingerprint, status) {
  if (!fingerprint) return;
  if (status === 'open') await pool.query('DELETE FROM issue_status WHERE site_id = ? AND fingerprint = ?', [siteId, fingerprint]);
  else await pool.query('INSERT INTO issue_status (site_id, fingerprint, status) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status), created_at = CURRENT_TIMESTAMP', [siteId, fingerprint, status]);
}

// Latest successful scan per site, and its issues that are neither fixed nor ignored.
const LATEST = '(SELECT site_id, MAX(id) AS id FROM scans WHERE finished_at IS NOT NULL AND error IS NULL GROUP BY site_id)';
export const OPEN_ISSUES_SQL = `SELECT si.site_id, COUNT(*) AS n FROM scan_issues si JOIN ${LATEST} l ON l.id = si.scan_id
  LEFT JOIN issue_status st ON st.site_id = si.site_id AND st.fingerprint = si.fingerprint WHERE st.status IS NULL GROUP BY si.site_id`;

/** Issues saved before fingerprints existed get one, so Fixed/Ignore works on them too. */
export async function backfillFingerprints() {
  const [rows] = await pool.query('SELECT id, type, page_url, detail, evidence FROM scan_issues WHERE fingerprint IS NULL');
  for (const r of rows) await pool.query('UPDATE scan_issues SET fingerprint = ? WHERE id = ?', [issueFingerprint(r), r.id]);
}
