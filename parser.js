// parser.js — tolerant order detection & field extraction (Green Gold)
// API: isLikelyQuestion, isOrderSummaryStrict, parseOrderFields, extractRef
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
    'how','where','why','help','support','problem','issue',
    'can you','please call','pls call','pls help',
    'ረዳ','እርዳ','መርዳት','ረዳኝ'
  ];
  return triggers.some(w => s.includes(w));
}

function extractRef(text) {
  if (!text) return '';
  const mDash = text.match(/(?:^|\s)(GG-\d{8}-\d{6}-[A-Z0-9_-]{3,})/i);
  if (mDash) return mDash[1];
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
    /GG-\d{8}-\d{6}-[A-Z0-9_-]{3,}/i,
    /GG[_-][A-Z0-9][A-Z0-9_\-]*/i,
    /Total:\s*ETB\s*[\d,]+/i,
    /Delivery\s*Fee:\s*ETB\s*[\d,]+/i,
    /\s*Roast:/i,
    /https?:\/\/(?:www\.)?google\.com\/maps\//i,
    /place_id:/i,
    /\s*Address:/i,
    /\bPromo\s*:/i,
  ];

  let score = 0;
  for (const a of anchors) if (a.test(s)) score++;
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
function safeTrim(s) { return (s || '').toString().trim(); }
function splitLines(text) {
  return String(text).replace(/\r/g, '')
    .split('\n').map(s => s.trim()).filter(Boolean);
}

// Unicode-safe strip (keeps Amharic too)
function stripLeadingNonText(line) {
  return String(line || '').replace(/^[^\p{L}\p{N}+]+/u, '').trim();
}

// ✅ if emoji is empty, skip emoji search
function extractAfterEmojiOrLabel(lines, emoji, labelRegex) {
  const emo = (typeof emoji === 'string' && emoji.length > 0) ? emoji : null;

  if (emo) {
    for (const line of lines) {
      const idx = line.indexOf(emo);
      if (idx >= 0) return line.slice(idx + emo.length).replace(/^[:\-–\s]+/, '').trim();
    }
  }

  if (labelRegex) {
    for (const line of lines) {
      const cleaned = stripLeadingNonText(line);
      const m = cleaned.match(labelRegex);
      if (m) {
        const i = (m.index ?? 0) + m[0].length;
        return cleaned.slice(i).replace(/^[:\-–\s]+/, '').trim();
      }
    }
  }

  return '';
}

