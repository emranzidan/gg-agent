// parser.js — tolerant order detection & field extraction (Green Gold)
// API kept identical: isLikelyQuestion, isOrderSummaryStrict, parseOrderFields, extractRef
// Supports flexible, emoji-rich summaries like the sample provided by Emru.
// Extracts:
//   - ref (GG-YYYYMMDD-HHMMSS-XXXX)
//   - items [{roast, type, size_g, qty, unit_price, line_total}]
//   - delivery fee, distance (km), pickup/store
//   - total (ETB)
//   - identity: customerName (👤 …), phone (📞 …), email (📧 …), address (📍 …), map url (Google Maps)
//   - derived: qty (sum of item qty), area (short location hint)

'use strict';

const STRICT_DEFAULTS = {
  strictMode: true,
  minTextLength: 40,
};

// -------------------- basic heuristics --------------------
function isLikelyQuestion(text) {
  if (!text) return false;
  const s = text.toLowerCase();
  if (s.includes('?')) return true;
  const triggers = [
    'how', 'where', 'why', 'help', 'support', 'problem', 'issue',
    'can you', 'please call', 'pls call', 'pls help',
    'ረዳ', 'እርዳ', 'መርዳት', 'ረዳኝ'
  ];
  return triggers.some(w => s.includes(w));
}

function extractRef(text) {
  if (!text) return '';
  // GG-20250829-145504-SI3L
  const m = text.match(/GG-\d{8}-\d{6}-[A-Z0-9]{3,12}/i);
  return m ? m[0] : '';
}

function isOrderSummaryStrict(text, opts = {}) {
  if (!text) return false;
  const s = String(text);
  const strictMode = !!(opts.strictMode ?? STRICT_DEFAULTS.strictMode);
  const minLen = Number(opts.minTextLength ?? STRICT_DEFAULTS.minTextLength);

  if (s.length < minLen) return false;

  const anchors = [
    /GG-\d{8}-\d{6}-[A-Z0-9]{3,12}/i,       // Order ref
    /Total:\s*ETB\s*[\d,]+/i,               // Total line
    /Delivery\s*Fee:\s*ETB\s*[\d,]+/i,      // Delivery fee
    /🫘\s*Roast:/i, /Roast:\s*[A-Za-z]/i,    // Any item block
    /📞/i, /Phone:/i,                        // Phone
    /https?:\/\/(?:www\.)?google\.com\/maps\//i, /place_id:/i, // Map
    /📍\s*Address:/i, /Address:/i,          // Address
  ];

  let score = 0;
  for (const a of anchors) if (a.test(s)) score++;

  // Strict requires at least 3 anchors, non-strict at least 2
  return score >= (strictMode ? 3 : 2);
}

// -------------------- helpers --------------------
function cleanMoney(str) {
  if (!str) return 0;
  const n = String(str).replace(/[^\d.]/g, '');
  return n ? Math.round(parseFloat(n)) : 0;
}
function toFloat(str) {
  if (!str) return 0;
  const n = String(str).replace(/[^\d.]/g, '');
  return n ? parseFloat(n) : 0;
}
function safeTrim(s) {
  return (s || '').toString().trim();
}

function splitLines(text) {
  return String(text)
    .replace(/\r/g, '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

function extractAfterEmojiOrLabel(lines, emoji, labelRegex) {
  // Prefer emoji line, else labeled line.
  for (const line of lines) {
    const idx = line.indexOf(emoji);
    if (idx >= 0) {
      return line.slice(idx + emoji.length).replace(/^[:\-–\s]+/, '').trim();
    }
  }
  for (const line of lines) {
    const m = line.match(labelRegex);
    if (m) {
      const i = (m.index ?? 0) + m[0].length;
      return line.slice(i).replace(/^[:\-–\s]+/, '').trim();
    }
  }
  return '';
}

function extractGoogleMapsUrl(text) {
  // Any google maps url, including place_id
  const url = text.match(/https?:\/\/(?:www\.)?google\.com\/maps\/[^\s)]+/i);
  if (url) return url[0];
  const place = text.match(/https?:\/\/(?:www\.)?google\.com\/maps\/place\/\?q=place_id:[^\s)]+/i);
  if (place) return place[0];
  return '';
}

function guessArea(address, pickup) {
  // Area heuristic:
  // 1) If address contains comma, take first segment.
  // 2) Else if pickup exists, use that.
  // 3) Else return '—'
  const a = safeTrim(address);
  if (a) {
    const seg = a.split(',').map(s => s.trim()).filter(Boolean)[0];
    if (seg) return seg;
  }
  const p = safeTrim(pickup);
  return p || '—';
}

