import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBid } from '../lib/bid-parser.js';

test('parses plain numeric bids', () => {
  const parsed = parseBid('500');
  assert.ok(parsed);
  assert.equal(parsed.amount, 500);
});

test('parses number-word bids', () => {
  const parsed = parseBid('five hundred');
  assert.ok(parsed);
  assert.equal(parsed.amount, 500);
});

test('parses word bids with context', () => {
  const parsed = parseBid('i bid one thousand two hundred');
  assert.ok(parsed);
  assert.equal(parsed.amount, 1200);
});

test('rejects comments with no numeric hints', () => {
  assert.equal(parseBid('great stream tonight'), null);
});

test('rejects year-like plain comments without bid context', () => {
  assert.equal(parseBid('2026'), null);
});