function extractGoogleMapsUrl(text) {
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

function deriveDateTimeFromRef(ref) {
  if (!ref) return { date_iso:null, date:null, time_hms:null, time_ordered:null };
  let m = ref.match(/^GG-(\d{8})-(\d{6})-/i);
  if (m) {
    const y=m[1].slice(0,4), M=m[1].slice(4,6), d=m[1].slice(6,8);
    const hh=m[2].slice(0,2), mm=m[2].slice(2,4), ss=m[2].slice(4,6);
    return { date_iso:`${y}-${M}-${d}`, date:`${d}/${M}/${y}`, time_hms:`${hh}:${mm}:${ss}`, time_ordered:`${hh}:${mm}` };
  }
  return { date_iso:null, date:null, time_hms:null, time_ordered:null };
}

// -------------------- PROMO parser --------------------
function normCode(c){ return safeTrim(c).toUpperCase(); }

function parsePromo(rawText){
  const text = String(rawText || '');

  // "🏷️ Promo: CODE (5% OFF)" or "Promo: CODE (5% OFF)"
  let m = text.match(/Promo\s*:\s*([^\n(]+)\s*\((\d+)\s*%\s*OFF\)/i);
  if (m) return { promo_code: normCode(m[1]), promo_pct: Number(m[2] || 0) || 0 };

  // "Promo Code: CODE (5% OFF)"
  m = text.match(/Promo\s*Code:\s*([^\n(]+)\s*\((\d+)\s*%\s*OFF\)/i);
  if (m) return { promo_code: normCode(m[1]), promo_pct: Number(m[2] || 0) || 0 };

  // "Order Details (Promo: CODE):" (allow trailing colon)
  m = text.match(/Order\s*Details\s*\(Promo:\s*([^)]+)\)\s*:?/i);
  if (m) return { promo_code: normCode(m[1]), promo_pct: 0 };

  return { promo_code: '', promo_pct: 0 };
}

// -------------------- items parser --------------------
function extractItems(lines) {
  const items = [];
  let cur = null;
  function ensureItem(){ if(!cur) cur={ roast:'', type:'', size_g:0, qty:0, unit_price:0, line_total:0 }; }
  function pushIfFilled(){
    if(!cur) return;
    const touched = cur.roast||cur.type||cur.size_g||cur.qty||cur.unit_price||cur.line_total;
    if(touched) items.push({ ...cur });
    cur=null;
  }

  for (let i=0;i<lines.length;i++){
    const L = lines[i];

    if (/\s*Roast:/i.test(L) || /^Roast:/i.test(L)){
      pushIfFilled(); ensureItem();
      const m=L.match(/Roast:\s*([A-Za-z]+)/i);
      if(m) cur.roast=m[1];
      continue;
    }
    if (/\s*Type:/i.test(L) || /^Type:/i.test(L)){
      ensureItem();
      const m=L.match(/Type:\s*([A-Za-z]+)/i);
      if(m) cur.type=m[1];
      continue;
    }
    if (/⚖️\s*Size:/i.test(L) || /^Size:/i.test(L)){
      ensureItem();
      const m=L.match(/Size:\s*([\d.,]+)\s*g/i);
      if(m) cur.size_g=Math.round(parseFloat(m[1].replace(',', '.')));
      continue;
    }
    if (/\s*Qty:/i.test(L) || /^Qty:/i.test(L)){
      ensureItem();
      const m=L.match(/Qty:\s*(\d+)/i);
      if(m) cur.qty=parseInt(m[1],10);
      continue;
    }
    if (/ETB/i.test(L)){
      ensureItem();
      const unit=L.match(/ETB\s*([\d,]+)\s*(?:x|×)?/i);
      const qty=L.match(/x\s*(\d+)/i);
      const line=L.match(/=\s*ETB\s*([\d,]+)/i);
      if(unit) cur.unit_price=cleanMoney(unit[1]);
      if(qty) cur.qty=cur.qty||parseInt(qty[1],10);
      if(line) cur.line_total=cleanMoney(line[1]);
      continue;
    }
  }

  pushIfFilled();
  return items;
}
function choosePrimaryItem(items){
  if(!items||!items.length) return null;
  const sorted=[...items].sort((a,b)=>{
    const qa=Number(a.qty||0), qb=Number(b.qty||0); if(qb!==qa) return qb-qa;
    const la=Number(a.line_total||0), lb=Number(b.line_total||0); if(lb!==la) return lb-la;
    const sa=Number(a.size_g||0), sb=Number(b.size_g||0); return sb-sa;
  });
  return sorted[0];
}

// -------------------- name/phone extraction --------------------
function normalizeName(s) {
  const x = safeTrim(s).replace(/^["']|["']$/g, '');
  if (!x) return '';
  if (/GG[-_]/i.test(x)) return '';
  if (/Order\s*ID/i.test(x)) return '';
  if (x.length > 120) return '';
  return x;
}

function looksLikeRealPhone(s) {
  const x = safeTrim(s);
  if (!x) return false;
  if (/[A-Za-z]/.test(x)) return false;

  const digits = x.replace(/[^\d]/g, '');
  if (digits.length < 9 || digits.length > 15) return false;

  // Accept formats:
  // +251..., 251..., 09..., 07..., 9xxxxxxxx
  if (x.startsWith('+251')) return true;
  if (digits.startsWith('251')) return true;
  if (x.startsWith('09') || x.startsWith('07')) return true;
  if (/^9\d{8,}$/.test(digits)) return true; // e.g. 902605253

  return false;
}

function findBestName(lines) {
  const byLabel = extractAfterEmojiOrLabel(lines, null, /^(?:Customer\s*Name|Customer|Name):/i);
  const n1 = normalizeName(byLabel);
  if (n1) return n1;

  const byEmoji = extractAfterEmojiOrLabel(lines, '👤', null);
  const n2 = normalizeName(byEmoji);
  if (n2) return n2;

  // "it's "Name""
  for (const line of lines) {
    const m = line.match(/it's\s*"([^"]+)"/i);
    if (m && m[1]) {
      const n3 = normalizeName(m[1]);
      if (n3) return n3;
    }
  }
  return '';
}

function findBestPhone(lines, raw) {
  const byEmoji = extractAfterEmojiOrLabel(lines, '📞', null);
  if (looksLikeRealPhone(byEmoji)) return byEmoji;

  const byLabel = extractAfterEmojiOrLabel(lines, null, /^(?:Phone|Tel|Mobile):/i);
  if (looksLikeRealPhone(byLabel)) return byLabel;

  // Scan candidates but reject Order-ID/date lines
  const matches = raw.match(/(\+?\d[\d\s().\-]{6,})/g) || [];
  const rawLines = raw.split('\n');

  for (const cand of matches) {
    const c = safeTrim(cand);
    if (!looksLikeRealPhone(c)) continue;

    const hostLine = rawLines.find(L => L.includes(c)) || '';
    if (/GG-\d{8}-\d{6}/i.test(hostLine)) continue;
    if (/Order\s*ID|Total|Delivery|Distance|ETB|Qty|Size|Roast|Type/i.test(hostLine)) continue;

    return c;
  }
  return '';
}

// -------------------- main parser --------------------
function parseOrderFields(text, opts = {}) {
  const minLen = Number(opts.minTextLength ?? STRICT_DEFAULTS.minTextLength);
  if (!text || text.length < minLen) return { ok:false, reason:'too_short' };

  const raw = String(text);
  const lines = splitLines(raw);

  const ref = extractRef(raw);

  const totalM = raw.match(/Total:\s*ETB\s*([\d,]+)/i);
  const total = totalM ? cleanMoney(totalM[1]) : 0;

  const delM = raw.match(/Delivery\s*Fee:\s*ETB\s*([\d,]+)/i);
  const delivery = delM ? cleanMoney(delM[1]) : 0;

  const distM = raw.match(/Distance:\s*([\d.]+)\s*km/i);
  const distance_km = distM ? toFloat(distM[1]) : 0;

  const pickup = extractAfterEmojiOrLabel(lines, null, /^(?:Pickup|Pick\s*up|Store|Hub):/i);

  const customerName = findBestName(lines);
  const phone = findBestPhone(lines, raw);

  const emailByEmoji = extractAfterEmojiOrLabel(lines, '📧', null);
  const emailMatch =
    (emailByEmoji && emailByEmoji.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)) ||
    raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const email = emailMatch ? emailMatch[0] : '';

  const address = extractAfterEmojiOrLabel(lines, null, /^(?:Address|Location):/i);
  const map = extractGoogleMapsUrl(raw);

  const items = extractItems(lines);
  const qty = items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
  const primary = choosePrimaryItem(items);

  const type = primary?.type || '';
  const roast = primary?.roast || '';
  const size = primary?.size_g ? `${primary.size_g}g` : '';
  const area = guessArea(address, pickup);

  const { date_iso, date, time_hms, time_ordered } = deriveDateTimeFromRef(ref);

  const promo = parsePromo(raw);

  return {
    ok: true,
    ref,

    total,
    delivery,
    distance_km,
    pickup,

    customerName: safeTrim(customerName),
    phone: safeTrim(phone),
    email: safeTrim(email),
    address: safeTrim(address),
    map: safeTrim(map) || '',
    area,

    items,
    qty,

    type,
    roast,
    size,

    date_iso,
    date,
    time_hms,
    time_ordered,

    promo_code: promo.promo_code || '',
    promo_pct: promo.promo_pct || 0,
  };
}

module.exports = {
  isLikelyQuestion,
  isOrderSummaryStrict,
  parseOrderFields,
  extractRef,
};
