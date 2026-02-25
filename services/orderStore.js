// services/orderStore.js — EMMA PRO MAX (Render Disk, no Supabase)
// Single source of truth for:
// - saveOrderIntake
// - savePaymentStatus
// - saveDriverEvent
// - exportAllCSV
// - clearAndExportAllCSV
// + dashboards:
// - verifyCreatorLogin
// - getCreatorSummary
// - getLeaderboard
// - listOrders / getLiveOrders

'use strict';

const path = require('path');
const { readJsonSafeSync, writeJsonAtomicSync, withLock, ensureDirSync } = require('./persistDisk');
const { hashPassword, verifyPassword } = require('./security');

const TZ_FALLBACK = 'Africa/Addis_Ababa';

const DATA_DIR = String(process.env.GG_DATA_DIR || '/var/data');
ensureDirSync(DATA_DIR);

const ORDERS_FILE  = path.join(DATA_DIR, 'orders.json');
const ARCHIVE_FILE = path.join(DATA_DIR, 'orders_archive.json');
const CREATORS_FILE= path.join(DATA_DIR, 'creators.json');

function nowIso() { return new Date().toISOString(); }

function localParts(ms = Date.now(), tz = TZ_FALLBACK) {
  try {
    const d = new Date(ms);
    const fmtDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const fmtTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    const [y, m, d2] = fmtDate.format(d).split('-');
    const t = fmtTime.format(d).replace(/\u202F|\u00A0/g, '');
    return { date: `${y}-${m}-${d2}`, time: t };
  } catch {
    const t = new Date(ms);
    const y = t.getUTCFullYear();
    const m = String(t.getUTCMonth() + 1).padStart(2, '0');
    const d = String(t.getUTCDate()).padStart(2, '0');
    const hh = String((t.getUTCHours() + 3) % 24).padStart(2, '0');
    const mm = String(t.getUTCMinutes()).padStart(2, '0');
    const ss = String(t.getUTCSeconds()).padStart(2, '0');
    return { date: `${y}-${m}-${d}`, time: `${hh}:${mm}:${ss}` };
  }
}

function toNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  return v;
}
function num(v, fallback = 0) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}
function intOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function normCode(code) {
  return String(code || '').trim().toUpperCase();
}

function loadOrdersDoc() {
  return readJsonSafeSync(ORDERS_FILE, { orders: {} });
}
function saveOrdersDoc(doc) {
  writeJsonAtomicSync(ORDERS_FILE, doc);
}
function loadArchiveDoc() {
  return readJsonSafeSync(ARCHIVE_FILE, { orders: {} });
}
function saveArchiveDoc(doc) {
  writeJsonAtomicSync(ARCHIVE_FILE, doc);
}
function loadCreatorsDoc() {
  return readJsonSafeSync(CREATORS_FILE, { creators: {} });
}
function saveCreatorsDoc(doc) {
  writeJsonAtomicSync(CREATORS_FILE, doc);
}

// ────────────────────────────────────────────────────────────────────────────────
// Core: save intake (idempotent upsert)
async function saveOrderIntake(fields, ctx, opts = {}) {
  const order_id = String(fields?.order_id || '').trim();
  if (!order_id) return;

  const tz = opts.tz || TZ_FALLBACK;
  const whenMs = opts.nowMs || Date.now();
  const parts = localParts(whenMs, tz);

  const incomingTotal = num(fields.total, 0);
  const incomingDelivery = num(fields.delivery_price, 0);
  const incomingSubtotal = num(fields.coffee_subtotal, Math.max(0, incomingTotal - incomingDelivery));

  const patch = {
    order_id,

    date: toNull(fields.date) || parts.date,
    time_ordered: toNull(fields.time_ordered) || parts.time,

    customer_name: toNull(fields.customer_name),
    email: toNull(fields.email),
    phone: toNull(fields.phone),

    type: toNull(fields.type),
    size: toNull(fields.size),
    roast_level: toNull(fields.roast_level),
    qty: intOrNull(fields.qty),

    // Totals
    delivery_price: incomingDelivery,
    total: incomingTotal,
    coffee_subtotal: incomingSubtotal,

    delivery_location: toNull(fields.delivery_location),
    map_url: toNull(fields.map_url),

    // Creator program
    promo_code: toNull(fields.promo_code) || '',
    promo_pct: num(fields.promo_pct, 0) || 0,

    // optional items array
    items: Array.isArray(fields.items) ? fields.items : [],

    // metadata
    chat_id: ctx?.chat?.id ?? null,
    raw_text: ctx?.message?.text ? String(ctx.message.text).slice(0, 4000) : null,

    updated_at: nowIso(),
  };

  await withLock(async () => {
    const doc = loadOrdersDoc();
    doc.orders = doc.orders || {};

    const existing = doc.orders[order_id] || null;

    const created_at = existing?.created_at || nowIso();
    const payment_status = existing?.payment_status || 'pending';

    // Preserve driver/payment timestamps unless we explicitly set later
    doc.orders[order_id] = {
      ...existing,
      ...patch,
      created_at,
      payment_status,
    };

    saveOrdersDoc(doc);
  });
}

