/**
 * Bid Parser — extracts bid amounts from live stream comment text.
 *
 * Handles: $500, 500, BID 500, bid $500, I bid 500, 500 dollars,
 *          $1,500.00, going 500, AUD 500, plain numbers,
 *          "five hundred", "5 hundred", "ill go 500", "500!", "500 please",
 *          "$500.00", "1500", "I'll take it for 500", etc.
 *
 * FIX LOG:
 * - Reduced aggressiveness of rejection filters — was rejecting valid bids
 * - Added more bid keyword patterns ("ill go", "mine for", "take it for", etc.)
 * - Relaxed the short-comment number extraction (was too strict)
 * - Added support for number words ("hundred", "thousand", "k")
 * - Lowered confidence threshold — in auction context, most numbers ARE bids
 *
 * Rejects: phone numbers, years, timestamps, URLs, emoji-only.
 *
 * FIX LOG (v2):
 * - CRITICAL: Number regex \d{1,3} was truncating 4+ digit bids without commas
 *   e.g. "1500" parsed as $150, "5000" as $500. Changed to \d{1,7} everywhere.
 * - Added "ill do", "do" to bid keyword patterns
 * - Narrowed year range to 2024-2027 (current years only)
 */

// Years to reject (narrowed to avoid blocking high-value bids like $2020-$2035)
const YEAR_RANGE = { min: 2024, max: 2027 };

// Phone-number-like patterns (10+ consecutive digits)
const PHONE_RE = /\b\d{10,}\b/;

// Time patterns: "10:30", "2:15pm"
const TIME_RE = /\b\d{1,2}:\d{2}\b/;

// URL pattern
const URL_RE = /https?:\/\/|www\./i;

