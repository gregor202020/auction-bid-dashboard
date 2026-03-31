# Auction Bid Dashboard — Project Specification

**Version**: 1.0
**Last Updated**: 2026-04-01
**Status**: Production Ready

## Executive Summary

Live Auction Bid Aggregator is a real-time bidding dashboard that collects bids from live streams across YouTube, Facebook, Instagram, and TikTok. It aggregates bids, filters spam, manages user blocklists, and streams results to connected browsers via WebSocket.

**Use Case**: Auction hosts broadcast live streams while accepting verbal bids in comments. This system automatically parses, validates, and displays the highest bids in real-time.

## Architecture

### High-Level Flow
```
Live Stream Comment → Platform Poller → Bid Parser → Spam Filter →
Auction Manager → WebSocket Broadcast → Browser Dashboard
```

### Tech Stack
- **Backend**: Node.js 18+ (ES modules), Express.js, ws (WebSocket)
- **Frontend**: Vanilla JavaScript (no framework), CSS Grid + Flexbox
- **External APIs**:
  - YouTube Data API v3
  - Facebook Graph API
  - Instagram Graph API
  - TikTok Live (via tiktok-live-connector npm)
  - Puppeteer (headless browser for Facebook login)

### Component Breakdown

#### 1. **Server (server.js)**
- Express app serving `public/` directory
- WebSocket server on same HTTP server
- REST API endpoints for platform management
- Environment variable validation
- DoS protection: 4KB body limit, 16KB WebSocket payload limit

**Key Routes**:
- `POST /api/connect` — Connect to a platform
- `POST /api/disconnect` — Disconnect a platform
- `POST /api/new-auction` — Clear all bids, start fresh auction
- `GET /api/status` — Get current system status
- `POST /api/block-user` — Add user to blocklist
- `POST /api/unblock-user` — Remove from blocklist

#### 2. **Auction Manager (lib/auction-manager.js)**
Central orchestrator that:
- Manages platform pollers (YouTube, Facebook, Instagram, TikTok)
- Routes incoming comments to handlers
- Maintains auction state (highest bid, bid count, platform counts)
- Controls spam filter
- Broadcasts WebSocket messages to all connected clients

**State**:
```javascript
{
  _bidCount: number,
  _highestBid: { id, platform, username, verified, amount, rawText, confidence, timestamp },
  _platformCounts: { yt, fb, ig, tt },
  _youtube: YouTubeLivePoller | null,
  _facebook: FacebookLivePoller | null,
  _instagram: InstagramLivePoller | null,
  _tiktok: TikTokLiveListener | null,
  _fbScraper: FbBrowserScraper | null,
  spamFilter: SpamFilter
}
```

#### 3. **Platform Pollers**
Each platform has its own poller that:
1. Connects to platform using provided credentials/identifiers
2. Polls comments at platform-appropriate intervals
3. Extracts username, comment text, verification status
4. Calls `_handleComment()` callback

**Platform-Specific Details**:

| Platform | Method | Frequency | Auth | Notes |
|----------|--------|-----------|------|-------|
| YouTube | API v3 | 1-2s polling | API Key | Returns verified channel info |
| Facebook | Graph API + Puppeteer | 2-3s + browser | Token + Browser | Fallback to browser scraper for missing usernames |
| Instagram | Graph API | 3-5s polling | Token + User ID | Requires Business Discovery API enabled |
| TikTok | tiktok-live-connector | Real-time WebSocket | None | Connects directly to TikTok servers |

#### 4. **Bid Parser (lib/bid-parser.js)**
Extracts bid amounts from comment text using multiple strategies:

