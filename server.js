/**
 * Auction Bid Dashboard — Server
 *
 * Express serves the static dashboard files from public/.
 * WebSocket server pushes real-time bids to connected browsers.
 * REST API controls platform connections and auction state.
 */

import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import { AuctionManager } from './lib/auction-manager.js';

// Load config only from this repo's local .env.
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const PORT = process.env.AUCTION_PORT || 3069;

// ── Express setup ─────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '4kb' })); // Limit body size to prevent DoS
// Serve only public/ directory — prevents source code exposure
app.use(express.static(join(__dirname, 'public')));

const httpServer = createServer(app);

// ── Clients set (declared before broadcast so closure is safe) ─
const clients = new Set();

// ── Initialize Auction Manager ────────────────────────────────
const credentials = {
  youtubeApiKey: process.env.AUCTION_YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY || '',
  metaAccessToken: process.env.META_ACCESS_TOKEN || '',
  igUserId: process.env.INSTAGRAM_USER_ID || '',
  fbPageId: process.env.FACEBOOK_PAGE_ID || '',
};

if (!credentials.youtubeApiKey) {
  console.warn('[WARN] AUCTION_YOUTUBE_API_KEY / YOUTUBE_API_KEY not set — YouTube integration disabled');
}
if (!credentials.metaAccessToken) console.warn('[WARN] META_ACCESS_TOKEN not set — Facebook/Instagram integration disabled');

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1) { // OPEN
      ws.send(payload);
    }
  }
}

const manager = new AuctionManager(credentials, broadcast);

// ── WebSocket setup ───────────────────────────────────────────
const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 16384, // 16KB max message size to prevent DoS
});

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (${clients.size} total)`);

  // Send current status on connect
  ws.send(JSON.stringify({ type: 'status', ...manager.getStatus() }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleClientMessage(ws, msg);
    } catch (err) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (${clients.size} total)`);
  });
});

/**
 * Safe send — checks readyState before sending.
 */
function safeSend(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

/**
 * Handle messages from WebSocket clients (alternative to REST API).
 */
function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'connect-platform':
      manager.connect(msg.platform, msg.identifier, msg.originalIdentifier).then(result => {
        safeSend(ws, { type: 'connect-result', platform: msg.platform, ...result });
      }).catch(err => {
        safeSend(ws, { type: 'connect-result', platform: msg.platform, success: false, error: err.message });
      });
      break;

    case 'disconnect-platform':
      manager.disconnect(msg.platform);
      break;

    case 'new-auction':
      manager.newAuction();
      break;

    case 'block-user':
      if (msg.platform && msg.username) {
        manager.blockUser(msg.platform, msg.username);
      }
      break;

    case 'unblock-user':
      if (msg.platform && msg.username) {
        manager.unblockUser(msg.platform, msg.username);
      }
      break;

    case 'update-filter':
      manager.updateFilterSettings(msg.settings || {});
      break;

    case 'get-status':
      safeSend(ws, { type: 'status', ...manager.getStatus() });
      break;

    case 'fb-login':
      manager.fbLogin().then(result => {
        safeSend(ws, { type: 'fb-login-result', ...result });
        if (result.loggedIn) {
          broadcast({ type: 'fb-login-status', ...manager.getFbLoginStatus() });
        }
      }).catch(err => {
        safeSend(ws, { type: 'fb-login-result', success: false, error: err.message });
      });
      break;

    case 'fb-login-click': {
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 2000 || y > 2000) {
        safeSend(ws, { type: 'fb-login-update', error: 'Invalid coordinates' });
        break;
      }
      manager.fbLoginClick(x, y).then(result => {
        safeSend(ws, { type: 'fb-login-update', ...result });
        if (result.loggedIn) {
          broadcast({ type: 'fb-login-status', loggedIn: true });
        }
      }).catch(err => {
        safeSend(ws, { type: 'fb-login-update', error: err.message });
      });
      break;
    }

    case 'fb-login-type':
      manager.fbLoginType(msg.text).then(result => {
        safeSend(ws, { type: 'fb-login-update', ...result });
        if (result.loggedIn) {
          broadcast({ type: 'fb-login-status', loggedIn: true });
        }
      }).catch(err => {
        safeSend(ws, { type: 'fb-login-update', error: err.message });
      });
      break;

    case 'fb-login-key':
      manager.fbLoginKeyPress(msg.key).then(result => {
        safeSend(ws, { type: 'fb-login-update', ...result });
        if (result.loggedIn) {
          broadcast({ type: 'fb-login-status', loggedIn: true });
        }
      }).catch(err => {
        safeSend(ws, { type: 'fb-login-update', error: err.message });
      });
      break;

    case 'fb-login-screenshot':
      manager.fbLoginScreenshot().then(result => {
        safeSend(ws, { type: 'fb-login-update', ...result });
        if (result.loggedIn) {
          broadcast({ type: 'fb-login-status', loggedIn: true });
        }
      }).catch(err => {
        safeSend(ws, { type: 'fb-login-update', error: err.message });
      });
      break;

    case 'fb-login-cancel':
      manager.fbLoginCancel().then(() => {
        safeSend(ws, { type: 'fb-login-update', cancelled: true });
      });
      break;

    case 'fb-login-status':
      safeSend(ws, { type: 'fb-login-status', ...manager.getFbLoginStatus() });
      break;

    default:
      safeSend(ws, { type: 'error', error: `Unknown message type: ${msg.type}` });
  }
}

// ── REST API (alternative to WebSocket messages) ──────────────
app.post('/api/connect', async (req, res) => {
  const { platform, identifier, originalIdentifier } = req.body;
  if (!platform || !identifier) {
    return res.status(400).json({ error: 'platform and identifier are required' });
  }
  const result = await manager.connect(platform, identifier, originalIdentifier);
  res.json(result);
});

app.post('/api/disconnect', (req, res) => {
  const { platform } = req.body;
  if (platform) {
    manager.disconnect(platform);
  } else {
    manager.disconnectAll();
  }
  res.json({ success: true });
});

app.post('/api/new-auction', (req, res) => {
  manager.newAuction();
  res.json({ success: true });
});

app.post('/api/block-user', (req, res) => {
  const { platform, username } = req.body;
  if (!platform || !username) {
    return res.status(400).json({ error: 'platform and username are required' });
  }
  manager.blockUser(platform, username);
  res.json({ success: true });
});

app.post('/api/unblock-user', (req, res) => {
  const { platform, username } = req.body;
  if (!platform || !username) {
    return res.status(400).json({ error: 'platform and username are required' });
  }
  manager.unblockUser(platform, username);
  res.json({ success: true });
});

app.get('/api/status', (req, res) => {
  res.json(manager.getStatus());
});

// ── Start server ──────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════╗');
  console.log('  ║   LIVE AUCTION BID AGGREGATOR                 ║');
  console.log(`  ║   Dashboard: http://localhost:${PORT}             ║`);
  console.log('  ║                                               ║');
  console.log(`  ║   YouTube:   ${credentials.youtubeApiKey ? '✅ API key loaded' : '❌ No API key'}            ║`);
  console.log(`  ║   Facebook:  ${credentials.metaAccessToken ? '✅ Token loaded  ' : '❌ No token     '}            ║`);
  console.log(`  ║   Instagram: ${credentials.metaAccessToken ? '✅ Token loaded  ' : '❌ No token     '}            ║`);
  console.log('  ║   TikTok:    ✅ No auth needed                ║');
  console.log('  ╚═══════════════════════════════════════════════╝');
  console.log('');
});
