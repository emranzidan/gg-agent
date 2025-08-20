// index.js — GreenGold EMMA (God Mode, modular)
// Reads behavior/text from: features.json, messages.json, drivers.json, and parser.js.
// Keep this file STABLE. Most future tweaks happen in the JSONs or parser.js.

// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');

// Order detection / parsing brain
const {
  isLikelyQuestion,
  isOrderSummaryStrict,
  parseOrderFields,
  extractRef
} = require('./parser');

// ─────────────────────────────────────────────────────────────────────────────
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
    flows: { holdSeconds: 60, buttonTtlSeconds: 900, driverWindowMinutes: 30, driverGiveUpMinutes: 2, allowNewOrderWhileActive: true, ...(f.flows || {}) },
    intake: { strictMode: true, escalateOnQuestion: true, minTextLength: 50, ...(f.intake || {}) },
    support: { enabled: true, phone: '+251 2601986', ...(f.support || {}) },
    flags: { flagDuplicateReceipts: true, flagForwardedReceipts: true, reReviewOnUndo: true, opsUnassignEnabled: false, sheetsExportEnabled: false, ...(f.flags || {}) },
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
      const name = String(d.name || '').trim();
      const phone = String(d.phone || '').trim();
      if (!name || !phone) continue;
      drivers.set(id, { id, name, phone });
    }
  }
  console.log(`Drivers loaded: ${drivers.size}`);
}
function exportDriversJson() {
  return JSON.stringify([...drivers.values()].map(d => ({ id: d.id, name: d.name, phone: d.phone })), null, 2);
}
// Initial load
loadFeatures();
loadMessages();
loadDriversFromFile();

// ─────────────────────────────────────────────────────────────────────────────
// Bot config (env + features)
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('Missing BOT_TOKEN'); process.exit(1); }

const OWNER_IDS = String(process.env.OWNER_IDS || '')
  .split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
if (OWNER_IDS.length === 0) console.warn('WARNING: OWNER_IDS not set.');

let STAFF_GROUP_ID   = process.env.STAFF_GROUP_ID   ? Number(process.env.STAFF_GROUP_ID)   : null;
let SUPPORT_GROUP_ID = process.env.SUPPORT_GROUP_ID ? Number(process.env.SUPPORT_GROUP_ID) : null;

const APPROVE_SCOPE     = (process.env.APPROVE_SCOPE || FEATURES.ops.approveScope || 'members').toLowerCase();
const RATE_LIMIT_MS     = Number(process.env.RATE_LIMIT_MS || FEATURES.ops.rateLimitMs || 1500);
const HOLD_SECONDS      = Number(process.env.HOLD_SECONDS || FEATURES.flows.holdSeconds || 60);
const BUTTON_TTL_SEC    = Number(process.env.BUTTON_TTL_SEC || FEATURES.flows.buttonTtlSeconds || 900);
const DRIVER_WINDOW_MS  = Number(process.env.DRIVER_WINDOW_MS || (FEATURES.flows.driverWindowMinutes * 60 * 1000));
const GIVEUP_MS         = Number((FEATURES.flows.driverGiveUpMinutes || 2) * 60 * 1000);
const ALLOW_NEW_ORDER   = !!FEATURES.flows.allowNewOrderWhileActive;

const SUPPORT_ENABLED   = !!FEATURES.support.enabled;
const SUPPORT_PHONE     = String(process.env.SUPPORT_PHONE || FEATURES.support.phone || '+251 2601986');

const DUP_FLAG          = !!FEATURES.flags.flagDuplicateReceipts;
const FWD_FLAG          = !!FEATURES.flags.flagForwardedReceipts;
const RE_REVIEW_ON_UNDO = !!FEATURES.flags.reReviewOnUndo;
const OPS_UNASSIGN_EN   = !!FEATURES.flags.opsUnassignEnabled;

const TIMEZONE          = String(FEATURES.time.timezone || 'Africa/Addis_Ababa');
const CUTOFF_HOUR       = Number(FEATURES.time.cutoffHourLocal || 18);

