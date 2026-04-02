/**
 * Facebook Browser Scraper — Puppeteer-based username enrichment
 *
 * The Meta Graph API deliberately omits commenter names on Live video comments.
 * This scraper runs a headless browser alongside the API poller to extract
 * usernames from the visible DOM, then enriches API-sourced comments.
 *
 * Login Flow (remote-controlled headless browser):
 * 1. User clicks "Login to Facebook" in dashboard
 * 2. Server launches HEADLESS Puppeteer, navigates to Facebook login
 * 3. Server streams screenshots to the dashboard via WebSocket
 * 4. User clicks/types on the streamed image — server relays to Puppeteer
 * 5. On login success, cookies saved automatically — zero file uploads
 *
 * Scraping Flow:
 * 1. On FB Live connect, headless browser loads the video page with saved cookies
 * 2. Every 3s, scrapes comment DOM for {username, text} pairs
 * 3. API poller calls lookupUsername(text) to enrich anonymous comments
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFile } from 'fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = join(__dirname, '..', 'fb-cookies.json');
const PROFILE_PATH = join(__dirname, '..', 'fb-profile');

function normalizeCommentLookupKey(text) {
  if (!text) return null;
  const normalized = text.toLowerCase().trim();
  return normalized || null;
}

function hasLoginLikeUrl(url) {
  const value = String(url || '');
  return value.includes('/login') || value.includes('/checkpoint') || value.includes('/recover');
}

function isFacebookDomainUrl(url) {
  return /^https?:\/\/(?:[a-z-]+\.)?facebook\.com\//i.test(String(url || ''));
}

function readSavedCookies() {
  if (!existsSync(COOKIES_PATH)) return [];

  try {
    const parsed = JSON.parse(readFileSync(COOKIES_PATH, 'utf-8'));
    if (!Array.isArray(parsed)) return [];

    const now = Date.now() / 1000;
    return parsed.filter((cookie) => {
      if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') {
        return false;
      }
      if (cookie.expires === undefined || cookie.expires === -1 || cookie.expires === null) {
        return true;
      }
      return Number(cookie.expires) > now;
    });
  } catch (_) {
    return [];
  }
}

function clearSavedCookies() {
  if (!existsSync(COOKIES_PATH)) return;
  try {
    unlinkSync(COOKIES_PATH);
  } catch (_) {}
}

export class FbBrowserScraper {
  constructor() {
    this._browser = null;
    this._page = null;
    this._running = false;
    this._scrapeTimer = null;
    this._commentMap = new Map();
    this._puppeteer = null;
    // Login session state
    this._loginBrowser = null;
    this._loginPage = null;
    this._loginActive = false;
  }

  getLoginStatus() {
    const cookies = readSavedCookies();
    const hasCookies = cookies.length > 0;
    if (!hasCookies) clearSavedCookies();
    return {
      loggedIn: hasCookies,
      loginActive: this._loginActive,
      cookiesFile: hasCookies ? COOKIES_PATH : null,
    };
  }

  /**
   * Start remote login flow — launches headless browser, returns initial screenshot.
   * The caller (server) streams screenshots via WebSocket to the dashboard.
   * Dashboard sends click/type events back which are relayed here.
   */
  async startLoginFlow() {
    const puppeteer = await this._loadPuppeteer();
    if (!puppeteer) {
      return { success: false, error: 'Puppeteer not installed. Run: npm install puppeteer' };
    }

    const status = this.getLoginStatus();
    if (status.loggedIn) {
      return { success: true, loggedIn: true, reusedSession: true, status: 'already-logged-in' };
    }

    // Ensure no scraper browser is holding the persistent profile lock.
    await this.disconnect();

    // Clean up any existing login session
    await this._cleanupLogin();

    try {
      this._loginBrowser = await puppeteer.launch(this._getLaunchOptions({ interactive: true }));

      this._loginPage = await this._loginBrowser.newPage();
      await this._preparePage(this._loginPage);

      await this._loginPage.goto('https://www.facebook.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));

      if (await this._checkLoginSuccess()) {
        return { success: true, loggedIn: true, reusedSession: true, status: 'already-logged-in' };
      }

      const currentUrl = this._loginPage.url();
      const title = await this._loginPage.title().catch(() => '');
      if (title === 'Facebook | Error' || /index\.php\?next=/i.test(currentUrl)) {
        await this._loginPage.goto('https://www.facebook.com/login', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }

      this._loginActive = true;
      console.log('[FB Scraper] Remote login session started');

      // Take initial screenshot
      const screenshot = await this._takeLoginScreenshot();
      return { success: true, screenshot, status: 'login-started' };

    } catch (err) {
      await this._cleanupLogin();
      return { success: false, error: err.message };
    }
  }

  /**
   * Handle a click event from the dashboard on the login page.
   * @param {number} x - X coordinate (relative to viewport)
   * @param {number} y - Y coordinate (relative to viewport)
   * @returns {{ screenshot: string, loggedIn: boolean }}
   */
  async loginClick(x, y) {
    if (!this._loginPage || !this._loginActive) {
      return { error: 'No active login session' };
    }
    try {
      await this._loginPage.mouse.click(x, y);
      return await this._buildInteractionResult({ settleTimeoutMs: 2500 });
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Handle keyboard input from the dashboard on the login page.
   * @param {string} text - Text to type
   * @returns {{ screenshot: string, loggedIn: boolean }}
   */
  async loginType(text) {
    if (!this._loginPage || !this._loginActive) {
      return { error: 'No active login session' };
    }
    try {
      await this._loginPage.keyboard.type(text, { delay: 50 });
      return await this._buildInteractionResult({ expectNavigation: false });
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Handle a key press (Enter, Tab, Backspace, etc.)
   */
  async loginKeyPress(key) {
    if (!this._loginPage || !this._loginActive) {
      return { error: 'No active login session' };
    }
    try {
      await this._loginPage.keyboard.press(key);
      return await this._buildInteractionResult({
        expectNavigation: key === 'Enter' || key === 'Tab',
        settleTimeoutMs: key === 'Enter' ? 5000 : 2500,
      });
    } catch (err) {
      return { error: err.message };
    }
  }

  async loginWheel(deltaX = 0, deltaY = 0) {
    if (!this._loginPage || !this._loginActive) {
      return { error: 'No active login session' };
    }
    try {
      await this._loginPage.mouse.wheel({ deltaX, deltaY });
      return await this._buildInteractionResult({ expectNavigation: false, settleTimeoutMs: 250 });
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Get a fresh screenshot of the login page.
   */
  async loginScreenshot() {
    if (!this._loginPage || !this._loginActive) {
      return { error: 'No active login session' };
    }
    try {
      return await this._buildInteractionResult({ expectNavigation: false });
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Cancel the login flow.
   */
  async cancelLogin() {
    await this._cleanupLogin();
    return { success: true };
  }

  async _takeLoginScreenshot() {
    if (!this._loginPage) return null;
    const buffer = await this._loginPage.screenshot({ type: 'jpeg', quality: 70 });
    return buffer.toString('base64');
  }

  async _buildInteractionResult(options = {}) {
    await this._waitForLoginPageSettled(options);
    const loggedIn = await this._checkLoginSuccess();
    const screenshot = await this._takeLoginScreenshot();
    const feedback = loggedIn ? null : await this._extractLoginFeedback();
    return feedback ? { screenshot, loggedIn, feedback } : { screenshot, loggedIn };
  }

  async _waitForLoginPageSettled(options = {}) {
    if (!this._loginPage) return;

    const { expectNavigation = true, settleTimeoutMs = expectNavigation ? 2500 : 400 } = options;
    if (expectNavigation) {
      try {
        await Promise.race([
          this._loginPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: settleTimeoutMs }).catch(() => null),
          this._loginPage.waitForFunction(() => {
            const text = document.body?.innerText || '';
            return /incorrect|invalid|wrong password|try again|temporarily blocked|unusual login|checkpoint|two-factor|confirm your identity|approve from another device/i.test(text);
          }, { timeout: settleTimeoutMs }).catch(() => null),
          new Promise((resolve) => setTimeout(resolve, settleTimeoutMs)),
        ]);
      } catch (_) {}
    } else {
      await new Promise((resolve) => setTimeout(resolve, settleTimeoutMs));
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  async _extractLoginFeedback() {
    if (!this._loginPage) return null;

    try {
      return await this._loginPage.evaluate(() => {
        const bodyText = document.body.innerText || '';
        const normalized = bodyText.replace(/\s+/g, ' ').trim();
        const candidates = [
          /incorrect/i,
          /invalid/i,
          /wrong password/i,
          /try again/i,
          /temporarily blocked/i,
          /unusual login/i,
          /checkpoint/i,
          /two-factor/i,
          /confirm your identity/i,
          /approve from another device/i,
        ];

        const url = window.location.href;
        if (url.includes('/checkpoint')) {
          return 'Facebook requires additional verification in this login session.';
        }

        const matchingLine = normalized
          .split(/(?<=[.?!])\s+/)
          .find((line) => candidates.some((pattern) => pattern.test(line)));

        return matchingLine || null;
      });
    } catch (_) {
      return null;
    }
  }

  async _saveLoginCookies(cookies) {
    await writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    console.log(`[FB Scraper] Login successful - ${cookies.length} cookies saved`);
  }

  async _checkLoginSuccess() {
    if (!this._loginPage) return false;
    try {
      const url = this._loginPage.url();
      const cookies = (await this._loginPage.cookies()).filter((cookie) => {
        return cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string';
      });
      const hasSessionCookies = cookies.some((cookie) => cookie.name === 'c_user') &&
        cookies.some((cookie) => cookie.name === 'xs');

      const looksLoggedIn = hasSessionCookies && isFacebookDomainUrl(url) && !hasLoginLikeUrl(url);
      if (looksLoggedIn) {
        await this._saveLoginCookies(cookies);
        setTimeout(() => this._cleanupLogin(), 500);
        return true;
      }
    } catch (_) {}
    return false;
  }

  async _cleanupLogin() {
    this._loginActive = false;
    if (this._loginBrowser) {
      try { await this._loginBrowser.close(); } catch (_) {}
      this._loginBrowser = null;
      this._loginPage = null;
    }
  }

  /**
   * Connect to a Facebook Live video page and start scraping comments.
   */
  async connect(pageTarget) {
    const puppeteer = await this._loadPuppeteer();
    if (!puppeteer) {
      console.warn('[FB Scraper] Puppeteer not available - username enrichment disabled');
      return false;
    }

    await this.disconnect();

    const cookies = readSavedCookies();
    if (cookies.length === 0) {
      clearSavedCookies();
      console.warn('[FB Scraper] No saved cookies - use "Login to Facebook" button first');
      return false;
    }

    try {
      this._browser = await puppeteer.launch(this._getLaunchOptions());

      this._page = await this._browser.newPage();
      await this._preparePage(this._page);
      await this._page.setCookie(...cookies);

      const videoUrl = /^https?:\/\//i.test(String(pageTarget || ''))
        ? String(pageTarget)
        : `https://www.facebook.com/watch/live/?v=${pageTarget}`;
      console.log(`[FB Scraper] Navigating to ${videoUrl}...`);
      await this._page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const currentUrl = this._page.url();
      if (hasLoginLikeUrl(currentUrl)) {
        console.warn('[FB Scraper] Cookies expired - use "Login to Facebook" to re-authenticate');
        clearSavedCookies();
        await this.disconnect();
        return false;
      }

      console.log('[FB Scraper] Connected - starting comment scraping');
      this._running = true;
      this._scrapeLoop();
      return true;

    } catch (err) {
      console.error('[FB Scraper] Connection failed:', err.message);
      if (this._browser) {
        try { await this._browser.close(); } catch (_) {}
        this._browser = null;
        this._page = null;
      }
      return false;
    }
  }

  async _scrapeLoop() {
    if (!this._running || !this._page) return;

    try {
      const comments = await this._page.evaluate(() => {
        const results = [];

        // Strategy 1: article-based comments
        const articles = document.querySelectorAll('[role="article"]');
        for (const article of articles) {
          const authorLink = article.querySelector('a[role="link"] span, a.x1i10hfl span');
          const textEl = article.querySelector('[dir="auto"]:not(a *)');
          if (authorLink && textEl) {
            const username = authorLink.textContent?.trim();
            const text = textEl.textContent?.trim();
            if (username && text && text.length < 500) results.push({ username, text });
          }
        }

        // Strategy 2: live video comment feed
        if (results.length === 0) {
          const commentEls = document.querySelectorAll('[data-testid="UFI2Comment/root_depth_0"], .x1lliihq');
          for (const el of commentEls) {
            const nameEl = el.querySelector('a span, [data-testid="UFI2CommentActorName"] span');
            const bodyEl = el.querySelector('[data-testid="UFI2CommentBody"] span, [dir="auto"]');
            if (nameEl && bodyEl) {
              const username = nameEl.textContent?.trim();
              const text = bodyEl.textContent?.trim();
              if (username && text) results.push({ username, text });
            }
          }
        }

        // Strategy 3: list-based comments
        if (results.length === 0) {
          const items = document.querySelectorAll('ul > li, [role="listitem"]');
          for (const item of items) {
            const spans = item.querySelectorAll('span');
            if (spans.length >= 2) {
              const username = spans[0].textContent?.trim();
              const text = spans[1].textContent?.trim();
              if (username && text && username.length < 50 && text.length < 500) results.push({ username, text });
            }
          }
        }

        return results;
      });

      for (const { username, text } of comments) {
        this._recordCommentMatch(username, text);
      }

      if (comments.length > 0) {
        console.log(`[FB Scraper] Scraped ${comments.length} comments (map: ${this._commentMap.size})`);
      }

    } catch (err) {
      if (!err.message.includes('detached') && !err.message.includes('closed')) {
        console.error('[FB Scraper] Scrape error:', err.message);
      }
    }

    if (this._running) {
      this._scrapeTimer = setTimeout(() => this._scrapeLoop(), 3000);
    }
  }

  lookupUsername(commentText) {
    const key = normalizeCommentLookupKey(commentText);
    if (!key) return null;

    const exactMatch = this._getUniqueUsernameForKey(key);
    if (exactMatch) return exactMatch;

    const stripped = key.replace(/[!?.…]+$/, '').trim();
    if (stripped !== key) {
      const strippedMatch = this._getUniqueUsernameForKey(stripped);
      if (strippedMatch) return strippedMatch;
    }

    return null;
  }

  _recordCommentMatch(username, text) {
    const key = normalizeCommentLookupKey(text);
    if (!key || !username) return;

    const now = Date.now();
    let entry = this._commentMap.get(key);
    if (!entry) {
      entry = { usernames: new Map(), lastSeen: now };
      this._commentMap.set(key, entry);
    }

    entry.usernames.set(username, now);
    entry.lastSeen = now;

    if (this._commentMap.size > 1000) {
      const entries = [...this._commentMap.entries()]
        .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
        .slice(0, 500);
      this._commentMap = new Map(entries);
    }
  }

  _getUniqueUsernameForKey(key) {
    const entry = this._commentMap.get(key);
    if (!entry) return null;

    const usernames = [...entry.usernames.keys()];
    return usernames.length === 1 ? usernames[0] : null;
  }

  async disconnect() {
    this._running = false;
    if (this._scrapeTimer) { clearTimeout(this._scrapeTimer); this._scrapeTimer = null; }
    if (this._browser) {
      try { await this._browser.close(); } catch (_) {}
      this._browser = null;
      this._page = null;
    }
    this._commentMap.clear();
    console.log('[FB Scraper] Disconnected');
  }

  isConnected() {
    return this._running && this._browser !== null;
  }

  _getLaunchOptions(options = {}) {
    const { interactive = false } = options;
    const canUseHeadfulDisplay = process.platform === 'linux' && Boolean(process.env.DISPLAY);
    const headless = canUseHeadfulDisplay ? false : 'new';

    return {
      headless,
      userDataDir: PROFILE_PATH,
      defaultViewport: { width: 800, height: 600 },
      ignoreDefaultArgs: interactive ? ['--enable-automation'] : [],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1200,800',
        '--lang=en-US,en',
        ...(headless ? ['--disable-gpu'] : []),
      ],
    };
  }

  async _preparePage(page) {
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4] });
      window.chrome = window.chrome || { runtime: {} };
    });
  }

  async _loadPuppeteer() {
    if (this._puppeteer) return this._puppeteer;
    try {
      this._puppeteer = await import('puppeteer');
      return this._puppeteer.default || this._puppeteer;
    } catch (_) {
      try {
        this._puppeteer = await import('puppeteer-core');
        return this._puppeteer.default || this._puppeteer;
      } catch (_2) {
        console.warn('[FB Scraper] Neither puppeteer nor puppeteer-core installed');
        return null;
      }
    }
  }
}
