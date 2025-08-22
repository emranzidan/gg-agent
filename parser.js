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

function isOrderSummaryStrict(text, opts = {}) {
  const cfg = { ...STRICT_DEFAULTS, ...opts };
  if (!text) return false;
  const s = text.trim();
  if (s.length < cfg.minTextLength) return false;

  // Must contain our ref and at least one of the expected anchors
  const hasRef = /GG-\d{8}-\d{6}-[A-Z0-9]{4}/.test(s);
  const hasOrderBlock = /Order Details/i.test(s) || /🧾\s*Order ID:/i.test(s);
  const hasTotal = /Total:\s*ETB/i.test(s);

  if (cfg.strictMode) {
    return hasRef && hasOrderBlock && hasTotal;
  }
  return hasRef || hasOrderBlock || hasTotal;
}

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

function extractPhone(text) {
  if (!text) return '';
  const line = (text.split('\n').find(l => /^📞/.test(l)) || '').replace(/^📞\s*/, '').trim();
  return line || '';
}

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
