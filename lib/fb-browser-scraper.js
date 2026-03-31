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
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = join(__dirname, '..', 'fb-cookies.json');

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
    const hasCookies = existsSync(COOKIES_PATH);
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

    // Clean up any existing login session
    await this._cleanupLogin();

    try {
      this._loginBrowser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
          '--window-size=1200,800', '--disable-dev-shm-usage',
        ],
        defaultViewport: { width: 800, height: 600 },
      });

      this._loginPage = await this._loginBrowser.newPage();

      // Set a realistic user agent
      await this._loginPage.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      );

      await this._loginPage.goto('https://www.facebook.com/login', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

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
      await new Promise(r => setTimeout(r, 500));
      const loggedIn = await this._checkLoginSuccess();
      const screenshot = await this._takeLoginScreenshot();
      return { screenshot, loggedIn };
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
      await new Promise(r => setTimeout(r, 300));
      const loggedIn = await this._checkLoginSuccess();
      const screenshot = await this._takeLoginScreenshot();
      return { screenshot, loggedIn };
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
      await new Promise(r => setTimeout(r, 1000)); // Wait longer for Enter (page navigation)
      const loggedIn = await this._checkLoginSuccess();
      const screenshot = await this._takeLoginScreenshot();
      return { screenshot, loggedIn };
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
      const loggedIn = await this._checkLoginSuccess();
      const screenshot = await this._takeLoginScreenshot();
      return { screenshot, loggedIn };
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

  async _checkLoginSuccess() {
    if (!this._loginPage) return false;
    try {
      const url = this._loginPage.url();
      if (!url.includes('/login') && !url.includes('/checkpoint') &&
          (url.includes('facebook.com/') || url.includes('facebook.com/?'))) {
        // Logged in! Save cookies BEFORE cleanup (so screenshot can still be taken by caller)
        const cookies = await this._loginPage.cookies();
        await writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
        console.log(`[FB Scraper] Login successful — ${cookies.length} cookies saved`);
        // Defer cleanup so the caller can still take a final screenshot
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
  async connect(videoId) {
    const puppeteer = await this._loadPuppeteer();
    if (!puppeteer) {
      console.warn('[FB Scraper] Puppeteer not available — username enrichment disabled');
      return false;
    }

    if (!existsSync(COOKIES_PATH)) {
      console.warn('[FB Scraper] No saved cookies — use "Login to Facebook" button first');
      return false;
    }

    try {
      const cookiesJson = await readFile(COOKIES_PATH, 'utf-8');
      const cookies = JSON.parse(cookiesJson);

      this._browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });

      this._page = await this._browser.newPage();
      await this._page.setCookie(...cookies);

      const videoUrl = `https://www.facebook.com/${videoId}`;
      console.log(`[FB Scraper] Navigating to ${videoUrl}...`);
      await this._page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      const currentUrl = this._page.url();
      if (currentUrl.includes('/login')) {
        console.warn('[FB Scraper] Cookies expired — use "Login to Facebook" to re-authenticate');
        await this._browser.close();
        this._browser = null;
        this._page = null;
        return false;
      }

      console.log('[FB Scraper] Connected — starting comment scraping');
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
        const key = text.toLowerCase().trim();
        this._commentMap.set(key, username);
      }

      if (this._commentMap.size > 1000) {
        const entries = [...this._commentMap.entries()];
        this._commentMap = new Map(entries.slice(entries.length - 500));
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
    if (!commentText) return null;
    const key = commentText.toLowerCase().trim();

    if (this._commentMap.has(key)) return this._commentMap.get(key);

    const stripped = key.replace(/[!?.…]+$/, '').trim();
    if (stripped !== key && this._commentMap.has(stripped)) return this._commentMap.get(stripped);

    for (const [mapKey, mapUsername] of this._commentMap) {
      if (mapKey.includes(key) || key.includes(mapKey)) return mapUsername;
    }

    return null;
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
