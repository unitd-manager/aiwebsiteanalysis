import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSiteState } from '../server/checks/uptime.js';
import { dueReminder, registrableDomain, expirationFromRdap } from '../server/checks/domain.js';
import { judgeImage } from '../server/scanAgent.js';
import { extractLinks, extractImages, isDevHost, findErrorMessages, expiredEventDates, staleCopyright, pageText } from '../server/pages.js';

test('site is only DOWN after 2 failed checks in a row', () => {
  let s = { status: 'up', consecutiveFailures: 0 };
  const fail = { ok: false };
  const r1 = nextSiteState(s, fail, 2);
  assert.equal(r1.status, 'degraded');
  assert.equal(r1.wentDown, false);
  const r2 = nextSiteState({ status: r1.status, consecutiveFailures: r1.consecutiveFailures }, fail, 2);
  assert.equal(r2.status, 'down');
  assert.equal(r2.wentDown, true);
  const r3 = nextSiteState({ status: 'down', consecutiveFailures: 2 }, fail, 2);
  assert.equal(r3.wentDown, false, 'no repeat alert while still down');
  const back = nextSiteState({ status: 'down', consecutiveFailures: 3 }, { ok: true }, 2);
  assert.equal(back.recovered, true);
  assert.equal(nextSiteState({ status: 'degraded', consecutiveFailures: 1 }, { ok: true }, 2).recovered, false, 'single blip is not a recovery alert');
});

test('expiry reminders pick the right threshold', () => {
  const now = new Date('2026-11-25T00:00:00Z');
  const inDays = (d) => new Date(now.getTime() + d * 86_400_000);
  assert.equal(dueReminder(inDays(60), now), null);
  assert.equal(dueReminder(inDays(25), now).threshold, 30);
  assert.equal(dueReminder(inDays(10), now).threshold, 14);
  assert.equal(dueReminder(inDays(1), now).threshold, 1);
  assert.equal(dueReminder(inDays(-2), now).threshold, 0);
  assert.equal(dueReminder(null, now), null);
});

test('registrable domain handles .co.in and subdomains', () => {
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('shop.example.co.in'), 'example.co.in');
  assert.equal(registrableDomain('example.in'), 'example.in');
  assert.equal(expirationFromRdap({ events: [{ eventAction: 'expiration', eventDate: '2027-03-01T00:00:00Z' }] }).toISOString(), '2027-03-01T00:00:00.000Z');
});

test('link extraction resolves relative links and skips mailto', () => {
  const html = '<a href="/about">A</a><a href="mailto:x@y.com">m</a><a href="https://other.com/x#top">o</a><img src="logo.png">';
  assert.deepEqual(extractLinks(html, 'https://site.com/blog/'), ['https://site.com/about', 'https://other.com/x']);
});

test('finds every image a visitor should see, including lazy and background images', () => {
  const html = `
    <img src="/logo.png" alt="Logo">
    <img src="data:image/gif;base64,R0lGOD" data-src="/lazy/team.jpg" alt="Team">
    <img srcset="/hero-480.webp 480w, /hero-1080.webp 1080w">
    <picture><source srcset="/banner.avif" type="image/avif"><img src="/banner.jpg"></picture>
    <div style="background-image: url('/bg/hero.jpg')"></div>
    <meta property="og:image" content="https://cdn.site.com/share.png">
    <img src="" alt="Event banner">
    <img alt="no source at all">
    <!-- <img src="/commented-out.png"> -->`;
  const { images, emptyTags } = extractImages(html, 'https://site.com/');
  assert.deepEqual(images.map((i) => i.url).sort(), [
    'https://cdn.site.com/share.png', 'https://site.com/banner.avif', 'https://site.com/banner.jpg', 'https://site.com/bg/hero.jpg',
    'https://site.com/hero-480.webp', 'https://site.com/lazy/team.jpg', 'https://site.com/logo.png'
  ]);
  assert.equal(images.find((i) => i.url.endsWith('team.jpg')).alt, 'Team');
  assert.equal(emptyTags.length, 2, 'img with empty src and img with no src are both missing images');
});

test('reads encoded background URLs, skips tracking pixels, spots dev servers', () => {
  const html = `<div style="background-image:linear-gradient(to bottom, rgba(0,0,0,.1) 0%, rgba(0,0,0,.7) 100%), url(&#x27;https://dev.srv1.hstgr.cloud/up/a.jpg&#x27;)"></div>
    <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1"></noscript>`;
  const { images, emptyTags } = extractImages(html, 'https://www.site.com/');
  assert.deepEqual(images.map((i) => i.url), ['https://dev.srv1.hstgr.cloud/up/a.jpg']);
  assert.equal(emptyTags.length, 0);
  assert.equal(isDevHost('https://dev.srv1.hstgr.cloud/up/a.jpg'), true);
  assert.equal(isDevHost('https://staging.site.com/x.png'), true);
  assert.equal(isDevHost('https://cdn.site.com/x.png'), false);
});

test('an image is missing if it 404s, returns a web page, or is empty', () => {
  assert.equal(judgeImage({ status: 200, contentType: 'image/png', length: 5120 }), null);
  assert.equal(judgeImage({ status: 200, contentType: 'image/svg+xml', length: -1 }), null);
  assert.match(judgeImage({ status: 404, contentType: 'text/html' }), /HTTP 404/);
  assert.match(judgeImage({ status: 200, contentType: 'text/html; charset=utf-8', length: 900 }), /text\/html instead of an image/);
  assert.match(judgeImage({ status: 200, contentType: 'image/jpeg', length: 0 }), /empty/);
  assert.match(judgeImage({ status: 0, error: 'Domain does not resolve' }), /does not load/);
});

test('finds visible error messages', () => {
  assert.equal(findErrorMessages('There has been a critical error on this website.')[0].label, 'WordPress critical error');
  assert.equal(findErrorMessages('Welcome to our site').length, 0);
});

test('flags past event dates but not copyright or blog dates', () => {
  const now = new Date('2026-11-25T00:00:00Z');
  const text = pageText(`<div class="banner">Join our AI Automation Summit on 15 October 2026 – register now!</div>
    <p>Posted on March 3, 2025</p><footer>© 2024 Acme</footer>
    <p>Upcoming webinar: December 10, 2026</p>`);
  const found = expiredEventDates(text, now).map((d) => d.raw);
  assert.deepEqual(found, ['15 October 2026']);
  assert.equal(staleCopyright(text, now).year, 2024);
  // Blog cards: "September 8, 2026 ... delivers end-to-end outcomes" is a post date, not an event.
  assert.equal(expiredEventDates('September 8, 2026 An agent orchestrator delivers end-to-end outcomes', now).length, 0);
  assert.equal(expiredEventDates('August 29, 2026 Support teams are buried under tickets', now).length, 0);
});