// ─────────────────────────────────────────────────────────────────────────────
// Bot state
const bot = new Telegraf(BOT_TOKEN);
const sessions = new Map();   // uid -> { ref, summary, status, method, assigned_driver_id, driverTimer, approvalTimer, holdMsgId, giveupUntil, createdAt }
const refs     = new Map();   // ref -> uid
const tokens   = new Map();   // deep-link test tokens (optional)
let maintenance = { on: false, note: '' };
const userRate = new Map();
const seenReceiptIds = new Set();

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
const isPrivate = (ctx) => ctx.chat?.type === 'private';
const isGroup   = (ctx) => ['group', 'supergroup'].includes(ctx.chat?.type);
const isOwner   = (ctx) => OWNER_IDS.includes(ctx.from?.id);
const now       = () => Date.now();
function genRef() { let r; do { r = 'GG_' + Math.random().toString(36).slice(2, 6).toUpperCase(); } while (refs.has(r)); return r; }
function getSessionByRef(ref) { const uid = refs.get(ref); return uid ? sessions.get(uid) : null; }
function ttlExpired(s) { return !s || (now() - s.createdAt) > (BUTTON_TTL_SEC * 1000); }
function localHour(tz) {
  try { return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).format(new Date())); }
  catch { return (new Date().getUTCHours() + 3) % 24; } // fallback Addis offset
}
function afterCutoff() { return localHour(TIMEZONE) >= CUTOFF_HOUR; }
function rateLimited(uid, minMs = RATE_LIMIT_MS) {
  const last = userRate.get(uid) || 0;
  const ok = now() - last >= minMs;
  if (ok) userRate.set(uid, now());
  return !ok;
}
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
function maskUsername(u) { return u ? '@' + u : 'no_username'; }

