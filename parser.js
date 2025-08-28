// parser.js — robust order detection & field extraction
// Handles both google.com/maps place_id and lat,lng URLs.
// Extracts {total, delivery, qty, area, map, customerName, phone, ref}.

const STRICT_DEFAULTS = {
  strictMode: true,
  minTextLength: 50,
};

// -------------------- basic heuristics --------------------
function isLikelyQuestion(text) {
  if (!text) return false;
  const s = text.toLowerCase();
  if (s.includes('?')) return true;
  const triggers = ['how', 'where', 'why', 'help', 'support', 'problem', 'issue', 'can you', 'please call'];
  return triggers.some(w => s.includes(w));
}

function extractRef(text) {
  if (!text) return '';
  const m = text.match(/GG-\d{8}-\d{6}-[A-Z0-9]{4}/i);
  return m ? m[0] : '';
}

// PATCH START: relax strict acceptance (Order ID + any of {Address, Qty, Size})
function isOrderSummaryStrict(text, opts = {}) {
  const cfg = { ...STRICT_DEFAULTS, ...opts };
  if (!text) return false;
  const s = text.trim();
  if (s.length < cfg.minTextLength) return false;

  const hasRef = /GG-\d{8}-\d{6}-[A-Z0-9]{4}/.test(s);

  // Existing anchors (kept)
  const hasOrderBlock = /Order Details/i.test(s) || /🧾\s*Order ID:/i.test(s);
  const hasTotal = /Total:\s*ETB/i.test(s);

  // New tolerant anchors
  const hasAddress = /📍\s*Address:/i.test(s) || /\bAddress:\s*/i.test(s);
  const hasQty = /🔢\s*Qty:\s*\d+/i.test(s) || /\bQty:\s*\d+/i.test(s);
  const hasSize = /⚖️\s*Size:\s*[\d.,]+\s*g/i.test(s) || /\bSize:\s*[\d.,]+\s*g/i.test(s);

  if (cfg.strictMode) {
    // Minimal acceptance: valid Order ID AND at least one core field
    const minimalOk = hasRef && (hasAddress || hasQty || hasSize);
    // Backward-compatible acceptance (old templates)
    const legacyOk = hasRef && hasOrderBlock && hasTotal;
    return minimalOk || legacyOk;
  }
  // Non-strict fallback unchanged
  return hasRef || hasOrderBlock || hasTotal || hasAddress || hasQty || hasSize;
}
// PATCH END

// -------------------- field extraction --------------------
function extractMapUrl(text) {
  if (!text) return '';
  // capture any google maps / goo.gl maps URL
  const re = /(https?:\/\/(?:www\.)?(?:google\.com\/maps[^\s\)]*|goo\.gl\/maps\/[^\s\)]*))/i;
  const m = text.match(re);
  if (!m) return '';
  // trim trailing punctuation
  return m[1].replace(/[)\]\}\.,]+$/, '');
}

function extractArea(text) {
  if (!text) return '';
  // Look for the Address line
  const addrLine = (text.split('\n').find(l => /📍\s*Address:/i.test(l)) || '')
    .replace(/📍\s*Address:\s*/i, '')
    .trim();

  if (!addrLine) return '';

  // Take text before the first comma to keep it short (keeps "Wesen Michael | ወሰን ሚካኤል")
  const beforeComma = addrLine.split(',')[0].trim();
  if (beforeComma) return beforeComma;

  // fallback: return full line (but trimmed)
  return addrLine;
}

function extractTotal(text) {
  if (!text) return '';
  const m = text.match(/Total:\s*ETB\s*([\d,\.]+)/i);
  return m ? Number(m[1].replace(/[^\d]/g, '')) : '';
}

function extractDeliveryFee(text) {
  if (!text) return '';
  const m = text.match(/Delivery Fee:\s*ETB\s*([\d,\.]+)/i);
  return m ? Number(m[1].replace(/[^\d]/g, '')) : '';
}

function extractQty(text) {
  if (!text) return '';
  // Sum all "🔢 Qty: N" lines
  const matches = text.match(/🔢\s*Qty:\s*(\d+)/gi) || [];
  const sum = matches.reduce((acc, line) => {
    const n = Number((line.match(/(\d+)/) || [0])[0]);
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);
  return sum || '';
}

function extractCustomerName(text) {
  if (!text) return '';
  // After "👤"
  const line = (text.split('\n').find(l => /^👤/.test(l)) || '').replace(/^👤\s*/, '').trim();
  return line || '';
}

// PATCH START: broaden phone capture but keep user's original format
function extractPhone(text) {
  if (!text) return '';

  const lines = text.split('\n').map(l => l.trim());

  // 1) Prefer 📞 line exactly as user typed it (no reformatting)
  const phoneEmojiLine = lines.find(l => /^📞/i.test(l));
  if (phoneEmojiLine) {
    return phoneEmojiLine.replace(/^📞\s*/i, '').trim();
  }

  // 2) Fallback: a line containing "phone"
  const phoneWordLine = lines.find(l => /\bphone\b/i.test(l));
  if (phoneWordLine) {
    return phoneWordLine.replace(/^\s*phone\s*[:\-]?\s*/i, '').trim();
  }

  // 3) Last resort: find a plausible phone token anywhere (keep original token)
  // captures +251xxxxxxxxx, 251xxxxxxxxx, 09xxxxxxxxx, or 9xxxxxxxxx (9–12 digits)
  const m = text.match(/(\+?251\d{9}|251\d{9}|0?9\d{8,9}|\b9\d{8,9}\b)/);
  return m ? m[1] : '';
}
// PATCH END

function parseOrderFields(text) {
  if (!text) return {};
  return {
    ref: extractRef(text),
    total: extractTotal(text),
    delivery: extractDeliveryFee(text),
    qty: extractQty(text),
    area: extractArea(text) || '—',
    map: extractMapUrl(text) || '—',
    customerName: extractCustomerName(text) || '',
    phone: extractPhone(text) || '',
  };
}

// -------------------- exports --------------------
module.exports = {
  isLikelyQuestion,
  isOrderSummaryStrict,
  parseOrderFields,
  extractRef,
};
