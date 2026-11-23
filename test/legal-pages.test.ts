import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';

test('serves readable HTML privacy policy and terms pages', async () => {
  const app = await buildApp();
  try {
    const cases = [
      {
        url: '/privacy-policy',
        title: '<title>Privacy Policy | Vico AI</title>',
        section: 'Google API Services User Data Policy',
        link: 'href="/terms-of-service"',
      },
      {
        url: '/terms-of-service',
        title: '<title>Terms of Service | Vico AI</title>',
        section: 'AI output and limitations',
        link: 'href="/privacy-policy"',
      },
    ];

    for (const page of cases) {
      const response = await app.inject({ method: 'GET', url: page.url });
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type'] ?? '', /^text\/html;\s*charset=utf-8/i);
      assert.match(response.body, /<html lang="en">/);
      assert.match(response.body, new RegExp(page.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.ok(response.body.includes(page.section));
      assert.ok(response.body.includes(page.link));
    }
  } finally {
    await app.close();
  }
});
