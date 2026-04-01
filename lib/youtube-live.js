/**
 * YouTube Live Chat Poller
 *
 * Uses YouTube Data API v3 liveChatMessages.list to poll live chat messages.
 * Respects the API's pollingIntervalMillis for rate limiting.
 */

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

export class YouTubeLivePoller {
  /**
   * @param {string} apiKey - YouTube Data API key
   * @param {(bid: object) => void} onComment - callback for each new comment
   */
  constructor(apiKey, onComment, onStateChange = null) {
    this.apiKey = apiKey;
    this.onComment = onComment;
    this.onStateChange = onStateChange;
    this._liveChatId = null;
    this._pageToken = null;
    this._timerId = null;
    this._running = false;
    this._seenIds = new Set();
    this._videoId = null;
    this._connectTimestamp = 0;
  }

  /**
   * Connect to a YouTube live stream by video ID.
   * @param {string} videoId - YouTube video ID (e.g., "dQw4w9WgXcQ")
   */
  async connect(videoId) {
    this._videoId = videoId;
    this._running = true;
    this._seenIds.clear();
    this._pageToken = null;
    this._connectTimestamp = Date.now();

    try {
      this._liveChatId = await this._getLiveChatId(videoId);
      if (!this._liveChatId) {
        throw new Error(`Could not find live chat for video ${videoId}. Is the stream live?`);
      }

      console.log(`[YouTube] Connected to live chat: ${this._liveChatId}`);
      this._poll();
    } catch (err) {
      this._running = false;
      this._liveChatId = null;
      this._pageToken = null;
      throw err;
    }
  }

  disconnect() {
    this._running = false;
    if (this._timerId) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
    this._liveChatId = null;
    this._pageToken = null;
    this._connectTimestamp = 0;
    console.log('[YouTube] Disconnected');
  }

  isConnected() {
    return this._running && this._liveChatId !== null;
  }

  async _getLiveChatId(videoId) {
    const url = `${YT_API_BASE}/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${this.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const message = err.error?.message || res.statusText;
      const reason = err.error?.errors?.[0]?.reason || '';

      if (res.status === 403 && /quota/i.test(message + ' ' + reason)) {
        throw new Error('YouTube API quota exceeded for the configured API key.');
      }

      throw new Error(`YouTube API error: ${message}`);
    }

    const data = await res.json();
    if (!data.items || data.items.length === 0) {
      throw new Error(`Video ${videoId} not found`);
    }

    const details = data.items[0].liveStreamingDetails;
    if (!details || !details.activeLiveChatId) {
      throw new Error(`Video ${videoId} does not have an active live chat`);
    }

    return details.activeLiveChatId;
  }

  async _poll() {
    if (!this._running) return;

    let pollingInterval = 3000; // default fallback (reduced from 5s for faster bid pickup)

    try {
      const params = new URLSearchParams({
        part: 'snippet,authorDetails',
        liveChatId: this._liveChatId,
        maxResults: '200',
        key: this.apiKey,
      });
      if (this._pageToken) params.set('pageToken', this._pageToken);

      const url = `${YT_API_BASE}/liveChat/messages?${params}`;
      const res = await fetch(url);

      if (!res.ok) {
        let errBody;
        try { errBody = await res.json(); } catch (_) { errBody = {}; }
        const msg = errBody.error?.message || res.statusText;
        const code = errBody.error?.code;
        // Only treat as "chat ended" if the error message explicitly says so
        if (msg.includes('ended') || msg.includes('not found') || msg.includes('disabled')) {
          console.log('[YouTube] Live chat has ended:', msg);
          this._running = false;
          this.onStateChange?.({ error: msg });
          return;
        }
        if (code === 400 || /page.?token/i.test(msg)) {
          console.warn('[YouTube] Invalid page token, resetting cursor and retrying...');
          this._pageToken = null;
        } else if (code === 403) {
          console.error('[YouTube] Fatal 403 error:', msg);
          this._running = false;
          this.onStateChange?.({ error: msg });
        } else {
          console.error('[YouTube] Poll error:', msg);
        }
      } else {
        const data = await res.json();
        this._pageToken = data.nextPageToken || this._pageToken;
        // Respect API's recommended interval but ensure at least 3s (don't poll faster)
        pollingInterval = Math.max(data.pollingIntervalMillis || 5000, 3000);

        const messages = data.items || [];

        for (const msg of messages) {
          const msgId = msg.id;
          if (this._seenIds.has(msgId)) continue;
          const publishedAt = new Date(msg.snippet?.publishedAt).getTime() || Date.now();
          if (publishedAt < this._connectTimestamp) continue;
          this._seenIds.add(msgId);

          // Cap seen IDs to prevent memory leak
          if (this._seenIds.size > 10000) {
            const arr = [...this._seenIds];
            this._seenIds = new Set(arr.slice(arr.length - 5000));
          }

          this.onComment({
            id: msgId,
            platform: 'yt',
            username: msg.authorDetails?.displayName || 'Unknown',
            text: msg.snippet?.displayMessage || '',
            timestamp: publishedAt,
          });
        }
      }
    } catch (err) {
      console.error('[YouTube] Poll exception:', err.message);
    }

    // Schedule next poll
    if (this._running) {
      this._timerId = setTimeout(() => this._poll(), pollingInterval);
    }
  }
}
