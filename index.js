// GreenGold EMMA — v2.0 "Ops Bulletproof"
// ─────────────────────────────────────────────────────────────────────────────
// WHAT'S NEW (all in one):
// • Short welcome + echo (no full summary to customer) + Addis 6pm morning line
// • 60s Approval Hold + Undo (customer only notified after hold ends)
// • Driver Give Up (2m) → re-broadcast excluding quitter
// • Support escalation for non-order/questions (claim button + customer DM)
// • Stale button TTL guard (Approve/Accept expire after BUTTON_TTL_SEC)
// • Receipt flags: duplicate file_id + forwarded indicator for staff
// • No-driver timeout also DMs customer: “Slight delay…”
// • Compact Amharic driver card (tries to parse qty/area/total/delivery fee/map)
// • Optional Google Sheets logging on milestones (ENABLE_SHEETS_EXPORT + URL)
// • Owner overrides: /revert {REF}, /forceapprove {REF}, /config_export
//
// DROP-IN: paste over existing index.js and deploy. No other files required.
//
// ENV (Render → Settings → Environment):
// - BOT_TOKEN (required)
// - OWNER_IDS (comma sep) e.g. 7286480319
// - STAFF_GROUP_ID (negative id)
// - SUPPORT_GROUP_ID (negative id)
// - APPROVE_SCOPE = members | admins    (default: members)
// - DRIVER_WINDOW_MS = 1800000          (default: 30m)
// - DEEP_LINK_TTL_MS = 1800000          (default: 30m)
// - BUTTON_TTL_SEC = 900                (default: 15m)
// - TELEBIRR_TEXT / BANK_TEXT           (optional custom copy)
// - SUPPORT_PHONE = +251 2601986        (default set)
// - ENABLE_SHEETS_EXPORT = true|false   (default: false)
// - SHEETS_WEBHOOK_URL = https://...    (Apps Script “web app” URL)
//
// NOTE: Single instance only (no local + Render). Telegram will split updates.

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

// ---------- Required config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('Missing BOT_TOKEN in .env'); process.exit(1); }

const OWNER_IDS = String(process.env.OWNER_IDS || '')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(n => Number.isFinite(n));
if (OWNER_IDS.length === 0) {
  console.warn('WARNING: OWNER_IDS not set. Set OWNER_IDS=7286480319 (or comma-separated list).');
}

let STAFF_GROUP_ID   = process.env.STAFF_GROUP_ID   ? Number(process.env.STAFF_GROUP_ID)   : null;
let SUPPORT_GROUP_ID = process.env.SUPPORT_GROUP_ID ? Number(process.env.SUPPORT_GROUP_ID) : null;

const DRIVER_WINDOW_MS = Number(process.env.DRIVER_WINDOW_MS || 30 * 60 * 1000);
const DEEP_LINK_TTL_MS = Number(process.env.DEEP_LINK_TTL_MS || 30 * 60 * 1000);
const APPROVE_SCOPE    = (process.env.APPROVE_SCOPE || 'members').toLowerCase(); // 'members' or 'admins'
const BUTTON_TTL_SEC   = Number(process.env.BUTTON_TTL_SEC || 900); // 15 min default
const SUPPORT_PHONE    = (process.env.SUPPORT_PHONE || '+251 2601986');

const ENABLE_SHEETS_EXPORT = String(process.env.ENABLE_SHEETS_EXPORT || 'false').toLowerCase() === 'true';
const SHEETS_WEBHOOK_URL   = process.env.SHEETS_WEBHOOK_URL || '';

// ---------- Optional texts ----------
let TELEBIRR_TEXT = (process.env.TELEBIRR_TEXT || `Telebirr Merchant: Green Gold Ethiopia plc
Merchant ID: 86555
Phone: +251 904122222

Please send a clear screenshot of your payment receipt here.`).trim();

let BANK_TEXT = (process.env.BANK_TEXT || `Bank: Commercial Bank of Ethiopia (CBE)
Account Name: Green Gold Ethiopia
Account Number: 1000387118806
Branch: Bambis Branch

Please send a clear screenshot of your payment receipt here.`).trim();

