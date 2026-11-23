import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';

test('serves public HTML pages with canonical URLs and working internal links', async () => {
  const app = await buildApp();
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const cases = [
      {
        url: '/',
        title: '<title>Vico AI | AI assistant for connected services</title>',
        section: 'AI-powered assistant designed to help users manage',
      },
      {
        url: '/privacy-policy',
        title: '<title>Privacy Policy | Vico AI</title>',
        section: 'Google API Services User Data Policy',
      },
      {
        url: '/terms-of-service',
        title: '<title>Terms of Service | Vico AI</title>',
        section: 'AI output and limitations',
      },
    ];

    for (const page of cases) {
      const response = await fetch(new URL(page.url, baseUrl));
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html;\s*charset=utf-8/i);
      assert.match(body, /<html lang="en">/);
      assert.match(body, new RegExp(page.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.ok(body.includes(page.section));
      if (page.url === '/privacy-policy') {
        for (const disclosure of [
          'https://www.googleapis.com/auth/calendar.events',
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send',
          'Data accessed and why',
          'Storage and protection',
          'Sharing and transfers of Google user data',
          'Retention, revocation, and deletion of Google data',
          'Limited Use requirements',
          'kimaniwilfred95@gmail.com',
        ]) {
          assert.ok(body.includes(disclosure), `privacy policy omits ${disclosure}`);
        }
      }
      const canonicalUrl = new URL(page.url, config.appBaseUrl).href;
      assert.ok(body.includes(`<link rel="canonical" href="${canonicalUrl}">`));
      assert.ok(!body.includes('__CANONICAL_URL__'));

      const internalLinks = [...body.matchAll(/href="(\/[^"#]*)"/g)]
        .map(([, href]) => href)
        .filter((href): href is string => Boolean(href));
      for (const href of new Set(internalLinks)) {
        const linkedResponse = await fetch(new URL(href, baseUrl));
        assert.equal(linkedResponse.status, 200, `${page.url} links to missing route ${href}`);
      }
    }

    const favicon = await fetch(new URL('/favicon.svg', baseUrl));
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get('content-type') ?? '', /^image\/svg\+xml/);

    const googleVerification = await fetch(
      new URL('/google4abf06ccc560e434.html', baseUrl),
    );
    assert.equal(googleVerification.status, 200);
    assert.equal(
      googleVerification.headers.get('content-type'),
      'text/html; charset=utf-8',
    );
    assert.equal(
      await googleVerification.text(),
      'google-site-verification: google4abf06ccc560e434.html',
    );
  } finally {
    await app.close();
  }
});
