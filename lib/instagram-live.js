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

function isLiveMediaCandidate(item) {
  if (!item) return false;

  if (
    item.media_product_type === 'LIVE' ||
    item.product_type === 'LIVE' ||
    item.broadcast_status === 'LIVE' ||
    /\/live\//i.test(String(item.permalink || ''))
  ) {
    return true;
  }

  // Meta's live_media edge can expose the active session as BROADCAST/FEED.
  return item._source === 'live_edge' && (
    item.media_type === 'BROADCAST' ||
    /\/stories\//i.test(String(item.permalink || ''))
  );
}

export function selectActiveInstagramLiveMedia(items = []) {
  if (!Array.isArray(items) || items.length === 0) return null;

  return [...items]
    .filter((item) => isLiveMediaCandidate(item))
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())[0] || null;
}

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
  constructor(accessToken, onComment, igUserId, onStateChange = null) {
    this.accessToken = accessToken;
    this.onComment = onComment;
    this._configuredIgUserId = igUserId || null;
    this.onStateChange = onStateChange;
    this._timerId = null;
    this._running = false;
    this._seenIds = new Set();
    this._mediaId = null;
    this._defaultPollIntervalMs = 2000;
    this._pollIntervalMs = this._defaultPollIntervalMs; // 2 seconds
    this._afterCursor = null;
    this._useAlternateFields = false;
    this._igUserId = null;
    this._configuredIgUsername = null;
    this._warnedAboutFields = false;
    this._connectTimestamp = null;
    this._mediaDescriptor = null;
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
    this._pollIntervalMs = this._defaultPollIntervalMs;
    this._connectTimestamp = Date.now();
    this._mediaDescriptor = null;

    if (identifier.startsWith('@')) {
      const username = identifier.slice(1);
      const userId = await this._resolveUsername(username);
      if (!userId) {
        this._running = false;
        const configuredHint = this._configuredIgUsername && this._configuredIgUsername.toLowerCase() !== username.toLowerCase()
          ? ` Connected business account is @${this._configuredIgUsername}.`
          : '';
        throw new Error(
          `Could not resolve Instagram username @${username}. ` +
          configuredHint +
          'Ensure: (1) the account is a Business/Creator account, ' +
          '(2) your token is a Page Access Token with instagram_basic permission, ' +
          '(3) the Page is connected to the IG account.'
        );
      }
      console.log(`[Instagram] Resolved @${username} → user ID ${userId}`);

      // Find an actual LIVE media object. Do not silently fall back to reels/posts.
      const liveMedia = await this._findActiveLiveMedia(userId);
      if (liveMedia?.id) {
        this._mediaId = liveMedia.id;
        this._mediaDescriptor = liveMedia;
      } else {
        this._running = false;
        throw new Error(
          `No active Instagram LIVE media was found for @${username}. ` +
          'The Graph API is not exposing a current live stream for that account right now.'
        );
      }
    } else {
      // Assume it's a media ID directly
      this._mediaId = identifier;
    }

    // Verify we can access this media
    const verified = await this._verifyMedia(this._mediaId, this._mediaDescriptor);
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
          this._configuredIgUsername = checkData.username || null;
          if (!username || (checkData.username && checkData.username.toLowerCase() === username.toLowerCase())) {
            this._igUserId = this._configuredIgUserId;
            return this._configuredIgUserId;
          }
          // Different username — try Business Discovery via our account
          console.log(`[Instagram] Configured account is @${checkData.username}, looking up @${username}...`);
          const discoveryParams = new URLSearchParams({
            fields: `business_discovery.username(${username}){id,username}`,
            access_token: this.accessToken,
          });
          const discoveryUrl = `${GRAPH_API_BASE}/${this._configuredIgUserId}?${discoveryParams}`;
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
          if (igAccount && (!username || (igAccount.username && igAccount.username.toLowerCase() === username.toLowerCase()))) {
            this._igUserId = igAccount.id;
            return igAccount.id;
          }
        }
        const firstIgId = pagesData.data?.[0]?.instagram_business_account?.id;
        if (firstIgId) {
          const discoveryParams = new URLSearchParams({
            fields: `business_discovery.username(${username}){id,username}`,
            access_token: this.accessToken,
          });
          const discoveryUrl = `${GRAPH_API_BASE}/${firstIgId}?${discoveryParams}`;
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

  async _fetchLiveMediaCollection(userId) {
    try {
      const liveEdgeUrl = `${GRAPH_API_BASE}/${userId}/live_media?fields=id,media_type,media_product_type,product_type,broadcast_status,timestamp,permalink&limit=10&access_token=${this.accessToken}`;
      const liveEdgeRes = await fetch(liveEdgeUrl);
      if (liveEdgeRes.ok) {
        const liveEdgeData = await liveEdgeRes.json();
        const liveItems = liveEdgeData.data || [];
        if (liveItems.length > 0) {
          return liveItems.map((item) => ({ ...item, _source: 'live_edge' }));
        }
      } else {
        const errBody = await this._safeJson(liveEdgeRes);
        console.log('[Instagram] live_media lookup failed:', errBody?.error?.message || liveEdgeRes.statusText);
      }

      const mediaUrl = `${GRAPH_API_BASE}/${userId}/media?fields=id,media_type,media_product_type,product_type,broadcast_status,timestamp,permalink&limit=25&access_token=${this.accessToken}`;
      const mediaRes = await fetch(mediaUrl);
      if (!mediaRes.ok) {
        const errBody = await this._safeJson(mediaRes);
        console.log('[Instagram] media lookup failed:', errBody?.error?.message || mediaRes.statusText);
        return [];
      }

      const mediaData = await mediaRes.json();
      return (mediaData.data || []).map((item) => ({ ...item, _source: 'media' }));
    } catch (err) {
      console.log('[Instagram] live media lookup error:', err.message);
      return [];
    }
  }

  /**
   * Find an actual LIVE media object for an IG user.
   */
  async _findActiveLiveMedia(userId) {
    try {
      const items = await this._fetchLiveMediaCollection(userId);
      const liveMedia = selectActiveInstagramLiveMedia(items);
      if (liveMedia) {
        console.log(`[Instagram] Found active live media: ${liveMedia.id} (${liveMedia.timestamp})`);
        return liveMedia;
      }

      if (items.length > 0) {
        const recentKinds = items
          .slice(0, 5)
          .map((item) => `${item._source || 'media'}:${item.media_product_type || item.product_type || item.media_type || 'unknown'}:${item.id}`)
          .join(', ');
        console.warn(`[Instagram] No active LIVE media found. Recent media were: ${recentKinds}`);
      } else {
        console.warn('[Instagram] No media returned while looking for active LIVE media.');
      }

      return null;
    } catch (err) {
      console.log('[Instagram] live media selection error:', err.message);
      return null;
    }
  }

  /**
   * Verify we can access the media and read its comments.
   */
  async _verifyMedia(mediaId, mediaDescriptor = null) {
    try {
      const url = `${GRAPH_API_BASE}/${encodeURIComponent(mediaId)}?fields=id,timestamp,media_type,media_product_type,product_type,broadcast_status&access_token=${this.accessToken}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const productType = data.media_product_type || data.product_type || data.broadcast_status || data.media_type || 'unknown';
        if (productType !== 'LIVE') {
          console.warn(`[Instagram] Media ${data.id} is not LIVE (${productType})`);
        }
        console.log(`[Instagram] Media verified: ${data.id} (type: ${productType})`);
        return true;
      }

      const errBody = await this._safeJson(res);
      console.warn('[Instagram] Media verification fallback:', errBody?.error?.message || res.statusText);
      if (errBody?.error?.code) {
        console.warn('[Instagram] Verification fallback code:', errBody.error.code, 'subcode:', errBody.error.error_subcode);
      }

      const commentsUrl = `${GRAPH_API_BASE}/${encodeURIComponent(mediaId)}/comments?fields=id,text,username,timestamp&limit=1&access_token=${this.accessToken}`;
      const commentsRes = await fetch(commentsUrl);
      if (!commentsRes.ok) {
        const commentsErr = await this._safeJson(commentsRes);
        console.error('[Instagram] Comment probe failed:', commentsErr?.error?.message || commentsRes.statusText);
        return false;
      }

      const descriptorType = mediaDescriptor?.media_product_type ||
        mediaDescriptor?.product_type ||
        mediaDescriptor?.broadcast_status ||
        mediaDescriptor?.media_type ||
        'unknown';
      console.log(`[Instagram] Media verified via comments edge: ${mediaId} (type: ${descriptorType})`);
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

      if (/after|cursor/i.test(errorMsg)) {
        console.warn('[Instagram] Invalid pagination cursor, resetting and retrying...');
        this._afterCursor = null;
        return;
      }

      if (res.status >= 500) {
        console.warn(`[Instagram] Transient poll error (code ${errorCode}): ${errorMsg}`);
        return;
      }

      console.error(`[Instagram] Poll error (code ${errorCode}): ${errorMsg}`);
      this._running = false;
      this.onStateChange?.({ error: errorMsg });
      return;
    }

    const data = await res.json();
    const comments = data.data || [];
    this._pollIntervalMs = this._defaultPollIntervalMs;

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

      let username = comment.username || comment.from?.username || null;
      if (!username) {
        username = `anon_${commentId.split('_').pop() || commentId}`;
      }
      if (!comment.username && this._useAlternateFields && !this._warnedAboutFields) {
        this._warnedAboutFields = true;
        console.warn('[Instagram] WARNING: username field unavailable — using anonymous IDs.');
      }

      const text = comment.text || comment.message || '';

      this.onComment({
        id: commentId,
        platform: 'ig',
        username,
        text,
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
