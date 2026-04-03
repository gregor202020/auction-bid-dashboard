import test from 'node:test';
import assert from 'node:assert/strict';

import { AuctionManager } from '../lib/auction-manager.js';

function createManager() {
  return new AuctionManager(
    {
      youtubeApiKey: '',
      metaAccessToken: '',
      igUserId: '',
      fbPageId: '',
    },
    () => {}
  );
}

test('status snapshot includes recent bids, top bids, and comments', () => {
  const manager = createManager();

  manager._handleComment({ id: 'c1', platform: 'yt', username: 'alice', text: '100', timestamp: 1000 });
  manager._handleComment({ id: 'c2', platform: 'fb', username: 'bob', text: '250', timestamp: 2000, verified: false });
  manager._handleComment({ id: 'c3', platform: 'ig', username: 'carol', text: 'nice item', timestamp: 3000 });

  const status = manager.getStatus();

  assert.equal(status.bidCount, 2);
  assert.equal(status.highestBid.amount, 250);
  assert.equal(status.recentComments.length, 3);
  assert.equal(status.recentBids.length, 2);
  assert.equal(status.topBids[0].amount, 250);
  assert.equal(status.topBids[0].verified, false);
});

test('newAuction clears bid and comment snapshots', () => {
  const manager = createManager();

  manager._handleComment({ id: 'c1', platform: 'yt', username: 'alice', text: '100', timestamp: 1000 });
  manager._handleComment({ id: 'c2', platform: 'yt', username: 'alice', text: 'hello', timestamp: 2000 });
  manager.newAuction();

  const status = manager.getStatus();

  assert.equal(status.bidCount, 0);
  assert.equal(status.highestBid, null);
  assert.equal(status.recentBids.length, 0);
  assert.equal(status.recentComments.length, 0);
});

test('top bid snapshot preserves older winners beyond the recent bid buffer', () => {
  const manager = createManager();

  manager._handleComment({ id: 'winner', platform: 'yt', username: 'alice', text: '9000', timestamp: 1 });

  for (let i = 0; i < 300; i++) {
    manager._handleComment({
      id: `c${i}`,
      platform: 'fb',
      username: `user${i}`,
      text: String(100 + i),
      timestamp: i + 10,
    });
  }

  const status = manager.getStatus();

  assert.equal(status.recentBids.length, 50);
  assert.equal(status.highestBid.amount, 9000);
  assert.equal(status.topBids[0].amount, 9000);
  assert.equal(status.topBids[0].id, 'winner');
});

test('facebook preflight rejects missing identifiers', async () => {
  const manager = createManager();
  const result = await manager.fbPreflight('', '');

  assert.equal(result.ok, false);
  assert.match(result.error, /required/i);
});

test('facebook connect is blocked when preflight fails', async () => {
  const manager = createManager();
  manager.fbPreflight = async () => ({
    ok: false,
    error: 'Facebook session expired. Re-login required.',
  });

  const result = await manager.connect('facebook', '958709113270294');

  assert.equal(result.success, false);
  assert.match(result.error, /Re-login required/i);
});
