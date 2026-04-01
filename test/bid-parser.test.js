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

test('rejects number words used as chatter instead of bids', () => {
  assert.equal(parseBid('one hundred percent'), null);
  assert.equal(parseBid('five stars'), null);
});

test('rejects numeric chatter with non-bid suffixes', () => {
  assert.equal(parseBid('thanks for 5k likes'), null);
});

test('rejects negotiation chatter that is not a committed bid', () => {
  assert.equal(parseBid('can you do 500?'), null);
  assert.equal(parseBid('do 500 shipped?'), null);
});

test('still accepts standalone suffix bids', () => {
  const parsed = parseBid('5k');
  assert.ok(parsed);
  assert.equal(parsed.amount, 5000);
});