// payment_status: 'pending' | 'approved' | 'rejected'
// In your bot, "approved" = PAID (this is what creator commission uses).
async function savePaymentStatus(order_id, status) {
  const id = String(order_id || '').trim();
  if (!id) return;

  const st = String(status || '').trim().toLowerCase() || 'pending';

  await withLock(async () => {
    const doc = loadOrdersDoc();
    doc.orders = doc.orders || {};
    const existing = doc.orders[id] || { order_id: id, created_at: nowIso() };

    doc.orders[id] = {
      ...existing,
      order_id: id,
      payment_status: st,
      paid_at: (st === 'approved' ? (existing.paid_at || nowIso()) : existing.paid_at || null),
      updated_at: nowIso(),
    };

    saveOrdersDoc(doc);
  });
}

async function saveDriverEvent(order_id, kind, driverName) {
  const id = String(order_id || '').trim();
  if (!id) return;

  const k = String(kind || '').trim().toLowerCase();
  const iso = nowIso();

  await withLock(async () => {
    const doc = loadOrdersDoc();
    doc.orders = doc.orders || {};
    const existing = doc.orders[id] || { order_id: id, created_at: iso };

    const patch = { updated_at: iso };
    if (driverName) patch.driver_name = String(driverName);

    if (k === 'accepted') patch.driver_accepted_time = iso;
    if (k === 'picked')   patch.driver_picked_time = iso;
    if (k === 'delivered')patch.driver_delivered_time = iso;

    doc.orders[id] = { ...existing, ...patch };
    saveOrdersDoc(doc);
  });
}

// ────────────────────────────────────────────────────────────────────────────────
// Admin exports (CSV)
const EXPORT_COLUMNS = [
  'order_id',
  'date',
  'time_ordered',
  'customer_name',
  'email',
  'phone',
  'type',
  'size',
  'roast_level',
  'qty',
  'coffee_subtotal',
  'delivery_price',
  'total',
  'promo_code',
  'promo_pct',
  'delivery_location',
  'map_url',
  'payment_status',
  'driver_name',
  'driver_accepted_time',
  'driver_picked_time',
  'driver_delivered_time',
  'created_at',
  'updated_at',
];

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function rowsToCSV(rows, columns) {
  const header = columns.join(',');
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(','));
  return [header, ...body].join('\n');
}
function allOrdersArray(doc) {
  const orders = (doc && doc.orders) ? doc.orders : {};
  return Object.values(orders || {});
}

async function exportAllCSV() {
  const doc = loadOrdersDoc();
  const rows = allOrdersArray(doc)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  const normalized = rows.map((r) => {
    const out = {};
    for (const c of EXPORT_COLUMNS) out[c] = (r[c] ?? '');
    return out;
  });

  return rowsToCSV(normalized, EXPORT_COLUMNS);
}

async function clearAndExportAllCSV() {
  const csv = await exportAllCSV();

  await withLock(async () => {
    const current = loadOrdersDoc();
    const arch = loadArchiveDoc();

    arch.orders = arch.orders || {};
    current.orders = current.orders || {};

    // move everything to archive
    for (const [id, row] of Object.entries(current.orders)) {
      arch.orders[id] = row;
    }

    // clear live
    current.orders = {};

    saveArchiveDoc(arch);
    saveOrdersDoc(current);
  });

  return csv;
}

// ────────────────────────────────────────────────────────────────────────────────
// Dashboards: orders list + live
async function listOrders({ limit = 200, payment_status = '' } = {}) {
  const doc = loadOrdersDoc();
  let rows = allOrdersArray(doc);

  if (payment_status) {
    const st = String(payment_status).toLowerCase();
    rows = rows.filter((o) => String(o.payment_status || '').toLowerCase() === st);
  }

  rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return rows.slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)));
}

