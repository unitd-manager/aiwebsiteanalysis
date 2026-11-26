import { pool } from './db.js';
import { runUptimeCheck, runSslCheck, runDomainCheck } from './monitor.js';
import { runSiteScan } from './scanAgent.js';
import { sendMonthlyReport, previousMonth } from './report.js';

const HOUR = 3_600_000;
let busy = false;
let scanning = false;

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.allSettled(items.slice(i, i + size).map((item) => fn(item).catch((e) => console.error(`[scheduler] site ${item.id}:`, e.message))));
  }
}

export async function tick(now = new Date()) {
  if (busy) return;
  busy = true;
  try {
    const intervalMs = Number(process.env.CHECK_INTERVAL_MINUTES || 5) * 60_000;
    const [sites] = await pool.query('SELECT * FROM sites WHERE paused = 0');
    const older = (d, ms) => !d || now - new Date(d) >= ms;

    // While a site is failing, re-check after 1 minute so the 2nd failure (and the alert) comes fast.
    const dueUptime = sites.filter((s) => older(s.last_checked_at, s.consecutive_failures > 0 ? 60_000 : intervalMs - 5_000));
    await inBatches(dueUptime, 10, runUptimeCheck);
    await inBatches(sites.filter((s) => older(s.ssl_checked_at, 12 * HOUR)), 5, runSslCheck);
    await inBatches(sites.filter((s) => older(s.domain_checked_at, 24 * HOUR)), 3, runDomainCheck);

    // Daily AI page scan, once per day after DAILY_SCAN_HOUR (server local time).
    const scanHour = Number(process.env.DAILY_SCAN_HOUR ?? 6);
    const todayStart = new Date(now); todayStart.setHours(scanHour, 0, 0, 0);
    // Runs in the background so long scans never delay uptime checks.
    const dueScans = sites.filter((s) => !s.last_scan_at || new Date(s.last_scan_at) < todayStart);
    if (now >= todayStart && dueScans.length && !scanning) {
      scanning = true;
      (async () => {
        for (const site of dueScans) await runSiteScan(site).catch((e) => console.error(`[scan] ${site.name}:`, e.message));
      })().finally(() => { scanning = false; });
    }

    // Monthly client reports on the 1st (sendMonthlyReport sends each month only once).
    if (now.getDate() === 1 && now.getHours() >= 9) {
      for (const site of sites) await sendMonthlyReport(site, previousMonth(now)).catch((e) => console.error('[report]', e.message));
    }
  } finally {
    busy = false;
  }
}

export function startScheduler() {
  if (process.env.SCHEDULER_ENABLED === '0') return null;
  const run = () => tick().catch((e) => console.error('[scheduler]', e.message));
  setTimeout(run, 3_000);
  return setInterval(run, 60_000);
}