// Message templating
function get(obj, pathStr) {
  return pathStr.split('.').reduce((o, k) => (o && k in o ? o[k] : undefined), obj);
}
function t(key, vars = {}) {
  let s = get(MSG, key);
  if (!s || typeof s !== 'string') return key; // fallback to key string if missing
  return s.replace(/\{([A-Z0-9_]+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

// Timers for driver window
function setDriverTimer(ref) {
  const s = getSessionByRef(ref); if (!s) return;
  clearDriverTimer(s);
  s.driverTimer = setTimeout(async () => {
    const still = getSessionByRef(ref);
    if (still && !still.assigned_driver_id && still.status === 'DISPATCHING' && STAFF_GROUP_ID) {
      await bot.telegram.sendMessage(
        STAFF_GROUP_ID,
        t('staff.no_driver_ping', { MINUTES: Math.round(DRIVER_WINDOW_MS / 60000), REF: ref })
      );
      const uid = refs.get(ref);
      if (uid) await bot.telegram.sendMessage(uid, t('customer.no_driver_delay', { REF: ref })).catch(()=>{});
    }
  }, DRIVER_WINDOW_MS);
}
function clearDriverTimer(s) { if (s?.driverTimer) { clearTimeout(s.driverTimer); s.driverTimer = null; } }

// ─────────────────────────────────────────────────────────────────────────────
// Health & basics
bot.start(async (ctx) => {
  const txt = ctx.message?.text || '';
  const payload = txt.split(' ')[1];

  if (payload && payload.startsWith('GG_')) {
    const tkn = tokens.get(payload);
    if (!tkn || (now() - tkn.createdAt) > (FEATURES.flows.deepLinkTtlMs || 30 * 60 * 1000)) {
      return ctx.reply('This link expired. Go back to our website and tap Order Now again.');
    }
    const ref = genRef();
    sessions.set(ctx.from.id, { ref, summary: tkn.summary, status: 'AWAITING_PAYMENT', method: null, assigned_driver_id: null, driverTimer: null, approvalTimer: null, holdMsgId: null, giveupUntil: null, createdAt: now() });
    refs.set(ref, ctx.from.id);
    return sendSummaryWithPay(ctx, tkn.summary, ref);
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
bot.command('maintenance', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const args = ctx.message.text.split(' ').slice(1);
  const mode = (args.shift() || '').toLowerCase();
  if (mode === 'on') { maintenance.on = true; maintenance.note = args.join(' ') || ''; return ctx.reply(`✅ Maintenance ON\nNote: ${maintenance.note}`); }
  if (mode === 'off') { maintenance.on = false; maintenance.note = ''; return ctx.reply('✅ Maintenance OFF'); }
  return ctx.reply('Usage:\n/maintenance on <note>\n/maintenance off');
});

// Payment text manage via messages.json (in-memory change; persist by editing file)
const waitFor = new Map(); // chat_id -> 'telebirr'|'bank'
bot.command('settelebirr', async (ctx) => { if (!isOwner(ctx) || !isPrivate(ctx)) return; waitFor.set(ctx.chat.id, 'telebirr'); ctx.reply('Send the new Telebirr text as your next message. (To persist, edit messages.json)'); });
bot.command('setbank',     async (ctx) => { if (!isOwner(ctx) || !isPrivate(ctx)) return; waitFor.set(ctx.chat.id, 'bank');     ctx.reply('Send the new Bank text as your next message. (To persist, edit messages.json)'); });
bot.command('getpay',      async (ctx) => { if (!isOwner(ctx) || !isPrivate(ctx)) return; ctx.reply(`Telebirr:\n${get(MSG,'customer.payment_info_telebirr')}\n\nBank:\n${get(MSG,'customer.payment_info_cbe')}`); });
bot.on('text', async (ctx, next) => {
  const pending = waitFor.get(ctx.chat.id);
  if (pending && isPrivate(ctx) && isOwner(ctx)) {
    if (pending === 'telebirr') { MSG.customer.payment_info_telebirr = ctx.message.text.trim(); await ctx.reply('✅ Telebirr text updated (in-memory). Edit messages.json to persist.'); }
    if (pending === 'bank')     { MSG.customer.payment_info_cbe      = ctx.message.text.trim(); await ctx.reply('✅ Bank text updated (in-memory). Edit messages.json to persist.'); }
    waitFor.delete(ctx.chat.id);
    return;
  }
  return next();
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
    const chunks = json.match(/[\s\S]{1,3500}/g) || [json];
    await ctx.reply(`Current drivers JSON (${chunks.length} part(s)) — paste into drivers.json:`);
    for (const part of chunks) await ctx.reply(part);
    return;
  }
  return ctx.reply(json);
});

// Owner: soft reset & force
bot.command('revert', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const ref = (ctx.message.text.split(' ')[1] || '').trim();
  const s = getSessionByRef(ref);
  if (!s) return ctx.reply('Ref not found.');
  s.status = 'AWAITING_RECEIPT';
  s.assigned_driver_id = null; s.giveupUntil = null;
  clearDriverTimer(s);
  s.createdAt = now(); // refresh TTL
  return ctx.reply(`↩️ Reverted order ${ref} to AWAITING_RECEIPT.`);
});
bot.command('forceapprove', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const ref = (ctx.message.text.split(' ')[1] || '').trim();
  const s = getSessionByRef(ref);
  if (!s) return ctx.reply('Ref not found.');
  const uid = refs.get(ref);
  s.status = 'APPROVED_HOLD'; s.approvalTimer = null;
  await finalizeApproval(s, uid);
  return ctx.reply(`✅ Forced approval for ${ref}.`);
});

// Ops: optional unassign & rebroadcast (guarded by feature flag)
bot.command('unassign', async (ctx) => {
  if (!OPS_UNASSIGN_EN) return; // disabled unless feature flag on
  if (!isOwner(ctx) || (isGroup(ctx) && ctx.chat.id !== STAFF_GROUP_ID)) return;
  const ref = (ctx.message.text.split(' ')[1] || '').trim();
  const s = getSessionByRef(ref);
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
    features_version: FEATURES._meta?.version || 'n/a'
  };
  return ctx.reply('CONFIG:\n' + JSON.stringify(cfg, null, 2));
});
bot.command('reload_texts', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  loadMessages(); loadFeatures();
  return ctx.reply('🔄 Reloaded messages.json & features.json.');
});

// Customer helpers
bot.command('cancel', async (ctx) => {
  if (!isPrivate(ctx)) return;
  const s = sessions.get(ctx.from.id);
  if (!s) return ctx.reply(get(MSG, 'customer.cancel_done') || 'Canceled.');
  refs.delete(s.ref); clearDriverTimer(s); sessions.delete(ctx.from.id);
  return ctx.reply(get(MSG, 'customer.cancel_done') || 'Canceled.');
});

// ─────────────────────────────────────────────────────────────────────────────
// Support escalation
async function escalateToSupport(ctx, rawText) {
  if (!SUPPORT_ENABLED || !SUPPORT_GROUP_ID) {
    return ctx.reply(t('customer.invalid_intake', { SUPPORT_PHONE: SUPPORT_PHONE }));
  }
  const user = ctx.from;
  const kb = Markup.inlineKeyboard([[Markup.button.callback(get(MSG,'buttons.support_claim') || 'I’ll handle', `support_claim:${user.id}`)]]);
  const post = await bot.telegram.sendMessage(
    SUPPORT_GROUP_ID,
    t('support.escalation_post', {
      CUSTOMER_NAME: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Customer',
      USERNAME: maskUsername(user.username),
      USER_ID: user.id,
      MESSAGE: rawText.slice(0, 1000)
    }),
    kb
  );
  await ctx.reply(t('customer.support_forward_ack', { SUPPORT_PHONE }));
  return post;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intake reply
async function sendSummaryWithPay(ctx, summary, ref) {
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(get(MSG,'buttons.payment_telebirr') || 'Telebirr', `pay:telebirr:${ref}`),
     Markup.button.callback(get(MSG,'buttons.payment_cbe') || 'CBE Bank', `pay:bank:${ref}`)]
  ]);
  const welcomeKey = afterCutoff() ? 'customer.welcome_after_cutoff' : 'customer.welcome';
  await ctx.reply(t(welcomeKey, { REF: ref }), kb);
}