// Used by your /api/live-orders getter in index.js (it tries multiple names)
async function getLiveOrders({ limit = 50 } = {}) {
  return listOrders({ limit });
}
async function listRecentOrders({ limit = 50 } = {}) {
  return listOrders({ limit });
}
async function listLiveOrders({ limit = 50 } = {}) {
  return listOrders({ limit });
}

// ────────────────────────────────────────────────────────────────────────────────
// Creators: credentials + summaries + leaderboard

async function createCreator({ code, password }) {
  const c = normCode(code);
  if (!c) return false;
  if (!password) return false;

  await withLock(async () => {
    const doc = loadCreatorsDoc();
    doc.creators = doc.creators || {};

    if (doc.creators[c]) return;

    const hp = hashPassword(String(password));
    doc.creators[c] = {
      code: c,
      salt: hp.salt,
      hash: hp.hash,
      active: true,
      created_at: nowIso(),
    };
    saveCreatorsDoc(doc);
  });

  return true;
}

async function verifyCreatorLogin({ code, password }) {
  const c = normCode(code);
  if (!c || !password) return false;

  const doc = loadCreatorsDoc();
  const row = doc?.creators?.[c];
  if (!row || row.active === false) return false;

  return verifyPassword(String(password), String(row.salt || ''), String(row.hash || ''));
}

function matchPromo(orderPromo, codeNorm) {
  const p = normCode(orderPromo);
  return !!p && p === codeNorm;
}

async function getCreatorSummary(code) {
  const c = normCode(code);
  if (!c) return {
    ok: false, code: '', paid_orders: 0, revenue: 0, commission: 0,
    breakdown_by_size: {}, items: []
  };

  const doc = loadOrdersDoc();
  const rows = allOrdersArray(doc);

  const paid = rows.filter((o) =>
    String(o.payment_status || '').toLowerCase() === 'approved' &&
    matchPromo(o.promo_code, c)
  );

  let revenue = 0;
  const breakdown_by_size = {}; // size -> { orders, qty, revenue }
  const items = [];

  for (const o of paid) {
    const sub = num(o.coffee_subtotal, 0);
    revenue += sub;

    const sizeKey = String(o.size || '—');
    if (!breakdown_by_size[sizeKey]) breakdown_by_size[sizeKey] = { orders: 0, qty: 0, revenue: 0 };
    breakdown_by_size[sizeKey].orders += 1;
    breakdown_by_size[sizeKey].qty += (intOrNull(o.qty) || 0);
    breakdown_by_size[sizeKey].revenue += sub;

    items.push({
      order_id: o.order_id,
      date: o.date || '',
      time_ordered: o.time_ordered || '',
      size: o.size || '',
      qty: o.qty || 0,
      coffee_subtotal: sub,
      total: num(o.total, 0),
      delivery_price: num(o.delivery_price, 0),
    });
  }

  items.sort((a, b) => String(b.order_id).localeCompare(String(a.order_id)));

  const commission = Math.round(revenue * 0.10);

  return {
    ok: true,
    code: c,
    paid_orders: paid.length,
    revenue: Math.round(revenue),
    commission,
    breakdown_by_size,
    items: items.slice(0, 300), // safety
  };
}

async function getLeaderboard() {
  const creatorsDoc = loadCreatorsDoc();
  const creatorCodes = Object.keys(creatorsDoc?.creators || {}).filter(Boolean);

  // If no creators saved yet, leaderboard is empty (secure, no random codes).
  if (!creatorCodes.length) {
    return { ok: true, total_creators: 0, rows: [] };
  }

  const rows = [];
  for (const code of creatorCodes) {
    // eslint-disable-next-line no-await-in-loop
    const sum = await getCreatorSummary(code);
    rows.push({
      code: sum.code,
      paid_orders: sum.paid_orders,
      revenue: sum.revenue,
      commission: sum.commission,
    });
  }

  rows.sort((a, b) => {
    if (b.revenue !== a.revenue) return b.revenue - a.revenue;
    return b.paid_orders - a.paid_orders;
  });

  // attach ranks
  const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));

  return { ok: true, total_creators: ranked.length, rows: ranked };
}

module.exports = {
  // existing bot calls (keep names)
  saveOrderIntake,
  savePaymentStatus,
  saveDriverEvent,
  exportAllCSV,
  clearAndExportAllCSV,

  // live/api compatibility
  getLiveOrders,
  listLiveOrders,
  listRecentOrders,
  listOrders,

  // creator program
  createCreator,
  verifyCreatorLogin,
  getCreatorSummary,
  getLeaderboard,
};
