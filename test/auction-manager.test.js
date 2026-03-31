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