// ─────────────────────────────────────────────────────────────────────────────
// Text DM logic (customer)
bot.on('text', async (ctx) => {
  if (!isPrivate(ctx)) return;
  if (ctx.message.text.startsWith('/')) return;

  if (maintenance.on) {
    const note = maintenance.note ? ` (Note: ${maintenance.note})` : '';
    return ctx.reply((get(MSG,'customer.maintenance_on') || 'Maintenance.') + note);
  }
  if (rateLimited(ctx.from.id)) return ctx.reply(get(MSG,'customer.rate_limited') || 'Slow down.');

  const text = ctx.message.text.trim();
  const isQ = isLikelyQuestion(text);

  const existing = sessions.get(ctx.from.id);
  if (existing) {
    if (existing.status === 'AWAITING_RECEIPT') return ctx.reply(get(MSG,'customer.awaiting_receipt_text') || 'Send receipt photo.');
    if (existing.status === 'AWAITING_PAYMENT') {
      if (isQ && FEATURES.intake.escalateOnQuestion) return escalateToSupport(ctx, text);
      return ctx.reply(t('customer.existing_awaiting_payment_nudge', { REF: existing.ref }));
    }
    // Active delivery states
    if (!isOrderSummaryStrict(text, { strictMode: FEATURES.intake.strictMode, minTextLength: FEATURES.intake.minTextLength })) {
      if (isQ && FEATURES.intake.escalateOnQuestion) return escalateToSupport(ctx, text);
      return ctx.reply(t('customer.order_in_progress_note', { REF: existing.ref, SUPPORT_PHONE }));
    }
    // new order mid-flow
    if (!ALLOW_NEW_ORDER) {
      return ctx.reply(t('customer.order_in_progress_note', { REF: existing.ref, SUPPORT_PHONE }));
    }
    // Soft reset to allow new order
    refs.delete(existing.ref); sessions.delete(ctx.from.id);
  }

  // Strict intake
  if (!isOrderSummaryStrict(text, { strictMode: FEATURES.intake.strictMode, minTextLength: FEATURES.intake.minTextLength })) {
    if (isQ && FEATURES.intake.escalateOnQuestion) return escalateToSupport(ctx, text);
    return ctx.reply(t('customer.invalid_intake', { SUPPORT_PHONE }));
  }

  // New order session
  const ref = genRef();
  sessions.set(ctx.from.id, {
    ref, summary: text, status: 'AWAITING_PAYMENT', method: null,
    assigned_driver_id: null, driverTimer: null, approvalTimer: null,
    holdMsgId: null, giveupUntil: null, createdAt: now()
  });
  refs.set(ref, ctx.from.id);

  await sendSummaryWithPay(ctx, text, ref);
});

