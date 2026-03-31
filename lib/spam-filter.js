/**
 * Spam Filter — three layers of bid spam protection.
 *
 * Layer 1: Automatic thresholds (min/max, jump cap, duplicates)
 * Layer 2: Manual disregard (handled in frontend — already built)
 * Layer 3: User block list (in-memory, per-session)
 */

export class SpamFilter {
  constructor(options = {}) {
    this.minBid = options.minBid ?? 1;
    this.maxBid = options.maxBid ?? 999999;
    this.jumpMultiplier = options.jumpMultiplier ?? 50; // flag bids >50x current highest (was 10x — too aggressive for varied auction items)
    this.duplicateWindowMs = options.duplicateWindowMs ?? 10000; // 10 seconds (reduced from 30s — in fast auctions, same-amount bids 10s+ apart are valid)

    /** @type {Set<string>} blocked usernames (lowercase) */
    this._blockedUsers = new Set();

    /** @type {Map<string, { amount: number, timestamp: number }>} recent bids per user */
    this._recentBids = new Map();

    /** Current highest bid amount — updated externally */
    this.currentHighest = 0;
  }

  /**
   * Update filter settings.
   */
  updateSettings(settings) {
    if (settings.minBid !== undefined) {
      const v = Number(settings.minBid);
      if (Number.isFinite(v) && v >= 0) this.minBid = v;
    }
    if (settings.maxBid !== undefined) {
      const v = Number(settings.maxBid);
      if (Number.isFinite(v) && v > 0) this.maxBid = v;
    }
    if (settings.jumpMultiplier !== undefined) {
      const v = Number(settings.jumpMultiplier);
      if (Number.isFinite(v) && v >= 2) this.jumpMultiplier = v;
    }
  }

  /**
   * Check if a bid should be allowed.
   * @param {{ amount: number, username: string, platform: string, timestamp: number }} bid
   * @returns {{ allowed: boolean, reason?: string }}
   */
  check(bid) {
    const userKey = `${bid.platform}:${(bid.username || '').toLowerCase()}`;

    // Layer 3: Blocked user
    if (this._blockedUsers.has(userKey)) {
      return { allowed: false, reason: 'User is blocked' };
    }

    // Layer 1a: Min threshold
    if (bid.amount < this.minBid) {
      return { allowed: false, reason: `Below minimum bid ($${this.minBid})` };
    }

    // Layer 1b: Max threshold
    if (bid.amount > this.maxBid) {
      return { allowed: false, reason: `Exceeds maximum bid ($${this.maxBid})` };
    }

    // Layer 1c: Jump bid detection
    if (this.currentHighest > 0 && bid.amount > this.currentHighest * this.jumpMultiplier) {
      return { allowed: false, reason: `Suspicious jump bid (>${this.jumpMultiplier}x current highest)` };
    }

    // Layer 1d: Duplicate detection (same user, same amount, within window)
    const recentKey = userKey;
    const recent = this._recentBids.get(recentKey);
    if (recent && recent.amount === bid.amount && (bid.timestamp - recent.timestamp) < this.duplicateWindowMs) {
      return { allowed: false, reason: `Duplicate bid (same amount within ${this.duplicateWindowMs / 1000}s)` };
    }

    // Record this bid for future duplicate checks
    this._recentBids.set(recentKey, { amount: bid.amount, timestamp: bid.timestamp });

    // Prune old entries periodically
    if (this._recentBids.size > 500) {
      this._pruneRecent(bid.timestamp);
    }

    return { allowed: true };
  }

  /**
   * Block a user from bidding.
   */
  blockUser(platform, username) {
    const key = `${platform}:${(username || '').toLowerCase()}`;
    this._blockedUsers.add(key);
  }

  /**
   * Unblock a user.
   */
  unblockUser(platform, username) {
    const key = `${platform}:${(username || '').toLowerCase()}`;
    this._blockedUsers.delete(key);
  }

  /**
   * Get list of blocked users.
   */
  getBlockedUsers() {
    return [...this._blockedUsers].map(key => {
      const idx = key.indexOf(':');
      return { platform: key.slice(0, idx), username: key.slice(idx + 1) };
    });
  }

  /**
   * Clear all state (for new auction).
   */
  reset() {
    this._recentBids.clear();
    // NOTE: blocked users persist across auctions intentionally
  }

  /**
   * Full reset including blocked users.
   */
  fullReset() {
    this._recentBids.clear();
    this._blockedUsers.clear();
  }

  _pruneRecent(now) {
    for (const [key, val] of this._recentBids) {
      if (now - val.timestamp > this.duplicateWindowMs * 2) {
        this._recentBids.delete(key);
      }
    }
  }
}