// ---------- In-memory stores ----------
const sessions = new Map();   // customer_id -> { ref, summary, status, method, assigned_driver_id, driverTimer, approvalTimer, holdMsgId, giveupUntil, createdAt }
const refs     = new Map();   // ref -> customer_id
const tokens   = new Map();   // for deep-link tests; owner can create
const drivers  = new Map();   // driver_id -> { id, name, phone }
let maintenance = { on: false, note: '' };
const userRate = new Map();   // user_id -> lastTs
const seenReceiptIds = new Set(); // duplicate receipt detection
const orderLog = [];          // in-memory milestone log (optionally mirrored to Sheets)

// ---------- Helpers ----------
const bot = new Telegraf(BOT_TOKEN);
const isPrivate = (ctx) => ctx.chat?.type === 'private';
const isGroup   = (ctx) => ['group','supergroup'].includes(ctx.chat?.type);
const isOwner   = (ctx) => OWNER_IDS.includes(ctx.from?.id);
const clean     = (s='') => s.replace(/\s+/g, ' ').trim();

function genRef() {
  let ref;
  do { ref = 'GG_' + Math.random().toString(36).slice(2, 6).toUpperCase(); } while (refs.has(ref));
  return ref;
}
function now() { return Date.now(); }
function getSessionByRef(ref) { const uid = refs.get(ref); return uid ? sessions.get(uid) : null; }
function ttlExpired(s) { return !s || (now() - s.createdAt) > (BUTTON_TTL_SEC * 1000); }

// Addis time helper (UTC+3, no DST)
function isAfter6pmAddis() {
  const utcHour = new Date().getUTCHours();
  const addisHour = (utcHour + 3) % 24;
  return addisHour >= 18;
}
function composeWelcomeEcho(ref) {
  const base = `🌿 Welcome to Green Gold.\n🧾 Got your order. Ref ${ref}. Choose a payment method:`;
  return isAfter6pmAddis()
    ? `${base}\n🕕 Orders placed after 6 pm will be delivered in the morning.`
    : base;
}

// Parse useful bits from summary for driver compact card (best effort)
function parseOrderFields(text) {
  const t = text || '';
  // Qty: "qty: 3", "x3", "items: 3"
  let qty = (t.match(/\bqty[:\s]*([0-9]+)\b/i) || t.match(/\bx\s*([0-9]+)\b/i) || t.match(/\bitems?[:\s]*([0-9]+)\b/i) || [,'—'])[1];
  // Total: "Total: ETB 1234" or "... 1,234 ETB"
  let total = (t.match(/\btotal[:\s]*ETB[:\s]*([0-9,]+)/i) || t.match(/([0-9][0-9,]+)\s*ETB\b/i) || [,'—'])[1];
  if (total && total !== '—') total = total.replace(/,/g,'');
  // Delivery fee: "Delivery: ETB 150", "Delivery Fee: 150 ETB"
  let delivery = (t.match(/\b(delivery(?:\s*fee)?)[^\d]*([0-9][0-9,]*)\s*ETB\b/i) || t.match(/\bETB\s*([0-9][0-9,]*)\s*(delivery)/i) || [,'','—'])[2];
  if (delivery && delivery !== '—') delivery = delivery.replace(/,/g,'');
  // Area: lines with "Area:", "አካባቢ:", "ቦታ:"
  let area = (t.match(/(?:Area|አካባቢ|ቦታ)[:\s]+(.{2,80})/i) || [,'—'])[1];
  if (area && area !== '—') area = area.split('\n')[0].trim();
  // Map URL: google maps link if present
  let map = (t.match(/https?:\/\/(?:maps\.google|goo\.gl)\/[^\s)]+/i) || [,'—'])[1];
  // Phone (optional)
  let phone = (t.match(/\+?251[-\s]?\d{9}/) || t.match(/\b0?9\d{8}\b/) || [,''])[1];
  if (phone && phone.startsWith('0')) phone = '+251' + phone.slice(1);
  return { qty: qty || '—', total: total || '—', delivery: delivery || '—', area: area || '—', map: map || '—', phone: phone || '' };
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
  if (APPROVE_SCOPE === 'admins') return isGroupAdmin(ctx);
  return true; // members
}
function setDriverTimer(ref) {
  const s = getSessionByRef(ref);
  if (!s) return;
  clearDriverTimer(s);
  s.driverTimer = setTimeout(async () => {
    const still = getSessionByRef(ref);
    if (still && !still.assigned_driver_id && still.status === 'DISPATCHING' && STAFF_GROUP_ID) {
      await bot.telegram.sendMessage(
        STAFF_GROUP_ID,
        `⏳ No driver accepted within ${Math.round(DRIVER_WINDOW_MS/60000)} minutes.\nRef: ${ref}\nPlease assign manually.`
      );
      const uid = refs.get(ref);
      if (uid) await bot.telegram.sendMessage(uid, `⏱️ We’re finding a driver for ${ref}. Slight delay in finding the driver.`);
      logMilestone('no_driver', still, { result: 'no_driver' }).catch(()=>{});
    }
  }, DRIVER_WINDOW_MS);
}
function clearDriverTimer(s) {
  if (s?.driverTimer) { clearTimeout(s.driverTimer); s.driverTimer = null; }
}
function rateLimited(userId, minMs = 1500) {
  const last = userRate.get(userId) || 0;
  const ok = now() - last >= minMs;
  if (ok) userRate.set(userId, now());
  return !ok;
}
function maskUsername(u) { return u ? '@' + u : 'no_username'; }

