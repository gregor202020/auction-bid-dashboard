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
