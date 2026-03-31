/**
 * LIVE AUCTION BID AGGREGATOR DASHBOARD
 *
 * Modes:
 *   1. LIVE MODE — connects to server via WebSocket, receives real bids
 *      from YouTube, Facebook, Instagram, TikTok live streams
 *   2. DEMO MODE — runs BidSimulator locally for testing/preview
 *
 * The dashboard auto-detects: if WebSocket connects → live mode.
 * User can also toggle demo mode manually via Settings panel.
 */

'use strict';

// ============================================================
// PLATFORM CONFIG
// ============================================================

const PLATFORMS = [
  { id: 'fb', name: 'Facebook Live', shortName: 'FB', color: '#1877F2', cssClass: 'plat-fb' },
  { id: 'ig', name: 'Instagram', shortName: 'IG', color: '#E4405F', cssClass: 'plat-ig' },
  { id: 'yt', name: 'YouTube', shortName: 'YT', color: '#FF0000', cssClass: 'plat-yt' },
  { id: 'tt', name: 'TikTok', shortName: 'TT', color: '#69C9D0', cssClass: 'plat-tt' },
  { id: 'tw', name: 'Twitch', shortName: 'TW', color: '#9146FF', cssClass: 'plat-tw' },
  { id: 'x', name: 'X / Twitter', shortName: 'X', color: '#1DA1F2', cssClass: 'plat-x' },
];

const PLATFORM_MAP = {};
for (const p of PLATFORMS) PLATFORM_MAP[p.id] = p;

/**
 * Extract platform-specific ID from a full URL.
 * Users can paste full URLs instead of hunting for video IDs.
 */
function extractPlatformId(platform, input) {
  const val = input.trim();

  if (platform === 'yt') {
    // YouTube: extract video ID from various URL formats
    // https://youtube.com/watch?v=VIDEO_ID
    // https://youtu.be/VIDEO_ID
    // https://youtube.com/live/VIDEO_ID
    // https://www.youtube.com/watch?v=VIDEO_ID&feature=share
    let match = val.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];
    match = val.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];
    match = val.match(/youtube\.com\/live\/([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];
    // Already a video ID (11 chars)
    if (/^[a-zA-Z0-9_-]{11}$/.test(val)) return val;
    return val;
  }

  if (platform === 'fb') {
    // Facebook: extract video ID from URL
    // https://facebook.com/PAGE/videos/VIDEO_ID
    // https://www.facebook.com/watch/live/?v=VIDEO_ID
    // https://fb.watch/SHORTCODE
    let match = val.match(/videos\/(\d+)/);
    if (match) return match[1];
    match = val.match(/[?&]v=(\d+)/);
    if (match) return match[1];
    // Already a numeric ID
    if (/^\d+$/.test(val)) return val;
    return val;
  }

  if (platform === 'ig') {
    // Instagram: accept @username, full URL, or media ID
    // https://instagram.com/USERNAME/live/
    // https://www.instagram.com/p/POST_ID/
    let match = val.match(/instagram\.com\/([a-zA-Z0-9_.]+)(?:\/live)?/);
    if (match && match[1] !== 'p' && match[1] !== 'reel') return '@' + match[1];
    // Already starts with @
    if (val.startsWith('@')) return val;
    // Numeric media ID
    if (/^\d+$/.test(val)) return val;
    // Bare username (no URL, no @, no numbers only)
    if (/^[a-zA-Z0-9_.]+$/.test(val) && !/^\d+$/.test(val)) return '@' + val;
    return val;
  }

  if (platform === 'tt') {
    // TikTok: extract username from URL
    // https://tiktok.com/@USERNAME/live
    // https://www.tiktok.com/@USERNAME
    let match = val.match(/tiktok\.com\/@([a-zA-Z0-9_.]+)/);
    if (match) return match[1];
    // Strip @ if present
    return val.replace(/^@/, '');
  }

  return val;
}

function formatCurrency(amount) {
  return '$' + Math.round(amount).toLocaleString('en-US');
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// Safe DOM element builder
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (key === 'className') node.className = val;
      else if (key === 'textContent') node.textContent = val;
      else if (key === 'title') node.title = val;
      else if (key.startsWith('data-')) node.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
      else node.setAttribute(key, val);
    }
  }
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else node.appendChild(child);
  }
  return node;
}

// ============================================================
// WEBSOCKET CLIENT
// ============================================================

class WebSocketClient {
  constructor() {
    this._ws = null;
    this._callbacks = { bid: null, status: null, filtered: null, auction: null, blocked: null, error: null, comment: null, fbLogin: null };
    this._reconnectTimer = null;
    this._connected = false;
  }

  onBid(cb) { this._callbacks.bid = cb; }
  onComment(cb) { this._callbacks.comment = cb; }
  onStatus(cb) { this._callbacks.status = cb; }
  onFbLogin(cb) { this._callbacks.fbLogin = cb; }
  onFiltered(cb) { this._callbacks.filtered = cb; }
  onNewAuction(cb) { this._callbacks.auction = cb; }
  onBlockedUpdate(cb) { this._callbacks.blocked = cb; }
  onError(cb) { this._callbacks.error = cb; }

