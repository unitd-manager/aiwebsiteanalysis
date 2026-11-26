import https from 'node:https';

// One HTTP check: is the site answering with a non-error page in time?
export const USER_AGENT = 'Mozilla/5.0 (compatible; SiteGuardBot/0.1; +website health monitor)';

export async function checkUptime(url, { timeoutMs = 15_000 } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' }
    });
    // Read (and discard) the body so the timing covers the full page, capped to avoid huge downloads.
    await readCapped(res, 2_000_000);
    const ms = Date.now() - started;
    const ok = res.status < 400;
    return { ok, statusCode: res.status, responseMs: ms, error: ok ? null : `HTTP ${res.status}` };
  } catch (error) {
    const code = error?.cause?.code;
    // Certificate problems (e.g. missing intermediate cert) don't stop browsers from loading the
    // site, so they are not downtime. Confirm the server answers; the SSL check reports the cert issue.
    if (CERT_ERRORS.has(code)) {
      const lenient = await lenientStatus(url, timeoutMs);
      if (lenient.status) {
        const ok = lenient.status < 400;
        return { ok, statusCode: lenient.status, responseMs: Date.now() - started, error: ok ? null : `HTTP ${lenient.status}`, certWarning: describeFetchError(error, timeoutMs) };
      }
    }
    return { ok: false, statusCode: null, responseMs: Date.now() - started, error: describeFetchError(error, timeoutMs) };
  }
}

export const isCertError = (error) => CERT_ERRORS.has(error?.cause?.code || error?.code);

// GET a page without certificate validation (used only after a cert error). Returns final URL, status and body.
export function lenientGet(url, { timeoutMs = 20_000, maxBytes = 1_500_000, hops = 5 } = {}) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', rejectUnauthorized: false, timeout: timeoutMs, headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(next.startsWith('https:') ? lenientGet(next, { timeoutMs, maxBytes, hops: hops - 1 }) : { url: next, status: res.statusCode, html: '' });
      }
      const isHtml = String(res.headers['content-type'] || '').includes('html');
      const chunks = []; let size = 0;
      res.on('data', (c) => { if (!isHtml) return; size += c.length; if (size <= maxBytes) chunks.push(c); else res.destroy(); });
      const done = () => resolve({ url, status: res.statusCode, contentType: String(res.headers['content-type'] || ''), length: Number(res.headers['content-length'] || -1), html: Buffer.concat(chunks).toString('utf8') });
      res.on('end', done); res.on('close', done);
    });
    req.on('timeout', () => { req.destroy(); resolve({ url, status: 0, html: '', error: 'timeout' }); });
    req.on('error', (e) => resolve({ url, status: 0, html: '', error: e.message }));
    req.end();
  });
}

const CERT_ERRORS = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);

// Status code without certificate validation, following up to 5 redirects.
function lenientStatus(url, timeoutMs, hops = 5) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', rejectUnauthorized: false, timeout: timeoutMs, headers: { 'user-agent': USER_AGENT } }, (res) => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        const next = new URL(res.headers.location, url).toString();
        if (next.startsWith('https:')) return resolve(lenientStatus(next, timeoutMs, hops - 1));
      }
      resolve({ status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });
}

export async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size >= maxBytes) { await reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function describeFetchError(error, timeoutMs) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return `No response within ${Math.round(timeoutMs / 1000)}s`;
  const code = error?.cause?.code || error?.code;
  const map = {
    ENOTFOUND: 'Domain does not resolve (DNS lookup failed)',
    EAI_AGAIN: 'DNS lookup failed (temporary)',
    ECONNREFUSED: 'Connection refused by server',
    ECONNRESET: 'Connection reset by server',
    ETIMEDOUT: 'Connection timed out',
    CERT_HAS_EXPIRED: 'SSL certificate has expired',
    ERR_TLS_CERT_ALTNAME_INVALID: 'SSL certificate does not match the domain',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'SSL certificate is self-signed',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'SSL certificate chain is incomplete'
  };
  return (map[code] || error?.cause?.message || error?.message || 'Request failed').slice(0, 500);
}

// Down only after N failures in a row; returns what changed so the caller can alert once.
export function nextSiteState({ status, consecutiveFailures }, result, threshold = 2) {
  if (result.ok) {
    return { status: 'up', consecutiveFailures: 0, wentDown: false, recovered: status === 'down' };
  }
  const failures = consecutiveFailures + 1;
  const isDown = failures >= threshold;
  return { status: isDown ? 'down' : (status === 'down' ? 'down' : 'degraded'), consecutiveFailures: failures, wentDown: isDown && status !== 'down', recovered: false };
}
