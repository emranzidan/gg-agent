// index.js — GreenGold EMMA (God Mode, Supabase memory wired)
// Stable entrypoint. Conversations are handled in ./flows/customerBotFlow.js
// State & refs live in ./core/session.js. Parsing in ./parser.js
'use strict';

// ────────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs   = require('fs');
const path = require('path');

// EMMA: NEW storage + export wiring (replaces old memory/export attempt)
const store = require('./services/orderStore');                  // NEW
const wireAdminExportFlow = require('./flows/adminExportFlow');  // NEW

// Order detection / parsing brain
const {
  isLikelyQuestion,
  isOrderSummaryStrict,
  parseOrderFields,
  extractRef
} = require('./parser');

// ────────────────────────────────────────────────────────────────────────────────
// Paths
const ROOT = __dirname;
const FEATURES_FILE = path.join(ROOT, 'features.json');
const MESSAGES_FILE = path.join(ROOT, 'messages.json');
const DRIVERS_FILE  = path.join(ROOT, 'drivers.json');

// Globals (live-reloadable)
let FEATURES = {};
let MSG = {};
const drivers = new Map(); // id -> {id, name, phone}

// Loaders
function safeReadJSON(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Failed reading ${file}:`, e.message);
    return fallback;
  }
}
function loadFeatures() {
  const f = safeReadJSON(FEATURES_FILE, {});
  // defaults
  FEATURES = {
    time: { timezone: 'Africa/Addis_Ababa', cutoffHourLocal: 18, ...(f.time || {}) },
    flows: {
      holdSeconds: 60,
      buttonTtlSeconds: 900,
      driverWindowMinutes: 30,
      driverGiveUpMinutes: 2,
      allowNewOrderWhileActive: true,
      deepLinkTtlMs: 30*60*1000,
      sessionTtlMinutes: 90,
      tinEnabled: true,
      ...(f.flows || {})
    },
    intake: { strictMode: true, escalateOnQuestion: true, minTextLength: 50, ...(f.intake || {}) },
    support: { enabled: true, phone: '+251 2601986', ...(f.support || {}) },
    flags: {
      flagDuplicateReceipts: true,
      flagForwardedReceipts: true,
      reReviewOnUndo: true,
      opsUnassignEnabled: false,
      sheetsExportEnabled: false,
      notifySupersede: true,
      ...(f.flags || {})
    },
    ops: { approveScope: 'members', rateLimitMs: 1500, ...(f.ops || {}) },
    broadcast: { language: 'am', shortCard: true, ...(f.broadcast || {}) },
    _meta: f._meta || { version: '1.0' }
  };
}
function loadMessages() {
  const m = safeReadJSON(MESSAGES_FILE, {});
  MSG = m || {};
}
function loadDriversFromFile() {
  drivers.clear();
  const arr = safeReadJSON(DRIVERS_FILE, []);
  if (Array.isArray(arr)) {
    for (const d of arr) {
      const id = Number(d.id);
      if (!Number.isFinite(id)) continue;
      const name  = String(d.name  || '').trim();
      const phone = String(d.phone || '').trim();
      if (!name || !phone) continue;
      drivers.set(id, { id, name, phone });
    }
  }
  console.log(`Drivers loaded: ${drivers.size}`);
}
function exportDriversJson() {
  return JSON.stringify(
    [...drivers.values()].map(d => ({ id: d.id, name: d.name, phone: d.phone })),
    null, 2
  );
}

// Initial load
loadFeatures();
loadMessages();
loadDriversFromFile();

// ────────────────────────────────────────────────────────────────────────────────
// Bot config (env + features)
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('Missing BOT_TOKEN'); process.exit(1); }

const OWNER_IDS = String(process.env.OWNER_IDS || '')
  .split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
if (OWNER_IDS.length === 0) console.warn('WARNING: OWNER_IDS not set.');

// Chat IDs from env
let STAFF_GROUP_ID   = process.env.STAFF_GROUP_ID   ? Number(process.env.STAFF_GROUP_ID)   : null;
let SUPPORT_GROUP_ID = process.env.SUPPORT_GROUP_ID ? Number(process.env.SUPPORT_GROUP_ID) : null;

// Sheets webhook env (optional)
const SHEETS_URL    = process.env.SHEETS_WEBHOOK_URL || '';
const SHEETS_SECRET = process.env.SHEETS_SECRET || '';

// Derived runtime knobs
let APPROVE_SCOPE, RATE_LIMIT_MS, HOLD_SECONDS, BUTTON_TTL_SEC, DRIVER_WINDOW_MS, GIVEUP_MS, ALLOW_NEW_ORDER;
let SUPPORT_ENABLED, SUPPORT_PHONE, DUP_FLAG, FWD_FLAG, RE_REVIEW_ON_UNDO, OPS_UNASSIGN_EN, TIMEZONE, CUTOFF_HOUR, NOTIFY_SUPERSEDE;

function refreshDerived() {
  APPROVE_SCOPE     = String(process.env.APPROVE_SCOPE || FEATURES.ops.approveScope || 'members').toLowerCase();
  RATE_LIMIT_MS     = Number(process.env.RATE_LIMIT_MS || FEATURES.ops.rateLimitMs || 1500);
  HOLD_SECONDS      = Number(process.env.HOLD_SECONDS || FEATURES.flows.holdSeconds || 60);
  BUTTON_TTL_SEC    = Number(process.env.BUTTON_TTL_SEC || FEATURES.flows.buttonTtlSeconds || 900);
  DRIVER_WINDOW_MS  = Number(process.env.DRIVER_WINDOW_MS || (FEATURES.flows.driverWindowMinutes * 60 * 1000));
  GIVEUP_MS         = Number((FEATURES.flows.driverGiveUpMinutes || 2) * 60 * 1000);
  ALLOW_NEW_ORDER   = !!FEATURES.flows.allowNewOrderWhileActive;

  SUPPORT_ENABLED   = !!FEATURES.support.enabled;
  SUPPORT_PHONE     = String(process.env.SUPPORT_PHONE || FEATURES.support.phone || '+251 2601986');

  DUP_FLAG          = !!FEATURES.flags.flagDuplicateReceipts;
  FWD_FLAG          = !!FEATURES.flags.flagForwardedReceipts;
  RE_REVIEW_ON_UNDO = !!FEATURES.flags.reReviewOnUndo;
  OPS_UNASSIGN_EN   = !!FEATURES.flags.opsUnassignEnabled;
  NOTIFY_SUPERSEDE  = !!FEATURES.flags.notifySupersede;

  TIMEZONE          = String(FEATURES.time.timezone || 'Africa/Addis_Ababa');
  CUTOFF_HOUR       = Number(FEATURES.time.cutoffHourLocal || 18);
}
refreshDerived();

// ────────────────────────────────────────────────────────────────────────────────
// Session module
let Session = null;
try {
  Session = require('./core/session');
  console.log('core/session loaded.');
} catch (e) {
  console.error('Missing ./core/session.js — please add it.');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────────────
// IMPORTANT: Create bot BEFORE any bot.* usage or wiring
const bot = new Telegraf(BOT_TOKEN);

// ────────────────────────────────────────────────────────────────────────────────
// Utilities
const isPrivate = (ctx) => ctx.chat?.type === 'private';
const isGroup   = (ctx) => ['group', 'supergroup'].includes(ctx.chat?.type);
const isOwner   = (ctx) => OWNER_IDS.includes(ctx.from?.id);
function now() { return Date.now(); }
function localHour(tz) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).format(new Date()));
  } catch {
    return (new Date().getUTCHours() + 3) % 24; // fallback UTC+3
  }
}
function afterCutoff() { return localHour(TIMEZONE) >= CUTOFF_HOUR; }
async function isGroupAdmin(ctx) {
  try {
    if (!isGroup(ctx)) return false;
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return m.status === 'creator' || m.status === 'administrator';
  } catch { return false; }
}
async function canApprove(ctx) {
  if (!isGroup(ctx) || ctx.chat.id !== STAFF_GROUP_ID) return false;
  return APPROVE_SCOPE === 'admins' ? isGroupAdmin(ctx) : true;
}

// Message templating
function get(obj, pathStr) {
  return pathStr.split('.').reduce((o, k) => (o && k in o ? o[k] : undefined), obj);
}
function t(key, vars = {}) {
  let s = get(MSG, key);
  if (!s || typeof s !== 'string') return key;
  // FIX: templating regex
  return s.replace(/\{([A-Z0-9_]+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

// Timers for driver window
function setDriverTimer(ref) {
  const s = Session.getSessionByRef(ref); if (!s) return;
  clearDriverTimer(s);
  s.driverTimer = setTimeout(async () => {
    const still = Session.getSessionByRef(ref);
    if (still && !still.assigned_driver_id && still.status === 'DISPATCHING' && STAFF_GROUP_ID) {
      await bot.telegram.sendMessage(
        STAFF_GROUP_ID,
        t('staff.no_driver_ping', { MINUTES: Math.round(DRIVER_WINDOW_MS / 60000), REF: ref })
      ).catch(()=>{});
      if (s._customerId) {
        await bot.telegram.sendMessage(s._customerId, t('customer.no_driver_delay', { REF: ref })).catch(()=>{});
      }
    }
  }, DRIVER_WINDOW_MS);
}
function clearDriverTimer(s) { if (s?.driverTimer) { clearTimeout(s.driverTimer); s.driverTimer = null; } }

// Sheets poster (best-effort)
async function postSheets(event, data = {}) {
  if (!(SHEETS_URL && SHEETS_SECRET && FEATURES.flags.sheetsExportEnabled)) return;
  try {
    const payload = { secret: SHEETS_SECRET, event, ...data };
    await fetch(SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('sheets post error', e.message);
    if (STAFF_GROUP_ID) bot.telegram.sendMessage(STAFF_GROUP_ID, '⚠️ Sheets logging failed once.').catch(()=>{});
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// SILENT WINDOWS (driver 15s) — schedule external effects after UNDO window
const UNDO_SECS = 15;
const openUndos = new Map();     // key = `${ref}:${action}:${driverId}` -> expiresAt (ms)
const pendingFx = new Map();     // key -> timeout handle

const fxKey = (ref, action, driverId) => `${ref}:${action}:${driverId}`;
function cancelFx(ref, action, driverId) {
  const key = fxKey(ref, action, driverId);
  const h = pendingFx.get(key);
  if (h) { clearTimeout(h); pendingFx.delete(key); }
}
function scheduleFx(ref, action, driverId, fn) {
  cancelFx(ref, action, driverId);
  const key = fxKey(ref, action, driverId);
  const h = setTimeout(async () => {
    pendingFx.delete(key);
    try { await fn(); } catch (e) { /* swallow */ }
  }, UNDO_SECS * 1000);
  pendingFx.set(key, h);
}

function isUndoOpen(ref, action, driverId) {
  const exp = openUndos.get(fxKey(ref, action, driverId));
  return !!exp && Date.now() <= exp;
}
async function openUndoPrompt(ref, action, driverId, labelText) {
  const expiresAt = Date.now() + UNDO_SECS * 1000;
  openUndos.set(fxKey(ref, action, driverId), expiresAt);
  setTimeout(() => openUndos.delete(fxKey(ref, action, driverId)), UNDO_SECS * 1000 + 500);

  const btn = Markup.inlineKeyboard([
    [Markup.button.callback(`↩️ Undo (${UNDO_SECS}s)`, `drv_undo_simple:${action}:${ref}`)]
  ]);
  try { await bot.telegram.sendMessage(driverId, `Undo ${labelText} — ${ref}?`, btn); } catch {}
}
function driverActionsKB(ref) {
  const btnPicked = get(MSG,'buttons.drv_picked_am') || '✔ ተነሳ';
  const btnDone   = get(MSG,'buttons.drv_done_am')   || '✔✔ ተደረሰ';
  const btnGiveup = get(MSG,'buttons.drv_giveup_am') || 'እተዋለሁ';
  return Markup.inlineKeyboard([
    [Markup.button.callback(btnPicked, `drv_picked:${ref}`)],
    [Markup.button.callback(btnDone,   `drv_done:${ref}`)],
    [Markup.button.callback(btnGiveup, `drv_giveup:${ref}`)]
  ]);
}
async function showDriverActions(ref, driverId) {
  try { await bot.telegram.sendMessage(driverId, `Actions restored for ${ref}.`, driverActionsKB(ref)); } catch {}
}
async function showAcceptDeclineToDriver(s, driverId) {
  try {
    const btnAccept = get(MSG,'buttons.drv_accept_am') || '✅ ተቀበል';
    const btnDecline= get(MSG,'buttons.drv_decline_am')|| '❌ አትቀበል';
    const kb = Markup.inlineKeyboard([[Markup.button.callback(btnAccept, `drv_accept:${s.ref}`),
      Markup.button.callback(btnDecline, `drv_decline:${s.ref}`)]]);

    const f = parseOrderFields(s.summary || '');
    const mapLine = f.map && f.map !== '—' ? t('driver.broadcast_map_line_am', { MAP_URL: f.map }) : '';
    let card = t('driver.broadcast_card_am', {
      REF: s.ref, QTY: f.qty, AREA: f.area, TOTAL: f.total, DELIVERY_FEE: f.delivery, MAP_LINE: mapLine
    });
    if (f.customerName) card = `👤 ${f.customerName}\n` + card;
    if (f.phone) card += `\n📞 ${f.phone}`;
    await bot.telegram.sendMessage(driverId, card, kb);
  } catch {}
}

// Accept → external effects (after 15s if not undone)
function scheduleAcceptEffects(ref, driverId) {
  scheduleFx(ref, 'accept', driverId, async () => {
    const s = Session.getSessionByRef(ref);
    if (!s) return;
    if (s.assigned_driver_id !== driverId || s.status !== 'ASSIGNED') return;

    const d = drivers.get(driverId);
    if (STAFF_GROUP_ID) {
      await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.driver_accepted', {
        REF: ref, DRIVER_NAME: d ? d.name : `id ${driverId}`, DRIVER_PHONE: d ? d.phone : '—', USER_ID: d ? d.id : driverId
      })).catch(()=>{});
    }
    const f = parseOrderFields(s.summary || '');
    if (s._customerId) {
      await bot.telegram.sendMessage(s._customerId, t('customer.driver_assigned', {
        REF: ref, DRIVER_NAME: d ? d.name : 'Assigned driver', DRIVER_PHONE: d ? d.phone : '—'
      })).catch(()=>{});
    }

    // NEW: persist driver accepted time
    try { await store.saveDriverEvent(ref, 'accepted', d ? d.name : ''); } catch(e) { console.warn('store.accepted error', e.message); }

    await postSheets('assigned', {
      ref,
      customer_name: f.customerName || '',
      phone: f.phone || '',
      area: f.area || '',
      map_url: f.map || '',
      total_etb: f.total || '',
      delivery_fee: f.delivery || '',
      payment_method: s.method || '',
      driver_id: d ? d.id : driverId,
      driver_name: d ? d.name : '',
      driver_phone: d ? d.phone : '',
      status: 'ASSIGNED'
    });
  });
}

// Picked → external effects
function schedulePickedEffects(ref, driverId) {
  scheduleFx(ref, 'picked', driverId, async () => {
    const s = Session.getSessionByRef(ref);
    if (!s) return;
    if (s.assigned_driver_id !== driverId || s.status !== 'OUT_FOR_DELIVERY') return;

    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.picked_up', { REF: ref, USER_ID: driverId })).catch(()=>{});
    if (s._customerId) await bot.telegram.sendMessage(s._customerId, t('customer.picked_up', { REF: ref })).catch(()=>{});

    // NEW: persist driver picked time
    const d = drivers.get(driverId);
    try { await store.saveDriverEvent(ref, 'picked', d ? d.name : ''); } catch(e) { console.warn('store.picked error', e.message); }
  });
}

// Delivered → external effects (incl. persist)
function scheduleDeliveredEffects(ref, driverId) {
  scheduleFx(ref, 'delivered', driverId, async () => {
    const s = Session.getSessionByRef(ref);
    if (!s) return;
    if (s.assigned_driver_id !== driverId || s.status !== 'DELIVERED') return;

    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.delivered', { REF: ref, USER_ID: driverId })).catch(()=>{});
    if (s._customerId) await bot.telegram.sendMessage(s._customerId, t('customer.delivered', { REF: ref })).catch(()=>{});

    const f3 = parseOrderFields(s.summary || '');
    const dInfo2 = drivers.get(driverId);
    await postSheets('delivered', {
      ref,
      customer_name: f3.customerName || '',
      phone: f3.phone || '',
      area: f3.area || '',
      map_url: f3.map || '',
      total_etb: f3.total || '',
      delivery_fee: f3.delivery || '',
      payment_method: s.method || '',
      driver_id: dInfo2 ? dInfo2.id : driverId,
      driver_name: dInfo2 ? dInfo2.name : '',
      driver_phone: dInfo2 ? dInfo2.phone : '',
      status: 'DELIVERED'
    });

    // NEW: persist delivered time (+ ensure intake exists)
    try {
      // ensure we have an intake row (idempotent upsert)
      const fields = mapFieldsFromSummary(f3, s.summary);
      fields.order_id = ref;
      await store.saveOrderIntake(fields); // no ctx: falls back to now if missing
      await store.savePaymentStatus(ref, 'approved'); // final state
      await store.saveDriverEvent(ref, 'delivered', dInfo2 ? dInfo2.name : '');
    } catch (e) {
      console.error('store(delivered) error', e);
      if (STAFF_GROUP_ID) bot.telegram.sendMessage(STAFF_GROUP_ID, `⚠️ Persist failed for ${ref} (delivered)`).catch(()=>{});
    }
  });
}

// Give up → external effects (rebroadcast)
function scheduleGiveupEffects(ref, driverId) {
  scheduleFx(ref, 'giveup', driverId, async () => {
    const s = Session.getSessionByRef(ref);
    if (!s) return;
    if (s.status !== 'DISPATCHING' || s.assigned_driver_id) return;

    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.driver_canceled_rebroadcast', { REF: ref, USER_ID: driverId })).catch(()=>{});
    await broadcastToDrivers(s, driverId);
    setDriverTimer(ref);

    // Optional: mark pickup undone (no DB change here)
  });
}

// ────────────────────────────────────────────────────────────────────────────────
// Health & basics
bot.start(async (ctx) => {
  const txt = ctx.message?.text || '';
  const payload = txt.split(' ')[1];

  if (payload && payload.startsWith('GG_')) {
    await ctx.reply('Link received. Please paste your order summary here to continue.');
    return;
  }

  await ctx.reply('EMMA online. Use /ping here. In your staff group, run /setstaff once.');
});
bot.command('ping', async (ctx) => ctx.reply(`pong | ${new Date().toISOString()}`));
bot.command('me',   async (ctx) => ctx.reply(`Your ID: ${ctx.from.id}`));
bot.command('id',   async (ctx) => ctx.reply(`Chat ID: ${ctx.chat.id}`));

// Bind staff group
bot.command('setstaff', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Run /setstaff inside the staff group.');
  if (!isOwner(ctx)) return ctx.reply('Not authorized (owner only).');
  STAFF_GROUP_ID = ctx.chat.id;
  await ctx.reply(`Staff group bound: ${STAFF_GROUP_ID}`);
});

// Maintenance
let maintenance = { on: false, note: '' };
bot.command('maintenance', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const args = ctx.message.text.split(' ').slice(1);
  const mode = (args.shift() || '').toLowerCase();
  if (mode === 'on')  { maintenance.on = true;  maintenance.note = args.join(' ') || ''; return ctx.reply(`✅ Maintenance ON\nNote: ${maintenance.note}`); }
  if (mode === 'off') { maintenance.on = false; maintenance.note = '';            return ctx.reply('✅ Maintenance OFF'); }
  return ctx.reply('Usage:\n/maintenance on <note>\n/maintenance off');
});

// Payment text manage via messages.json (in-memory change; persist by editing file)
const waitFor = new Map(); // chat_id -> 'telebirr'|'bank'
bot.command('settelebirr', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  waitFor.set(ctx.chat.id, 'telebirr');
  ctx.reply('Send the new Telebirr text as your next message. (To persist, edit messages.json)');
});
bot.command('setbank', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  waitFor.set(ctx.chat.id, 'bank');
  ctx.reply('Send the new Bank text as your next message. (To persist, edit messages.json)');
});
bot.command('getpay', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  ctx.reply(`Telebirr:\n${get(MSG,'customer.payment_info_telebirr')}\n\nBank:\n${get(MSG,'customer.payment_info_cbe')}`);
});
bot.on('text', async (ctx, next) => {
  const pending = waitFor.get(ctx.chat.id);
  if (pending && isPrivate(ctx) && isOwner(ctx)) {
    if (pending === 'telebirr') {
      MSG.customer = MSG.customer || {};
      MSG.customer.payment_info_telebirr = ctx.message.text.trim();
      await ctx.reply('✅ Telebirr text updated (in-memory). Edit messages.json to persist.');
    }
    if (pending === 'bank') {
      MSG.customer = MSG.customer || {};
      MSG.customer.payment_info_cbe = ctx.message.text.trim();
      await ctx.reply('✅ Bank text updated (in-memory). Edit messages.json to persist.');
    }
    waitFor.delete(ctx.chat.id);
    return;
  }
  if (typeof next === 'function') return next();
});

// ────────────────────────────────────────────────────────────────────────────────
// NEW: Intake capture middleware (fixed: call next() only once)
bot.on('text', async (ctx, next) => {
  try {
    const txt = String(ctx.message?.text || '');

    // Only process if it’s a real summary-length message
    if (txt && txt.length >= 20) {
      if (isOrderSummaryStrict(txt) || /Order ID:\s*GG-/i.test(txt)) {
        const parsed = parseOrderFields(txt) || {};
        const fields  = mapFieldsFromSummary(parsed, txt);
        fields.order_id = extractRef(txt) || parsed.ref || ''; // GG-...
        if (fields.order_id) {
          await store.saveOrderIntake(fields, ctx).catch(e =>
            console.warn('saveOrderIntake error:', e.message)
          );
        }
      }
    }
  } catch (e) {
    console.warn('intake middleware error:', e.message);
  }

  // Call next ONCE, here.
  return (typeof next === 'function' ? next() : undefined);
});

// Drivers CRUD (+ persistence helpers)
bot.command('adddriver', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const raw = ctx.message.text.split(' ').slice(1).join(' ');
  if (!raw) return ctx.reply('Format:\n/adddriver <tg_id> | <full name> | <phone>');
  const parts = raw.split('|').map(s => s.trim());
  if (parts.length < 3) return ctx.reply('Format:\n/adddriver <tg_id> | <full name> | <phone>');
  const id = Number(parts[0]); const name = parts[1]; const phone = parts[2];
  if (!Number.isFinite(id)) return ctx.reply('tg_id must be a number. Example:\n/adddriver 7138336029 | Abebe | +251 911111111');
  drivers.set(id, { id, name, phone });
  return ctx.reply(`✅ Driver added:\n• ID: ${id}\n• Name: ${name}\n• Phone: ${phone}\n\nTo persist across restarts: add them to drivers.json in the repo and deploy.`);
});
bot.command('drivers', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  if (drivers.size === 0) return ctx.reply('No drivers yet. Add one:\n/adddriver 7138336029 | Abebe | +251 911111111');
  const list = [...drivers.values()].map(d => `• ${d.name} — ${d.phone} (id ${d.id})`).join('\n');
  return ctx.reply(`Drivers:\n${list}`);
});
bot.command('removedriver', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const id = Number(ctx.message.text.split(' ').slice(1).join(' ').trim());
  if (!Number.isFinite(id)) return ctx.reply('Format:\n/removedriver <tg_id>');
  if (!drivers.has(id)) return ctx.reply(`No driver with id ${id}.`);
  drivers.delete(id);
  return ctx.reply(`✅ Driver removed: ${id}\n\nTo persist removal: update drivers.json and deploy.`);
});
bot.command('drivers_reload', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  loadDriversFromFile();
  return ctx.reply(`🔄 Reloaded drivers.json — ${drivers.size} drivers.`);
});
bot.command('drivers_export', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const json = exportDriversJson();
  if (json.length > 3500) {
    // FIX: chunk regex
    const chunks = json.match(/[\s\S]{1,3500}/g) || [json];
    await ctx.reply(`Current drivers JSON (${chunks.length} part(s)) — paste into drivers.json:`);
    for (const part of chunks) await ctx.reply(part);
    return;
  }
  return ctx.reply(json);
});

// Owner: revert & force-approve
bot.command('revert', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const ref = (ctx.message.text.split(' ')[1] || '').trim();
  const s = Session.getSessionByRef(ref);
  if (!s) return ctx.reply('Ref not found.');
  s.status = 'AWAITING_RECEIPT';
  s.assigned_driver_id = null; s.giveupUntil = null;
  clearDriverTimer(s);
  s.createdAt = Date.now(); // refresh TTL
  return ctx.reply(`↩️ Reverted order ${ref} to AWAITING_RECEIPT.`);
});
bot.command('forceapprove', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const ref = (ctx.message.text.split(' ')[1] || '').trim();
  const s = Session.getSessionByRef(ref);
  if (!s) return ctx.reply('Ref not found.');
  s.status = 'APPROVED_HOLD'; s.approvalTimer = null;
  await finalizeApproval(s);
  return ctx.reply(`✅ Forced approval for ${ref}.`);
});

// Ops: optional unassign & rebroadcast (guarded by feature flag)
bot.command('unassign', async (ctx) => {
  if (!OPS_UNASSIGN_EN) return;
  if (!isOwner(ctx) || (isGroup(ctx) && ctx.chat.id !== STAFF_GROUP_ID)) return;
  const ref = (ctx.message.text.split(' ')[1] || '').trim();
  const s = Session.getSessionByRef(ref);
  if (!s) return ctx.reply('Ref not found.');
  if (!s.assigned_driver_id) return ctx.reply('No driver assigned.');
  const quitterId = s.assigned_driver_id;
  s.assigned_driver_id = null; s.status = 'DISPATCHING'; s.giveupUntil = null;
  if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.driver_canceled_rebroadcast', { REF: s.ref, USER_ID: quitterId }));
  await broadcastToDrivers(s, quitterId);
  setDriverTimer(s.ref);
  return ctx.reply(`Re-broadcasted ${ref} (excluding ${quitterId}).`);
});

// Config exports & reloads
bot.command('config_export', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const cfg = {
    STAFF_GROUP_ID, SUPPORT_GROUP_ID, APPROVE_SCOPE, RATE_LIMIT_MS,
    HOLD_SECONDS, BUTTON_TTL_SEC, DRIVER_WINDOW_MS, GIVEUP_MS,
    TIMEZONE, CUTOFF_HOUR, drivers_loaded: drivers.size,
    features_version: FEATURES._meta?.version || 'n/a',
    sheets_enabled: !!(SHEETS_URL && SHEETS_SECRET && FEATURES.flags.sheetsExportEnabled)
  };
  return ctx.reply('CONFIG:\n' + JSON.stringify(cfg, null, 2));
});
bot.command('reload_texts', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  loadMessages(); loadFeatures(); refreshDerived();
  return ctx.reply('🔄 Reloaded messages.json & features.json.');
});

// ────────────────────────────────────────────────────────────────────────────────
// Callback handlers: support claim, staff approvals, driver actions
bot.on('callback_query', async (ctx, next) => {
  try {
    const data = String(ctx.callbackQuery.data || '');

    // Support claim
    if (data.startsWith('support_claim:')) {
      if (!isGroup(ctx) || ctx.chat.id !== SUPPORT_GROUP_ID) return ctx.answerCbQuery('Use in support group.');
      const customerId = Number(data.split(':')[1]);
      const who = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `id ${ctx.from.id}`;
      const msg = ctx.update.callback_query.message;
      const claimed = ((msg.text || '') + `\n` + t('support.claimed_suffix', { CLAIMER_NAME: who })).trim();
      await ctx.telegram.editMessageText(SUPPORT_GROUP_ID, msg.message_id, undefined, claimed).catch(()=>{});
      await bot.telegram.sendMessage(customerId, t('support.customer_claim_dm', { SUPPORT_PHONE })).catch(()=>{});
      return ctx.answerCbQuery('Claimed.');
    }

    // Staff Approve / Reject / Undo
    if (data.startsWith('approve:') || data.startsWith('reject:') || data.startsWith('undo:')) {
      if (!isGroup(ctx)) return ctx.answerCbQuery('Use inside staff group.');
      if (!STAFF_GROUP_ID || ctx.chat.id !== STAFF_GROUP_ID) return ctx.answerCbQuery('Wrong group.');
      if (!(await canApprove(ctx))) return ctx.answerCbQuery('Not authorized.');

      // Undo path → re-review
      if (data.startsWith('undo:')) {
        if (!RE_REVIEW_ON_UNDO) return ctx.answerCbQuery('Undo disabled.');
        const ref = data.split(':')[1];
        const s = Session.getSessionByRef(ref);
        if (!s || s.status !== 'APPROVED_HOLD') return ctx.answerCbQuery('Nothing to undo.');
        if (s.approvalTimer) { clearTimeout(s.approvalTimer); s.approvalTimer = null; }
        s.status = 'AWAITING_RECEIPT';
        s.assigned_driver_id = null; s.giveupUntil = null;
        s.createdAt = Date.now(); // refresh TTL
        if (s.holdMsgId) {
          await bot.telegram.editMessageText(STAFF_GROUP_ID, s.holdMsgId, undefined, t('staff.approval_undone_message', { REF: s.ref })).catch(()=>{});
        }
        const reKb = Markup.inlineKeyboard([
          [Markup.button.callback(get(MSG,'buttons.approve') || 'Approve', `approve:${s._customerId || '0'}:${s.ref}`),
           Markup.button.callback(get(MSG,'buttons.reject')  || 'Reject',  `reject:${s._customerId || '0'}:${s.ref}`)]
        ]);
        await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.re_review_prompt', { REF: s.ref }), reKb);
        return ctx.answerCbQuery('Approval undone.');
      }

      const [verb, userIdStr, ref] = data.split(':');
      const uid = Number(userIdStr);
      const s = Session.getSessionByRef(ref);
      if (!s || s.ref !== ref) return ctx.answerCbQuery('Order not found.');
      if (Session.ttlExpired && Session.ttlExpired(s)) {
        await ctx.answerCbQuery('Action expired.');
        await ctx.telegram.sendMessage(STAFF_GROUP_ID, t('staff.action_expired', { REF: ref }));
        return;
      }
      if (uid && !s._customerId) s._customerId = uid;

      if (verb === 'approve') {
        s.status = 'APPROVED_HOLD';
        await ctx.editMessageCaption({ caption: t('staff.approved_on_hold_caption', { REF: s.ref }) }).catch(()=>{});
        const holdMsg = await ctx.telegram.sendMessage(
          STAFF_GROUP_ID,
          t('staff.approved_hold_message', { REF: s.ref }),
          Markup.inlineKeyboard([[Markup.button.callback(get(MSG,'buttons.undo_hold') || 'Undo (60s)', `undo:${s.ref}`)]])
        );
        s.holdMsgId = holdMsg.message_id;
        s.approvalTimer = setTimeout(async () => {
          const fresh = Session.getSessionByRef(ref);
          if (!fresh || fresh.status !== 'APPROVED_HOLD') return;
          await finalizeApproval(fresh).catch(()=>{});
        }, HOLD_SECONDS * 1000);
        // Customer DM only after hold in finalizeApproval()
        return ctx.answerCbQuery('Approved (on hold).');
      } else {
        s.status = 'REJECTED';
        if (uid) await ctx.telegram.sendMessage(uid, t('customer.payment_rejected', { REF: s.ref, SUPPORT_PHONE })).catch(()=>{});
        await ctx.editMessageCaption({ caption: t('staff.rejected_caption', { REF: s.ref }) }).catch(()=>{});
        await ctx.telegram.sendMessage(STAFF_GROUP_ID, t('staff.rejected_notice', { REF: s.ref }));
        return ctx.answerCbQuery('Rejected.');
      }
    }

    // Driver accepts / declines
    if (data.startsWith('drv_accept:') || data.startsWith('drv_decline:')) {
      if (!isPrivate(ctx)) return ctx.answerCbQuery('Check your DM with the bot.');
      const [, ref] = data.split(':');
      const s = Session.getSessionByRef(ref);
      if (!s) return ctx.answerCbQuery('Job not found.');
      if (Session.ttlExpired && Session.ttlExpired(s)) return ctx.answerCbQuery('This job has expired.');

      if (data.startsWith('drv_accept:')) {
        if (s.assigned_driver_id) {
          return ctx.answerCbQuery(
            s.assigned_driver_id === ctx.from.id
              ? (get(MSG,'driver.accept_you_already_have') || 'You already have this job.')
              : (get(MSG,'driver.accept_already_assigned') || 'Already assigned.')
          );
        }
        s.assigned_driver_id = ctx.from.id;
        s.status = 'ASSIGNED';
        s.giveupUntil = Date.now() + GIVEUP_MS;
        clearDriverTimer(s);

        const btnPicked = get(MSG,'buttons.drv_picked_am') || '✔ ተነሳ';
        const btnDone   = get(MSG,'buttons.drv_done_am')   || '✔✔ ተደረሰ';
        const btnGiveup = get(MSG,'buttons.drv_giveup_am') || 'እተዋለሁ';
        const driverActions = Markup.inlineKeyboard([
          [Markup.button.callback(btnPicked, `drv_picked:${s.ref}`)],
          [Markup.button.callback(btnDone,   `drv_done:${s.ref}`)],
          [Markup.button.callback(btnGiveup, `drv_giveup:${s.ref}`)]
        ]);

        const f = parseOrderFields(s.summary || '');
        const mapLine = f.map && f.map !== '—' ? t('driver.broadcast_map_line_am', { MAP_URL: f.map }) : '';
        let assignedCard = t('driver.assigned_card_am', {
          REF: s.ref, QTY: f.qty, AREA: f.area, TOTAL: f.total, DELIVERY_FEE: f.delivery, MAP_LINE: mapLine
        });
        if (f.phone) assignedCard += `\n📞 ${f.phone}`;

        await ctx.reply(assignedCard, driverActions);
        await ctx.answerCbQuery('Assigned to you.');

        // Silent window: only show UNDO to driver + schedule effects
        await openUndoPrompt(s.ref, 'accept', ctx.from.id, 'ተቀበል');
        scheduleAcceptEffects(s.ref, ctx.from.id);
        return;
      } else {
        return ctx.answerCbQuery(get(MSG,'driver.declined_ok') || 'Declined. Thanks.');
      }
    }

    // Driver picked / delivered / give up
    if (data.startsWith('drv_picked:') || data.startsWith('drv_done:') || data.startsWith('drv_giveup:')) {
      if (!isPrivate(ctx)) return ctx.answerCbQuery('Use your DM with the bot.');
      const [, ref] = data.split(':');
      const s = Session.getSessionByRef(ref);
      if (!s) return ctx.answerCbQuery('Job not found.');
      if (s.assigned_driver_id !== ctx.from.id) return ctx.answerCbQuery('Not your job.');

      if (data.startsWith('drv_giveup:')) {
        if (!s.giveupUntil || Date.now() > s.giveupUntil) return ctx.answerCbQuery(get(MSG,'driver.giveup_too_late') || 'Too late.');
        const quitterId = s.assigned_driver_id;
        s.assigned_driver_id = null; s.status = 'DISPATCHING'; s.giveupUntil = null;
        await ctx.answerCbQuery(get(MSG,'driver.giveup_ok') || 'Given up.');
        // Silent window: undo + schedule rebroadcast (no immediate staff/broadcast)
        await openUndoPrompt(s.ref, 'giveup', ctx.from.id, 'እተዋለሁ');
        scheduleGiveupEffects(s.ref, quitterId);
        return;
      }

      if (data.startsWith('drv_picked:')) {
        s.status = 'OUT_FOR_DELIVERY';
        await ctx.answerCbQuery(get(MSG,'driver.picked_marked') || 'Picked.');
        // Silent window: undo + schedule staff/customer notices
        await openUndoPrompt(s.ref, 'picked', ctx.from.id, 'ተነሳ');
        schedulePickedEffects(s.ref, ctx.from.id);
        return;
      } else {
        s.status = 'DELIVERED';
        await ctx.answerCbQuery(get(MSG,'driver.delivered_marked') || 'Delivered.');
        // Silent window: undo + schedule staff/customer + sheets + persist
        await openUndoPrompt(s.ref, 'delivered', ctx.from.id, 'ተደረሰ');
        scheduleDeliveredEffects(s.ref, ctx.from.id);
        return;
      }
    }

    // UNDO button for driver actions (15s window)
    if (/^drv_undo_simple:(accept|picked|delivered|giveup):/.test(data)) {
      const [, action, ref] = data.match(/^drv_undo_simple:(accept|picked|delivered|giveup):(.+)$/);
      const driverId = Number(ctx.from.id);

      if (!isUndoOpen(ref, action, driverId)) {
        await ctx.answerCbQuery('Undo window expired.');
        return;
      }
      cancelFx(ref, action, driverId); // cancel pending external effects

      const s = Session.getSessionByRef(ref);
      if (!s) { await ctx.answerCbQuery('Order not found.'); return; }

      if (action === 'accept') {
        if (s.assigned_driver_id !== driverId || s.status !== 'ASSIGNED') { await ctx.answerCbQuery('Nothing to undo.'); return; }
        s.assigned_driver_id = null;
        s.status = 'DISPATCHING';
        s.giveupUntil = null;
        await ctx.answerCbQuery('Undone. Choose again.');
        await showAcceptDeclineToDriver(s, driverId);
        return;
      }

      if (action === 'picked') {
        if (s.status !== 'OUT_FOR_DELIVERY') { await ctx.answerCbQuery('Nothing to undo.'); return; }
        s.status = 'ASSIGNED';
        await ctx.answerCbQuery('Picked → undone.');
        await showDriverActions(ref, driverId);
        return;
      }

      if (action === 'delivered') {
        if (s.status !== 'DELIVERED') { await ctx.answerCbQuery('Nothing to undo.'); return; }
        s.status = 'OUT_FOR_DELIVERY';
        await ctx.answerCbQuery('Delivered → undone.');
        await showDriverActions(ref, driverId);
        return;
      }

      if (action === 'giveup') {
        if (s.status !== 'DISPATCHING' || s.assigned_driver_id) { await ctx.answerCbQuery('Nothing to undo.'); return; }
        s.assigned_driver_id = driverId;
        s.status = 'ASSIGNED';
        s.giveupUntil = Date.now() + (typeof GIVEUP_MS === 'number' ? GIVEUP_MS : 120000);
        await ctx.answerCbQuery('Give up → undone.');
        await showDriverActions(ref, driverId);
        return;
      }
    }

    if (typeof next === 'function') return next();
  } catch (e) {
    console.error('callback_query error', e);
    return ctx.answerCbQuery('Error.');
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// Finalize approval after hold (notify customer + dispatch)
async function finalizeApproval(s) {
  try {
    if (!s || s.status !== 'APPROVED_HOLD') return;
    s.status = 'DISPATCHING';
    if (s.holdMsgId) {
      await bot.telegram.editMessageText(STAFF_GROUP_ID, s.holdMsgId, undefined, t('staff.finalize_approved', { REF: s.ref })).catch(()=>{});
    }

    // ✅ Customer DM only NOW (after full hold)
    if (s._customerId) {
      await bot.telegram.sendMessage(s._customerId, t('customer.payment_confirmed_after_hold', { REF: s.ref })).catch(()=>{});
    }

    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.dispatching_notice', { REF: s.ref }));

    // Sheets: approved
    const f = parseOrderFields(s.summary || '');
    await postSheets('approved', {
      ref: s.ref,
      customer_name: f.customerName || '',
      phone: f.phone || '',
      area: f.area || '',
      map_url: f.map || '',
      total_etb: f.total || '',
      delivery_fee: f.delivery || '',
      payment_method: s.method || '',
      status: 'APPROVED'
    });

    // EMMA: persist payment_confirmed → Supabase (idempotent)
    try {
      const fields = mapFieldsFromSummary(f, s.summary);
      fields.order_id = s.ref;
      await store.saveOrderIntake(fields);                 // upsert intake row if missing
      await store.savePaymentStatus(s.ref, 'approved');    // mark approved
    } catch (e) {
      console.error('store(payment_confirmed) error', e);
      if (STAFF_GROUP_ID) bot.telegram.sendMessage(STAFF_GROUP_ID, `⚠️ Persist failed for ${s.ref} (payment_confirmed)`).catch(()=>{});
    }

    await broadcastToDrivers(s);
    setDriverTimer(s.ref);
  } catch (err) {
    console.error('finalizeApproval error', err);
    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, `⚠️ Error while finalizing approval for ${s?.ref || 'ref'}.`);
  } finally {
    if (s) s.approvalTimer = null;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Driver broadcast (includes phone)
async function broadcastToDrivers(s, excludeId = null) {
  if (drivers.size === 0) {
    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, '⚠️ No drivers configured. Use /adddriver in owner DM.');
    return;
  }
  const btnAccept = get(MSG,'buttons.drv_accept_am') || '✅ ተቀበል';
  const btnDecline= get(MSG,'buttons.drv_decline_am')|| '❌ አትቀበል';
  const kb = (ref) => Markup.inlineKeyboard([[Markup.button.callback(btnAccept, `drv_accept:${ref}`), Markup.button.callback(btnDecline, `drv_decline:${ref}`)]]);

  const f = parseOrderFields(s.summary || '');
  const mapLine = f.map && f.map !== '—' ? t('driver.broadcast_map_line_am', { MAP_URL: f.map }) : '';
  let card = t('driver.broadcast_card_am', {
    REF: s.ref, QTY: f.qty, AREA: f.area, TOTAL: f.total, DELIVERY_FEE: f.delivery, MAP_LINE: mapLine
  });

  if (f.customerName) card = `👤 ${f.customerName}\n` + card;
  if (f.phone) card += `\n📞 ${f.phone}`;

  const failed = [];
  const sent = [];
  for (const d of drivers.values()) {
    if (excludeId && d.id === excludeId) continue;
    try { await bot.telegram.sendMessage(d.id, card, kb(s.ref)); sent.push(`${d.name} [${d.id}]`); }
    catch { failed.push(`${d.name || 'Driver'} [${d.id}]`); }
  }
  if (STAFF_GROUP_ID) {
    await bot.telegram.sendMessage(
      STAFF_GROUP_ID,
      t('staff.broadcast_report', {
        REF: s.ref,
        SENT: sent.length ? sent.join(', ') : 'none',
        FAILED: failed.length ? failed.join(', ') : 'none'
      })
    );
    if (failed.length) await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.broadcast_failed_hint', { COUNT: failed.length }));
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Wire customer flow
try {
  const wireCustomerFlow = require('./flows/customerBotFlow');
  wireCustomerFlow(bot, {
    FEATURES,
    SUPPORT_PHONE,
    SUPPORT_GROUP_ID,
    STAFF_GROUP_ID,
    BUTTON_TTL_SEC,
    ALLOW_NEW_ORDER,
    // parser helpers
    isLikelyQuestion,
    isOrderSummaryStrict,
    parseOrderFields,
    extractRef,
    // templating
    t, get,
    // session API
    Session,
    // misc
    afterCutoff,
    // expose MSG for flow (optional)
    MSG
  });
  console.log('flows/customerBotFlow wired.');
} catch (e) {
  console.warn('flows/customerBotFlow missing — customer conversations will be inactive until you add it.');
}

// ────────────────────────────────────────────────────────────────────────────────
// NEW: wire export commands (/export orders, /clear_and_export_orders)
try {
  wireAdminExportFlow(bot, { store });
  console.log('flows/adminExportFlow wired.');
} catch (e) {
  console.error('adminExportFlow wiring failed:', e.message);
}

// ────────────────────────────────────────────────────────────────────────────────
bot.launch().then(() => console.log('Polling started…'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
function mapFieldsFromSummary(parsed, rawText) {
  const f = parsed || {};
  const email = (rawText && (rawText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '')) || '';
  const addrMatch = rawText && rawText.match(/Address:\s*([^\n]+)/i);
  const address = addrMatch ? addrMatch[1].trim() : (f.area || '');
  const map_url = f.map || '';

  return {
    customer_name:  f.customerName || '',
    email,
    phone:          f.phone || '',
    type:           f.type || '',
    size:           f.size || '',
    roast_level:    f.roast || '',
    qty:            f.qty || '',
    product_price:  null,                 // optional; total/delivery will fill total
    delivery_price: f.delivery || '',
    total:          f.total || '',
    delivery_location: address,
    map_url,
  };
}

function watchFile(fp, onChange) {
  try {
    if (!fs.existsSync(fp)) return;
    fs.watch(fp, { persistent: false }, (ev) => {
      if (ev === 'change') {
        try { onChange(); } catch (e) { console.warn('[hot] reload error:', e.message); }
      }
    });
  } catch (e) {
    console.warn('[hot] watcher failed for', fp, e.message);
  }
}
