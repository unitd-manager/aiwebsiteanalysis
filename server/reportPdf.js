import PDFDocument from 'pdfkit';
import { brandName, brandColor, brandLogo } from './settings.js';

// The built-in PDF fonts only cover Western European characters. Swap common symbols
// and drop anything else (emoji, other scripts) so the PDF never shows broken glyphs.
const clean = (s) => String(s ?? '')
  .replace(/₹/g, 'Rs.').replace(/[✓✔]/g, 'OK').replace(/[→⇒]/g, '->').replace(/…/g, '...')
  .replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•\n]/g, '')
  .trim();
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
const stamp = (d) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');
const daysLeft = (d) => (d ? Math.ceil((new Date(d) - Date.now()) / 86_400_000) : null);
const SEV = { high: '#b91c1c', medium: '#b45309', low: '#0369a1' };

/** Fetches the brand logo (PNG or JPEG only, which is what PDFs support). Never throws. */
export async function fetchLogo(url = brandLogo()) {
  if (!/^https?:\/\//i.test(url || '')) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const png = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const jpg = buf[0] === 0xff && buf[1] === 0xd8;
    return (png || jpg) && buf.length < 2_000_000 ? buf : null;
  } catch { return null; }
}

/** Renders the monthly report (from buildReport) as a PDF Buffer. */
export function renderReportPdf(r, logo = null) {
  const color = /^#[0-9a-f]{6}$/i.test(brandColor()) ? brandColor() : '#0f766e';
  const brand = clean(brandName()) || 'SiteGuard';
  const monthName = new Date(`${r.month}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `${clean(r.site.name)} - ${monthName} health report`, Author: brand } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const L = 40;
  const W = doc.page.width - 80;
  const bottom = () => doc.page.height - 60;
  const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
  const heading = (text) => {
    ensure(50);
    doc.moveDown(1.2).font('Helvetica-Bold').fontSize(13).fillColor('#111827').text(text, L, doc.y, { width: W });
    doc.moveDown(0.4);
  };
  const body = (text, opts = {}) => doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 10).fillColor(opts.color || '#111827').text(clean(text), L, doc.y, { width: W, ...opts.pdf });

  // Simple table: columns [{ title, width (0-1), color? }], rows of strings.
  const table = (cols, rows) => {
    const widths = cols.map((c) => c.width * W);
    const drawRow = (cells, header) => {
      doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
      const h = Math.max(...cells.map((c, i) => doc.heightOfString(clean(c), { width: widths[i] - 12 }))) + 10;
      if (doc.y + h > bottom()) { doc.addPage(); if (!header) drawRow(cols.map((c) => c.title), true); }
      const y = doc.y;
      if (header) doc.rect(L, y, W, h).fill('#f3f4f6');
      let x = L;
      cells.forEach((c, i) => {
        doc.fillColor(header ? '#374151' : (typeof cols[i].color === 'function' ? cols[i].color(c) : '#111827'))
          .font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5)
          .text(clean(c), x + 6, y + 5, { width: widths[i] - 12 });
        x += widths[i];
      });
      doc.moveTo(L, y + h).lineTo(L + W, y + h).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
      doc.x = L; doc.y = y + h;
    };
    drawRow(cols.map((c) => c.title), true);
    rows.forEach((row) => drawRow(row, false));
  };

  // Header band
  doc.rect(0, 0, doc.page.width, 70).fill(color);
  let logoDrawn = false;
  if (logo) { try { doc.image(logo, L, 17, { fit: [160, 36] }); logoDrawn = true; } catch { /* unreadable image: fall back to the name */ } }
  if (!logoDrawn) doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff').text(brand, L, 25, { width: W / 2 });
  doc.font('Helvetica').fontSize(11).fillColor('#ffffff').text('Monthly website health report', L, 29, { width: W, align: 'right' });

  // Title
  doc.x = L; doc.y = 95;
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#111827').text(clean(r.site.name), L, doc.y, { width: W });
  body(`${r.site.url}  ·  ${monthName}`, { color: '#6b7280', size: 10.5 });

  // Stat cards
  const cards = [
    ['Uptime', r.uptime === null ? 'No data' : `${r.uptime.toFixed(2)}%`],
    ['Downtime incidents', String(r.incidents.length)],
    ['Avg response', r.avgMs ? `${r.avgMs} ms` : '-']
  ];
  const cy = doc.y + 14;
  const gap = 10;
  const cw = (W - gap * 2) / 3;
  cards.forEach(([label, value], i) => {
    const x = L + i * (cw + gap);
    doc.roundedRect(x, cy, cw, 62, 6).lineWidth(1).strokeColor('#e5e7eb').stroke();
    doc.font('Helvetica-Bold').fontSize(18).fillColor(color).text(value, x, cy + 12, { width: cw, align: 'center' });
    doc.font('Helvetica').fontSize(9.5).fillColor('#6b7280').text(label, x, cy + 38, { width: cw, align: 'center' });
  });
  doc.x = L; doc.y = cy + 62;

  heading('Renewal dates');
  const left = (d) => { const n = daysLeft(d); return n === null ? 'Unknown' : n <= 0 ? 'EXPIRED' : `${n} days`; };
  const warnColor = (v) => (v === 'EXPIRED' || (/^\d+ days$/.test(v) && parseInt(v, 10) <= 30) ? '#b91c1c' : '#111827');
  table(
    [{ title: 'Item', width: 0.4 }, { title: 'Expires', width: 0.3 }, { title: 'Time left', width: 0.3, color: warnColor }],
    [['SSL certificate', day(r.sslExpires), left(r.sslExpires)], ['Domain name', day(r.domainExpires), left(r.domainExpires)]]
  );

  if (r.site.backup_expected_hours) {
    heading('Backups');
    const last = r.site.last_backup_at ? `${stamp(r.site.last_backup_at)} UTC` : 'none received yet';
    body(`Expected every ${r.site.backup_expected_hours} h. Last backup: ${last}${r.site.last_backup_status === 'fail' ? ' (reported FAILED)' : ''}`);
  }

  heading('Downtime');
  if (r.incidents.length) {
    table(
      [{ title: 'Started (UTC)', width: 0.25 }, { title: 'Resolved (UTC)', width: 0.25 }, { title: 'Cause', width: 0.5 }],
      r.incidents.map((i) => [stamp(i.started_at), i.resolved_at ? stamp(i.resolved_at) : 'Ongoing', i.cause || '-'])
    );
    doc.moveDown(0.4);
    body(`Total downtime: about ${r.downtimeMinutes} minutes.`, { color: '#6b7280' });
  } else body('No downtime this month.');

  heading('Website issues');
  if (!r.scan) body('No page scan yet.');
  else {
    body(`${r.scan.summary} (last scan ${day(r.scan.started_at)})`);
    if (r.issues.length) {
      doc.moveDown(0.5);
      table(
        [{ title: 'Severity', width: 0.13, color: (v) => SEV[v] || '#111827' }, { title: 'Problem', width: 0.52 }, { title: 'Page', width: 0.35 }],
        r.issues.map((i) => [i.severity, i.evidence ? `${i.detail}\n${i.evidence}` : i.detail, String(i.page_url || '').replace(/^https?:\/\/[^/]+/, '') || '/'])
      );
    }
  }

  // Footer on every page
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    const fy = doc.page.height - 40;
    doc.page.margins.bottom = 0; // let the footer sit below the text area without adding a page
    doc.font('Helvetica').fontSize(8.5).fillColor('#9ca3af')
      .text(`Monitored 24/7 by ${brand}. Checks run every ${Number(process.env.CHECK_INTERVAL_MINUTES || 5)} minutes.`, L, fy, { width: W / 2 + 60, lineBreak: false })
      .text(`Page ${p - range.start + 1} of ${range.count}`, L, fy, { width: W, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}

export const reportFileName = (site, month) => `${new URL(site.url).hostname.replace(/^www\./, '')}-${month}-health-report.pdf`;
