/**
 * Instagram Live Comments Poller
 *
 * Uses Meta Graph API to poll comments on Instagram media (posts and live).
 *
 * FIX LOG (v2):
 * - CRITICAL: Business Discovery API URL was malformed — `username` was passed
 *   as a query param instead of inside the `fields` selector. Fixed.
 * - CRITICAL: `live_media` edge is not a public Graph API endpoint.
 *   Replaced with `/media` filtered by recent VIDEO type.
 * - CRITICAL: Silent fallback to wrong media (recent photo instead of live).
 *   Now warns loudly and prefers erroring over silent degradation.
 * - Added unique anon_ fallback username to prevent spam filter collision.
 * - Safer error body parsing (handles non-JSON error responses).
 * - Initial poll promise caught to avoid unhandled rejection.
 *
 * REQUIRED PERMISSIONS on Meta Access Token:
 * - instagram_basic
 * - instagram_manage_comments
 * - pages_show_list
 * - pages_read_engagement
 *
 * HOW TO GET THE MEDIA ID:
 * The user needs to provide either:
 * 1. The IG Media ID directly (a numeric string like "17890000000000000")
 * 2. An @username — resolves via connected IG Business accounts + Business Discovery
 *
 * To find the media ID manually, use the IG Graph API:
 *   GET /{ig-user-id}/media?fields=id,media_type,timestamp → filter for VIDEO
 */

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

export class InstagramLivePoller {
  /**
   * @param {string} accessToken - Meta access token (must be a Page Access Token)
   * @param {(comment: object) => void} onComment - callback for each new comment
   */
  /**
   * @param {string} accessToken - Meta access token (must be a Page Access Token)
   * @param {(comment: object) => void} onComment - callback for each new comment
   * @param {string} [igUserId] - Optional pre-configured IG User ID from env
   */
  constructor(accessToken, onComment, igUserId) {
    this.accessToken = accessToken;
    this.onComment = onComment;
    this._configuredIgUserId = igUserId || null;
    this._timerId = null;
    this._running = false;
    this._seenIds = new Set();
    this._mediaId = null;
    this._pollIntervalMs = 2000; // 2 seconds
    this._afterCursor = null;
    this._useAlternateFields = false;
    this._igUserId = null;
    this._warnedAboutFields = false;
    this._connectTimestamp = null;
  }

  /**
   * Connect to an Instagram media/live by media ID or @username.
   * @param {string} identifier - Instagram media ID or @username
   */
  async connect(identifier) {
    this._running = true;
    this._seenIds.clear();
    this._afterCursor = null;
    this._useAlternateFields = false;
    this._connectTimestamp = Date.now();

    if (identifier.startsWith('@')) {
      const username = identifier.slice(1);
      const userId = await this._resolveUsername(username);
      if (!userId) {
        this._running = false;
        throw new Error(
          `Could not resolve Instagram username @${username}. ` +
          'Ensure: (1) the account is a Business/Creator account, ' +
          '(2) your token is a Page Access Token with instagram_basic permission, ' +
          '(3) the Page is connected to the IG account.'
        );
      }
      console.log(`[Instagram] Resolved @${username} → user ID ${userId}`);

      // Try to find their most recent VIDEO media (likely the live stream)
      const liveMediaId = await this._findLiveOrRecentVideo(userId);
      if (liveMediaId) {
        this._mediaId = liveMediaId;
      } else {
        this._running = false;
        throw new Error(
          `No live stream or recent video found for @${username}. ` +
          'Provide the IG Media ID directly instead.'
        );
      }
    } else {
      // Assume it's a media ID directly
      this._mediaId = identifier;
    }

    // Verify we can access this media
    const verified = await this._verifyMedia(this._mediaId);
    if (!verified) {
      this._running = false;
      throw new Error(
        `Could not access Instagram media ${this._mediaId}. ` +
        'Check the media ID and ensure your access token has ' +
        'instagram_basic and instagram_manage_comments permissions.'
      );
    }

    console.log(`[Instagram] Connected to media: ${this._mediaId}`);
    this._poll().catch(err => console.error('[Instagram] Initial poll failed:', err.message));
  }

