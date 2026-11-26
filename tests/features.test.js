import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { issueFingerprint, classifyIssues } from '../server/issues.js';
import { backupOverdue, backupGraceHours } from '../server/backups.js';
import { expiredEventDates } from '../server/pages.js';
import { deliverAlert, alertRecipients, setMailTransportForTests } from '../server/notify.js';
import { setSettingsCacheForTests } from '../server/settings.js';

test('issue fingerprints ignore which page the crawler saw first and AI wording', () => {
  const a = { type: 'broken_link', page_url: 'https://s.com/a', detail: 'Broken link (HTTP 404)', evidence: 'https://x.com/dead' };
  const b = { ...a, page_url: 'https://s.com/b', detail: 'Broken link (HTTP 404) (on 3 pages)' };
  assert.equal(issueFingerprint(a), issueFingerprint(b));
  const ai1 = { type: 'outdated_banner', page_url: 'https://s.com/', detail: 'AI: Webinar passed, remove it', evidence: 'Webinar: Secure AI Agents' };
  const ai2 = { ...ai1, type: 'expired_date', detail: 'AI: The webinar already happened' };
  assert.equal(issueFingerprint(ai1), issueFingerprint(ai2), 'same quote = same issue');
  assert.notEqual(issueFingerprint({ type: 'page_error', page_url: 'https://s.com/x', detail: 'HTTP 500' }), issueFingerprint({ type: 'page_error', page_url: 'https://s.com/y', detail: 'HTTP 500' }));
});

test('daily scans flag only new issues; ignored stay quiet; fixed ones come back if still there', () => {
  const link = { type: 'broken_link', page_url: 'https://s.com/', detail: 'Broken', evidence: 'https://x.com/1' };
  const known = { ...link, evidence: 'https://x.com/2' };
  const ignored = { ...link, evidence: 'https://x.com/3' };
  const fixed = { ...link, evidence: 'https://x.com/4' };
  const prev = new Set([issueFingerprint(known), issueFingerprint(fixed)]);
  const statuses = new Map([[issueFingerprint(ignored), 'ignored'], [issueFingerprint(fixed), 'fixed']]);
  const { issues, reopened } = classifyIssues([link, known, ignored, fixed], prev, statuses);
  const by = (e) => issues.find((i) => i.evidence === e);
  assert.equal(by('https://x.com/1').is_new, 1, 'never seen before');
  assert.equal(by('https://x.com/2').is_new, 0, 'seen yesterday');
  assert.equal(by('https://x.com/3').ignored, true);
  assert.equal(by('https://x.com/4').reopened, true);
  assert.deepEqual(reopened, [issueFingerprint(fixed)]);
});

test('backup is overdue only after the interval plus grace', () => {
  const last = new Date('2026-11-25T00:00:00Z');
  const site = { backup_expected_hours: 24, last_backup_at: last };
  assert.equal(backupGraceHours(24), 2);
  assert.equal(backupGraceHours(2), 1);
  assert.equal(backupOverdue(site, new Date('2026-11-26T01:00:00Z')).overdue, false, '25h: within grace');
  assert.equal(backupOverdue(site, new Date('2026-11-26T03:00:00Z')).overdue, true, '27h: overdue');
  assert.equal(backupOverdue({ backup_expected_hours: null, last_backup_at: last }, new Date('2027-01-01')).overdue, false, 'monitoring off');
  assert.equal(backupOverdue({ backup_expected_hours: 24, backup_since: last }, new Date('2026-11-27T00:00:00Z')).overdue, true, 'never checked in');
});

test('dates without a year are caught on event banners (the October 26th webinar case)', () => {
  const now = new Date('2026-11-26T00:00:00Z');
  const banner = 'Webinar: Building Secure AI Agents for the Enterprise\nOctober 26th | 11:00 AM EDT\nRegister now';
  const found = expiredEventDates(banner, now);
  assert.equal(found.length, 1);
  assert.equal(found[0].yearless, true);
  assert.equal(found[0].date.toISOString().slice(0, 10), '2026-10-26');
  // Upcoming, far past (= probably next year), dated with a year, and lowercase "may" are not flagged as year-less.
  assert.equal(expiredEventDates('Upcoming webinar: December 10th', now).length, 0);
  assert.equal(expiredEventDates('Annual summit: January 15th', now).length, 0);
  assert.equal(expiredEventDates('Webinar: you may 5 times register', now).length, 0);
  assert.equal(expiredEventDates('Webinar on October 26, 2026', now).filter((d) => d.yearless).length, 0);
});

