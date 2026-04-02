import test from 'node:test';
import assert from 'node:assert/strict';

import { selectActiveInstagramLiveMedia } from '../lib/instagram-live.js';

test('selectActiveInstagramLiveMedia prefers LIVE product media', () => {
  const result = selectActiveInstagramLiveMedia([
    { id: 'reel-1', media_product_type: 'REELS', timestamp: '2026-04-02T01:44:12+0000' },
    { id: 'live-1', media_product_type: 'LIVE', timestamp: '2026-04-02T01:45:00+0000' },
  ]);

  assert.equal(result?.id, 'live-1');
});

test('selectActiveInstagramLiveMedia returns null for non-live reels and posts', () => {
  const result = selectActiveInstagramLiveMedia([
    { id: 'reel-1', media_product_type: 'REELS', timestamp: '2026-04-02T01:44:12+0000' },
    { id: 'feed-1', media_product_type: 'FEED', timestamp: '2026-04-02T01:46:00+0000' },
  ]);

  assert.equal(result, null);
});

test('selectActiveInstagramLiveMedia accepts live_media broadcasts returned as BROADCAST/FEED', () => {
  const result = selectActiveInstagramLiveMedia([
    {
      id: 'story-live-1',
      _source: 'live_edge',
      media_type: 'BROADCAST',
      media_product_type: 'FEED',
      permalink: 'https://www.instagram.com/stories/thirdwavebbq/3866112541420831836',
      timestamp: '2026-04-02T02:22:31+0000',
    },
    { id: 'reel-1', media_product_type: 'REELS', timestamp: '2026-04-02T01:44:12+0000' },
  ]);

  assert.equal(result?.id, 'story-live-1');
});
