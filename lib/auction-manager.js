/**
 * Auction Manager — orchestrates platform connections, bid parsing,
 * spam filtering, and WebSocket broadcasting.
 */

import { parseBid } from './bid-parser.js';
import { SpamFilter } from './spam-filter.js';
import { YouTubeLivePoller } from './youtube-live.js';
import { FacebookLivePoller } from './facebook-live.js';
import { InstagramLivePoller } from './instagram-live.js';
import { TikTokLiveListener } from './tiktok-live.js';
import { FbBrowserScraper } from './fb-browser-scraper.js';

// Map full platform names to short codes used by pollers
const PLATFORM_SHORT = { youtube: 'yt', facebook: 'fb', instagram: 'ig', tiktok: 'tt' };

export class AuctionManager {
  /**
   * @param {{ youtubeApiKey: string, metaAccessToken: string }} credentials
   * @param {(message: object) => void} broadcast - sends message to all WS clients
   */
  constructor(credentials, broadcast) {
    this.credentials = credentials;
    this.broadcast = broadcast;
    this.spamFilter = new SpamFilter();

    // Platform connectors
    this._youtube = null;
    this._facebook = null;
    this._instagram = null;
    this._tiktok = null;
    this._fbScraper = null;

    // Auction state
    this._bidCount = 0;
    this._highestBid = null;
    this._platformCounts = { yt: 0, fb: 0, ig: 0, tt: 0 };
    this._recentBids = [];
    this._recentComments = [];
    this._topBids = [];
  }

  _broadcastPlatformState(platform, update) {
    if (!update) return;

    if (update.error) {
      this.broadcast({
        type: 'platform-error',
        platform,
        error: update.error,
      });
      return;
    }

    if (update.connected === true) {
      this.broadcast({ type: 'platform-connected', platform });
      return;
    }

    if (update.connected === false) {
      this.broadcast({ type: 'platform-disconnected', platform });
    }
  }

  /**
   * Handle an incoming comment from any platform.
   * Parses bid, filters spam, broadcasts if valid.
   */
  _handleComment(comment) {
    const normalizedComment = {
      ...comment,
      timestamp: comment.timestamp || Date.now(),
      verified: comment.verified !== false,
    };

    this._rememberComment(normalizedComment);

    // Broadcast ALL comments to frontend (for comment stream)
    this.broadcast({ type: 'new-comment', comment: normalizedComment });

    // Parse bid from comment text
    const parsed = parseBid(normalizedComment.text);
    if (!parsed) return; // Not a bid

    // Build bid object
    const bid = {
      id: normalizedComment.id,
      platform: normalizedComment.platform,
      username: normalizedComment.username,
      verified: normalizedComment.verified,
      amount: parsed.amount,
      rawText: parsed.rawText,
      confidence: parsed.confidence,
      timestamp: normalizedComment.timestamp,
    };

    // Run through spam filter
    const filterResult = this.spamFilter.check(bid);
    if (!filterResult.allowed) {
      // Broadcast filtered notification (so frontend can show it if wanted)
      this.broadcast({
        type: 'bid-filtered',
        bid,
        reason: filterResult.reason,
      });
      return;
    }

    // Update state
    this._bidCount++;
    this._platformCounts[bid.platform] = (this._platformCounts[bid.platform] || 0) + 1;
    this._rememberBid(bid);

    if (!this._highestBid || bid.amount > this._highestBid.amount) {
      this._highestBid = bid;
      this.spamFilter.currentHighest = bid.amount;
    }

    // Broadcast valid bid
    this.broadcast({
      type: 'new-bid',
      bid,
    });
  }

  _rememberComment(comment) {
    this._recentComments.push(comment);
    if (this._recentComments.length > 100) {
      this._recentComments.splice(0, this._recentComments.length - 100);
    }
  }

  _rememberBid(bid) {
    this._recentBids.push(bid);
    if (this._recentBids.length > 250) {
      this._recentBids.splice(0, this._recentBids.length - 250);
    }

    this._topBids = [...this._topBids, bid]
      .sort((a, b) => b.amount - a.amount || (a.timestamp || 0) - (b.timestamp || 0))
      .slice(0, 25);
  }

  _getTopBids(limit = 10) {
    return [...this._topBids]
      .sort((a, b) => b.amount - a.amount || a.timestamp - b.timestamp)
      .slice(0, limit);
  }

  /**
   * Connect to a platform.
   * @param {string} platform - 'youtube' | 'facebook' | 'instagram' | 'tiktok'
   * @param {string} identifier - video ID, media ID, or username
   */
  async connect(platform, identifier, originalIdentifier = identifier) {
    try {
      switch (platform) {
        case 'youtube': {
          if (this._youtube) this._youtube.disconnect();
          this._youtube = new YouTubeLivePoller(
            this.credentials.youtubeApiKey,
            (comment) => this._handleComment(comment),
            (update) => this._broadcastPlatformState('youtube', update)
          );
          await this._youtube.connect(identifier);
          break;
        }
        case 'facebook': {
          if (this._facebook) this._facebook.disconnect();
          // Start browser scraper for username enrichment (if cookies available)
          if (!this._fbScraper) {
            this._fbScraper = new FbBrowserScraper();
          }
          this._facebook = new FacebookLivePoller(
            this.credentials.metaAccessToken,
            (comment) => this._handleComment(comment),
            this._fbScraper,
            (update) => this._broadcastPlatformState('facebook', update)
          );
          await this._facebook.connect(identifier, originalIdentifier);
          break;
        }
        case 'instagram': {
          if (this._instagram) this._instagram.disconnect();
          this._instagram = new InstagramLivePoller(
            this.credentials.metaAccessToken,
            (comment) => this._handleComment(comment),
            this.credentials.igUserId, // Pass pre-configured IG User ID
            (update) => this._broadcastPlatformState('instagram', update)
          );
          await this._instagram.connect(identifier);
          break;
        }
        case 'tiktok': {
          if (this._tiktok) this._tiktok.disconnect();
          this._tiktok = new TikTokLiveListener(
            (comment) => this._handleComment(comment),
            (connected) => this._broadcastPlatformState('tiktok', { connected })
          );
          await this._tiktok.connect(identifier);
          break;
        }
        default:
          throw new Error(`Unknown platform: ${platform}`);
      }

      this.broadcast({
        type: 'platform-connected',
        platform,
        identifier,
      });

      return { success: true };
    } catch (err) {
      this.broadcast({
        type: 'platform-error',
        platform,
        error: err.message,
      });
      return { success: false, error: err.message };
    }
  }

