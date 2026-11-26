// Pure HTML/text helpers for the daily page scan (no network, easy to test).

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));

export function pageText(html) {
  return decode(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/section|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

export function pageTitle(html) {
  return decode(String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
}

// All http(s) links on the page, resolved and without #fragments.
export function extractLinks(html, baseUrl) {
  const out = new Set();
  // Images are checked separately (extractImages), so they get their own "missing image" issue.
  for (const m of String(html).matchAll(/<(?:a|link|script|iframe)\b[^>]*?\s(?:href|src)\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    if (/<link\b/i.test(m[0]) && /rel\s*=\s*["'][^"']*(icon|image_src)/i.test(m[0])) continue;
    const raw = decode(m[1].trim());
    if (/^(mailto|tel|javascript|data|whatsapp|sms):/i.test(raw)) continue;
    try {
      const u = new URL(raw, baseUrl);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      out.add(u.toString());
    } catch { /* ignore malformed */ }
  }
  return [...out];
}

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2];
const firstSrcsetUrl = (srcset) => String(srcset || '').split(',').map((s) => s.trim().split(/\s+/)[0]).find(Boolean);
const TRACKERS = /facebook\.com\/tr|bat\.bing\.com|px\.ads\.linkedin|google-analytics\.com|googletagmanager\.com|doubleclick\.net|analytics\.twitter|t\.co\/i\/adsct|pixel\.wp\.com/i;

// Production pages should not depend on a test/dev server: when it is switched off, the images vanish.
export const isDevHost = (url) => {
  try {
    const host = new URL(url).hostname;
    return /^(dev|staging|stage|test|uat|qa|preview|sandbox)[.-]/i.test(host) || /\.(hstgr\.cloud|localhost|local|test)$/i.test(host) || /^(localhost|127\.|10\.|192\.168\.)/.test(host);
  } catch { return false; }
};
const isPlaceholder = (src) => /^data:/i.test(src) || /(placeholder|blank|spacer|lazy|pixel)\.(gif|png|svg)/i.test(src);

/**
 * Every image a visitor should see on the page, with where it came from.
 * Returns { images: [{ url, alt, source }], emptyTags: [snippet] }. emptyTags are <img> tags
 * with no usable address at all, which always show as a missing image.
 */
export function extractImages(html, baseUrl) {
  const found = new Map();
  const emptyTags = [];
  const add = (raw, alt, source) => {
    const value = decode(String(raw || '').trim());
    if (!value || isPlaceholder(value)) return false;
    try {
      const u = new URL(value, baseUrl);
      if (!/^https?:$/.test(u.protocol) || TRACKERS.test(u.toString())) return false;
      u.hash = '';
      const key = u.toString();
      if (!found.has(key)) found.set(key, { url: key, alt: alt || '', source });
      return true;
    } catch { return false; }
  };
  const text = String(html).replace(/<!--[\s\S]*?-->/g, '');
  for (const [tag] of text.matchAll(/<img\b[^>]*>/gi)) {
    // Invisible 1x1 tracking pixels (Facebook, LinkedIn, Bing...) are not content images.
    if (/\s(width|height)\s*=\s*["']?1["'\s>\/]/i.test(tag) || TRACKERS.test(tag)) continue;
    const alt = decode(attr(tag, 'alt') || '').trim();
    // Lazy-loading plugins keep the real address in data-* attributes and a placeholder in src.
    const candidates = [attr(tag, 'data-src'), attr(tag, 'data-lazy-src'), attr(tag, 'data-original'), firstSrcsetUrl(attr(tag, 'data-srcset')), attr(tag, 'src'), firstSrcsetUrl(attr(tag, 'srcset'))];
    if (!candidates.some((c) => add(c, alt, 'img'))) emptyTags.push(tag.slice(0, 200));
  }
  for (const [tag] of text.matchAll(/<source\b[^>]*>/gi)) {
    if (/type\s*=\s*["'](video|audio)/i.test(tag)) continue;
    add(firstSrcsetUrl(attr(tag, 'srcset') || attr(tag, 'data-srcset')), '', 'picture');
  }
  // Inline style attributes encode quotes as &#x27; / &quot;, so decode before reading url(...).
  // A declaration can hold several layers, e.g. "linear-gradient(...), url('/hero.jpg')".
  for (const [decl] of decode(text).matchAll(/background(?:-image)?\s*:[^;}>]*/gi)) {
    for (const m of decl.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) add(m[2], '', 'background');
  }
  for (const [tag] of text.matchAll(/<meta\b[^>]*>/gi)) {
    if (/(property|name)\s*=\s*["'](og:image|twitter:image)["']/i.test(tag)) add(attr(tag, 'content'), '', 'share image');
  }
  return { images: [...found.values()], emptyTags };
}

export const isPageLink = (url) => !/\.(png|jpe?g|gif|webp|svg|ico|css|js|pdf|zip|mp4|mp3|woff2?|ttf|xml|json)(\?|$)/i.test(url);

// Visible server/CMS error messages that mean a page is broken even with HTTP 200.
const ERROR_PATTERNS = [
  [/\b(Fatal error|Parse error|Warning|Notice|Deprecated):\s.{0,80}\bon line \d+/i, 'PHP error shown on page'],
  [/There has been a critical error on this website/i, 'WordPress critical error'],
  [/Error establishing a database connection/i, 'Database connection error'],
  [/\b(Uncaught (?:TypeError|ReferenceError|Exception))\b/i, 'Uncaught error shown on page'],
  [/\b(502 Bad Gateway|503 Service (?:Temporarily )?Unavailable|504 Gateway Time-?out)\b/i, 'Gateway error page'],
  [/\bApplication error: a client-side exception has occurred\b/i, 'Front-end crash'],
  [/\b(Page not found|404 not found)\b/i, 'Shows a "not found" message']
];

export function findErrorMessages(text) {
  const found = [];
  for (const [re, label] of ERROR_PATTERNS) {
    const m = text.match(re);
    if (m) found.push({ label, evidence: m[0].slice(0, 200) });
  }
  return found;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const EVENT_WORDS = /\b(upcoming|join us|register|registration|rsvp|book (?:now|your)|webinar|event|conference|summit|meetup|workshop|offer ends|sale ends|ends on|ending on|limited offer|deadline|last date|valid (?:till|until)|open until|expires? on|coming soon|launching|save the date|book tickets|get tickets)\b/i;

/** Dates written on the page, with the sentence around them. */
export function findDates(text) {
  const results = [];
  const patterns = [
    // 12 October 2026, 12th Oct, 2026
    [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'gi'), (m) => [m[3], m[2], m[1]]],
    // October 12, 2026
    [new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), (m) => [m[3], m[1], m[2]]],
    // 2026-10-12
    [/\b(20\d{2})-(\d{2})-(\d{2})\b/g, (m) => [m[1], Number(m[2]) - 1, m[3]]]
  ];
  for (const [re, parts] of patterns) {
    for (const m of text.matchAll(re)) {
      const [y, mon, d] = parts(m);
      const month = typeof mon === 'number' ? mon : MONTHS[String(mon).toLowerCase().slice(0, 3)];
      const date = new Date(Date.UTC(Number(y), month, Number(d)));
      if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(d)) continue;
      // Context = the line the date is on (a banner, a sentence), capped to 120 chars each side.
      const lineStart = Math.max(text.lastIndexOf('\n', m.index) + 1, m.index - 120);
      const nl = text.indexOf('\n', m.index + m[0].length);
      const lineEnd = Math.min(nl === -1 ? text.length : nl, m.index + m[0].length + 120);
      const context = text.slice(lineStart, lineEnd).replace(/\s+/g, ' ').trim();
      results.push({ raw: m[0], date, context });
    }
  }
  return results;
}

/**
 * Past dates that sit next to event/offer wording, e.g. "Join our webinar on 12 Oct 2025".
 * Copyright lines and blog post dates are ignored.
 */
export function expiredEventDates(text, now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return findDates(text).filter(({ date, context }) =>
    date.getTime() < today &&
    EVENT_WORDS.test(context) &&
    !/(©|copyright|posted on|published|updated on|last updated)/i.test(context));
}

/** "© 2023" in the footer when it is already a later year. */
export function staleCopyright(text, now = new Date()) {
  const m = text.match(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2})/i);
  if (!m) return null;
  const year = Number(m[1]);
  return year < now.getUTCFullYear() ? { year, evidence: m[0] } : null;
}