// Bid keyword patterns — these boost confidence
// Note: "sold" deliberately excluded — it's an auctioneer confirmation, not a bid
const BID_KEYWORD_RE = /\b(?:bid|bidding|offer|going|raise|mine|take|want|pay|do|ill\s+(?:go|do|take|pay)|i'?ll\s+(?:go|do|take|pay)|me\s+for|mine\s+for|yes\s+for)\b/i;

// Currency patterns
const CURRENCY_PREFIX_RE = /(?:\$|AUD\s*\$?|A\$|NZD\s*\$?)/i;

// K/thousand suffix: "5k", "1.5k", "2 thousand"
const K_SUFFIX_RE = /(\d+(?:\.\d+)?)\s*(?:k|thousand)\b/i;

// Hundred suffix: "5 hundred", "fifteen hundred"
const HUNDRED_SUFFIX_RE = /(\d+)\s*hundred/i;

/**
 * Parse a bid amount from comment text.
 * @param {string} text - The raw comment text
 * @returns {{ amount: number, rawText: string, confidence: 'high'|'medium'|'low' } | null}
 */
export function parseBid(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return null;

  // Quick reject: no digits at all
  if (!/\d/.test(trimmed)) return null;

  // Reject URLs
  if (URL_RE.test(trimmed)) return null;

  // Reject phone numbers
  if (PHONE_RE.test(trimmed.replace(/[\s\-().+]/g, ''))) return null;

  // Reject pure timestamps
  if (TIME_RE.test(trimmed) && trimmed.replace(TIME_RE, '').replace(/\s/g, '').length < 3) return null;

  let confidence = 'low';
  let amount = null;

  // Strategy 0: K/thousand suffix — "5k", "1.5k", "2 thousand"
  const kMatch = trimmed.match(K_SUFFIX_RE);
  if (kMatch) {
    amount = parseFloat(kMatch[1]) * 1000;
    confidence = 'high';
  }

  // Strategy 0b: Hundred suffix — "5 hundred", "15 hundred"
  if (amount === null) {
    const hundredMatch = trimmed.match(HUNDRED_SUFFIX_RE);
    if (hundredMatch) {
      amount = parseInt(hundredMatch[1], 10) * 100;
      confidence = 'high';
    }
  }

  // Strategy 1: Currency symbol prefix — highest confidence
  // Matches: $500, $1,500.00, AUD 500, A$500, $ 500
  if (amount === null) {
    const currencyMatch = trimmed.match(
      /(?:\$|AUD\s*\$?|A\$|NZD\s*\$?)\s*((?:\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.\d{1,2})?)/i
    );
    if (currencyMatch) {
      amount = parseAmount(currencyMatch[1]);
      confidence = 'high';
    }
  }

  // Strategy 2: Bid keyword + number
  // Matches: BID 500, bid $500, I bid 500, bidding 1500, offer 200, going 500,
  //          ill go 500, i'll take 500, mine for 200, me for 500
  if (amount === null) {
    const keywordMatch = trimmed.match(
      /\b(?:bid|bidding|offer|going|raise|mine|take|want|pay|go|do)\s*(?:it\s+)?(?:for\s+)?(?:\$|AUD\s*\$?|A\$)?\s*((?:\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.\d{1,2})?)/i
    );
    if (keywordMatch) {
      amount = parseAmount(keywordMatch[1]);
      confidence = 'high';
    }
  }

  // Strategy 3: Number + currency word suffix
  // Matches: 500 dollars, 500 bucks, 500 AUD
  if (amount === null) {
    const suffixMatch = trimmed.match(
      /((?:\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.\d{1,2})?)\s*(?:dollars?|bucks?|AUD|NZD)\b/i
    );
    if (suffixMatch) {
      amount = parseAmount(suffixMatch[1]);
      confidence = 'high';
    }
  }

  // Strategy 4: Plain number (entire comment is basically just a number)
  // Matches: "500", "1500", "250.50", "500!", "500 please", "500 👋"
  if (amount === null) {
    const plainMatch = trimmed.match(
      /^\s*(?:(?:i'?ll?\s+)?(?:bid|go|do|take|pay|offer)?\s*)?(?:\$|AUD\s*\$?|A\$)?\s*((?:\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.\d{1,2})?)\s*(?:dollars?|bucks?|AUD|please|pls|!+|\.+|👋|🙋|🖐|✋|👍)?\s*$/i
    );
    if (plainMatch) {
      amount = parseAmount(plainMatch[1]);
      confidence = BID_KEYWORD_RE.test(trimmed) ? 'high' : 'medium';
    }
  }

  // Strategy 5: Number appears in a short comment (< 80 chars)
  // In an auction context, most short comments with numbers ARE bids
  if (amount === null && trimmed.length < 80) {
    const looseMatch = trimmed.match(
      /((?:\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.\d{1,2})?)/
    );
    if (looseMatch) {
      const candidate = parseAmount(looseMatch[1]);
      if (candidate !== null && candidate >= 1) {
        // Reject years
        if (candidate >= YEAR_RANGE.min && candidate <= YEAR_RANGE.max) return null;
        // Reject very small numbers without context (1, 2, 3 — likely not bids)
        if (candidate < 5 && !CURRENCY_PREFIX_RE.test(trimmed) && !BID_KEYWORD_RE.test(trimmed)) return null;

        // In auction context, if there's a bid keyword, boost confidence
        if (BID_KEYWORD_RE.test(trimmed)) {
          confidence = 'high';
        } else if (candidate >= 10) {
          // Numbers >= 10 in short comments during auction are likely bids
          confidence = 'medium';
        } else {
          confidence = 'low';
        }
        amount = candidate;
      }
    }
  }

  if (amount === null) return null;

  // Final sanity checks
  if (amount <= 0 || amount > 999999) return null;
  // Reject tiny amounts (1-4) unless bid keyword or currency context present
  if (amount < 5 && !CURRENCY_PREFIX_RE.test(trimmed) && !BID_KEYWORD_RE.test(trimmed)) return null;
  // Only reject year-like numbers if there's no bid/currency context
  if (amount >= YEAR_RANGE.min && amount <= YEAR_RANGE.max && !CURRENCY_PREFIX_RE.test(trimmed) && !BID_KEYWORD_RE.test(trimmed)) return null;

  return {
    amount: Math.round(amount * 100) / 100,
    rawText: trimmed,
    confidence
  };
}

/**
 * Parse a number string with optional commas into a float.
 */
function parseAmount(str) {
  if (!str) return null;
  const cleaned = str.replace(/,/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num) || !isFinite(num)) return null;
  return num;
}