  /**
   * Disconnect a specific platform.
   */
  disconnect(platform) {
    switch (platform) {
      case 'youtube':
        if (this._youtube) { this._youtube.disconnect(); this._youtube = null; }
        break;
      case 'facebook':
        if (this._facebook) { this._facebook.disconnect(); this._facebook = null; }
        break;
      case 'instagram':
        if (this._instagram) { this._instagram.disconnect(); this._instagram = null; }
        break;
      case 'tiktok':
        if (this._tiktok) { this._tiktok.disconnect(); this._tiktok = null; }
        break;
    }
    this.broadcast({ type: 'platform-disconnected', platform });
  }

  /**
   * Disconnect all platforms.
   */
  disconnectAll() {
    for (const p of ['youtube', 'facebook', 'instagram', 'tiktok']) {
      this.disconnect(p);
    }
  }

  /**
   * Start a new auction — clear bids but keep platform connections active.
   */
  newAuction() {
    this._bidCount = 0;
    this._highestBid = null;
    this._platformCounts = { yt: 0, fb: 0, ig: 0, tt: 0 };
    this._recentBids = [];
    this._recentComments = [];
    this._topBids = [];
    this.spamFilter.reset();
    this.spamFilter.currentHighest = 0;

    this.broadcast({ type: 'new-auction' });
  }

  /**
   * Block a user.
   */
  blockUser(platform, username) {
    if (!platform || !username) return;
    // Normalize: WS/REST sends 'youtube' but bids use 'yt'
    const shortPlatform = PLATFORM_SHORT[platform] || platform;
    this.spamFilter.blockUser(shortPlatform, username);
    this.broadcast({
      type: 'user-blocked',
      platform: shortPlatform,
      username,
      blockedUsers: this.spamFilter.getBlockedUsers(),
    });
  }

  /**
   * Unblock a user.
   */
  unblockUser(platform, username) {
    if (!platform || !username) return;
    const shortPlatform = PLATFORM_SHORT[platform] || platform;
    this.spamFilter.unblockUser(shortPlatform, username);
    this.broadcast({
      type: 'user-unblocked',
      platform: shortPlatform,
      username,
      blockedUsers: this.spamFilter.getBlockedUsers(),
    });
  }

  /**
   * Update spam filter settings.
   */
  /**
   * Start Facebook login flow — launches remote headless browser.
   */
  async fbLogin() {
    if (!this._fbScraper) this._fbScraper = new FbBrowserScraper();
    return await this._fbScraper.startLoginFlow();
  }

  async fbLoginClick(x, y) {
    if (!this._fbScraper) return { error: 'No scraper' };
    return await this._fbScraper.loginClick(x, y);
  }

  async fbLoginType(text) {
    if (!this._fbScraper) return { error: 'No scraper' };
    return await this._fbScraper.loginType(text);
  }

  async fbLoginKeyPress(key) {
    if (!this._fbScraper) return { error: 'No scraper' };
    return await this._fbScraper.loginKeyPress(key);
  }

  async fbLoginScreenshot() {
    if (!this._fbScraper) return { error: 'No scraper' };
    return await this._fbScraper.loginScreenshot();
  }

  async fbLoginCancel() {
    if (!this._fbScraper) return { success: true };
    return await this._fbScraper.cancelLogin();
  }

  getFbLoginStatus() {
    if (!this._fbScraper) this._fbScraper = new FbBrowserScraper();
    return this._fbScraper.getLoginStatus();
  }

  updateFilterSettings(settings) {
    this.spamFilter.updateSettings(settings);
    this.broadcast({
      type: 'filter-updated',
      settings: {
        minBid: this.spamFilter.minBid,
        maxBid: this.spamFilter.maxBid,
        jumpMultiplier: this.spamFilter.jumpMultiplier,
      },
    });
  }

  /**
   * Get current status.
   */
  getStatus() {
    return {
      platforms: {
        youtube: this._youtube?.isConnected() || false,
        facebook: this._facebook?.isConnected() || false,
        instagram: this._instagram?.isConnected() || false,
        tiktok: this._tiktok?.isConnected() || false,
      },
      bidCount: this._bidCount,
      highestBid: this._highestBid,
      platformCounts: { ...this._platformCounts },
      blockedUsers: this.spamFilter.getBlockedUsers(),
      filterSettings: {
        minBid: this.spamFilter.minBid,
        maxBid: this.spamFilter.maxBid,
        jumpMultiplier: this.spamFilter.jumpMultiplier,
      },
      recentBids: this._recentBids.slice(-50),
      topBids: this._getTopBids(10),
      recentComments: this._recentComments.slice(-50),
    };
  }
}