// Sheets logging (optional)
async function logMilestone(milestone, s, extra = {}) {
  try {
    const customer_id = refs.get(s.ref);
    const row = {
      timestamp: new Date().toISOString(),
      milestone, // approved | picked_up | delivered | no_driver
      ref: s.ref,
      total: parseOrderFields(s.summary).total || '—',
      delivery_fee: parseOrderFields(s.summary).delivery || '—',
      area: parseOrderFields(s.summary).area || '—',
      items_text: s.summary.slice(0, 500),
      payment_status: s.status,
      approver_id: extra.approver_id || '',
      driver_id: s.assigned_driver_id || '',
      result: extra.result || '',
      customer_id
    };
    orderLog.push(row);
    if (ENABLE_SHEETS_EXPORT && SHEETS_WEBHOOK_URL) {
      await fetch(SHEETS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row)
      });
    }
  } catch (e) { /* silent */ }
}

// ---------- Health & Utility ----------
bot.start(async (ctx) => {
  const txt = ctx.message?.text || '';
  const parts = txt.split(' ');
  const payload = parts[1];
  if (payload && payload.startsWith('GG_')) {
    const t = tokens.get(payload);
    if (!t || (now() - t.createdAt) > DEEP_LINK_TTL_MS) {
      return ctx.reply('This link expired. Go back to our website and tap Order Now again.');
    }
    const ref = genRef();
    sessions.set(ctx.from.id, { ref, summary: t.summary, status: 'AWAITING_PAYMENT', method: null, assigned_driver_id: null, driverTimer: null, approvalTimer: null, holdMsgId: null, giveupUntil: null, createdAt: now() });
    refs.set(ref, ctx.from.id);
    await sendSummaryWithPay(ctx, t.summary, ref);
    return;
  }
  await ctx.reply('EMMA online. Use /ping here. In your staff group, run /setstaff once.');
});

bot.command('ping', async (ctx) => ctx.reply(`pong | ${new Date().toISOString()}`));
bot.command('me',   async (ctx) => ctx.reply(`Your ID: ${ctx.from.id}`));
bot.command('id',   async (ctx) => ctx.reply(`Chat ID: ${ctx.chat.id}`));

// ---------- Bind staff group (owner only, in group) ----------
bot.command('setstaff', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Run /setstaff inside the staff group.');
  if (!isOwner(ctx)) return ctx.reply('Not authorized (owner only).');
  STAFF_GROUP_ID = ctx.chat.id;
  await ctx.reply(`Staff group bound: ${STAFF_GROUP_ID}`);
});

// ---------- Maintenance (owner DM) ----------
bot.command('maintenance', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const args = ctx.message.text.split(' ').slice(1);
  const mode = (args.shift() || '').toLowerCase();
  if (mode === 'on') {
    maintenance.on = true; maintenance.note = args.join(' ') || '';
    return ctx.reply(`✅ Maintenance ON\nNote: ${maintenance.note}`);
  } else if (mode === 'off') {
    maintenance.on = false; maintenance.note = '';
    return ctx.reply('✅ Maintenance OFF');
  } else {
    return ctx.reply('Usage:\n/maintenance on <note>\n/maintenance off');
  }
});

// ---------- Approve scope toggle (owner DM) ----------
bot.command('approverule', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const v = (ctx.message.text.split(' ')[1] || '').toLowerCase();
  if (!['members','admins'].includes(v)) return ctx.reply('Usage: /approverule members|admins');
  process.env.APPROVE_SCOPE = v; // reflect at runtime
  return ctx.reply(`✅ Approve scope set to: ${v}`);
});