  connect() {
    if (this._ws) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}`;

    try {
      this._ws = new WebSocket(url);
    } catch (err) {
      console.log('[WS] WebSocket not available (file:// mode?)');
      return false;
    }

    this._ws.onopen = () => {
      this._connected = true;
      console.log('[WS] Connected to server');
    };

    this._ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleMessage(msg);
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    };

    this._ws.onclose = () => {
      this._connected = false;
      this._ws = null;
      console.log('[WS] Disconnected — reconnecting in 3s...');
      this._reconnectTimer = setTimeout(() => this.connect(), 3000);
    };

    this._ws.onerror = () => {
      // onclose will fire after this
    };

    return true;
  }

  isConnected() { return this._connected; }

  send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  connectPlatform(platform, identifier) {
    this.send({ type: 'connect-platform', platform, identifier });
  }

  disconnectPlatform(platform) {
    this.send({ type: 'disconnect-platform', platform });
  }

  newAuction() {
    this.send({ type: 'new-auction' });
  }

  blockUser(platform, username) {
    this.send({ type: 'block-user', platform, username });
  }

  unblockUser(platform, username) {
    this.send({ type: 'unblock-user', platform, username });
  }

  updateFilter(settings) {
    this.send({ type: 'update-filter', settings });
  }

  fbLogin() {
    this.send({ type: 'fb-login' });
  }

  fbLoginStatus() {
    this.send({ type: 'fb-login-status' });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'new-comment':
        if (this._callbacks.comment) {
          const comment = msg.comment;
          const plat = PLATFORM_MAP[comment.platform];
          if (plat) comment.platform = plat;
          this._callbacks.comment(comment);
        }
        break;

      case 'new-bid':
        if (this._callbacks.bid) {
          const bid = msg.bid;
          bid.platform = PLATFORM_MAP[bid.platform] || PLATFORM_MAP['fb'];
          this._callbacks.bid(bid);
        }
        break;

      case 'bid-filtered':
        if (this._callbacks.filtered) this._callbacks.filtered(msg);
        break;

      case 'status':
        if (this._callbacks.status) this._callbacks.status(msg);
        break;

      case 'platform-connected':
      case 'platform-disconnected':
      case 'platform-error':
      case 'connect-result':
        if (this._callbacks.status) this._callbacks.status(msg);
        break;

      case 'new-auction':
        if (this._callbacks.auction) this._callbacks.auction();
        break;

      case 'user-blocked':
      case 'user-unblocked':
        if (this._callbacks.blocked) this._callbacks.blocked(msg);
        break;

      case 'filter-updated':
        break;

      case 'fb-login-result':
      case 'fb-login-status':
        if (this._callbacks.fbLogin) this._callbacks.fbLogin(msg);
        break;

      case 'error':
        if (this._callbacks.error) this._callbacks.error(msg.error);
        break;
    }
  }
}

// ============================================================
// BID SIMULATOR (demo mode)
// ============================================================

class BidSimulator {
  constructor() {
    this._callback = null;
    this._timerId = null;
    this._running = false;
    this._currentAverage = 100;
    this._demoUsernames = {
      fb: ['sarah_m', 'bbq_mike_2024', 'bargain_hunter', 'local_flea', 'mark_t', 'collectors_corner'],
      ig: ['vibes_only_22', 'aesthetic.bids', 'insta_auctions', 'thrift.queen', 'reels_n_deals'],
      yt: ['theAuctioneer99', 'WatcherWayne', 'SeriousCollector', 'BidKingYT', 'VintageTreasures'],
      tt: ['vibes.only', 'bid_king99', 'tokbidder', 'auction.tok', 'fyp_finds'],
      tw: ['StreamBidder', 'PogChampBid', 'HypeTrainBuyer', 'KappaCollector'],
      x: ['xbidder', 'tweet_n_bid', 'auction_x_user', 'birdbid'],
    };
  }

  onBid(callback) { this._callback = callback; }
  onComment(callback) { this._commentCallback = callback; }

  start() {
    if (this._running) return;
    this._running = true;
    this._scheduleNext();
    this._scheduleChatMessage();
  }

  stop() {
    this._running = false;
    if (this._timerId) { clearTimeout(this._timerId); this._timerId = null; }
    if (this._chatTimerId) { clearTimeout(this._chatTimerId); this._chatTimerId = null; }
  }

  reset() {
    this.stop();
    this._currentAverage = 100;
  }

  _scheduleChatMessage() {
    if (!this._running) return;
    const interval = 500 + Math.random() * 3000;
    this._chatTimerId = setTimeout(() => { this._emitChat(); this._scheduleChatMessage(); }, interval);
  }

  _emitChat() {
    if (!this._commentCallback) return;
    const chatMessages = [
      'This is awesome!', 'Love the stream!', 'What item is next?',
      'How much is shipping?', 'Great stuff today', 'Can you show it again?',
      'Is that authentic?', 'Ship to Sydney?', 'Nice one!', 'Want!',
      'Hello from Perth!', 'First time watching', 'Do you ship interstate?',
      'Whats the condition?', 'Any more of these?', 'Love your auctions',
      'Whats the size?', 'Can I pick up?', 'Fire sale!', 'LFG!',
    ];
    const weights = [
      { id: 'fb', w: 0.30 }, { id: 'ig', w: 0.10 }, { id: 'yt', w: 0.30 },
      { id: 'tt', w: 0.15 }, { id: 'tw', w: 0.08 }, { id: 'x', w: 0.07 },
    ];
    let r = Math.random(), platformId = 'fb';
    let cum = 0;
    for (const w of weights) { cum += w.w; if (r <= cum) { platformId = w.id; break; } }
    const platform = PLATFORM_MAP[platformId];
    const usernames = this._demoUsernames[platformId] || ['demo_user'];
    this._commentCallback({
      id: 'chat-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
      platform,
      username: usernames[Math.floor(Math.random() * usernames.length)],
      text: chatMessages[Math.floor(Math.random() * chatMessages.length)],
      timestamp: Date.now(),
    });
  }

  _scheduleNext() {
    if (!this._running) return;
    const interval = 800 + Math.random() * 2200;
    this._timerId = setTimeout(() => { this._emitBid(); this._scheduleNext(); }, interval);
  }

  _emitBid() {
    if (!this._callback) return;

    // Pick weighted random platform (FB & YT heavier)
    const weights = [
      { id: 'fb', w: 0.30 }, { id: 'ig', w: 0.10 }, { id: 'yt', w: 0.30 },
      { id: 'tt', w: 0.15 }, { id: 'tw', w: 0.08 }, { id: 'x', w: 0.07 },
    ];
    let r = Math.random(), platformId = 'fb';
    let cum = 0;
    for (const w of weights) { cum += w.w; if (r <= cum) { platformId = w.id; break; } }

    const platform = PLATFORM_MAP[platformId];
    const usernames = this._demoUsernames[platformId] || ['demo_user'];
    const username = usernames[Math.floor(Math.random() * usernames.length)];

    const roll = Math.random();
    let amount;
    if (roll < 0.70) {
      amount = this._currentAverage + 5 + Math.random() * 45;
    } else if (roll < 0.90) {
      amount = Math.max(5, this._currentAverage - (10 + Math.random() * (this._currentAverage * 0.4)));
    } else {
      amount = this._currentAverage + 100 + Math.random() * 400;
    }
    amount = Math.max(5, Math.round(amount * 100) / 100);
    this._currentAverage = this._currentAverage * 0.92 + amount * 0.08;

    this._callback({
      id: crypto.randomUUID ? crypto.randomUUID() : 'bid-' + Date.now() + '-' + Math.floor(Math.random() * 1e9),
      platform,
      username,
      amount,
      timestamp: Date.now(),
    });
  }
}

// ============================================================
// AUCTION STATE MANAGER
// ============================================================

class AuctionState {
  constructor() {
    this._allBids = [];
    this._disregarded = new Set();
    this._bidsByPlatform = {};
    for (const p of PLATFORMS) this._bidsByPlatform[p.id] = 0;
    this._totalBidCount = 0;
  }

  addBid(bid) {
    this._allBids.push(bid);
    this._bidsByPlatform[bid.platform.id] = (this._bidsByPlatform[bid.platform.id] || 0) + 1;
    this._totalBidCount++;
  }

  disregardBid(bidId) {
    if (this._disregarded.has(bidId)) return false;
    const bid = this._allBids.find(b => b.id === bidId);
    if (!bid) return false;
    this._disregarded.add(bidId);
    return true;
  }

  getActiveBids() {
    return this._allBids.filter(b => !this._disregarded.has(b.id)).sort((a, b) => b.amount - a.amount);
  }

  getHighestBid() {
    const active = this.getActiveBids();
    return active.length > 0 ? active[0] : null;
  }

  getNextBids() { return this.getActiveBids().slice(1, 4); }
  getTopBids(n = 10) { return this.getActiveBids().slice(0, n); }
  getBidsByPlatform() { return { ...this._bidsByPlatform }; }
  getTotalCount() { return this._totalBidCount; }
  isDisregarded(bidId) { return this._disregarded.has(bidId); }

  reset() {
    this._allBids = [];
    this._disregarded = new Set();
    for (const p of PLATFORMS) this._bidsByPlatform[p.id] = 0;
    this._totalBidCount = 0;
  }
}

// ============================================================
// DOM RENDERER
// ============================================================

class DashboardRenderer {
  constructor(state) {
    this._state = state;
    this._prevHighestId = null;

    this._heroSection = document.getElementById('hero-section');
    this._heroAmount = document.getElementById('hero-amount');
    this._heroUsername = document.getElementById('hero-username');
    this._heroPlatformBadge = document.getElementById('hero-platform-badge');
    this._heroTime = document.getElementById('hero-time');
    this._feedList = document.getElementById('feed-list');
    this._leaderboardList = document.getElementById('leaderboard-list');
    this._nextBidsList = document.getElementById('next-bids-list');
    this._statusBar = document.getElementById('status-bar');
    this._totalBidsCount = document.getElementById('total-bids-count');
    this._toastContainer = document.getElementById('toast-container');

    this._initStatusBar();
  }

  _initStatusBar() {
    while (this._statusBar.firstChild) this._statusBar.removeChild(this._statusBar.firstChild);
    for (const p of PLATFORMS) {
      const countSpan = el('span', { className: 'badge-count', id: 'badge-count-' + p.id }, '0');
      const badge = el('div', { className: 'platform-badge ' + p.cssClass, id: 'badge-' + p.id },
        el('span', { className: 'badge-name' }, p.shortName),
        document.createTextNode(' '),
        countSpan
      );
      this._statusBar.appendChild(badge);
    }
  }

  updateHeroBid(bid) {
    if (!bid) {
      this._heroAmount.textContent = '—';
      this._heroUsername.textContent = 'Waiting for bids...';
      this._heroUsername.style.color = 'var(--text-muted)';
      this._heroPlatformBadge.textContent = '';
      this._heroPlatformBadge.className = '';
      this._heroTime.textContent = '';
      return;
    }

    const isNewHighest = bid.id !== this._prevHighestId;
    this._prevHighestId = bid.id;

    this._heroAmount.textContent = formatCurrency(bid.amount);
    this._heroUsername.textContent = '@' + bid.username;
    this._heroUsername.style.color = '';
    this._heroTime.textContent = formatTime(bid.timestamp);
    this._heroPlatformBadge.textContent = bid.platform.name;
    this._heroPlatformBadge.className = 'platform-badge ' + bid.platform.cssClass;

    if (isNewHighest) {
      this._heroSection.classList.remove('pulse');
      void this._heroSection.offsetWidth;
      this._heroSection.classList.add('pulse');
    }
  }

  updateNextBids(nextBids) {
    while (this._nextBidsList.firstChild) this._nextBidsList.removeChild(this._nextBidsList.firstChild);
    if (nextBids.length === 0) {
      this._nextBidsList.appendChild(el('div', { className: 'empty-state' }, 'No other bids yet'));
      return;
    }
    nextBids.forEach((bid, i) => {
      const rank = i + 2;
      const row = el('div', { className: 'next-bid-row', 'data-bid-id': bid.id },
        el('span', { className: 'next-bid-rank rank-' + rank }, '#' + rank),
        el('span', { className: 'next-bid-platform ' + bid.platform.cssClass }, bid.platform.shortName),
        el('span', { className: 'next-bid-user' }, '@' + bid.username),
        el('span', { className: 'next-bid-amount' }, formatCurrency(bid.amount)),
        el('button', { className: 'next-bid-disregard', 'data-bid-id': bid.id, title: 'Disregard this bid' }, 'Disregard'),
        el('button', { className: 'block-user-btn', 'data-platform': bid.platform.id, 'data-username': bid.username, title: 'Block this user' }, 'Block')
      );
      this._nextBidsList.appendChild(row);
    });
  }

  addToFeed(bid) {
    const emptyState = this._feedList.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const isHighest = this._state.getHighestBid()?.id === bid.id;
    const amountClass = 'feed-amount' + (isHighest ? ' highlight' : '');
    const entryClass = 'feed-entry' + (isHighest ? ' new-highest' : '');

    const entry = el('div', { className: entryClass, 'data-bid-id': bid.id },
      el('span', { className: 'feed-platform-tag ' + bid.platform.cssClass }, bid.platform.shortName),
      el('span', { className: 'feed-username' + (bid.verified === false ? ' username-unverified' : '') }, '@' + bid.username),
      el('span', { className: amountClass }, formatCurrency(bid.amount)),
      el('span', { className: 'feed-time' }, formatTime(bid.timestamp)),
      el('button', { className: 'feed-disregard-btn', 'data-bid-id': bid.id, title: 'Disregard this bid' }, '\u2715'),
      el('button', { className: 'block-user-btn small', 'data-platform': bid.platform.id, 'data-username': bid.username, title: 'Block user' }, '\u26D4')
    );

    this._feedList.insertBefore(entry, this._feedList.firstChild);
    const entries = this._feedList.querySelectorAll('.feed-entry');
    if (entries.length > 50) entries[entries.length - 1].remove();
  }

  markFeedEntryDisregarded(bidId) {
    const entry = this._feedList.querySelector('[data-bid-id="' + bidId + '"]');
    if (entry) {
      entry.classList.add('disregarded');
      const btn = entry.querySelector('.feed-disregard-btn');
      if (btn) btn.disabled = true;
    }
  }

  updateLeaderboard(topBids) {
    while (this._leaderboardList.firstChild) this._leaderboardList.removeChild(this._leaderboardList.firstChild);
    if (topBids.length === 0) {
      this._leaderboardList.appendChild(el('div', { className: 'empty-state' }, 'Leaderboard will populate...'));
      return;
    }
    topBids.forEach((bid, i) => {
      const rank = i + 1;
      const row = el('div', { className: 'lb-row rank-' + rank, 'data-bid-id': bid.id },
        el('span', { className: 'lb-rank' }, String(rank)),
        el('span', { className: 'lb-platform-tag ' + bid.platform.cssClass }, bid.platform.shortName),
        el('span', { className: 'lb-username' }, '@' + bid.username),
        el('span', { className: 'lb-amount' }, formatCurrency(bid.amount)),
        el('button', { className: 'lb-disregard-btn', 'data-bid-id': bid.id, title: 'Disregard this bid' }, '\u2715'),
        el('button', { className: 'block-user-btn small', 'data-platform': bid.platform.id, 'data-username': bid.username, title: 'Block user' }, '\u26D4')
      );
      this._leaderboardList.appendChild(row);
    });
  }

  updatePlatformCounts(counts) {
    for (const p of PLATFORMS) {
      const countEl = document.getElementById('badge-count-' + p.id);
      if (countEl) countEl.textContent = (counts[p.id] || 0).toLocaleString();
    }
  }

  updateTotalCount(count) {
    this._totalBidsCount.textContent = count.toLocaleString() + ' bid' + (count !== 1 ? 's' : '');
  }

  showToast(message, type = 'info') {
    const toast = el('div', { className: 'toast toast-' + type }, message);
    this._toastContainer.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 3000);
  }

  reset() {
    this._prevHighestId = null;
    this.updateHeroBid(null);
    this.updateNextBids([]);
    while (this._feedList.firstChild) this._feedList.removeChild(this._feedList.firstChild);
    this._feedList.appendChild(el('div', { className: 'empty-state' }, 'Bids will appear here...'));
    this.updateLeaderboard([]);
    this.updatePlatformCounts({});
    this.updateTotalCount(0);
  }
}

// ============================================================
// CONNECTION PANEL UI
// ============================================================

class ConnectionPanelUI {
  constructor(wsClient) {
    this._ws = wsClient;
    this._panel = document.getElementById('connection-panel');
    this._platformStatus = { yt: false, fb: false, ig: false, tt: false };
  }

  init() {
    // Toggle panel
    document.getElementById('btn-settings').addEventListener('click', () => {
      this._panel.classList.toggle('panel-collapsed');
    });

    // Platform connect buttons
    const platformMap = {
      yt: { input: 'input-yt', btn: 'btn-connect-yt', apiName: 'youtube' },
      fb: { input: 'input-fb', btn: 'btn-connect-fb', apiName: 'facebook' },
      ig: { input: 'input-ig', btn: 'btn-connect-ig', apiName: 'instagram' },
      tt: { input: 'input-tt', btn: 'btn-connect-tt', apiName: 'tiktok' },
    };

    for (const [id, cfg] of Object.entries(platformMap)) {
      const btn = document.getElementById(cfg.btn);
      const input = document.getElementById(cfg.input);

      btn.addEventListener('click', () => {
        if (this._platformStatus[id]) {
          // Disconnect
          this._ws.disconnectPlatform(cfg.apiName);
          this._setStatus(id, false);
          btn.textContent = 'Connect';
          btn.classList.remove('connected');
        } else {
          // Connect — auto-extract ID from full URLs
          let val = input.value.trim();
          if (!val) { input.focus(); return; }
          val = extractPlatformId(id, val);
          input.value = val; // show extracted ID in the input
          this._ws.connectPlatform(cfg.apiName, val);
          btn.textContent = 'Connecting...';
          btn.disabled = true;
          setTimeout(() => { btn.disabled = false; }, 5000);
        }
      });
    }

    // Filter apply
    document.getElementById('btn-apply-filter').addEventListener('click', () => {
      const minBid = parseFloat(document.getElementById('filter-min').value) || 1;
      const maxBid = parseFloat(document.getElementById('filter-max').value) || 999999;
      const jumpMultiplier = parseFloat(document.getElementById('filter-jump').value) || 50;
      this._ws.updateFilter({ minBid, maxBid, jumpMultiplier });
    });
  }

  _setStatus(platformId, connected) {
    this._platformStatus[platformId] = connected;
    const dot = document.getElementById('conn-dot-' + platformId);
    if (dot) {
      dot.classList.toggle('connected', connected);
      dot.classList.toggle('disconnected', !connected);
    }
    const btn = document.getElementById('btn-connect-' + platformId);
    if (btn) {
      btn.textContent = connected ? 'Disconnect' : 'Connect';
      btn.classList.toggle('connected', connected);
      btn.disabled = false;
    }
  }

  handleStatusMessage(msg) {
    if (msg.type === 'status' && msg.platforms) {
      // Full status update
      if (msg.platforms.youtube !== undefined) this._setStatus('yt', msg.platforms.youtube);
      if (msg.platforms.facebook !== undefined) this._setStatus('fb', msg.platforms.facebook);
      if (msg.platforms.instagram !== undefined) this._setStatus('ig', msg.platforms.instagram);
      if (msg.platforms.tiktok !== undefined) this._setStatus('tt', msg.platforms.tiktok);
    } else if (msg.type === 'platform-connected') {
      const idMap = { youtube: 'yt', facebook: 'fb', instagram: 'ig', tiktok: 'tt' };
      this._setStatus(idMap[msg.platform], true);
    } else if (msg.type === 'platform-disconnected') {
      const idMap = { youtube: 'yt', facebook: 'fb', instagram: 'ig', tiktok: 'tt' };
      this._setStatus(idMap[msg.platform], false);
    } else if (msg.type === 'platform-error') {
      const idMap = { youtube: 'yt', facebook: 'fb', instagram: 'ig', tiktok: 'tt' };
      this._setStatus(idMap[msg.platform], false);
    } else if (msg.type === 'connect-result' && !msg.success) {
      const idMap = { youtube: 'yt', facebook: 'fb', instagram: 'ig', tiktok: 'tt' };
      this._setStatus(idMap[msg.platform], false);
    }
  }

  updateBlockedUsers(blockedUsers) {
    const list = document.getElementById('blocked-users-list');
    const count = document.getElementById('blocked-count');
    while (list.firstChild) list.removeChild(list.firstChild);
    count.textContent = '(' + (blockedUsers?.length || 0) + ')';

    if (!blockedUsers || blockedUsers.length === 0) return;

    for (const user of blockedUsers) {
      const platformObj = PLATFORM_MAP[user.platform];
      const entry = el('div', { className: 'blocked-user-entry' },
        el('span', { className: 'blocked-user-platform ' + (platformObj?.cssClass || '') }, platformObj?.shortName || user.platform),
        el('span', { className: 'blocked-user-name' }, '@' + user.username),
        el('button', {
          className: 'unblock-btn',
          'data-platform': user.platform,
          'data-username': user.username,
        }, 'Unblock')
      );
      list.appendChild(entry);
    }
  }
}

// ============================================================
// MAIN CONTROLLER
// ============================================================

function init() {
  const state = new AuctionState();
  const renderer = new DashboardRenderer(state);
  const simulator = new BidSimulator();
  const wsClient = new WebSocketClient();
  const connPanel = new ConnectionPanelUI(wsClient);

  let demoMode = false;
  let liveMode = false;

  // ── Common bid handler ──
  function handleBid(bid) {
    state.addBid(bid);
    renderer.addToFeed(bid);
    // Compute sorted active bids ONCE (not 3x)
    const activeBids = state.getActiveBids();
    renderer.updateHeroBid(activeBids.length > 0 ? activeBids[0] : null);
    renderer.updateNextBids(activeBids.slice(1, 4));
    renderer.updateLeaderboard(activeBids.slice(0, 10));
    renderer.updatePlatformCounts(state.getBidsByPlatform());
    renderer.updateTotalCount(state.getTotalCount());
  }

  // ── Wire up simulator (demo mode) ──
  simulator.onBid(handleBid);
  // Wire simulator chat messages to the comment stream handler
  simulator.onComment((comment) => {
    if (wsClient._callbacks.comment) wsClient._callbacks.comment(comment);
  });

  // ── Wire up WebSocket (live mode) ──
  wsClient.onBid(handleBid);

  wsClient.onStatus((msg) => {
    connPanel.handleStatusMessage(msg);
    if (msg.type === 'platform-connected') {
      liveMode = true;
      renderer.showToast(`${msg.platform} connected`, 'success');
      // Stop demo if running
      if (demoMode) {
        simulator.stop();
        demoMode = false;
        document.getElementById('btn-demo').textContent = 'Start Demo';
      }
    } else if (msg.type === 'platform-disconnected') {
      renderer.showToast(`${msg.platform} disconnected`, 'info');
    } else if (msg.type === 'platform-error') {
      renderer.showToast(`${msg.platform}: ${msg.error}`, 'error');
    } else if (msg.type === 'connect-result' && !msg.success) {
      renderer.showToast(`${msg.platform}: ${msg.error}`, 'error');
    }
  });

  wsClient.onFiltered((msg) => {
    // Optionally show filtered bids as muted in feed
    console.log(`[Filtered] ${msg.bid.username}: $${msg.bid.amount} — ${msg.reason}`);
  });

  wsClient.onNewAuction(() => {
    state.reset();
    renderer.reset();
    // Reset comment stream
    commentCount = 0;
    commentStreamCount.textContent = '0';
    while (commentStreamList.firstChild) commentStreamList.removeChild(commentStreamList.firstChild);
    commentStreamList.appendChild(el('div', { className: 'empty-state' }, 'Comments will appear here...'));
    renderer.showToast('New auction started!', 'success');
  });

  wsClient.onBlockedUpdate((msg) => {
    connPanel.updateBlockedUsers(msg.blockedUsers);
    if (msg.type === 'user-blocked') {
      renderer.showToast(`Blocked @${msg.username}`, 'info');
    } else {
      renderer.showToast(`Unblocked @${msg.username}`, 'info');
    }
  });

  wsClient.onError((err) => {
    renderer.showToast(err, 'error');
  });

  // ── Comment stream ──
  const commentStreamList = document.getElementById('comment-stream-list');
  const commentStreamCount = document.getElementById('comment-stream-count');
  const commentStreamSection = document.getElementById('comment-stream-section');
  let commentCount = 0;
  const MAX_COMMENTS = 100;

  wsClient.onComment((comment) => {
    // Remove empty state
    const emptyState = commentStreamList.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    commentCount++;
    commentStreamCount.textContent = commentCount.toLocaleString();

    // Check if this comment also parsed as a bid (for highlighting)
    const isBid = /\d/.test(comment.text || '');

    const platformObj = (typeof comment.platform === 'object') ? comment.platform : PLATFORM_MAP[comment.platform];
    const entryClass = 'comment-entry' + (isBid ? ' is-bid' : '');
    const usernameClass = 'comment-username' + (comment.verified === false ? ' username-unverified' : '');

    const entry = el('div', { className: entryClass },
      el('span', { className: 'comment-platform-tag ' + (platformObj?.cssClass || '') }, platformObj?.shortName || '?'),
      el('span', { className: usernameClass }, '@' + (comment.username || 'unknown')),
      el('span', { className: 'comment-text' }, comment.text || ''),
      el('span', { className: 'comment-time' }, formatTime(comment.timestamp || Date.now()))
    );

    commentStreamList.insertBefore(entry, commentStreamList.firstChild);

    // Cap at MAX_COMMENTS
    const entries = commentStreamList.querySelectorAll('.comment-entry');
    if (entries.length > MAX_COMMENTS) entries[entries.length - 1].remove();
  });

  // ── Comment stream toggle ──
  const commentsBtn = document.getElementById('btn-comments');
  commentsBtn.addEventListener('click', () => {
    commentStreamSection.classList.toggle('stream-hidden');
    commentsBtn.classList.toggle('active');
  });

  // ── Facebook login ──
  const fbLoginBtn = document.getElementById('btn-fb-login');
  const fbLoginStatus = document.getElementById('fb-login-status');

  // ── Facebook Remote Login (streamed headless browser) ──
  let fbLoginWindow = null;

  fbLoginBtn.addEventListener('click', () => {
    fbLoginBtn.textContent = 'Starting...';
    fbLoginBtn.disabled = true;
    wsClient.send({ type: 'fb-login' });
  });

  wsClient.onFbLogin((msg) => {
    if (msg.type === 'fb-login-result') {
      fbLoginBtn.disabled = false;
      if (msg.success && msg.screenshot) {
        // Login page loaded — open popup with the screenshot
        fbLoginBtn.textContent = 'Logging in...';
        openFbLoginPopup(msg.screenshot);
      } else if (msg.success && msg.status === 'login-started') {
        // Backwards compat
        fbLoginBtn.textContent = 'Logging in...';
      } else {
        fbLoginBtn.textContent = 'Login to Facebook';
        fbLoginStatus.textContent = 'Login failed: ' + (msg.error || 'unknown');
        fbLoginStatus.className = 'conn-hint status-warn';
        renderer.showToast('FB login failed: ' + (msg.error || ''), 'error');
      }
    } else if (msg.type === 'fb-login-update') {
      if (msg.loggedIn) {
        // Login successful!
        if (fbLoginWindow && !fbLoginWindow.closed) fbLoginWindow.close();
        fbLoginBtn.textContent = 'Logged In';
        fbLoginBtn.classList.add('logged-in');
        fbLoginBtn.disabled = false;
        fbLoginStatus.textContent = 'Logged in — usernames will be scraped automatically';
        fbLoginStatus.className = 'conn-hint status-ok';
        renderer.showToast('Facebook login successful!', 'success');
      } else if (msg.screenshot && fbLoginWindow && !fbLoginWindow.closed) {
        // Update the screenshot in the popup
        const img = fbLoginWindow.document.getElementById('fb-screen');
        if (img) img.src = 'data:image/jpeg;base64,' + msg.screenshot;
      } else if (msg.cancelled) {
        if (fbLoginWindow && !fbLoginWindow.closed) fbLoginWindow.close();
        fbLoginBtn.textContent = 'Login to Facebook';
        fbLoginBtn.disabled = false;
      } else if (msg.error) {
        renderer.showToast('FB login error: ' + msg.error, 'error');
      }
    } else if (msg.type === 'fb-login-status') {
      if (msg.loggedIn) {
        fbLoginBtn.textContent = 'Logged In';
        fbLoginBtn.classList.add('logged-in');
        fbLoginStatus.textContent = 'Session saved — usernames will be scraped automatically';
        fbLoginStatus.className = 'conn-hint status-ok';
      } else {
        fbLoginBtn.textContent = 'Login to Facebook';
        fbLoginStatus.textContent = 'Not logged in — Facebook bids will show as "Unverified"';
        fbLoginStatus.className = 'conn-hint status-warn';
      }
    }
  });

  function openFbLoginPopup(screenshotBase64) {
    fbLoginWindow = window.open('', 'FBLogin', 'width=820,height=640,resizable=yes,scrollbars=no');
    if (!fbLoginWindow) {
      renderer.showToast('Popup blocked — allow popups for this site', 'error');
      return;
    }
    const doc = fbLoginWindow.document;
    doc.title = 'Facebook Login';
    doc.body.style.cssText = 'margin:0;padding:0;background:#1a1a2e;display:flex;flex-direction:column;height:100vh;font-family:system-ui;';

    const header = doc.createElement('div');
    header.style.cssText = 'background:#1877F2;color:#fff;padding:8px 16px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';
    const title = doc.createElement('span');
    title.textContent = 'Facebook Login — click and type below';
    title.style.cssText = 'font-weight:700;font-size:14px;';
    const cancelBtn = doc.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'background:rgba(255,255,255,0.2);border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;';
    cancelBtn.onclick = () => { wsClient.send({ type: 'fb-login-cancel' }); fbLoginWindow.close(); fbLoginBtn.textContent = 'Login to Facebook'; fbLoginBtn.disabled = false; };
    header.appendChild(title);
    header.appendChild(cancelBtn);
    doc.body.appendChild(header);

    const img = doc.createElement('img');
    img.id = 'fb-screen';
    img.src = 'data:image/jpeg;base64,' + screenshotBase64;
    img.style.cssText = 'width:800px;height:600px;cursor:pointer;display:block;margin:0 auto;';

    // Click handler — send coordinates to server
    img.addEventListener('click', (e) => {
      const rect = img.getBoundingClientRect();
      const x = Math.round((e.clientX - rect.left) * (800 / rect.width));
      const y = Math.round((e.clientY - rect.top) * (600 / rect.height));
      wsClient.send({ type: 'fb-login-click', x, y });
    });

    doc.body.appendChild(img);

    // Keyboard handler — send typing to server
    doc.addEventListener('keydown', (e) => {
      e.preventDefault();
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Backspace' || e.key === 'Escape') {
        wsClient.send({ type: 'fb-login-key', key: e.key });
      } else if (e.key.length === 1) {
        wsClient.send({ type: 'fb-login-type', text: e.key });
      }
    });

    const hint = doc.createElement('div');
    hint.style.cssText = 'color:#fff;text-align:center;padding:10px;font-size:13px;flex-shrink:0;background:#1877F2;font-weight:600;';
    hint.textContent = 'THIS IS INTERACTIVE — Click the email field above, then type your login. Press Enter to submit.';
    doc.body.appendChild(hint);

    // Add pulsing border to indicate interactivity
    const pulseStyle = doc.createElement('style');
    pulseStyle.textContent = '@keyframes pulse-border { 0%,100% { border-color: #1877F2; } 50% { border-color: #ff6b35; } } #fb-screen { border: 3px solid #1877F2; animation: pulse-border 2s infinite; }';
    doc.head.appendChild(pulseStyle);
  }

  // Try to connect WebSocket
  const wsConnected = wsClient.connect();

  // ── Connection panel ──
  connPanel.init();

  // Request FB login status on connect
  setTimeout(() => { wsClient.fbLoginStatus(); }, 1000);

  // ── Disregard + Block handler — event delegation ──
  document.body.addEventListener('click', (e) => {
    // Disregard buttons
    const disregardBtn = e.target.closest('button[data-bid-id]');
    if (disregardBtn && (disregardBtn.classList.contains('feed-disregard-btn') ||
        disregardBtn.classList.contains('lb-disregard-btn') ||
        disregardBtn.classList.contains('next-bid-disregard'))) {
      const bidId = disregardBtn.dataset.bidId;
      const bid = state._allBids.find(b => b.id === bidId);
      if (!bid || state.isDisregarded(bidId)) return;

      state.disregardBid(bidId);
      renderer.markFeedEntryDisregarded(bidId);
      renderer.showToast('Bid disregarded: ' + formatCurrency(bid.amount) + ' from @' + bid.username, 'info');
      renderer.updateHeroBid(state.getHighestBid());
      renderer.updateNextBids(state.getNextBids());
      renderer.updateLeaderboard(state.getTopBids(10));
      return;
    }

    // Block user buttons
    const blockBtn = e.target.closest('.block-user-btn');
    if (blockBtn) {
      const platform = blockBtn.dataset.platform;
      const username = blockBtn.dataset.username;
      if (platform && username) {
        wsClient.blockUser(platform, username);
        renderer.showToast('Blocked @' + username, 'info');
      }
      return;
    }

    // Unblock buttons
    const unblockBtn = e.target.closest('.unblock-btn');
    if (unblockBtn) {
      const platform = unblockBtn.dataset.platform;
      const username = unblockBtn.dataset.username;
      if (platform && username) {
        wsClient.unblockUser(platform, username);
      }
      return;
    }
  });

  // ── New Auction button ──
  const confirmOverlay = document.getElementById('confirm-overlay');
  const confirmMessage = document.getElementById('confirm-message');

  document.getElementById('btn-new-auction').addEventListener('click', () => {
    confirmMessage.textContent = 'Clear all bids and start a new auction item?';
    confirmOverlay.classList.remove('hidden');
  });

  document.getElementById('confirm-yes').addEventListener('click', () => {
    confirmOverlay.classList.add('hidden');
    if (liveMode) {
      wsClient.newAuction();
    } else {
      state.reset();
      renderer.reset();
      if (demoMode) {
        simulator.reset();
        simulator.start();
      }
      renderer.showToast('New auction started!', 'success');
    }
  });

  document.getElementById('confirm-no').addEventListener('click', () => {
    confirmOverlay.classList.add('hidden');
  });

  // ── Demo mode toggle ──
  document.getElementById('btn-demo').addEventListener('click', () => {
    if (demoMode) {
      simulator.stop();
      demoMode = false;
      document.getElementById('btn-demo').textContent = 'Start Demo';
    } else {
      simulator.start();
      demoMode = true;
      document.getElementById('btn-demo').textContent = 'Stop Demo';
    }
  });

  // ── Pause / Resume ──
  const pauseBtn = document.getElementById('btn-pause');
  let paused = false;
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    if (paused) {
      if (demoMode) simulator.stop();
      pauseBtn.textContent = 'Resume';
    } else {
      if (demoMode) simulator.start();
      pauseBtn.textContent = 'Pause';
    }
  });

  // ── Reset ──
  document.getElementById('btn-reset').addEventListener('click', () => {
    simulator.reset();
    state.reset();
    renderer.reset();
    paused = false;
    pauseBtn.textContent = 'Pause';
    if (demoMode) simulator.start();
  });

  // ── Bid Overlay (separate popup window for screen sharing / OBS) ──
  let overlayWindow = null;

  document.getElementById('btn-overlay').addEventListener('click', () => {
    // Open a separate browser window — user can share just this window
    if (overlayWindow && !overlayWindow.closed) {
      overlayWindow.focus();
      return;
    }
    overlayWindow = window.open('', 'BidOverlay', 'width=450,height=400,resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=no,status=no');
    if (!overlayWindow) {
      renderer.showToast('Popup blocked — allow popups for this site', 'error');
      return;
    }
    writeOverlayHTML(overlayWindow);
    updateOverlay();
  });

  function writeOverlayHTML(win) {
    const doc = win.document;
    doc.title = 'Live Auction — Bid Overlay';
    doc.documentElement.style.cssText = 'margin:0;padding:0;height:100%;';
    doc.body.style.cssText = 'margin:0;padding:0;height:100%;font-family:Inter,system-ui,sans-serif;background:#0d1117;color:#e6edf3;overflow:hidden;';
    doc.body.textContent = ''; // clear safely

    const style = doc.createElement('style');
    style.textContent = [
      '* { box-sizing: border-box; }',
      '#overlay-wrap { height:100vh; display:flex; flex-direction:column; }',
      '#o-header { background:linear-gradient(135deg,#ff6b35,#f7931e); padding:10px 16px; display:flex; justify-content:space-between; align-items:center; }',
      '#o-title { font-size:0.85rem; font-weight:800; letter-spacing:2px; color:#fff; }',
      '#o-hero { text-align:center; padding:20px 16px 12px; border-bottom:1px solid #21262d; flex-shrink:0; }',
      '#o-hero-label { font-size:0.65rem; letter-spacing:2px; color:#8b949e; margin-bottom:4px; }',
      '#o-hero-amount { font-size:3rem; font-weight:800; color:#3fb950; line-height:1.1; text-shadow:0 0 30px rgba(63,185,80,0.3); }',
      '#o-hero-meta { display:flex; justify-content:center; gap:10px; margin-top:6px; font-size:0.9rem; }',
      '#o-hero-user { font-weight:600; }',
      '#o-hero-plat { font-size:0.75rem; padding:2px 8px; border-radius:4px; background:#161b22; color:#8b949e; }',
      '#o-runners { padding:10px 16px; flex:1; }',
      '#o-runners-label { font-size:0.6rem; letter-spacing:2px; color:#8b949e; margin-bottom:6px; }',
      '.o-runner { display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:6px; margin-bottom:4px; background:#161b22; font-size:0.85rem; }',
      '.o-rank { color:#8b949e; font-weight:700; min-width:24px; }',
      '.o-plat { font-size:0.65rem; font-weight:700; padding:2px 5px; border-radius:3px; color:#fff; }',
      '.o-user { flex:1; color:#8b949e; }',
      '.o-amt { font-weight:700; color:#e6edf3; }',
      '.plat-fb { background:#1877F2; }',
      '.plat-ig { background:#E4405F; }',
      '.plat-yt { background:#FF0000; }',
      '.plat-tt { background:#69C9D0; color:#000; }',
      '.plat-tw { background:#9146FF; }',
      '.plat-x { background:#1DA1F2; }',
    ].join('\n');
    doc.head.appendChild(style);

    const wrap = doc.createElement('div');
    wrap.id = 'overlay-wrap';
    const headerDiv = createEl(doc, 'div', 'o-header');
    headerDiv.appendChild(createEl(doc, 'span', 'o-title', null, 'LIVE AUCTION'));
    wrap.appendChild(headerDiv);
    const hero = doc.createElement('div');
    hero.id = 'o-hero';
    const heroLabel = doc.createElement('div');
    heroLabel.id = 'o-hero-label';
    heroLabel.textContent = 'HIGHEST BID';
    hero.appendChild(heroLabel);
    const heroAmt = doc.createElement('div');
    heroAmt.id = 'o-hero-amount';
    heroAmt.textContent = '\u2014';
    hero.appendChild(heroAmt);
    const meta = doc.createElement('div');
    meta.id = 'o-hero-meta';
    const heroUser = doc.createElement('span');
    heroUser.id = 'o-hero-user';
    meta.appendChild(heroUser);
    const heroPlat = doc.createElement('span');
    heroPlat.id = 'o-hero-plat';
    meta.appendChild(heroPlat);
    hero.appendChild(meta);
    wrap.appendChild(hero);

    const runners = doc.createElement('div');
    runners.id = 'o-runners';
    const runnersLabel = doc.createElement('div');
    runnersLabel.id = 'o-runners-label';
    runnersLabel.textContent = 'NEXT BIDS';
    runners.appendChild(runnersLabel);
    for (let i = 1; i <= 3; i++) {
      const r = doc.createElement('div');
      r.id = 'o-runner-' + i;
      r.className = 'o-runner';
      runners.appendChild(r);
    }
    wrap.appendChild(runners);
    doc.body.appendChild(wrap);
  }

  function createEl(doc, tag, id, className, text) {
    const node = doc.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function updateOverlay() {
    if (!overlayWindow || overlayWindow.closed) return;
    const doc = overlayWindow.document;

    const highest = state.getHighestBid();
    const heroAmt = doc.getElementById('o-hero-amount');
    const heroUser = doc.getElementById('o-hero-user');
    const heroPlat = doc.getElementById('o-hero-plat');
    if (!heroAmt) return; // window not ready yet

    if (highest) {
      heroAmt.textContent = formatCurrency(highest.amount);
      heroUser.textContent = '@' + highest.username;
      heroPlat.textContent = highest.platform.name || '';
      heroPlat.className = 'o-plat ' + (highest.platform.cssClass || '');
    } else {
      heroAmt.textContent = '\u2014';
      heroUser.textContent = 'Waiting for bids...';
      heroPlat.textContent = '';
    }

    const nextBids = state.getNextBids();
    for (let i = 0; i < 3; i++) {
      const runner = doc.getElementById('o-runner-' + (i + 1));
      if (!runner) continue;
      while (runner.firstChild) runner.removeChild(runner.firstChild);
      if (i < nextBids.length) {
        const bid = nextBids[i];
        runner.style.display = '';
        const rank = doc.createElement('span'); rank.className = 'o-rank'; rank.textContent = '#' + (i + 2);
        const plat = doc.createElement('span'); plat.className = 'o-plat ' + (bid.platform.cssClass || ''); plat.textContent = bid.platform.shortName || '';
        const user = doc.createElement('span'); user.className = 'o-user'; user.textContent = '@' + bid.username;
        const amt = doc.createElement('span'); amt.className = 'o-amt'; amt.textContent = formatCurrency(bid.amount);
        runner.appendChild(rank); runner.appendChild(plat); runner.appendChild(user); runner.appendChild(amt);
      } else {
        runner.style.display = 'none';
      }
    }
  }

  // Hook overlay updates into the bid handler
  const origUpdateHero = renderer.updateHeroBid.bind(renderer);
  renderer.updateHeroBid = function(bid) {
    origUpdateHero(bid);
    updateOverlay();
  };

  // If no WebSocket (opened as file://), start demo by default
  if (!wsConnected) {
    simulator.start();
    demoMode = true;
    document.getElementById('btn-demo').textContent = 'Stop Demo';
  }
}

document.addEventListener('DOMContentLoaded', init);