test('alerts go to the team (and client only when opted in), by email and WhatsApp', async () => {
  setSettingsCacheForTests({ team_email: 'web@agency.test', team_whatsapp: '+91 98765 43210', brand_name: 'AcmeGuard' });
  const site = { id: 1, alert_client: 0, client_email: 'boss@client.test', client_whatsapp: '+919000000000' };
  assert.deepEqual(alertRecipients(site), { emails: ['web@agency.test'], phones: ['+919876543210'] });
  assert.deepEqual(alertRecipients({ ...site, alert_client: 1 }).emails, ['web@agency.test', 'boss@client.test']);
  assert.deepEqual(alertRecipients({ ...site, alert_client: 1 }, false).emails, ['web@agency.test'], 'scan alerts are team-only');

  // Email: capture with nodemailer's JSON transport. WhatsApp: capture the Twilio API call.
  const sent = [];
  const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
  setMailTransportForTests({ sendMail: async (m) => { sent.push(m); return jsonTransport.sendMail(m); } });
  const calls = [];
  const realFetch = globalThis.fetch;
  Object.assign(process.env, { WHATSAPP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886' });
  globalThis.fetch = async (url, init) => { calls.push({ url, body: String(init.body) }); return new Response('{}', { status: 201 }); };
  try {
    const result = await deliverAlert({ emails: ['web@agency.test'], phones: ['+919876543210'], subject: 'Site DOWN', message: 'acme.com failed 2 checks' });
    assert.deepEqual(result.delivered.sort(), ['email', 'whatsapp']);
    assert.deepEqual(result.errors, []);
    assert.equal(sent[0].subject, '[AcmeGuard] Site DOWN');
    assert.equal(sent[0].to, 'web@agency.test');
    assert.match(calls[0].url, /api\.twilio\.com\/2010-04-01\/Accounts\/AC123\/Messages\.json/);
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.get('To'), 'whatsapp:+919876543210');
    assert.match(form.get('Body'), /Site DOWN[\s\S]*failed 2 checks/);

    // A provider error is reported, not thrown, and email still goes out.
    globalThis.fetch = async () => new Response('Authenticate', { status: 401 });
    const bad = await deliverAlert({ emails: ['web@agency.test'], phones: ['+919876543210'], subject: 'x', message: 'y' });
    assert.deepEqual(bad.delivered, ['email']);
    assert.match(bad.errors[0], /Twilio WhatsApp failed: HTTP 401/);
  } finally {
    globalThis.fetch = realFetch;
    setMailTransportForTests(null);
    for (const k of ['WHATSAPP_PROVIDER', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM']) delete process.env[k];
  }
});

test('monthly report renders as a multi-page PDF, even with emoji and long issue lists', async () => {
  const { renderReportPdf, reportFileName } = await import('../server/reportPdf.js');
  setSettingsCacheForTests({ brand_name: 'Test Agency 🛡️', brand_color: '#1d4ed8' });
  const site = { name: 'example.com', url: 'https://www.example.com/', backup_expected_hours: 24, last_backup_at: new Date(), last_backup_status: 'ok' };
  const issues = Array.from({ length: 25 }, (_, i) => ({ severity: ['high', 'medium', 'low'][i % 3], detail: `Broken link (HTTP 404) → https://example.com/a/very/long/path/${i} “quoted” ₹799 🎉`, page_url: `https://www.example.com/page-${i}` }));
  const pdf = await renderReportPdf({
    site, month: '2026-10', uptime: 99.512, checks: 8000, avgMs: 420,
    incidents: [{ started_at: new Date('2026-10-03T10:00:00Z'), resolved_at: new Date('2026-10-03T10:12:00Z'), cause: 'HTTP 502' }],
    downtimeMinutes: 12, scan: { summary: 'Found 25 issues across 40 pages.', started_at: new Date() }, issues,
    sslExpires: new Date(Date.now() + 10 * 86_400_000), domainExpires: null
  });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pages >= 2, `expected 2+ pages, got ${pages}`);
  assert.equal(reportFileName(site, '2026-10'), 'example.com-2026-10-health-report.pdf');
  setSettingsCacheForTests({});
});