// ---------- Payment texts (owner DM) ----------
const waitFor = new Map(); // chat_id -> 'telebirr'|'bank'
bot.command('settelebirr', async (ctx) => { if (!isOwner(ctx) || !isPrivate(ctx)) return; waitFor.set(ctx.chat.id, 'telebirr'); ctx.reply('Send the new Telebirr text as your next message.'); });
bot.command('setbank',     async (ctx) => { if (!isOwner(ctx) || !isPrivate(ctx)) return; waitFor.set(ctx.chat.id, 'bank');     ctx.reply('Send the new Bank text as your next message.'); });
bot.command('getpay',      async (ctx) => { if (!isOwner(ctx) || !isPrivate(ctx)) return; ctx.reply(`Telebirr:\n${TELEBIRR_TEXT}\n\nBank:\n${BANK_TEXT}`); });

bot.on('text', async (ctx, next) => {
  const pending = waitFor.get(ctx.chat.id);
  if (pending && isPrivate(ctx) && isOwner(ctx)) {
    if (pending === 'telebirr') { TELEBIRR_TEXT = ctx.message.text.trim(); await ctx.reply('✅ Telebirr text updated.'); }
    if (pending === 'bank')     { BANK_TEXT = ctx.message.text.trim();     await ctx.reply('✅ Bank text updated.'); }
    waitFor.delete(ctx.chat.id);
    return;
  }
  return next();
});

// ---------- Owner driver management (DM) ----------
bot.command('adddriver', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const raw = ctx.message.text.split(' ').slice(1).join(' ');
  if (!raw) return ctx.reply('Format:\n/adddriver <tg_id> | <full name> | <phone>');
  const parts = raw.split('|').map(x => clean(x));
  if (parts.length < 3) return ctx.reply('Format:\n/adddriver <tg_id> | <full name> | <phone>');
  const id = Number(parts[0]); const name = parts[1]; const phone = parts[2];
  if (!Number.isFinite(id)) return ctx.reply('tg_id must be a number. Example:\n/adddriver 7138336029 | Abebe | +971 524711872');
  drivers.set(id, { id, name, phone });
  return ctx.reply(`✅ Driver added:\n• ID: ${id}\n• Name: ${name}\n• Phone: ${phone}`);
});
bot.command('drivers', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  if (drivers.size === 0) return ctx.reply('No drivers yet. Add one:\n/adddriver 7138336029 | Abebe | +971 524711872');
  const list = [...drivers.values()].map(d => `• ${d.name} — ${d.phone} (id ${d.id})`).join('\n');
  return ctx.reply(`Drivers:\n${list}`);
});
bot.command('removedriver', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const id = Number(ctx.message.text.split(' ').slice(1).join(' ').trim());
  if (!Number.isFinite(id)) return ctx.reply('Format:\n/removedriver <tg_id>');
  if (!drivers.has(id)) return ctx.reply(`No driver with id ${id}.`);
  drivers.delete(id);
  return ctx.reply(`✅ Driver removed: ${id}`);
});

// ---------- Owner overrides (DM) ----------
bot.command('revert', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const ref = (ctx.message.text.split(' ')[1] || '').trim();
  const s = getSessionByRef(ref);
  if (!s) return ctx.reply('Ref not found.');
  s.status = 'AWAITING_RECEIPT';
  s.assigned_driver_id = null;
  s.giveupUntil = null;
  clearDriverTimer(s);
  return ctx.reply(`↩️ Reverted order ${ref} to AWAITING_RECEIPT.`);
});
bot.command('forceapprove', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const ref = (ctx.message.text.split(' ')[1] || '').trim();
  const s = getSessionByRef(ref);
  if (!s) return ctx.reply('Ref not found.');
  const uid = refs.get(ref);
  s.status = 'APPROVED_HOLD';
  s.approvalTimer = null;
  await finalizeApproval(s, uid);
  return ctx.reply(`✅ Forced approval for ${ref}.`);
});
bot.command('config_export', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const cfg = {
    STAFF_GROUP_ID, SUPPORT_GROUP_ID, APPROVE_SCOPE, DRIVER_WINDOW_MS, BUTTON_TTL_SEC,
    ENABLE_SHEETS_EXPORT, SHEETS_WEBHOOK_URL: SHEETS_WEBHOOK_URL ? '[set]' : '[unset]',
    TELEBIRR_TEXT_len: TELEBIRR_TEXT.length, BANK_TEXT_len: BANK_TEXT.length
  };
  return ctx.reply('CONFIG:\n' + JSON.stringify(cfg, null, 2));
});