**Parsing Strategies** (in order):
1. Explicit format: `$500`, `500$`, `USD 500`
2. Word format: `five hundred`, `15k`, `1.5k`
3. Marker format: `BID 500`, `OFFER 500`
4. Plain number: `500` (if context suggests it's a bid)

**Output**:
```javascript
{
  amount: number,        // Bid amount in USD
  confidence: 'high' | 'medium' | 'low',
  rawText: string        // Original text extracted
}
```

**Validation Rules**:
- Minimum bid: $5 (or $1 if already have bids)
- Maximum bid: $999,999
- Rejects: 0, negative, NaN, too large

#### 5. **Spam Filter (lib/spam-filter.js)**
4-layer filtering system:

**Layer 1: Threshold Filtering**
- Below minimum bid → rejected
- Above maximum bid → rejected
- Jump cap check: bid amount > 50× highest existing bid → rejected

**Layer 2: Duplicate Detection**
- Same user + same amount within 10 seconds → rejected
- Prevents comment reposting spam

**Layer 3: Manual Blocklist**
- Per-platform user blocklist
- Format: `{ platform: Set(usernames) }`

**Layer 4: Verification Status**
- Tracks if comment is from verified account
- Allows filtering or flagging of unverified bids

**Settings**:
```javascript
{
  minBid: 1,            // Minimum allowed bid
  maxBid: 999999,       // Maximum allowed bid
  jumpMultiplier: 50    // Max ratio to highest bid
}
```

#### 6. **Frontend (public/)**

**index.html**: Dashboard structure
- Header with controls (New Auction, Overlay, Comments toggle, Settings, Pause, Reset)
- Connection panel (platform inputs, filter settings, blocked users list, Facebook login)
- Main panel: Hero bid section, Next 3 bids, Live feed, Comment stream
- Right panel: Top bids leaderboard
- Status bar showing platform connection status

**app.js**: Frontend logic
- WebSocket connection to server
- Message handlers for bids, comments, platform status
- UI updates (real-time bid rendering, leaderboard sorting)
- Filter application (min/max bid, jump cap)
- Demo mode (generates fake bids)
- Bid overlay window (for screen sharing)

**styles.css**: Dashboard styling
- Dark theme optimized for live streaming
- Responsive grid layout
- Hero bid section (large, prominent)
- Live feed scrolling
- Leaderboard with platform badges

## Data Structures

### Comment Object (from poller)
```javascript
{
  id: string,                    // Platform-specific ID
  platform: 'yt' | 'fb' | 'ig' | 'tt',
  username: string,              // Display name
  text: string,                  // Full comment text
  verified: boolean,             // Is verified account
  timestamp: number              // Unix timestamp (ms)
}
```

### Bid Object (after parsing)
```javascript
{
  id: string,                    // comment.id
  platform: 'yt' | 'fb' | 'ig' | 'tt',
  username: string,
  verified: boolean,
  amount: number,                // In USD
  rawText: string,               // Extracted bid text
  confidence: number,            // 0.0-1.0
  timestamp: number
}
```

### WebSocket Messages

**Client → Server**:
```javascript
{ type: 'connect-platform', platform: string, identifier: string }
{ type: 'disconnect-platform', platform: string }
{ type: 'new-auction' }
{ type: 'block-user', platform: string, username: string }
{ type: 'unblock-user', platform: string, username: string }
{ type: 'update-filter', settings: { minBid, maxBid, jumpMultiplier } }
{ type: 'get-status' }
{ type: 'fb-login' }
{ type: 'fb-login-click', x: number, y: number }
{ type: 'fb-login-type', text: string }
{ type: 'fb-login-key', key: string }
{ type: 'fb-login-cancel' }
```

**Server → Client**:
```javascript
{ type: 'new-bid', bid: Bid }
{ type: 'bid-filtered', bid: Bid, reason: string }
{ type: 'new-comment', comment: Comment }
{ type: 'platform-connected', platform: string, identifier: string }
{ type: 'platform-disconnected', platform: string }
{ type: 'platform-error', platform: string, error: string }
{ type: 'new-auction' }
{ type: 'user-blocked', platform: string, username: string, blockedUsers: Map }
{ type: 'user-unblocked', platform: string, username: string, blockedUsers: Map }
{ type: 'filter-updated', settings: { minBid, maxBid, jumpMultiplier } }
{ type: 'status', platforms: {...}, bidCount: number, highestBid: Bid, topBids: Bid[], recentBids: Bid[], recentComments: Comment[], ... }
{ type: 'fb-login-result' | 'fb-login-status' | 'fb-login-update', loggedIn: boolean, screenshot?: string, ... }
```

## Configuration

### Environment Variables (`.env`)

**Required for YouTube**:
```
YOUTUBE_API_KEY=YOUR_KEY
```

**Required for Facebook/Instagram**:
```
META_ACCESS_TOKEN=YOUR_TOKEN
FACEBOOK_PAGE_ID=XXXXXX
INSTAGRAM_USER_ID=XXXXXX
```

**Optional**:
```
AUCTION_PORT=3069                    # Default: 3069
NODE_ENV=production                  # Default: development
```

### Startup Configuration
- Load `.env` from this repo only
- Environment variables can also be provided by the host process
- Log warnings for missing API keys

## Deployment

### Local Development
```bash
npm install
cp .env.example .env
# Add your API credentials to .env
npm start
# Navigate to http://localhost:3069
```

### Production (VPS/Docker)
```bash
npm install --production
NODE_ENV=production npm start
# Runs on configured AUCTION_PORT (default 3069)
# Behind nginx reverse proxy on port 80/443
```

### Environment Requirements
- Node.js 18.0+
- npm 8.0+
- Port 3069 available (or configured AUCTION_PORT)
- Internet access to platform APIs
- Puppeteer dependencies for headless browser (Firefox/Chrome)

## Testing & Quality

### Test Coverage (as of 2026-04-01)
- ✅ Smoke Test: Startup, module resolution, env vars
- ✅ Static Analysis: No dead code, proper scoping, import correctness
- ✅ Dynamic Testing: 56 bid parser tests, 8 spam filter tests
- ✅ Integration: Data flow end-to-end, platform connections
- ✅ Security: Input validation, DoS protection, no secret leakage
- ✅ E2E: Happy paths, error handling, concurrent operations

### Known Limitations
1. **Facebook User Scraping**: Requires Puppeteer + Facebook login. May fail if Facebook changes UI or enables bot detection.
2. **API Rate Limits**: YouTube (100 reqs/day for development), TikTok (no official API, uses reverse engineering)
3. **Comment Parsing**: Heuristic-based; may not catch all bid formats or regional variations
4. **Verification Status**: YouTube verified, Facebook graph API, TikTok inherent; Instagram limited

## Future Enhancements

### Phase 2 (Planned)
- Persistent bid history to database
- Bid analytics (trends, peak times, platform performance)
- Email/SMS alerts for high bids
- Mobile app (React Native)
- Auctioneer role (bid confirmation/denial)

### Phase 3 (Research)
- ML model for bid prediction
- Multi-auction concurrent support
- Seller dashboard (analytics, insights)
- Integration with payment systems

## Support & Debugging

### Common Issues
1. **"No API key" warning but still trying to use platform**
   - Check `.env` file has correct key
   - Restart server after changing credentials

2. **Comments not appearing**
   - Verify live stream is actively receiving comments
   - Check platform status bar shows "connected"
   - Review server logs for API errors

3. **Facebook login stuck**
   - Browser scraper may have crashed; click "Cancel"
   - Check Puppeteer process status

### Monitoring
- Server logs show all connections/disconnections
- Status bar shows platform connection status
- WebSocket message count in browser console

## Project Ownership
- **Author**: Greg
- **GitHub**: [gregor202020/auction-bid-dashboard](https://github.com/gregor202020/auction-bid-dashboard)
- **Last Audit**: 2026-04-01 (5-phase comprehensive testing)
