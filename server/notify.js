import nodemailer from 'nodemailer';
import { pool } from './db.js';
import { setting, brandName } from './settings.js';

let transport;
let transportForTests = null;
export function setMailTransportForTests(t) { transportForTests = t; }

function mailer() {
  if (transportForTests) return transportForTests;
  if (!process.env.SMTP_HOST) return null;
  transport ||= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  return transport;
}

/** Which channels can send right now, and what is missing (shown on the Settings page). */
export function channelStatus() {
  const provider = (process.env.WHATSAPP_PROVIDER || '').toLowerCase();
  const waKeys = provider === 'twilio' ? ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM'] : provider === 'meta' ? ['META_WHATSAPP_TOKEN', 'META_WHATSAPP_PHONE_ID'] : [];
  const emailMissing = [!process.env.SMTP_HOST && 'SMTP_HOST in .env', !setting('team_email') && 'team email'].filter(Boolean);
  const waMissing = [!provider && 'WHATSAPP_PROVIDER in .env', ...waKeys.filter((k) => !process.env[k]).map((k) => `${k} in .env`), !setting('team_whatsapp') && 'team WhatsApp number'].filter(Boolean);
  return {
    email: { ready: !emailMissing.length, missing: emailMissing, smtpHost: process.env.SMTP_HOST || null },
    whatsapp: { ready: !waMissing.length, missing: waMissing, provider: provider || null }
  };
}

export async function sendEmail(to, subject, text, html, attachments) {
  const recipients = [to].flat().filter(Boolean);
  const t = mailer();
  if (!recipients.length || !t) return false;
  await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: recipients.join(', '), subject, text, html, attachments });
  return true;
}

export const normalizePhone = (n) => String(n || '').replace(/[^\d+]/g, '').replace(/^(?!\+)/, '+');

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
    // Meta only delivers free-form text inside a 24h customer-service window. For cold alerts,
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

/** Who receives an alert: always the web team, plus the client when the site opts in. */
export function alertRecipients(site, includeClient = true) {
  const emails = [setting('team_email')];
  const phones = [setting('team_whatsapp')];
  if (includeClient && site?.alert_client) { emails.push(site.client_email); phones.push(site.client_whatsapp); }
  const uniq = (list) => [...new Set(list.map((x) => String(x || '').trim()).filter(Boolean))];
  return { emails: uniq(emails), phones: uniq(phones.map((p) => p && normalizePhone(p))) };
}

/** Send one alert on every configured channel. Returns what was delivered and any errors. */
export async function deliverAlert({ emails, phones, subject, message }) {
  const delivered = new Set();
  const errors = [];
  const fullSubject = `[${brandName()}] ${subject}`;
  const jobs = [
    sendEmail(emails, fullSubject, message).then((ok) => ok && delivered.add('email')).catch((e) => errors.push(`Email: ${e.message}`)),
    ...phones.map((p) => sendWhatsApp(p, `${subject}\n\n${message}`).then((ok) => ok && delivered.add('whatsapp')).catch((e) => errors.push(`WhatsApp ${p}: ${e.message}`)))
  ];
  await Promise.all(jobs);
  return { delivered: [...delivered], errors };
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
  const { emails, phones } = alertRecipients(site, includeClient);
  const { delivered, errors } = await deliverAlert({ emails, phones, subject, message });
  for (const e of errors) console.error('[alert] delivery failed:', e);
  if (!delivered.length) console.log(`[alert] ${subject} (no channel delivered; saved to dashboard)`);
  await pool.query('UPDATE alerts SET channels = ? WHERE id = ?', [delivered.join(',') || (errors.length ? 'failed' : 'dashboard'), alertId]);
  return { id: alertId, delivered, errors };
}