// ---------- Support escalation ----------
async function escalateToSupport(ctx, rawText) {
  if (!SUPPORT_GROUP_ID) {
    return ctx.reply(
      `I couldn’t read that as an order. Please tap “Order Now” on our site so it pastes the correct summary.\n` +
      `If you already have an ongoing order, call ${SUPPORT_PHONE}.`
    );
  }
  const user = ctx.from;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('I’ll handle', `support_claim:${user.id}`)]
  ]);
  const post = await bot.telegram.sendMessage(
    SUPPORT_GROUP_ID,
    `🆘 Customer Help Needed\nUser: ${user.first_name || ''} ${user.last_name || ''} (${maskUsername(user.username)})\n` +
    `Telegram ID: ${user.id}\nMessage:\n_${rawText.slice(0, 1000)}_`,
    kb
  );
  await ctx.reply(`We’ve forwarded your message to a support teammate. If urgent, call ${SUPPORT_PHONE}.`);
  return post;
}

// ---------- Customer intake (DM) ----------
async function sendSummaryWithPay(ctx, summary, ref) {
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('Telebirr', `pay:telebirr:${ref}`), Markup.button.callback('CBE Bank', `pay:bank:${ref}`)]
  ]);
  await ctx.reply(composeWelcomeEcho(ref), kb);
}

bot.on('text', async (ctx) => {
  if (!isPrivate(ctx)) return;
  if (ctx.message.text.startsWith('/')) return; // handled above

  if (maintenance.on) {
    const note = maintenance.note ? ` (Note: ${maintenance.note})` : '';
    return ctx.reply(`We’re temporarily paused for maintenance. Please try again shortly.${note}`);
  }
  if (rateLimited(ctx.from.id)) return ctx.reply('Please wait a moment before sending another message.');

  const text = ctx.message.text.trim();

  // If question / not clearly an order → escalate to Support
  if (/[?]/.test(text) || text.length < 30) {
    await escalateToSupport(ctx, text);
    return;
  }

  // Treat as order summary (paste-mode)
  const ref = genRef();
  sessions.set(ctx.from.id, {
    ref, summary: text, status: 'AWAITING_PAYMENT', method: null,
    assigned_driver_id: null, driverTimer: null, approvalTimer: null,
    holdMsgId: null, giveupUntil: null, createdAt: now()
  });
  refs.set(ref, ctx.from.id);

  await sendSummaryWithPay(ctx, text, ref);
});