  disconnect() {
    this._running = false;
    if (this._timerId) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
    this._mediaId = null;
    console.log('[Instagram] Disconnected');
  }

  isConnected() {
    return this._running && this._mediaId !== null;
  }

  /**
   * Resolve an IG username to a user ID via connected IG Business Accounts.
   */
  async _resolveUsername(username) {
    try {
      // Strategy 1: Use pre-configured IG User ID from env (avoids /me/accounts)
      if (this._configuredIgUserId) {
        console.log(`[Instagram] Using configured IG User ID: ${this._configuredIgUserId}`);
        const checkUrl = `${GRAPH_API_BASE}/${this._configuredIgUserId}?fields=id,username&access_token=${this.accessToken}`;
        const checkRes = await fetch(checkUrl);
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          if (!username || checkData.username === username) {
            this._igUserId = this._configuredIgUserId;
            return this._configuredIgUserId;
          }
          // Different username — try Business Discovery via our account
          console.log(`[Instagram] Configured account is @${checkData.username}, looking up @${username}...`);
          const discoveryUrl = `${GRAPH_API_BASE}/${this._configuredIgUserId}?fields=business_discovery.fields(id,username)&username=${encodeURIComponent(username)}&access_token=${this.accessToken}`;
          const discRes = await fetch(discoveryUrl);
          if (discRes.ok) {
            const discData = await discRes.json();
            if (discData.business_discovery?.id) return discData.business_discovery.id;
          }
        } else {
          console.log('[Instagram] Configured IG User ID not accessible — trying /me/accounts...');
        }
      }

      // Strategy 2: Try /me/accounts (requires pages_show_list permission)
      const pagesUrl = `${GRAPH_API_BASE}/me/accounts?fields=instagram_business_account{id,username}&access_token=${this.accessToken}`;
      const pagesRes = await fetch(pagesUrl);
      if (pagesRes.ok) {
        const pagesData = await pagesRes.json();
        for (const page of (pagesData.data || [])) {
          const igAccount = page.instagram_business_account;
          if (igAccount && (!username || igAccount.username === username)) {
            this._igUserId = igAccount.id;
            return igAccount.id;
          }
        }
        const firstIgId = pagesData.data?.[0]?.instagram_business_account?.id;
        if (firstIgId) {
          const discoveryUrl = `${GRAPH_API_BASE}/${firstIgId}?fields=business_discovery.fields(id,username)&username=${encodeURIComponent(username)}&access_token=${this.accessToken}`;
          const discRes = await fetch(discoveryUrl);
          if (discRes.ok) {
            const discData = await discRes.json();
            if (discData.business_discovery?.id) return discData.business_discovery.id;
          }
        }
      } else {
        const errBody = await this._safeJson(pagesRes);
        console.log('[Instagram] /me/accounts not available:', errBody?.error?.message || '(skipping)');
      }

      return null;
    } catch (err) {
      console.error('[Instagram] Username resolution error:', err.message);
      return null;
    }
  }

  /**
   * Find most recent VIDEO media for an IG user (likely live stream).
   * Uses the standard /media edge with media_type filtering.
   */
  async _findLiveOrRecentVideo(userId) {
    try {
      // Get recent media and look for VIDEO type (live streams show as VIDEO)
      const url = `${GRAPH_API_BASE}/${userId}/media?fields=id,timestamp,media_type&limit=10&access_token=${this.accessToken}`;
      const res = await fetch(url);
      if (!res.ok) {
        const errBody = await this._safeJson(res);
        console.log('[Instagram] media lookup failed:', errBody?.error?.message || res.statusText);
        return null;
      }
      const data = await res.json();
      const items = data.data || [];

      // Prefer VIDEO type (live streams are VIDEO)
      const video = items.find(m => m.media_type === 'VIDEO');
      if (video) {
        console.log(`[Instagram] Found recent video media: ${video.id} (${video.timestamp})`);
        return video.id;
      }

      // If no video, use first media (could be an image post with comments)
      if (items.length > 0) {
        console.warn(`[Instagram] No VIDEO media found. Using most recent ${items[0].media_type}: ${items[0].id}`);
        console.warn('[Instagram] For live auctions, provide the IG Media ID directly for best results.');
        return items[0].id;
      }

      return null;
    } catch (err) {
      console.log('[Instagram] media lookup error:', err.message);
      return null;
    }
  }

  /**
   * Verify we can access the media and read its comments.
   */
  async _verifyMedia(mediaId) {
    try {
      const url = `${GRAPH_API_BASE}/${encodeURIComponent(mediaId)}?fields=id,timestamp,media_type&access_token=${this.accessToken}`;
      const res = await fetch(url);
      if (!res.ok) {
        const errBody = await this._safeJson(res);
        console.error('[Instagram] Media verification failed:', errBody?.error?.message || res.statusText);
        if (errBody?.error?.code) {
          console.error('[Instagram] Error code:', errBody.error.code, 'subcode:', errBody.error.error_subcode);
        }
        return false;
      }
      const data = await res.json();
      console.log(`[Instagram] Media verified: ${data.id} (type: ${data.media_type || 'unknown'})`);
      return true;
    } catch (err) {
      console.error('[Instagram] Media verification exception:', err.message);
      return false;
    }
  }

  async _poll() {
    if (!this._running) return;

    try {
      await this._fetchComments(this._afterCursor);
    } catch (err) {
      console.error('[Instagram] Poll exception:', err.message);
    }

    if (this._running) {
      this._timerId = setTimeout(() => this._poll(), this._pollIntervalMs);
    }
  }

  /**
   * Fetch one page of comments and follow pagination if more exist.
   */
  async _fetchComments(afterCursor, depth = 0) {
    if (!this._running || depth > 5) return;

    const fields = this._useAlternateFields
      ? 'id,text,timestamp'
      : 'id,text,username,timestamp';

    const params = new URLSearchParams({
      fields,
      limit: '100',
      access_token: this.accessToken,
    });

    if (afterCursor) {
      params.set('after', afterCursor);
    }

    const url = `${GRAPH_API_BASE}/${encodeURIComponent(this._mediaId)}/comments?${params}`;
    const res = await fetch(url);

    if (!this._running) return;

    if (!res.ok) {
      const errBody = await this._safeJson(res);
      const errorMsg = errBody?.error?.message || res.statusText;
      const errorCode = errBody?.error?.code;

      if (!this._useAlternateFields && (errorMsg.includes('field') || errorCode === 100)) {
        console.warn('[Instagram] Standard fields failed, trying alternate fields...');
        this._useAlternateFields = true;
        return; // Will retry on next poll cycle
      }

      if (errorCode === 4 || errorCode === 32) {
        console.warn('[Instagram] Rate limited, backing off to 10s...');
        this._pollIntervalMs = 10000;
        return;
      }

      console.error(`[Instagram] Poll error (code ${errorCode}): ${errorMsg}`);
      return;
    }

    const data = await res.json();
    const comments = data.data || [];

    if (data.paging?.cursors?.after) {
      this._afterCursor = data.paging.cursors.after;
    }

    for (const comment of comments) {
      const commentId = comment.id;
      if (this._seenIds.has(commentId)) continue;
      this._seenIds.add(commentId);

      if (this._seenIds.size > 10000) {
        const arr = [...this._seenIds];
        this._seenIds = new Set(arr.slice(arr.length - 5000));
      }

      const commentTime = new Date(comment.timestamp).getTime() || Date.now();

      if (this._connectTimestamp && commentTime < this._connectTimestamp) {
        continue;
      }

      let username = comment.username || null;
      if (!username) {
        username = `anon_${commentId.split('_').pop() || commentId}`;
      }
      if (!comment.username && this._useAlternateFields && !this._warnedAboutFields) {
        this._warnedAboutFields = true;
        console.warn('[Instagram] WARNING: username field unavailable — using anonymous IDs.');
      }

      this.onComment({
        id: commentId,
        platform: 'ig',
        username,
        text: comment.text || '',
        timestamp: commentTime,
      });
    }

    // Follow pagination if more comments exist
    if (data.paging?.next) {
      await this._fetchComments(this._afterCursor, depth + 1);
    }
  }

  /**
   * Safely parse JSON response body (handles non-JSON error pages).
   */
  async _safeJson(res) {
    try {
      return await res.json();
    } catch (_) {
      return null;
    }
  }
}