// ─────────────────────────────────────────────────────────────────────────────
// Buttons: support claim / payment / staff actions / driver actions
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

    // Payment choice
    if (data.startsWith('pay:')) {
      const [, method, ref] = data.split(':');
      const s = getSessionByRef(ref);
      if (!s) return ctx.answerCbQuery('No active order.');
      s.method = method.toUpperCase();
      s.status = 'AWAITING_RECEIPT';

      const f = parseOrderFields(s.summary);
      if (method === 'telebirr') {
        await ctx.reply(t('customer.payment_info_telebirr', { TOTAL: f.total || '—' }));
      } else {
        await ctx.reply(t('customer.payment_info_cbe', { TOTAL: f.total || '—' }));
      }
      await ctx.answerCbQuery('Payment info sent.');

      if (STAFF_GROUP_ID) {
        await ctx.telegram.sendMessage(
          STAFF_GROUP_ID,
          t('staff.method_selected', {
            REF: s.ref, METHOD: s.method,
            CUSTOMER_NAME: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
            USERNAME: maskUsername(ctx.from.username)
          })
        );
      }
      return;
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
        const s = getSessionByRef(ref);
        if (!s || s.status !== 'APPROVED_HOLD') return ctx.answerCbQuery('Nothing to undo.');
        if (s.approvalTimer) { clearTimeout(s.approvalTimer); s.approvalTimer = null; }
        s.status = 'AWAITING_RECEIPT';
        s.assigned_driver_id = null; s.giveupUntil = null;
        s.createdAt = now(); // refresh TTL
        if (s.holdMsgId) {
          await bot.telegram.editMessageText(STAFF_GROUP_ID, s.holdMsgId, undefined, t('staff.approval_undone_message', { REF: s.ref })).catch(()=>{});
        }
        const uid = refs.get(ref);
        const reKb = Markup.inlineKeyboard([
          [Markup.button.callback(get(MSG,'buttons.approve') || 'Approve', `approve:${uid}:${s.ref}`),
           Markup.button.callback(get(MSG,'buttons.reject')  || 'Reject',  `reject:${uid}:${s.ref}`)]
        ]);
        await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.re_review_prompt', { REF: s.ref }), reKb);
        return ctx.answerCbQuery('Approval undone.');
      }

      const [verb, userId, ref] = data.split(':');
      const uid = Number(userId);
      const s = getSessionByRef(ref) || sessions.get(uid);
      if (!s || s.ref !== ref) return ctx.answerCbQuery('Order not found.');
      if (ttlExpired(s)) {
        await ctx.answerCbQuery('Action expired.');
        await ctx.telegram.sendMessage(STAFF_GROUP_ID, t('staff.action_expired', { REF: ref }));
        return;
      }

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
          const fresh = getSessionByRef(ref);
          if (!fresh || fresh.status !== 'APPROVED_HOLD') return;
          await finalizeApproval(fresh, uid).catch(()=>{});
        }, HOLD_SECONDS * 1000);
        return ctx.answerCbQuery('Approved (on hold).');
      } else {
        s.status = 'REJECTED';
        await ctx.telegram.sendMessage(uid, t('customer.payment_rejected', { REF: s.ref, SUPPORT_PHONE }));
        await ctx.editMessageCaption({ caption: t('staff.rejected_caption', { REF: s.ref }) }).catch(()=>{});
        await ctx.telegram.sendMessage(STAFF_GROUP_ID, t('staff.rejected_notice', { REF: s.ref }));
        return ctx.answerCbQuery('Rejected.');
      }
    }

    // Driver accepts / declines
    if (data.startsWith('drv_accept:') || data.startsWith('drv_decline:')) {
      if (!isPrivate(ctx)) return ctx.answerCbQuery('Check your DM with the bot.');
      const [, ref] = data.split(':');
      const s = getSessionByRef(ref);
      if (!s) return ctx.answerCbQuery('Job not found.');
      if (ttlExpired(s)) return ctx.answerCbQuery('This job has expired.');

      if (data.startsWith('drv_accept:')) {
        if (s.assigned_driver_id) {
          return ctx.answerCbQuery(s.assigned_driver_id === ctx.from.id ? (get(MSG,'driver.accept_you_already_have') || 'You already have this job.') : (get(MSG,'driver.accept_already_assigned') || 'Already assigned.'));
        }
        s.assigned_driver_id = ctx.from.id;
        s.status = 'ASSIGNED';
        s.giveupUntil = now() + GIVEUP_MS;
        clearDriverTimer(s);

        const btnPicked = get(MSG,'buttons.drv_picked_am') || '✔ ተነሳ';
        const btnDone   = get(MSG,'buttons.drv_done_am')   || '✔✔ ተደረሰ';
        const btnGiveup = get(MSG,'buttons.drv_giveup_am') || 'እተዋለሁ';
        const driverActions = Markup.inlineKeyboard([
          [Markup.button.callback(btnPicked, `drv_picked:${s.ref}`)],
          [Markup.button.callback(btnDone,   `drv_done:${s.ref}`)],
          [Markup.button.callback(btnGiveup, `drv_giveup:${s.ref}`)]
        ]);

        const f = parseOrderFields(s.summary);
        const mapLine = f.map && f.map !== '—' ? t('driver.broadcast_map_line_am', { MAP_URL: f.map }) : '';
        await ctx.reply(
          t('driver.assigned_card_am', {
            REF: s.ref, QTY: f.qty, AREA: f.area, TOTAL: f.total, DELIVERY_FEE: f.delivery, MAP_LINE: mapLine
          }),
          driverActions
        );
        await ctx.answerCbQuery('Assigned to you.');

        const d = drivers.get(ctx.from.id);
        if (STAFF_GROUP_ID) {
          await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.driver_accepted', {
            REF: s.ref, DRIVER_NAME: d ? d.name : `id ${ctx.from.id}`, DRIVER_PHONE: d ? d.phone : '—', USER_ID: d ? d.id : ctx.from.id
          }));
        }
        await bot.telegram.sendMessage(refs.get(s.ref), t('customer.driver_assigned', { REF: s.ref, DRIVER_NAME: d ? d.name : 'Assigned driver', DRIVER_PHONE: d ? d.phone : '—' }));
        return;
      } else {
        return ctx.answerCbQuery(get(MSG,'driver.declined_ok') || 'Declined. Thanks.');
      }
    }

    // Driver picked / delivered / give up
    if (data.startsWith('drv_picked:') || data.startsWith('drv_done:') || data.startsWith('drv_giveup:')) {
      if (!isPrivate(ctx)) return ctx.answerCbQuery('Use your DM with the bot.');
      const [, ref] = data.split(':');
      const s = getSessionByRef(ref);
      if (!s) return ctx.answerCbQuery('Job not found.');
      if (s.assigned_driver_id !== ctx.from.id) return ctx.answerCbQuery('Not your job.');

      if (data.startsWith('drv_giveup:')) {
        if (!s.giveupUntil || now() > s.giveupUntil) return ctx.answerCbQuery(get(MSG,'driver.giveup_too_late') || 'Too late.');
        const quitterId = s.assigned_driver_id;
        s.assigned_driver_id = null; s.status = 'DISPATCHING'; s.giveupUntil = null;
        if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.driver_canceled_rebroadcast', { REF: s.ref, USER_ID: quitterId }));
        await ctx.answerCbQuery(get(MSG,'driver.giveup_ok') || 'Given up.');
        await broadcastToDrivers(s, quitterId);
        setDriverTimer(s.ref);
        return;
      }

      if (data.startsWith('drv_picked:')) {
        s.status = 'OUT_FOR_DELIVERY';
        await ctx.answerCbQuery(get(MSG,'driver.picked_marked') || 'Picked.');
        if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.picked_up', { REF: s.ref, USER_ID: ctx.from.id }));
        await bot.telegram.sendMessage(refs.get(s.ref), t('customer.picked_up', { REF: s.ref })).catch(()=>{});
        return;
      } else {
        s.status = 'DELIVERED';
        await ctx.answerCbQuery(get(MSG,'driver.delivered_marked') || 'Delivered.');
        if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.delivered', { REF: s.ref, USER_ID: ctx.from.id }));
        await bot.telegram.sendMessage(refs.get(s.ref), t('customer.delivered', { REF: s.ref })).catch(()=>{});
        return;
      }
    }

    return next();
  } catch (e) {
    console.error('callback_query error', e);
    return ctx.answerCbQuery('Error.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Finalize approval after hold (notify customer + dispatch)
async function finalizeApproval(s, uid) {
  try {
    if (!s || s.status !== 'APPROVED_HOLD') return;
    s.status = 'DISPATCHING';
    if (s.holdMsgId) {
      await bot.telegram.editMessageText(STAFF_GROUP_ID, s.holdMsgId, undefined, t('staff.finalize_approved', { REF: s.ref })).catch(()=>{});
    }
    await bot.telegram.sendMessage(uid, t('customer.payment_confirmed_after_hold', { REF: s.ref }));
    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, t('staff.dispatching_notice', { REF: s.ref }));
    await broadcastToDrivers(s);
    setDriverTimer(s.ref);
  } catch (err) {
    console.error('finalizeApproval error', err);
    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, `⚠️ Error while finalizing approval for ${s?.ref || 'ref'}.`);
  } finally {
    if (s) s.approvalTimer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Receipt photo
bot.on('photo', async (ctx) => {
  if (!isPrivate(ctx)) return;
  if (maintenance.on) {
    const note = maintenance.note ? ` (Note: ${maintenance.note})` : '';
    return ctx.reply((get(MSG,'customer.maintenance_on') || 'Maintenance.') + note);
  }

  const s = sessions.get(ctx.from.id);
  if (!s || s.status !== 'AWAITING_RECEIPT') return ctx.reply(get(MSG,'customer.awaiting_receipt_text') || 'Send receipt photo after choosing payment.');
  if (!STAFF_GROUP_ID) return ctx.reply('Staff group not configured yet. Please try again shortly.');

  const best = ctx.message.photo.at(-1);
  const fileId = best.file_id;

  const flags = [];
  if (DUP_FLAG) {
    const isDuplicate = seenReceiptIds.has(fileId);
    seenReceiptIds.add(fileId);
    if (isDuplicate) flags.push('⚠️ Duplicate receipt (same photo sent before)');
  }
  if (FWD_FLAG) {
    const isFwd = !!(ctx.message.forward_from || ctx.message.forward_from_chat || ctx.message.forward_date);
    if (isFwd) flags.push('⚠️ Forwarded receipt');
  }

  const caption = [
    t('staff.receipt_caption', {
      REF: s.ref,
      METHOD: s.method,
      CUSTOMER_NAME: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
      USERNAME: maskUsername(ctx.from.username),
      USER_ID: ctx.from.id
    }),
    flags.length ? `${get(MSG,'staff.receipt_flags_prefix') || 'Flags:'} ${flags.join(' | ')}` : ''
  ].filter(Boolean).join('\n');

  const actions = Markup.inlineKeyboard([
    [Markup.button.callback(get(MSG,'buttons.approve') || 'Approve ✅', `approve:${ctx.from.id}:${s.ref}`),
     Markup.button.callback(get(MSG,'buttons.reject')  || 'Reject ❌',  `reject:${ctx.from.id}:${s.ref}`)]
  ]);

  await ctx.telegram.sendPhoto(STAFF_GROUP_ID, fileId, { caption, ...actions });
  await ctx.telegram.sendMessage(STAFF_GROUP_ID, (get(MSG,'staff.order_summary_prefix') || '🧾 Order Summary:\n').replace('{REF}', s.ref) + s.summary.slice(0, 4000));
  await ctx.reply(t('customer.receipt_received', { REF: s.ref }));
});

// Guard: expecting photo but got something else
bot.on('message', async (ctx) => {
  if (isPrivate(ctx) && !ctx.message.photo && !ctx.message.text?.startsWith('/')) {
    const s = sessions.get(ctx.from.id);
    if (s && s.status === 'AWAITING_RECEIPT') return ctx.reply(get(MSG,'customer.awaiting_receipt_text') || 'Send receipt photo.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Driver broadcast
async function broadcastToDrivers(s, excludeId = null) {
  if (drivers.size === 0) {
    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, '⚠️ No drivers configured. Use /adddriver in owner DM.');
    return;
  }
  const btnAccept = get(MSG,'buttons.drv_accept_am') || '✅ ተቀበል';
  const btnDecline= get(MSG,'buttons.drv_decline_am')|| '❌ አትቀበል';
  const kb = (ref) => Markup.inlineKeyboard([[Markup.button.callback(btnAccept, `drv_accept:${ref}`), Markup.button.callback(btnDecline, `drv_decline:${ref}`)]]);

  const f = parseOrderFields(s.summary);
  const mapLine = f.map && f.map !== '—' ? t('driver.broadcast_map_line_am', { MAP_URL: f.map }) : '';
  const card = t('driver.broadcast_card_am', {
    REF: s.ref, QTY: f.qty, AREA: f.area, TOTAL: f.total, DELIVERY_FEE: f.delivery, MAP_LINE: mapLine
  });

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

// ─────────────────────────────────────────────────────────────────────────────
// Launch
bot.launch().then(() => console.log('Polling started…'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