// ---------- Buttons (payment select, group approvals, driver actions, support claim) ----------
bot.on('callback_query', async (ctx, next) => {
  try {
    const data = String(ctx.callbackQuery.data || '');

    // Support claim (from Support group)
    if (data.startsWith('support_claim:')) {
      if (!isGroup(ctx) || ctx.chat.id !== SUPPORT_GROUP_ID) return ctx.answerCbQuery('Use inside support group.');
      const customerId = Number(data.split(':')[1]);
      const who = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `id ${ctx.from.id}`;
      const msg = ctx.update.callback_query.message;
      const claimed = (msg.text || '').split('\n').concat([`🟢 ${who} is handling.`]).join('\n');
      await ctx.telegram.editMessageText(SUPPORT_GROUP_ID, msg.message_id, undefined, claimed).catch(()=>{});
      await bot.telegram.sendMessage(customerId, `👋 A team member is on it. If you need to call, ${SUPPORT_PHONE}.`).catch(()=>{});
      return ctx.answerCbQuery('Claimed.');
    }

    // Customer selects payment method
    if (data.startsWith('pay:')) {
      const [, method, ref] = data.split(':'); // "pay:telebirr:GG_XXXX"
      const s = getSessionByRef(ref);
      if (!s) return ctx.answerCbQuery('No active order.');
      s.method = method.toUpperCase();
      s.status = 'AWAITING_RECEIPT';

      await ctx.reply(method === 'telebirr' ? TELEBIRR_TEXT : BANK_TEXT);
      await ctx.answerCbQuery('Payment info sent.');

      if (STAFF_GROUP_ID) {
        await ctx.telegram.sendMessage(
          STAFF_GROUP_ID,
          `ℹ️ Payment method selected\nRef: ${s.ref}\nMethod: ${s.method}\nCustomer: ${ctx.from.first_name || ''} ${ctx.from.last_name || ''} (${maskUsername(ctx.from.username)})`
        );
      }
      return;
    }

    // Group Approve / Reject / Undo
    if (data.startsWith('approve:') || data.startsWith('reject:') || data.startsWith('undo:')) {
      if (!isGroup(ctx)) return ctx.answerCbQuery('Use inside staff group.');
      if (!STAFF_GROUP_ID || ctx.chat.id !== STAFF_GROUP_ID) return ctx.answerCbQuery('Wrong group.');
      if (!(await canApprove(ctx))) return ctx.answerCbQuery('Not authorized.');

      // Undo
      if (data.startsWith('undo:')) {
        const ref = data.split(':')[1];
        const s = getSessionByRef(ref);
        if (!s || s.status !== 'APPROVED_HOLD') return ctx.answerCbQuery('Nothing to undo.');
        if (s.approvalTimer) { clearTimeout(s.approvalTimer); s.approvalTimer = null; }
        s.status = 'AWAITING_RECEIPT';
        if (s.holdMsgId) {
          const doneText = `↩️ Approval undone — Ref: ${s.ref}\nCustomer was NOT notified.`;
          await bot.telegram.editMessageText(STAFF_GROUP_ID, s.holdMsgId, undefined, doneText).catch(()=>{});
        }
        await bot.telegram.sendMessage(STAFF_GROUP_ID, `↩️ Approval undone\nRef: ${s.ref}`);
        return ctx.answerCbQuery('Approval undone.');
      }

      // Approve/Reject
      const [verb, userId, ref] = data.split(':'); // "approve:USERID:GG_XXXX"
      const uid = Number(userId);
      const s = getSessionByRef(ref) || sessions.get(uid);
      if (!s || s.ref !== ref) return ctx.answerCbQuery('Order not found.');

      // TTL guard (stale approval)
      if (ttlExpired(s)) {
        await ctx.answerCbQuery('This action expired for this order.');
        await ctx.telegram.sendMessage(STAFF_GROUP_ID, `⛔ Action expired — Ref: ${ref}`);
        return;
      }

      if (verb === 'approve') {
        s.status = 'APPROVED_HOLD';
        await ctx.editMessageCaption({ caption: `📸 Payment screenshot received\nRef: ${s.ref}\nStatus: ✅ Approved (on hold 60s)` }).catch(()=>{});
        const holdMsg = await ctx.telegram.sendMessage(
          STAFF_GROUP_ID,
          `✅ Approved — Ref: ${s.ref}\n⏳ Holding 60s before notifying customer.\nTap Undo to cancel.`,
          Markup.inlineKeyboard([ [Markup.button.callback('Undo (60s)', `undo:${s.ref}`)] ])
        );
        s.holdMsgId = holdMsg.message_id;
        s.approvalTimer = setTimeout(async () => {
          const fresh = getSessionByRef(ref);
          if (!fresh || fresh.status !== 'APPROVED_HOLD') return;
          await finalizeApproval(fresh, uid).catch(()=>{});
        }, 60 * 1000);
        return ctx.answerCbQuery('Approved (on hold).');
      } else { // reject
        s.status = 'REJECTED';
        await ctx.telegram.sendMessage(uid, `❌ We couldn’t verify the receipt for ${s.ref}.\nPlease send a clear screenshot (full screen, readable).\nIf you need help, call ${SUPPORT_PHONE}.`);
        await ctx.editMessageCaption({ caption: `📸 Payment screenshot received\nRef: ${s.ref}\nStatus: ❌ Rejected` }).catch(()=>{});
        await ctx.telegram.sendMessage(STAFF_GROUP_ID, `❌ Rejected\nRef: ${s.ref}\nCustomer notified to resend.`);
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
          return ctx.answerCbQuery(s.assigned_driver_id === ctx.from.id ? 'You already have this job.' : 'Already assigned.');
        }
        s.assigned_driver_id = ctx.from.id;
        s.status = 'ASSIGNED';
        s.giveupUntil = now() + 2 * 60 * 1000; // 2 minutes to give up
        clearDriverTimer(s);

        const driverActions = Markup.inlineKeyboard([
          [Markup.button.callback('✔ ተነሳ', `drv_picked:${s.ref}`)],
          [Markup.button.callback('✔✔ ተደረሰ', `drv_done:${s.ref}`)],
          [Markup.button.callback('እተዋለሁ', `drv_giveup:${s.ref}`)]
        ]);

        const f = parseOrderFields(s.summary);
        await ctx.reply(
          `✅ ስራ ተመድቧል (Assigned)\nRef: ${s.ref}\n\n` +
          `ብዛት: ${f.qty}\n` +
          `ቦታ: ${f.area}\n` +
          `ጠቅላላ ዋጋ: ${f.total} ETB\n` +
          `ጭነት የሞተር ሂሳብ: ${f.delivery}\n` +
          (f.map && f.map !== '—' ? `ካርታ: ${f.map}\n` : '') +
          `\n(ከታች ያሉ ቁልፎችን ይጠቀሙ)`,
          driverActions
        );
        await ctx.answerCbQuery('Assigned to you.');

        const d = drivers.get(ctx.from.id);
        if (STAFF_GROUP_ID) {
          await bot.telegram.sendMessage(STAFF_GROUP_ID, `🚗 Driver accepted\nRef: ${s.ref}\nDriver: ${d ? `${d.name} (${d.phone}) [${d.id}]` : `id ${ctx.from.id}`}`);
        }
        await bot.telegram.sendMessage(refs.get(s.ref), `🚚 Your order is on the way.\nDriver: ${d ? d.name : 'Assigned driver'}\nPhone: ${d ? d.phone : '—'}`);
        logMilestone('approved', s, { approver_id: 'auto_after_hold' }).catch(()=>{});
        return;
      } else {
        return ctx.answerCbQuery('Declined. Thanks.');
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
        if (!s.giveupUntil || now() > s.giveupUntil) return ctx.answerCbQuery('Give up window has expired.');
        const quitterId = s.assigned_driver_id;
        s.assigned_driver_id = null;
        s.status = 'DISPATCHING';
        s.giveupUntil = null;
        if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, `⚠️ Driver canceled — Ref: ${s.ref}. Re-broadcasting to others (excluding ${quitterId}).`);
        await ctx.answerCbQuery('You’ve given up this job.');
        await broadcastToDrivers(s, quitterId);
        setDriverTimer(s.ref);
        return;
      }

      if (data.startsWith('drv_picked:')) {
        s.status = 'OUT_FOR_DELIVERY';
        await ctx.answerCbQuery('Marked picked up.');
        if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, `📦 Picked up\nRef: ${s.ref}\nDriver: ${ctx.from.id}`);
        logMilestone('picked_up', s).catch(()=>{});
        return;
      } else {
        s.status = 'DELIVERED';
        await ctx.answerCbQuery('Marked delivered. Thank you!');
        if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, `✅ Delivered\nRef: ${s.ref}\nDriver: ${ctx.from.id}`);
        await bot.telegram.sendMessage(refs.get(s.ref), '✅ Delivered. Enjoy your coffee.');
        logMilestone('delivered', s, { result: 'success' }).catch(()=>{});
        return;
      }
    }

    return next();
  } catch (e) {
    console.error('callback_query error', e);
    return ctx.answerCbQuery('Error.');
  }
});

