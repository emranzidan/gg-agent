'use strict';

/**
 * Memory interface for GreenGold orders.
 * Single source of truth: Supabase.
 *
 * Exposes:
 *   - persist(row, phase)         // upsert by order_id, applies phase-specific fields
 *   - fetchAllOrders(range?)      // fetch rows for export
 *   - toCSV(rows)                 // turn rows into CSV with your exact column order
 *   - health()
 *
 * Phases:
 *   'payment_confirmed' | 'driver_accepted' | 'driver_picked' | 'delivered'
 *
 * Env:
 *   STORAGE_MODE=supabase
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_KEY=...
 */

const SUPPORTED = new Set(['supabase']);
const mode = (process.env.STORAGE_MODE || 'supabase').toLowerCase();

if (!SUPPORTED.has(mode)) {
  throw new Error(`Unsupported STORAGE_MODE=${mode}. Use 'supabase'.`);
}

const supabase = require('./adapters/supabase'); // File 1/3 you already created

// ----------------------- helpers -----------------------

function pad2(n) { return String(n).padStart(2, '0'); }

function tzNowParts(tz = 'Africa/Addis_Ababa', fromMs = null) {
  const d = fromMs ? new Date(fromMs) : new Date();
  // Date in tz
  const fmtDate = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const [dd, mm, yyyy] = fmtDate.format(d).split('/');
  const dateDDMMYYYY = `${dd}/${mm}/${yyyy}`;              // for human CSV
  const timeHHMM = fmtTime.format(d);                      // 'HH:MM'
  const isoDate = `${yyyy}-${mm}-${dd}`;                   // 'YYYY-MM-DD' for DB
  return { dateDDMMYYYY, timeHHMM, isoDate };
}

function pick(v, fallback=null) {
  return (v === undefined || v === null || v === '') ? fallback : v;
}

// Normalize to your 18 columns exactly (names must match Supabase table)
function normalizeForTable(row = {}) {
  return {
    order_id:              String(row.order_id || '').trim(),

    date:                  row.date || null,               // 'YYYY-MM-DD' OR 'DD/MM/YYYY' (adapter coerces)
    time_ordered:          row.time_ordered || null,       // 'HH:MM' or 'HH:MM:SS'

    customer_name:         pick(row.customer_name, null),
    email:                 pick(row.email, null),
    phone:                 pick(row.phone, null),

    payment_status:        pick(row.payment_status, null), // 'approved' | 'pending' | 'rejected'
    driver_name:           pick(row.driver_name, null),

    driver_accepted_time:  row.driver_accepted_time || null,   // 'HH:MM'
    driver_picked_time:    row.driver_picked_time   || null,
    driver_delivered_time: row.driver_delivered_time|| null,

    delivery_location:     pick(row.delivery_location, null),

    product_price:         row.product_price ?? null,      // numeric
    delivery_price:        row.delivery_price ?? null,     // numeric

    type_chosen:           pick(row.type_chosen, null),    // Beans | Powder
    roast_level:           pick(row.roast_level, null),    // Light | Medium | Dark
    size:                  pick(row.size, null),           // e.g., 1000g
    qty:                   (row.qty != null ? parseInt(row.qty, 10) : null)
  };
}

// Merge phase-specific fields
function applyPhase(baseRow, phase, opts = {}) {
  const out = { ...baseRow };
  const tz = opts.tz || 'Africa/Addis_Ababa';
  const refStartMs = opts.createdAtMs || Date.now();
  const nowParts = tzNowParts(tz);

  switch (phase) {
    case 'payment_confirmed': {
      // ensure date/time_ordered present (from createdAt if provided)
      const when = tzNowParts(tz, refStartMs);
      if (!out.date) out.date = when.isoDate;
      if (!out.time_ordered) out.time_ordered = when.timeHHMM;
      if (!out.payment_status) out.payment_status = 'approved';
      break;
    }
    case 'driver_accepted': {
      if (!out.driver_accepted_time) out.driver_accepted_time = nowParts.timeHHMM;
      break;
    }
    case 'driver_picked': {
      if (!out.driver_picked_time) out.driver_picked_time = nowParts.timeHHMM;
      break;
    }
    case 'delivered': {
      if (!out.driver_delivered_time) out.driver_delivered_time = nowParts.timeHHMM;
      break;
    }
    default:
      // no-op
      break;
  }
  return out;
}

// ----------------------- public API -----------------------

async function persist(row, phase, opts = {}) {
  if (!row || !row.order_id) throw new Error('persist() requires row.order_id');
  const tableRow = normalizeForTable(row);
  const phased   = applyPhase(tableRow, phase, opts);

  // Route to adapter
  const data = await supabase.upsert(phased);
  return { ok: true, order_id: data.order_id };
}

async function fetchAllOrders(range = {}) {
  // range: {fromDate: 'YYYY-MM-DD'|'DD/MM/YYYY', toDate: same}
  return await supabase.fetchAll(range);
}

function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// CSV in your exact column order
function toCSV(rows = []) {
  const header = [
    'order_id','date','time_ordered','customer_name','email','phone',
    'payment_status','driver_name','driver_accepted_time','driver_picked_time','driver_delivered_time',
    'delivery_location','product_price','delivery_price','type_chosen','roast_level','size','qty'
  ];

  const lines = [header.join(',')];

  for (const r of rows) {
    // format date/time for CSV readability
    let dateOut = '';
    if (r.date) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
        const [Y,M,D] = r.date.split('-');
        dateOut = `${D}/${M}/${Y}`; // DD/MM/YYYY
      } else {
        dateOut = r.date; // already human
      }
    }
    const rowOut = [
      r.order_id ?? '',
      dateOut,
      (r.time_ordered || '')?.toString().slice(0,5),      // HH:MM
      r.customer_name ?? '',
      r.email ?? '',
      r.phone ?? '',
      r.payment_status ?? '',
      r.driver_name ?? '',
      (r.driver_accepted_time || '')?.toString().slice(0,5),
      (r.driver_picked_time   || '')?.toString().slice(0,5),
      (r.driver_delivered_time|| '')?.toString().slice(0,5),
      r.delivery_location ?? '',
      r.product_price ?? '',
      r.delivery_price ?? '',
      r.type_chosen ?? '',
      r.roast_level ?? '',
      r.size ?? '',
      (r.qty ?? '').toString()
    ].map(escapeCSV);

    lines.push(rowOut.join(','));
  }

  return lines.join('\n');
}

async function health() {
  return await supabase.health();
}

module.exports = {
  persist,
  fetchAllOrders,
  toCSV,
  health
};
