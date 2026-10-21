import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFirstStepFailure, excerptAroundLabel } from '../shared/person-confirmation.js';

test('an HTTP server response is distinct from a transport failure', () => {
  assert.equal(classifyFirstStepFailure({ code: 'provider_error', status: 500, message: 'HTTP 500' }).code, 'provider_unknown');
  assert.equal(classifyFirstStepFailure({ code: 'provider_error', message: 'fetch failed: ECONNRESET' }).code, 'provider_network');
});

function assertOriginalSpan(text: string, label: string): string {
  const excerpt = excerptAroundLabel(text, label);
  assert.ok(excerpt, 'an observed normalized name keeps an original excerpt');
  const span = /^原文第 (\d+)–(\d+) 字符$/.exec(excerpt.locator);
  assert.ok(span);
  const start = Number(span[1]) - 1;
  const end = Number(span[2]);
  assert.ok(start >= 0 && end <= text.length);
  assert.equal(text.slice(start, end), excerpt.quote, 'the locator resolves to the exact retained original');
  return excerpt.quote;
}

test('normalization preserves original offsets after ligatures and combining marks', () => {
  assert.match(assertOriginalSpan('ﬃ'.repeat(40) + '. 陈冕是研究员。另一句无关。', '陈冕'), /陈冕/);
  assert.equal(assertOriginalSpan('e\u0301lodie researches compilers.', 'Élodie'), 'e\u0301lodie researches compilers.');
});

test('a long source excerpt stays bounded with a locator for the displayed quote', () => {
  const quote = assertOriginalSpan('前'.repeat(500) + '陈冕维护排版工具' + '后'.repeat(500) + '。', '陈冕');
  assert.ok(quote.length <= 400);
  assert.match(quote, /陈冕/);
});
