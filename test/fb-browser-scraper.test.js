import test from 'node:test';
import assert from 'node:assert/strict';

import { FbBrowserScraper } from '../lib/fb-browser-scraper.js';

test('lookupUsername returns the unique username for an exact comment match', () => {
  const scraper = new FbBrowserScraper();
  scraper._recordCommentMatch('alice', '500');

  assert.equal(scraper.lookupUsername('500'), 'alice');
});

test('lookupUsername returns null when identical comment text is ambiguous', () => {
  const scraper = new FbBrowserScraper();
  scraper._recordCommentMatch('alice', '500');
  scraper._recordCommentMatch('bob', '500');

  assert.equal(scraper.lookupUsername('500'), null);
});

test('lookupUsername matches stripped punctuation conservatively', () => {
  const scraper = new FbBrowserScraper();
  scraper._recordCommentMatch('alice', '500');

  assert.equal(scraper.lookupUsername('500!!!'), 'alice');
});

test('lookupUsername uses nearest timestamp when text is ambiguous', () => {
  const scraper = new FbBrowserScraper();
  const originalNow = Date.now;

  try {
    Date.now = () => 1000;
    scraper._recordCommentMatch('alice', '500');
    Date.now = () => 5000;
    scraper._recordCommentMatch('bob', '500');
  } finally {
    Date.now = originalNow;
  }

  assert.equal(scraper.lookupUsername('500'), null);
  assert.equal(scraper.lookupUsername('500', 1200), 'alice');
  assert.equal(scraper.lookupUsername('500', 5200), 'bob');
});

test('lookupUsername returns null when nearest timestamp has competing usernames', () => {
  const scraper = new FbBrowserScraper();
  const originalNow = Date.now;

  try {
    Date.now = () => 10000;
    scraper._recordCommentMatch('alice', '500');
    Date.now = () => 10100;
    scraper._recordCommentMatch('bob', '500');
  } finally {
    Date.now = originalNow;
  }

  assert.equal(scraper.lookupUsername('500', 10040), null);
});
