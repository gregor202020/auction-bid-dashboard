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

// Number words for bids like "five hundred"
const NUMBER_WORD_RE = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/i;

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

  // Quick reject: no numeric hints at all
  if (!/\d/.test(trimmed) && !NUMBER_WORD_RE.test(trimmed)) return null;

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

  // Strategy 0c: Number words — "five hundred", "one thousand two hundred"
  if (amount === null && NUMBER_WORD_RE.test(trimmed)) {
    const wordAmount = parseWordAmount(trimmed);
    if (wordAmount !== null) {
      amount = wordAmount;
      confidence = (BID_KEYWORD_RE.test(trimmed) || /\b(?:dollars?|bucks?|aud|usd|nzd)\b/i.test(trimmed))
        ? 'high'
        : 'medium';
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

const SMALL_WORDS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS_WORDS = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function parseWordAmount(text) {
  const tokens = text.toLowerCase().match(/[a-z]+/g) || [];
  const candidates = [];
  let currentTokens = [];

  const flush = () => {
    if (currentTokens.length === 0) return;
    const amount = parseWordTokenSequence(currentTokens);
    if (amount !== null) candidates.push(amount);
    currentTokens = [];
  };

  for (const token of tokens) {
    if (SMALL_WORDS[token] !== undefined || TENS_WORDS[token] !== undefined || token === 'hundred' || token === 'thousand' || token === 'and') {
      currentTokens.push(token);
    } else {
      flush();
    }
  }

  flush();

  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function parseWordTokenSequence(tokens) {
  let total = 0;
  let current = 0;
  let seenNumber = false;

  for (const token of tokens) {
    if (token === 'and') continue;

    if (SMALL_WORDS[token] !== undefined) {
      current += SMALL_WORDS[token];
      seenNumber = true;
      continue;
    }

    if (TENS_WORDS[token] !== undefined) {
      current += TENS_WORDS[token];
      seenNumber = true;
      continue;
    }

    if (token === 'hundred') {
      if (current === 0) return null;
      current *= 100;
      seenNumber = true;
      continue;
    }

    if (token === 'thousand') {
      if (current === 0) return null;
      total += current * 1000;
      current = 0;
      seenNumber = true;
      continue;
    }

    return null;
  }

  const amount = total + current;
  return seenNumber && amount > 0 ? amount : null;
}
