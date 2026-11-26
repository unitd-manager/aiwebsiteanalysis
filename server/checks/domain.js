// Domain expiry from RDAP (the modern, free, JSON replacement for WHOIS). rdap.org redirects
// to the right registry (Verisign for .com, NIXI for .in, etc.).

// Common two-part public suffixes, so "shop.example.co.in" -> "example.co.in".
const TWO_PART_SUFFIXES = new Set([
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in', 'res.in',
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'net.nz',
  'com.sg', 'com.my', 'com.br', 'com.mx', 'com.ar', 'co.za', 'co.jp', 'ne.jp', 'or.jp', 'com.cn', 'com.hk', 'com.tr', 'com.pk', 'com.bd', 'com.lk', 'com.np', 'co.ae', 'com.sa', 'com.ng', 'co.ke'
]);

export function registrableDomain(hostname) {
  const parts = hostname.toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

export function expirationFromRdap(json) {
  const event = (json?.events || []).find((e) => /expiration/i.test(e.eventAction || ''));
  const date = event ? new Date(event.eventDate) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

// IANA's official list of which registry serves RDAP for each TLD, cached for a day.
let bootstrap = { at: 0, services: [] };
async function rdapBase(tld) {
  if (Date.now() - bootstrap.at > 86_400_000) {
    try {
      const res = await fetch('https://data.iana.org/rdap/dns.json', { signal: AbortSignal.timeout(15_000) });
      if (res.ok) bootstrap = { at: Date.now(), services: (await res.json()).services || [] };
    } catch { /* fall back to rdap.org below */ }
  }
  const entry = bootstrap.services.find(([tlds]) => tlds.includes(tld));
  return entry?.[1]?.[0] || 'https://rdap.org/';
}

export async function checkDomain(siteUrl, { timeoutMs = 15_000 } = {}) {
  const domain = registrableDomain(new URL(siteUrl).hostname);
  try {
    const base = await rdapBase(domain.split('.').pop());
    const res = await fetch(`${base.replace(/\/?$/, '/')}domain/${encodeURIComponent(domain)}`, {
      redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/rdap+json, application/json', 'user-agent': 'SiteGuard/0.1 (website monitor)' }
    });
    if (res.status === 404) return { domain, expiresAt: null, error: 'Registry has no RDAP record for this domain' };
    if (!res.ok) return { domain, expiresAt: null, error: `RDAP lookup failed (HTTP ${res.status})` };
    const expiresAt = expirationFromRdap(await res.json());
    return { domain, expiresAt, error: expiresAt ? null : 'Registry did not publish an expiry date' };
  } catch (error) {
    return { domain, expiresAt: null, error: `RDAP lookup failed: ${error.message}` };
  }
}

// Which reminder (if any) is due: the smallest threshold the remaining days have crossed.
export function dueReminder(expiresAt, now = new Date(), thresholds = [30, 14, 7, 1]) {
  if (!expiresAt) return null;
  const daysLeft = Math.ceil((new Date(expiresAt) - now) / 86_400_000);
  if (daysLeft <= 0) return { daysLeft, threshold: 0 };
  const crossed = [...thresholds].sort((a, b) => a - b).find((t) => daysLeft <= t);
  return crossed === undefined ? null : { daysLeft, threshold: crossed };
}
