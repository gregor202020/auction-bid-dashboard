/**
 * Facebook Live Comments Poller
 *
 * Uses Meta Graph API to poll comments on a Facebook Live video.
 * Endpoint: /{video-id}/comments?filter=stream
 *
 * FIX LOG:
 * - Username: `from` requires Page token with pages_read_user_content.
 *   Added fallback to request `from` and `message_tags` for name extraction.
 *   If `from` is null, try extracting from message_tags or use profile name lookup.
 * - Missing bids: Changed from `since` timestamp (loses same-second comments)
 *   to cursor-based pagination with `after` parameter.
 * - Poll interval: Reduced from 2.5s to 1.5s for faster pickup.
 * - Added `filter=stream` + `order=chronological` for reliable ordering.
 */

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export class FacebookLivePoller {
  /**
   * @param {string} accessToken - Meta/Facebook Page access token
   * @param {(comment: object) => void} onComment - callback for each new comment
   */
  /**
   * @param {string} accessToken - Meta/Facebook Page access token
   * @param {(comment: object) => void} onComment - callback for each new comment
   * @param {import('./fb-browser-scraper.js').FbBrowserScraper} [scraper] - Optional browser scraper for username enrichment
   */
  constructor(accessToken, onComment, scraper) {
    this.accessToken = accessToken;
    this.onComment = onComment;
    this._scraper = scraper || null;
    this._timerId = null;
    this._running = false;
    this._seenIds = new Set();
    this._videoId = null;
    this._pollIntervalMs = 1500;
    this._afterCursor = null;
    this._initialPollDone = false;
  }

  /**
   * Check what type of token we have and log it.
   * Page tokens already have the right access; User tokens need exchange.
   */
  async _checkTokenType() {
    try {
      const url = `${GRAPH_API_BASE}/me?fields=id,name&access_token=${this.accessToken}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      // If /me returns a Page (numeric ID matching a page), it's a Page token
      console.log(`[Facebook] Token identity: ${data.name} (${data.id})`);
    } catch (_) {}
  }

  /**
   * Connect to a Facebook Live video by video ID.
   * @param {string} videoId - Facebook live video ID
   */
  async connect(videoId) {
    this._videoId = videoId;
    this._running = true;
    this._seenIds.clear();
    this._afterCursor = null;
    this._connectTimestamp = Date.now();

    // Check token type and log identity
    await this._checkTokenType();

    // Try to start browser scraper for username enrichment (non-blocking, optional)
    if (this._scraper) {
      try {
        const scraperStarted = await this._scraper.connect(videoId);
        if (scraperStarted) {
          console.log('[Facebook] Browser scraper active — usernames will be enriched');
        } else {
          console.log('[Facebook] Browser scraper not available — using API-only mode');
        }
      } catch (scraperErr) {
        console.log('[Facebook] Browser scraper failed to start:', scraperErr.message, '— continuing without it');
      }
    }

    // Verify the video exists and is accessible
    const valid = await this._verifyVideo(videoId);
    if (!valid) {
      throw new Error(`Could not access Facebook video ${videoId}. Check the video ID and access token.`);
    }

    console.log(`[Facebook] Connected to live video: ${videoId}`);
    this._poll();
  }

  disconnect() {
    this._running = false;
    if (this._timerId) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
    this._videoId = null;
    // Clean up scraper
    if (this._scraper) {
      this._scraper.disconnect().catch(() => {});
    }
    console.log('[Facebook] Disconnected');
  }

  isConnected() {
    return this._running && this._videoId !== null;
  }

  async _verifyVideo(videoId) {
    try {
      const url = `${GRAPH_API_BASE}/${encodeURIComponent(videoId)}?fields=id,title&access_token=${this.accessToken}`;
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json();
        console.error('[Facebook] Video verification failed:', err.error?.message);
        return false;
      }
      const data = await res.json();
      console.log(`[Facebook] Video found: ${data.title || data.id}`);

      // Probe one comment to check if 'from' field is readable
      try {
        const probeUrl = `${GRAPH_API_BASE}/${encodeURIComponent(videoId)}/comments?fields=from{name}&limit=1&access_token=${this.accessToken}`;
        const probeRes = await fetch(probeUrl);
        if (probeRes.ok) {
          const probeData = await probeRes.json();
          if (probeData.data?.length && !probeData.data[0].from) {
            console.warn('[Facebook] Token CANNOT read comment authors — usernames will use fallback IDs.');
            console.warn('[Facebook] Use a Page Access Token with pages_read_user_content permission for proper names.');
          } else if (probeData.data?.length) {
            console.log('[Facebook] Token CAN read comment authors — usernames will work.');
          }
        }
      } catch (_) {
        // Non-fatal, just skip the probe
      }

      return true;
    } catch (err) {
      console.error('[Facebook] Video verification exception:', err.message);
      return false;
    }
  }

  async _poll() {
    if (!this._running) return;

    try {
      await this._fetchPage(this._afterCursor);
    } catch (err) {
      console.error('[Facebook] Poll exception:', err.message);
    }

    if (this._running) {
      this._timerId = setTimeout(() => this._poll(), this._pollIntervalMs);
    }
  }

  /**
   * Fetch one page of comments and follow pagination if there are more pages.
   * This prevents skipping comments when >100 arrive between polls.
   */
  async _fetchPage(afterCursor, depth = 0) {
    if (!this._running || depth > 5) return; // cap pagination depth to prevent infinite loops

    const params = new URLSearchParams({
      filter: 'stream',
      order: 'chronological',
      fields: 'id,message,created_time,from{name,id,picture},message_tags',
      limit: '100',
      access_token: this.accessToken,
    });

    if (afterCursor) {
      params.set('after', afterCursor);
    }

    const url = `${GRAPH_API_BASE}/${encodeURIComponent(this._videoId)}/comments?${params}`;
    const res = await fetch(url);

    // Check if disconnected while awaiting fetch
    if (!this._running) return;

    if (!res.ok) {
      let errorMsg = res.statusText;
      try { errorMsg = (await res.json()).error?.message || errorMsg; } catch (_) {}
      console.error('[Facebook] Poll error:', errorMsg);
      return;
    }

    const data = await res.json();
    const comments = data.data || [];

    // Update cursor for next poll
    if (data.paging?.cursors?.after) {
      this._afterCursor = data.paging.cursors.after;
    }

    for (const comment of comments) {
      const commentId = comment.id;
      if (this._seenIds.has(commentId)) continue;
      this._seenIds.add(commentId);

      // Cap seen IDs to prevent memory leak
      if (this._seenIds.size > 10000) {
        const arr = [...this._seenIds];
        this._seenIds = new Set(arr.slice(arr.length - 5000));
      }

      // Skip comments that were posted before we connected
      const createdTime = new Date(comment.created_time).getTime();
      if (createdTime < this._connectTimestamp) {
        continue;
      }

      // Extract username — multi-strategy fallback chain
      let username = null;
      let verified = true;

      // Strategy 1: API `from` field (best case — requires specific token permissions)
      if (comment.from?.name) {
        username = comment.from.name;
      } else if (comment.from?.id) {
        username = `user_${comment.from.id}`;
      } else if (comment.message_tags?.length) {
        const tag = comment.message_tags[0];
        username = tag.name || (tag.id ? `user_${tag.id}` : null);
      }

      // Strategy 2: Browser scraper lookup (matches by comment text)
      if (!username && this._scraper) {
        const scraperMatch = this._scraper.lookupUsername(comment.message);
        if (scraperMatch) {
          username = scraperMatch;
        }
      }

      // Strategy 3: Fallback — mark as Unverified with unique suffix
      // Each anonymous commenter gets a unique ID to prevent spam filter collisions
      // (otherwise all "Unverified User" bids share one key and duplicates get rejected)
      if (!username) {
        const shortId = commentId.split('_').pop() || commentId.slice(-8);
        username = `Unverified (${shortId})`;
        verified = false;
      }

      if (!verified && !this._warnedAboutPermissions) {
        this._warnedAboutPermissions = true;
        console.warn('[Facebook] Some comments have no username — showing as "Unverified User".');
        console.warn('[Facebook] Use "Login to Facebook" in Settings to enable browser-based username scraping.');
      }

      this.onComment({
        id: commentId,
        platform: 'fb',
        username,
        verified,
        text: comment.message || '',
        timestamp: createdTime || Date.now(),
      });
    }

    // If there are more pages, follow pagination (depth cap prevents infinite loops)
    if (data.paging?.next) {
      await this._fetchPage(this._afterCursor, depth + 1);
    }
  }
}
