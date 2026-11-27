import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntelligenceService, fuzzySimilarity } from '../src/modules/intelligence/intelligence.service.js';
import { interpretGmailMessage } from '../src/modules/google/gmail-result-interpreter.js';

const intelligence = new IntelligenceService();

test('recognizes exact birthday lookup and calendar retrieval terms', () => {
  const result = intelligence.understand("When is Maryam's birthday?");
  assert.equal(result.intent, 'birthday_lookup');
  assert.deepEqual(result.tools, ['calendar_lookup']);
  assert.equal(result.clarificationRequired, false);
  assert.ok(result.searchTerms.includes('maryam'));
});

test('recognizes spelling variations as possible entity matches', () => {
  const result = intelligence.understand("When is Marriam's bday?");
  assert.equal(result.intent, 'birthday_lookup');
  assert.equal(result.normalizedMessage.includes('marriam'), true);
  assert.ok(result.entities.some((entity) =>
    entity.candidates.some((candidate) => candidate.value === 'maryam'),
  ));
});

test('resolves madam through an alias candidate set', () => {
  const result = intelligence.understand("When is madam's birthday?");
  assert.equal(result.intent, 'birthday_lookup');
  assert.ok(result.entities.some((entity) =>
    entity.original === 'madam' &&
    entity.candidates.some((candidate) => candidate.value === 'maryam'),
  ));
});

test('ranks the strongest calendar match and leaves ambiguous ties visible', () => {
  const maryam = { summary: "Maryam's birthday", description: 'madam birthday', start: '2026-06-12' };
  const mary = { summary: "Mary's birthday", description: '', start: '2026-09-04' };
  const decision = intelligence.understand("When is Mary's birthday?");
  const matches = intelligence.rankCalendarEvents([mary, maryam], decision);
  assert.equal(matches.length, 2);
  assert.ok(matches[0].score >= matches[1].score);
  assert.ok(matches.every((match) => Array.isArray(match.evidence)));
});

test('recognizes Gmail spelling variations and payment search terms', () => {
  const result = intelligence.understand('Find that email John sent about the paymant');
  assert.equal(result.intent, 'gmail_search');
  assert.deepEqual(result.tools, ['gmail_search']);
  assert.ok(result.normalizedMessage.includes('payment'));
  assert.ok(result.searchTerms.includes('payment'));
});

test('keeps an ambiguous next-week request advisory instead of forcing Calendar', () => {
  const result = intelligence.understand('What do I have next week?');
  assert.equal(result.intent, 'direct_conversation');
  assert.deepEqual(result.tools, []);
  assert.ok(result.timeExpressions.includes('next week'));
});

test('keeps direct conversation free of tool execution', () => {
  const result = intelligence.understand('Good morning, how are you?');
  assert.equal(result.intent, 'direct_conversation');
  assert.deepEqual(result.tools, []);
  assert.equal(result.clarificationRequired, false);
});

test('provides bounded deterministic fuzzy similarity', () => {
  assert.equal(fuzzySimilarity('maryam', 'maryam'), 1);
  assert.ok(fuzzySimilarity('marriam', 'maryam') > 0.8);
  assert.ok(fuzzySimilarity('john', 'server') < 0.8);
});

test('ranks Gmail results without executing integration calls', () => {
  const decision = intelligence.understand('Find that email John sent about the paymant');
  const matches = intelligence.rankGmailResults([
    { subject: 'Quarterly report', snippet: 'Nothing about payment' },
    { subject: 'Server subscription payment', snippet: 'Invoice attached' },
  ], decision);
  assert.ok(matches[0].score >= matches[1].score);
  assert.ok(matches[0].evidence.length > 0);
});

test('ranks explicitly urgent Gmail messages above otherwise equivalent messages', () => {
  const urgent = interpretGmailMessage({
    subject: 'Meeting update',
    body: 'Urgent: please confirm your attendance today.',
  });
  const routine = interpretGmailMessage({
    subject: 'Meeting update',
    body: 'Please confirm your attendance today.',
  });
  const matches = intelligence.rankGmailResults([routine, urgent], intelligence.understand(''));

  assert.equal(matches[0].value, urgent);
  assert.ok(matches[0].evidence.includes('explicitly urgent'));
});
