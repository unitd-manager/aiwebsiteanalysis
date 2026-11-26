import { pool } from './db.js';

// Settings edited on the Settings page. A saved value wins over .env; .env is the fallback,
// so a fresh install still works from .env alone. Secrets (SMTP/WhatsApp keys) stay in .env only.
const ENV_FALLBACK = {
  brand_name: 'BRAND_NAME',
  brand_color: 'BRAND_COLOR',
  brand_logo_url: 'BRAND_LOGO_URL',
  team_email: 'TEAM_EMAIL',
  team_whatsapp: 'TEAM_WHATSAPP'
};
export const EDITABLE = Object.keys(ENV_FALLBACK);

let cache = null;

export async function loadSettings() {
  const [rows] = await pool.query('SELECT name, value FROM settings');
  cache = Object.fromEntries(rows.map((r) => [r.name, r.value]));
  return cache;
}

/** Synchronous read (settings are loaded at startup and after every save). */
export function setting(name, fallback = '') {
  const saved = cache?.[name];
  if (saved !== undefined && saved !== null && saved !== '') return saved;
  const envName = ENV_FALLBACK[name];
  return (envName && process.env[envName]) || fallback;
}

export async function saveSettings(values) {
  for (const [name, value] of Object.entries(values)) {
    await pool.query('INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [name, value ?? null]);
  }
  await loadSettings();
}

export const brandName = () => setting('brand_name', 'SiteGuard');
export const brandColor = () => (/^#[0-9a-f]{3,8}$/i.test(setting('brand_color')) ? setting('brand_color') : '#0f766e');
export const brandLogo = () => setting('brand_logo_url');

// For tests: set the in-memory settings without a database.
export function setSettingsCacheForTests(values) { cache = values; }
