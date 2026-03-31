import test from 'node:test';
import assert from 'node:assert/strict';

import { SpamFilter } from '../lib/spam-filter.js';

test('blocks duplicate bids from the same user inside the window', () => {
  const filter = new SpamFilter({ duplicateWindowMs: 10000 });
  const first = filter.check({ platform: 'yt', username: 'alice', amount: 100, timestamp: 1000 });
  const second = filter.check({ platform: 'yt', username: 'alice', amount: 100, timestamp: 5000 });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
});

test('allows the same amount again after the duplicate window', () => {
  const filter = new SpamFilter({ duplicateWindowMs: 1000 });
  filter.check({ platform: 'yt', username: 'alice', amount: 100, timestamp: 1000 });
  const next = filter.check({ platform: 'yt', username: 'alice', amount: 100, timestamp: 3000 });

  assert.equal(next.allowed, true);
});
