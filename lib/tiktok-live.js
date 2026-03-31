/**
 * TikTok Live WebSocket Listener
 *
 * Uses the tiktok-live-connector npm package to listen for live chat messages
 * via WebSocket. No authentication required — connects as a public viewer.
 *
 * This is an unofficial/community library (reverse-engineered protocol).
 * May break if TikTok changes their internal API.
 *
 * FIX LOG:
 * - Added auto-reconnect with exponential backoff on disconnect
 * - Added warning when msgId is missing (dedup degraded)
 */

export class TikTokLiveListener {
  /**
   * @param {(comment: object) => void} onComment - callback for each new chat message
   */
  constructor(onComment) {
    this.onComment = onComment;
    this._client = null;
    this._running = false;
    this._username = null;
    this._seenIds = new Set();
    this._reconnectTimer = null;
    this._reconnectDelay = 5000; // start at 5s
    this._maxReconnectDelay = 60000; // cap at 60s
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 10;
    this._warnedAboutMsgId = false;
  }

  /**
   * Connect to a TikTok user's live stream.
   * @param {string} username - TikTok username (without @)
   */
  async connect(username) {
    this._username = username.replace(/^@/, '');
    this._running = true;
    this._seenIds.clear();
    this._reconnectAttempts = 0;

    await this._doConnect();
  }

  async _doConnect() {
    try {
      // Dynamic import since it's a CommonJS module
      const { WebcastPushConnection } = await import('tiktok-live-connector');

      this._client = new WebcastPushConnection(this._username, {
        processInitialData: false, // Don't replay historical messages — causes phantom bids
        enableExtendedGiftInfo: false,
        enableWebsocketUpgrade: true,
        requestPollingIntervalMs: 1000,
      });

      this._client.on('chat', (data) => {
        if (!this._running) return;

        const msgId = data.msgId || `tt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Warn once if msgId is missing — dedup is degraded
        if (!data.msgId && !this._warnedAboutMsgId) {
          this._warnedAboutMsgId = true;
          console.warn('[TikTok] WARNING: msgId not present in chat data — duplicate detection is degraded. This may be due to a tiktok-live-connector version mismatch.');
        }

        if (this._seenIds.has(msgId)) return;
        this._seenIds.add(msgId);

        if (this._seenIds.size > 10000) {
          const arr = [...this._seenIds];
          this._seenIds = new Set(arr.slice(arr.length - 5000));
        }

        this.onComment({
          id: msgId,
          platform: 'tt',
          username: data.uniqueId || data.nickname || 'Unknown',
          text: data.comment || '',
          timestamp: Date.now(),
        });
      });

      this._client.on('disconnected', () => {
        console.log('[TikTok] Disconnected from live stream');
        // Auto-reconnect if we were intentionally running
        if (this._running) {
          this._scheduleReconnect();
        }
      });

      this._client.on('error', (err) => {
        console.error('[TikTok] Error:', err.message);
      });

      const state = await this._client.connect();
      console.log(`[TikTok] Connected to @${this._username} — ${state.roomInfo?.title || 'Live'} (${state.viewerCount || 0} viewers)`);

      // Reset reconnect backoff on successful connection
      this._reconnectDelay = 5000;
      this._reconnectAttempts = 0;

    } catch (err) {
      // If this was a reconnect attempt, schedule another
      if (this._running && this._reconnectAttempts > 0) {
        console.error(`[TikTok] Reconnect failed: ${err.message}`);
        this._scheduleReconnect();
        return;
      }

      this._running = false;
      // Provide helpful error messages
      if (err.message?.includes('not found') || err.message?.includes('offline')) {
        throw new Error(`TikTok user @${this._username} is not currently live`);
      }
      throw new Error(`TikTok connection failed: ${err.message}`);
    }
  }

  _scheduleReconnect() {
    if (!this._running) return;
    // Clear any existing timer to prevent parallel reconnects
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.error(`[TikTok] Max reconnect attempts (${this._maxReconnectAttempts}) reached — giving up`);
      this._running = false;
      return;
    }

    this._reconnectAttempts++;
    const delay = Math.min(this._reconnectDelay, this._maxReconnectDelay);
    console.log(`[TikTok] Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})...`);

    this._reconnectTimer = setTimeout(async () => {
      // Clean up old client
      if (this._client) {
        try { this._client.disconnect(); } catch (_) {}
        this._client = null;
      }
      await this._doConnect();
    }, delay);

    // Exponential backoff
    this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, this._maxReconnectDelay);
  }

  disconnect() {
    this._running = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._client) {
      try {
        this._client.disconnect();
      } catch (_) {
        // ignore disconnect errors
      }
      this._client = null;
    }
    console.log('[TikTok] Disconnected');
  }

  isConnected() {
    return this._running && this._client !== null;
  }
}