// Finalize approval after hold
async function finalizeApproval(s, uid) {
  try {
    if (!s || s.status !== 'APPROVED_HOLD') return;
    s.status = 'DISPATCHING';
    if (s.holdMsgId) {
      const txt = `✅ Approved — Ref: ${s.ref}\nHold finished. Notifying customer and dispatching.`;
      await bot.telegram.editMessageText(STAFF_GROUP_ID, s.holdMsgId, undefined, txt).catch(()=>{});
    }
    await bot.telegram.sendMessage(uid, '✅ Payment confirmed for your order.\nWe’re assigning a driver now.');
    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, `📣 Dispatching to drivers…\nRef: ${s.ref}`);
    await broadcastToDrivers(s);
    setDriverTimer(s.ref);
  } catch (err) {
    console.error('finalizeApproval error', err);
    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, `⚠️ Error while finalizing approval for ${s.ref}.`);
  } finally {
    if (s) s.approvalTimer = null;
  }
}

// ---------- Receipt photo ----------
bot.on('photo', async (ctx) => {
  if (!isPrivate(ctx)) return;
  if (maintenance.on) {
    const note = maintenance.note ? ` (Note: ${maintenance.note})` : '';
    return ctx.reply(`We’re temporarily paused for maintenance. Please try again shortly.${note}`);
  }

  const s = sessions.get(ctx.from.id);
  if (!s || s.status !== 'AWAITING_RECEIPT') return ctx.reply('I need a screenshot of the payment receipt after you choose a payment method.');
  if (!STAFF_GROUP_ID) return ctx.reply('Staff group not configured yet. Please try again in a moment.');

  const best = ctx.message.photo.at(-1);
  const fileId = best.file_id;

  // Duplicate / forwarded
  const isDuplicate = seenReceiptIds.has(fileId);
  seenReceiptIds.add(fileId);
  const isFwd = !!(ctx.message.forward_from || ctx.message.forward_from_chat || ctx.message.forward_date);

  const captionLines = [
    `📸 Payment screenshot received`,
    `Ref: ${s.ref}`,
    `Method: ${s.method}`,
    `From: ${ctx.from.first_name || ''} ${ctx.from.last_name || ''} (${maskUsername(ctx.from.username)})`,
    `Telegram ID: ${ctx.from.id}`
  ];
  const flags = [];
  if (isDuplicate) flags.push('⚠️ Duplicate receipt (same photo sent before)');
  if (isFwd) flags.push('⚠️ Forwarded receipt');
  if (flags.length) captionLines.push(`Flags: ${flags.join(' | ')}`);
  const caption = captionLines.join('\n');

  const actions = Markup.inlineKeyboard([
    [Markup.button.callback('Approve ✅', `approve:${ctx.from.id}:${s.ref}`), Markup.button.callback('Reject ❌', `reject:${ctx.from.id}:${s.ref}`)]
  ]);

  await ctx.telegram.sendPhoto(STAFF_GROUP_ID, fileId, { caption, ...actions });

  // Full summary for staff (not to customer)
  await ctx.telegram.sendMessage(STAFF_GROUP_ID, `🧾 Order Summary (${s.ref}):\n${s.summary.slice(0, 4000)}`);

  await ctx.reply(`📸 Receipt received for ${s.ref}. We’re verifying it. You’ll get an update shortly.`);
});

