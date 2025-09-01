// parser.js — tolerant order detection & field extraction (Green Gold)
// API: isLikelyQuestion, isOrderSummaryStrict, parseOrderFields, extractRef
// Extracts from emoji-rich summaries and multiple ID styles.
// Supports refs like "GG-20250831-235519-D1XB" and "GG_TEST_20250831_1952" and "GG_9JOW".

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

// Robustly pick the first GG reference (dash or underscore styles)
function extractRef(text) {
  if (!text) return '';
  // Try full dash style first: GG-YYYYMMDD-HHMMSS-XXXX
  const mDash = text.match(/(?:^|\s)(GG-\d{8}-\d{6}-[A-Z0-9_-]{3,})/i);
  if (mDash) return mDash[1];

  // Fallback: any GG_ token up to whitespace/punct
  const mUnder = text.match(/(?:^|\s)(GG[_-][A-Z0-9][A-Z0-9_\-]*)/i);
  if (mUnder) return mUnder[1];

  return '';
}

function isOrderSummaryStrict(text, opts = {}) {
  if (!text) return false;
  const s = String(text);
  const strictMode = !!(opts.strictMode ?? STRICT_DEFAULTS.strictMode);
  const minLen = Number(opts.minTextLength ?? STRICT_DEFAULTS.minTextLength);

  if (s.length < minLen) return false;

  const anchors = [
    /GG-\d{8}-\d{6}-[A-Z0-9_-]{3,}/i,     // Dash ref
    /GG[_-][A-Z0-9][A-Z0-9_\-]*/i,        // Underscore/loose ref
    /Total:\s*ETB\s*[\d,]+/i,             // Total line
    /Delivery\s*Fee:\s*ETB\s*[\d,]+/i,    // Delivery fee
    /🫘\s*Roast:/i, /Roast:\s*[A-Za-z]/i,  // Any item block
    /📞/i, /Phone:/i,                      // Phone
    /https?:\/\/(?:www\.)?google\.com\/maps\//i, /place_id:/i, // Map
    /📍\s*Address:/i, /Address:/i,        // Address
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
  const a = safeTrim(address);
  if (a) {
    const seg = a.split(',').map(s => s.trim()).filter(Boolean)[0];
    if (seg) return seg;
  }
  const p = safeTrim(pickup);
  return p || '—';
}

function leftPad2(n) { n = String(n); return n.length === 1 ? '0' + n : n; }
function deriveDateTimeFromRef(ref) {
  // Returns: { date_iso: 'YYYY-MM-DD', date: 'DD/MM/YYYY', time_hms: 'HH:MM:SS', time_ordered: 'HH:MM' } or nulls
  if (!ref) return { date_iso: null, date: null, time_hms: null, time_ordered: null };

  // GG-YYYYMMDD-HHMMSS-XXXX
  let m = ref.match(/^GG-(\d{8})-(\d{6})-/i);
  if (m) {
    const y = m[1].slice(0,4), M = m[1].slice(4,6), d = m[1].slice(6,8);
    const hh = m[2].slice(0,2), mm = m[2].slice(2,4), ss = m[2].slice(4,6);
    return {
      date_iso: `${y}-${M}-${d}`,
      date: `${d}/${M}/${y}`,
      time_hms: `${hh}:${mm}:${ss}`,
      time_ordered: `${hh}:${mm}`,
    };
  }

  // GG_*_YYYYMMDD_HHMM (e.g., GG_TEST_20250831_1952) or GG_*_YYYYMMDDHHMM
  m = ref.match(/(\d{8})[_-]?(\d{4,6})$/);
  if (m) {
    const y = m[1].slice(0,4), M = m[1].slice(4,6), d = m[1].slice(6,8);
    const hh = m[2].slice(0,2), mm = m[2].slice(2,4), ss = m[2].length === 6 ? m[2].slice(4,6) : '00';
    return {
      date_iso: `${y}-${M}-${d}`,
      date: `${d}/${M}/${y}`,
      time_hms: `${hh}:${mm}:${ss}`,
      time_ordered: `${hh}:${mm}`,
    };
  }

  return { date_iso: null, date: null, time_hms: null, time_ordered: null };
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
    const touched = cur.roast || cur.type || cur.size_g || cur.qty || cur.unit_price || cur.line_total;
    if (touched) items.push({ ...cur });
    cur = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];

    // New item often starts at Roast
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
      // e.g., Size: 250 g, 1000 g, 250g
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
      // 💸 ETB 2125 x 2 = ETB 4250
      ensureItem();
      const unit = L.match(/ETB\s*([\d,]+)\s*(?:x|×)?/i);
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

function choosePrimaryItem(items) {
  if (!items || !items.length) return null;
  // Sort by qty desc, then line_total desc, then size_g desc
  const sorted = [...items].sort((a, b) => {
    const qa = Number(a.qty || 0), qb = Number(b.qty || 0);
    if (qb !== qa) return qb - qa;
    const la = Number(a.line_total || 0), lb = Number(b.line_total || 0);
    if (lb !== la) return lb - la;
    const sa = Number(a.size_g || 0), sb = Number(b.size_g || 0);
    return sb - sa;
  });
  return sorted[0];
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

  // Items + top-level (dominant) fields for compatibility
  const items = extractItems(lines);
  const qty = items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);

  const primary = choosePrimaryItem(items);
  const type  = primary?.type  || '';
  const roast = primary?.roast || '';
  // top-level size as a friendly string (e.g., "1000g")
  const size  = primary?.size_g ? `${primary.size_g}g` : '';

  const area = guessArea(address, pickup);

  // Optional date/time derivation from ref
  const { date_iso, date, time_hms, time_ordered } = deriveDateTimeFromRef(ref);

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
    // convenient single-item style (dominant)
    type,
    roast,
    size,
    // derived timestamps (non-breaking extras)
    date_iso,       // "YYYY-MM-DD"
    date,           // "DD/MM/YYYY"
    time_hms,       // "HH:MM:SS"
    time_ordered,   // "HH:MM"
  };
}

module.exports = {
  isLikelyQuestion,
  isOrderSummaryStrict,
  parseOrderFields,
  extractRef,
};
