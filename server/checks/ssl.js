import tls from 'node:tls';

// Reads the certificate the site presents and when it expires.
export function checkSsl(siteUrl, { timeoutMs = 10_000 } = {}) {
  const { hostname, port, protocol } = new URL(siteUrl);
  if (protocol !== 'https:') return Promise.resolve({ ok: false, error: 'Site does not use HTTPS', expiresAt: null });
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port: Number(port) || 443, servername: hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      const authError = socket.authorizationError ? String(socket.authorizationError) : null;
      socket.end();
      if (!cert || !cert.valid_to) return resolve({ ok: false, error: 'No certificate returned', expiresAt: null });
      const expiresAt = new Date(cert.valid_to);
      const issuer = cert.issuer?.O || cert.issuer?.CN || null;
      resolve({ ok: authorized && expiresAt > new Date(), expiresAt, issuer, error: authorized ? null : authError });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'SSL handshake timed out', expiresAt: null }); });
    socket.on('error', (e) => resolve({ ok: false, error: e.message, expiresAt: null }));
  });
}