// ---------- Guard: expecting photo but got text/other ----------
bot.on('message', async (ctx) => {
  if (isPrivate(ctx) && !ctx.message.photo && !ctx.message.text?.startsWith('/')) {
    const s = sessions.get(ctx.from.id);
    if (s && s.status === 'AWAITING_RECEIPT') return ctx.reply('I need a screenshot of the receipt. Please attach a photo.');
  }
});

// ---------- Driver broadcast ----------
async function broadcastToDrivers(s, excludeId = null) {
  if (drivers.size === 0) {
    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, `⚠️ No drivers configured. Use /adddriver in owner DM.`);
    return;
  }
  const kb = (ref) => Markup.inlineKeyboard([
    [Markup.button.callback('✅ ተቀበል', `drv_accept:${ref}`), Markup.button.callback('❌ አትቀበል', `drv_decline:${ref}`)]
  ]);

  const f = parseOrderFields(s.summary);
  const card =
    `🛵 አዲስ ስራ — ${s.ref}\n` +
    `ብዛት: ${f.qty}\n` +
    `ቦታ: ${f.area}\n` +
    `ጠቅላላ ዋጋ: ${f.total} ETB\n` +
    `ጭነት የሞተር ሂሳብ: ${f.delivery}\n` +
    (f.map && f.map !== '—' ? `ካርታ: ${f.map}\n` : '') +
    `\n(ቁልፎችን ይጠቀሙ)`;

  const failed = [];
  const sent = [];
  for (const d of drivers.values()) {
    if (excludeId && d.id === excludeId) continue;
    try {
      await bot.telegram.sendMessage(d.id, card, kb(s.ref));
      sent.push(`${d.name} [${d.id}]`);
    } catch {
      failed.push(`${d.name || 'Driver'} [${d.id}]`);
    }
  }
  if (STAFF_GROUP_ID) {
    await bot.telegram.sendMessage(
      STAFF_GROUP_ID,
      `Driver broadcast sent.\nRef: ${s.ref}\n✅ Sent: ${sent.length ? sent.join(', ') : 'none'}\n⚠️ Failed (DM first): ${failed.length ? failed.join(', ') : 'none'}`
    );
    if (failed.length) {
      await bot.telegram.sendMessage(STAFF_GROUP_ID, `⚠️ Could not DM ${failed.length} driver(s). They must DM the bot at least once.`);
    }
  }
}

// ---------- Launch ----------
bot.launch().then(() => console.log('Polling started…'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
