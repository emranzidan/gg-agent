// parser.js — EMMA order parsing & intent detection
// Keep all “what counts as an order” logic here so index.js can stay stable.

'use strict';

// ---------- Regex anchors (exported for debugging/tests) ----------
const REF_PATTERN   = /\bGG-\d{8}-\d{6}-[A-Z0-9]{4}\b/;              // GG-YYYYMMDD-HHMMSS-XXXX
const ORDER_HEADER  = /(?:^|\n)\s*🧾\s*Order\s*ID\s*:\s*GG-/i;       // "🧾 Order ID: GG-..."
const HAS_TOTAL     = /\bTotal\s*:\s*ETB\s*[0-9][0-9,.]*/i;
const HAS_ETB       = /\bETB\b/i;
const HAS_QTY       = /\b(Qty|Quantity)\b|\bx\s*\d+/i;
const MAP_URL_RX    = /https?:\/\/(?:maps\.google|goo\.gl)\/[^\s)]+/i;
const PHONE_RX_251  = /\+?251[-\s.]?\d{9}\b/;
const PHONE_RX_09   = /\b0?9\d{8}\b/;

// ---------- Helpers ----------
const clean = (s = '') => s.replace(/\s+/g, ' ').trim();
const first = (arr, idx = 1) => (arr && arr[idx]) || '';

function normPhone(p) {
  if (!p) return '';
  let x = p.replace(/[^\d+]/g, '');
  if (x.startsWith('0')) x = '+251' + x.slice(1);
  if (!x.startsWith('+')) x = '+' + x;
  return x;
}

// ---------- Public: question detector (for support escalation) ----------
function isLikelyQuestion(text = '') {
  if (!text) return false;
  if (/[?؟]/.test(text)) return true;
  if (/\b(help|support|problem|issue|እርዳታ|ረዳ|ጥያቄ)\b/i.test(text)) return true;
  return false;
}

// ---------- Public: strict order detector ----------
/**
 * Determine if a DM text looks like a real order summary.
 * @param {string} text - raw incoming message
 * @param {object} opts - { strictMode=true, minTextLength=50 }
 */
function isOrderSummaryStrict(text = '', opts = {}) {
  const strictMode    = opts.strictMode !== false; // default true
  const minLen        = Number.isFinite(opts.minTextLength) ? opts.minTextLength : 50;

  const t = text;
  if (!t || t.length < minLen) return false;

  // Primary rule: proper header + ref + any money signal
  const byHeader  = ORDER_HEADER.test(t) && REF_PATTERN.test(t) && (HAS_TOTAL.test(t) || HAS_ETB.test(t));

  // Secondary rule: ref + ETB + any quantity signal
  const bySignals = REF_PATTERN.test(t) && HAS_ETB.test(t) && HAS_QTY.test(t);

  // In non-strict mode, allow “ref + ETB” if the message is long enough
  const relaxed   = !strictMode && REF_PATTERN.test(t) && HAS_ETB.test(t);

  return byHeader || bySignals || relaxed;
}

// ---------- Public: extract useful fields for ops/driver cards ----------
/**
 * Parse fields from an order summary.
 * Returns: { ref, qty, total, delivery, area, map, phone, customerName }
 */
function parseOrderFields(text = '') {
  const t = text;

  // Reference
  const ref = first(t.match(REF_PATTERN)) || '';

  // Quantity
  let qty =
    first(t.match(/\bqty[:\s]*([0-9]+)\b/i)) ||
    first(t.match(/\bquantity[:\s]*([0-9]+)\b/i)) ||
    first(t.match(/\bx\s*([0-9]+)\b/i)) ||
    first(t.match(/\bitems?[:\s]*([0-9]+)\b/i)) ||
    '—';

  // Total ETB
  // Matches: "Total: ETB 7,600" or "... = ETB 7600" or "ETB 7600 total"
  let total =
    first(t.match(/\bTotal\s*:\s*ETB\s*([0-9][0-9,.]*)/i)) ||
    first(t.match(/=\s*ETB\s*([0-9][0-9,.]*)/i)) ||
    first(t.match(/\bETB\s*([0-9][0-9,.]*)\s*total\b/i)) ||
    '—';
  if (total !== '—') total = total.replace(/[,]/g, '');

  // Delivery fee (many ways users phrase it)
  let delivery =
    first(t.match(/\bDelivery(?:\s*Fee)?\s*:\s*ETB\s*([0-9][0-9,.]*)/i)) ||
    first(t.match(/\bETB\s*([0-9][0-9,.]*)\s*(?:delivery|delivery\s*fee)\b/i)) ||
    first(t.match(/\bጭነት[^0-9]*([0-9][0-9,.]*)\s*ETB\b/)) ||
    '—';
  if (delivery !== '—') delivery = delivery.replace(/[,]/g, '');

  // Area / Address (take only the rest of the line)
  let area =
    first(t.match(/(?:Address|Area|አካባቢ|ቦታ)\s*:\s*(.+)/i)) ||
    first(t.match(/(?:Pickup|ማንሳት)\s*:\s*(.+)/i)) ||
    '—';
  if (area !== '—') area = area.split('\n')[0].trim();

  // Map URL
  let map = first(t.match(MAP_URL_RX)) || '—';

  // Phone (normalize to +2519xxxxxxxx if starts with 09)
  let phone = first(t.match(PHONE_RX_251)) || first(t.match(PHONE_RX_09)) || '';
  phone = normPhone(phone);

  // Customer name (best-effort)
  let customerName =
    clean(first(t.match(/(?:^|\n)\s*👤\s*([^@\n]{2,64})/))) || // after 👤
    clean(first(t.match(/(?:^|\n)\s*Name\s*:\s*([^\n]{2,64})/i))) ||
    '';

  return {
    ref: ref || '',
    qty: qty || '—',
    total: total || '—',
    delivery: delivery || '—',
    area: area || '—',
    map: map || '—',
    phone,
    customerName
  };
}

// ---------- Public: tiny helpers the bot may want ----------
function extractRef(text = '') {
  return first(text.match(REF_PATTERN)) || '';
}

module.exports = {
  // regex for tests
  REF_PATTERN,
  ORDER_HEADER,
  HAS_TOTAL,
  HAS_ETB,
  HAS_QTY,
  MAP_URL_RX,

  // core API
  isLikelyQuestion,
  isOrderSummaryStrict,
  parseOrderFields,
  extractRef
};
