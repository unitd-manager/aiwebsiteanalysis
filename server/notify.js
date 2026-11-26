import nodemailer from 'nodemailer';
import { pool } from './db.js';

let transport;
function mailer() {
  if (!process.env.SMTP_HOST) return null;
  transport ||= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  return transport;
}

export async function sendEmail(to, subject, text, html) {
  const recipients = [to].flat().filter(Boolean);
  const t = mailer();
  if (!recipients.length || !t) return false;
  await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: recipients.join(', '), subject, text, html });
  return true;
}

const normalizePhone = (n) => String(n || '').replace(/[^\d+]/g, '').replace(/^(?!\+)/, '+');

export async function sendWhatsApp(to, text) {
  const provider = (process.env.WHATSAPP_PROVIDER || '').toLowerCase();
  const phone = to && normalizePhone(to);
  if (!phone || !provider) return false;
  const body = text.slice(0, 1500);
  if (provider === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: process.env.TWILIO_WHATSAPP_FROM, To: `whatsapp:${phone}`, Body: body })
    });
    if (!res.ok) throw new Error(`Twilio WhatsApp failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return true;
  }
  if (provider === 'meta') {
    // Note: Meta only delivers free-form text inside a 24h customer-service window. For cold alerts,
    // create an approved template and switch this payload to type "template".
    const res = await fetch(`https://graph.facebook.com/v21.0/${process.env.META_WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.META_WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone.replace('+', ''), type: 'text', text: { body } })
    });
    if (!res.ok) throw new Error(`Meta WhatsApp failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return true;
  }
  throw new Error(`Unknown WHATSAPP_PROVIDER "${provider}"`);
}

/**
 * Record an alert and deliver it to the web team (and the client, if the site opts in).
 * dedupeKey makes it fire once: e.g. "ssl:12:2026-12-31:14" is sent only once per threshold.
 */
export async function raiseAlert(site, { kind, dedupeKey = null, subject, message, includeClient = true }) {
  let alertId;
  try {
    const [result] = await pool.query('INSERT INTO alerts (site_id, kind, dedupe_key, subject, message) VALUES (?, ?, ?, ?, ?)', [site?.id ?? null, kind, dedupeKey, subject, message]);
    alertId = result.insertId;
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return { skipped: true };
    throw error;
  }
  const emails = [process.env.TEAM_EMAIL];
  const phones = [process.env.TEAM_WHATSAPP];
  if (includeClient && site?.alert_client) { emails.push(site.client_email); phones.push(site.client_whatsapp); }

  const delivered = [];
  const attempts = [
    sendEmail(emails.filter(Boolean), `[${process.env.BRAND_NAME || 'SiteGuard'}] ${subject}`, message).then((ok) => ok && delivered.push('email')),
    ...[...new Set(phones.filter(Boolean))].map((p) => sendWhatsApp(p, `${subject}\n\n${message}`).then((ok) => ok && delivered.push('whatsapp')))
  ];
  const results = await Promise.allSettled(attempts);
  for (const r of results) if (r.status === 'rejected') console.error('[alert] delivery failed:', r.reason?.message);
  if (!delivered.length) console.log(`[alert] ${subject} — ${message.split('\n')[0]} (no channel configured, saved to dashboard only)`);
  await pool.query('UPDATE alerts SET channels = ? WHERE id = ?', [[...new Set(delivered)].join(',') || 'dashboard', alertId]);
  return { id: alertId, delivered };
}