// -------------------- items parser --------------------
function extractItems(lines) {
  const items = [];
  let cur = null;

  function ensureItem() {
    if (!cur) cur = { roast: '', type: '', size_g: 0, qty: 0, unit_price: 0, line_total: 0 };
  }
  function pushIfFilled() {
    if (!cur) return;
    // consider an item if at least one field was seen
    const touched = cur.roast || cur.type || cur.size_g || cur.qty || cur.unit_price || cur.line_total;
    if (touched) items.push({ ...cur });
    cur = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];

    // New item can be indicated by Roast line
    if (/🫘\s*Roast:/i.test(L) || /^Roast:/i.test(L)) {
      pushIfFilled();
      ensureItem();
      const m = L.match(/Roast:\s*([A-Za-z]+)/i);
      if (m) cur.roast = m[1];
      continue;
    }

    if (/🧂\s*Type:/i.test(L) || /^Type:/i.test(L)) {
      ensureItem();
      const m = L.match(/Type:\s*([A-Za-z]+)/i);
      if (m) cur.type = m[1];
      continue;
    }

    if (/⚖️\s*Size:/i.test(L) || /^Size:/i.test(L)) {
      ensureItem();
      // e.g., Size: 250 g
      const m = L.match(/Size:\s*([\d.,]+)\s*g/i);
      if (m) cur.size_g = Math.round(parseFloat(m[1].replace(',', '.')));
      continue;
    }

    if (/🔢\s*Qty:/i.test(L) || /^Qty:/i.test(L)) {
      ensureItem();
      const m = L.match(/Qty:\s*(\d+)/i);
      if (m) cur.qty = parseInt(m[1], 10);
      continue;
    }

    if (/💸/i.test(L) || /ETB/i.test(L)) {
      // 💸 ETB 595 x 2 = ETB 1190
      ensureItem();
      const unit = L.match(/ETB\s*([\d,]+)/i);
      const qty  = L.match(/x\s*(\d+)/i);
      const line = L.match(/=\s*ETB\s*([\d,]+)/i);
      if (unit) cur.unit_price = cleanMoney(unit[1]);
      if (qty)  cur.qty = cur.qty || parseInt(qty[1], 10);
      if (line) cur.line_total = cleanMoney(line[1]);
      continue;
    }
  }

  pushIfFilled();
  return items;
}

// -------------------- main parser --------------------
function parseOrderFields(text, opts = {}) {
  const minLen = Number(opts.minTextLength ?? STRICT_DEFAULTS.minTextLength);
  if (!text || text.length < minLen) {
    return { ok: false, reason: 'too_short' };
  }

  const raw   = String(text);
  const lines = splitLines(raw);

  const ref = extractRef(raw);

  // Monetary & numeric fields
  const totalM = raw.match(/Total:\s*ETB\s*([\d,]+)/i);
  const total = totalM ? cleanMoney(totalM[1]) : 0;

  const delM = raw.match(/Delivery\s*Fee:\s*ETB\s*([\d,]+)/i);
  const delivery = delM ? cleanMoney(delM[1]) : 0;

  const distM = raw.match(/Distance:\s*([\d.]+)\s*km/i);
  const distance_km = distM ? toFloat(distM[1]) : 0;

  const pickup = extractAfterEmojiOrLabel(
    lines,
    '🏪',
    /^(?:Pickup|Pick\s*up|Store|Hub):/i
  );

  const customerName = extractAfterEmojiOrLabel(lines, '👤', /^(?:Customer|Name):/i);
  // Phone: prefer "📞 ..." line; else any phone-ish pattern
  let phone = extractAfterEmojiOrLabel(lines, '📞', /^(?:Phone|Tel|Mobile):/i);
  if (!phone) {
    const m = raw.match(/(\+?\d[\d\s().\-]{6,})/);
    phone = m ? m[1].trim() : '';
  }
  const emailMatch = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const email = emailMatch ? emailMatch[0] : '';

  const address = extractAfterEmojiOrLabel(lines, '📍', /^(?:Address|Location):/i);
  const map = extractGoogleMapsUrl(raw);

  const items = extractItems(lines);
  const qty = items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);

  const area = guessArea(address, pickup);

  return {
    ok: true,
    ref,
    // order figures
    total,
    delivery,
    distance_km,
    pickup,
    // identity & location
    customerName: safeTrim(customerName),
    phone: safeTrim(phone),
    email: safeTrim(email),
    address: safeTrim(address),
    map: safeTrim(map) || '',
    area,
    // items
    items,
    qty,
  };
}

module.exports = {
  isLikelyQuestion,
  isOrderSummaryStrict,
  parseOrderFields,
  extractRef,
};
