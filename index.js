// GreenGold EMMA — v1.4 "Mega Bomb"
// ✅ Paste-mode intake
// ✅ Payment selection (Telebirr / CBE)
// ✅ Receipt forwarding with Approve/Reject
// ✅ Fix: Approve/Reject parses data correctly (no "order not found")
// ✅ After Approve → broadcast to drivers; first-accept wins
// ✅ Driver flow: Accept/Decline → Picked Up → Delivered
// ✅ No-driver ping after DRIVER_WINDOW_MS
// ✅ Owner-only settings (multi-owner via OWNER_IDS)
// ✅ Approvals: group members by default (toggle via APPROVE_SCOPE)
// ✅ Edge handling: wrong content, link expired stub, maintenance, rate limit
// NOTE: In-memory storage for sessions/drivers; persistence can be added later.

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

// ---------- Required config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env'); process.exit(1);
}
const OWNER_IDS = String(process.env.OWNER_IDS || '')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(n => Number.isFinite(n));
if (OWNER_IDS.length === 0) {
  console.warn('WARNING: OWNER_IDS not set. Set OWNER_IDS=7286480319 (or comma-separated list).');
}
let STAFF_GROUP_ID = process.env.STAFF_GROUP_ID ? Number(process.env.STAFF_GROUP_ID) : null;
const DRIVER_WINDOW_MS = Number(process.env.DRIVER_WINDOW_MS || 30 * 60 * 1000);
const DEEP_LINK_TTL_MS = Number(process.env.DEEP_LINK_TTL_MS || 30 * 60 * 1000);
const APPROVE_SCOPE = (process.env.APPROVE_SCOPE || 'members').toLowerCase(); // 'members' or 'admins'

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
const sessions = new Map();   // customer_id -> { ref, summary, status, method, assigned_driver_id, driverTimer, createdAt }
const refs = new Map();       // ref -> customer_id
const tokens = new Map();     // token -> { summary, createdAt }  (for deep-link tests; owner can create)
const drivers = new Map();    // driver_id -> { id, name, phone }
let maintenance = { on: false, note: '' };
const userRate = new Map();   // user_id -> lastTs

// ---------- Helpers ----------
const bot = new Telegraf(BOT_TOKEN);
const isPrivate = (ctx) => ctx.chat?.type === 'private';
const isGroup = (ctx) => ['group','supergroup'].includes(ctx.chat?.type);
const isOwner = (ctx) => OWNER_IDS.includes(ctx.from?.id);
const clean = (s='') => s.replace(/\s+/g, ' ').trim();
function genRef() { return 'GG_' + Math.random().toString(36).slice(2, 6).toUpperCase(); }
function now() { return Date.now(); }
function getSessionByRef(ref) { const uid = refs.get(ref); return uid ? sessions.get(uid) : null; }

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

// ---------- Health & Utility ----------
bot.start(async (ctx) => {
  // Parse deep-link: "/start GG_<token>"
  const txt = ctx.message?.text || '';
  const parts = txt.split(' ');
  const payload = parts[1];
  if (payload && payload.startsWith('GG_')) {
    const t = tokens.get(payload);
    if (!t || (now() - t.createdAt) > DEEP_LINK_TTL_MS) {
      return ctx.reply('This link expired. Go back to our website and tap Order Now again.');
    }
    const ref = genRef();
    sessions.set(ctx.from.id, { ref, summary: t.summary, status: 'AWAITING_PAYMENT', method: null, assigned_driver_id: null, driverTimer: null, createdAt: now() });
    refs.set(ref, ctx.from.id);
    await sendSummaryWithPay(ctx, t.summary, ref);
    return;
  }
  await ctx.reply('EMMA online. Use /ping here. In your staff group, run /setstaff once.');
});

bot.command('ping', async (ctx) => ctx.reply(`pong | ${new Date().toISOString()}`));
bot.command('me', async (ctx) => ctx.reply(`Your ID: ${ctx.from.id}`));
bot.command('id', async (ctx) => ctx.reply(`Chat ID: ${ctx.chat.id}`));

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

// ---------- (Optional) Owner deep-link test token ----------
bot.command('createtoken', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  const summary = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!summary) return ctx.reply('Usage:\n/createtoken <order summary text>');
  const token = 'GG_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  tokens.set(token, { summary, createdAt: now() });
  return ctx.reply(`Token created:\n${token}\nOpen: t.me/${ctx.botInfo?.username}?start=${token}`);
});

// ---------- Customer intake (DM) ----------
async function sendSummaryWithPay(ctx, summary, ref) {
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('Pay with Telebirr', `pay:telebirr:${ref}`)],
    [Markup.button.callback('Pay with Bank (CBE)', `pay:bank:${ref}`)]
  ]);
  await ctx.reply(`🧾 Green Gold Order Summary\n\n${summary}\n\nPick a payment method:`, kb);
}

bot.on('text', async (ctx) => {
  if (!isPrivate(ctx)) return;
  if (ctx.message.text.startsWith('/')) return;         // handled above
  if (maintenance.on) {
    const note = maintenance.note ? ` (Note: ${maintenance.note})` : '';
    return ctx.reply(`We’re temporarily paused for maintenance. Please try again shortly.${note}`);
  }
  if (rateLimited(ctx.from.id)) return ctx.reply('Please wait a moment before sending another message.');

  // Treat any text as order summary (paste-mode)
  const summary = ctx.message.text.trim();
  const ref = genRef();
  sessions.set(ctx.from.id, { ref, summary, status: 'AWAITING_PAYMENT', method: null, assigned_driver_id: null, driverTimer: null, createdAt: now() });
  refs.set(ref, ctx.from.id);
  await sendSummaryWithPay(ctx, summary, ref);
});

// ---------- Buttons (payment select, group approvals, driver actions) ----------
bot.on('callback_query', async (ctx, next) => {
  try {
    const data = String(ctx.callbackQuery.data || '');

    // Customer selects payment method
    if (data.startsWith('pay:')) {
      const [, method, ref] = data.split(':');                 // "pay:telebirr:GG_XXXX"
      const s = getSessionByRef(ref);
      if (!s) return ctx.answerCbQuery('No active order.');
      s.method = method.toUpperCase();
      s.status = 'AWAITING_RECEIPT';

      await ctx.reply(method === 'telebirr' ? TELEBIRR_TEXT : BANK_TEXT);
      await ctx.answerCbQuery('Payment info sent.');

      if (STAFF_GROUP_ID) {
        await ctx.telegram.sendMessage(
          STAFF_GROUP_ID,
          `ℹ️ Payment method selected
Ref: ${s.ref}
Method: ${s.method}
Customer: ${ctx.from.first_name || ''} ${ctx.from.last_name || ''} (@${ctx.from.username || 'no_username'})`
        );
      }
      return;
    }

    // Group Approve / Reject
    if (data.startsWith('approve:') || data.startsWith('reject:')) {
      if (!isGroup(ctx)) return ctx.answerCbQuery('Use inside staff group.');
      if (!STAFF_GROUP_ID || ctx.chat.id !== STAFF_GROUP_ID) return ctx.answerCbQuery('Wrong group.');
      if (!(await canApprove(ctx))) return ctx.answerCbQuery('Not authorized.');

      const [verb, userId, ref] = data.split(':');             // "approve:USERID:GG_XXXX"
      const uid = Number(userId);
      const s = getSessionByRef(ref) || sessions.get(uid);
      if (!s || s.ref !== ref) return ctx.answerCbQuery('Order not found.');

      if (verb === 'approve') {
        s.status = 'DISPATCHING';
        await ctx.telegram.sendMessage(uid, '✅ Payment confirmed.\nWe’re assigning a driver now. You’ll receive their name and phone shortly.');
        await ctx.editMessageCaption({ caption: `📸 Payment screenshot received\nRef: ${s.ref}\nStatus: ✅ Approved` }).catch(()=>{});
        await ctx.telegram.sendMessage(STAFF_GROUP_ID, `✅ Approved\nRef: ${s.ref}\nNow dispatching to drivers…`);
        await broadcastToDrivers(s);
        setDriverTimer(s.ref);
      } else {
        s.status = 'REJECTED';
        await ctx.telegram.sendMessage(uid, '❌ We couldn’t verify the receipt.\nPlease resend a clear screenshot or reply here if you need help.');
        await ctx.editMessageCaption({ caption: `📸 Payment screenshot received\nRef: ${s.ref}\nStatus: ❌ Rejected` }).catch(()=>{});
        await ctx.telegram.sendMessage(STAFF_GROUP_ID, `❌ Rejected\nRef: ${s.ref}\nCustomer notified to resend.`);
      }
      return ctx.answerCbQuery('Done.');
    }

    // Driver accepts / declines
    if (data.startsWith('drv_accept:') || data.startsWith('drv_decline:')) {
      if (!isPrivate(ctx)) return ctx.answerCbQuery('Check your DM with the bot.');
      const [, ref] = data.split(':');                          // "drv_accept:GG_XXXX"
      const s = getSessionByRef(ref);
      if (!s) return ctx.answerCbQuery('Job not found.');

      if (data.startsWith('drv_accept:')) {
        if (s.assigned_driver_id) {
          return ctx.answerCbQuery(s.assigned_driver_id === ctx.from.id ? 'You already have this job.' : 'Already assigned.');
        }
        s.assigned_driver_id = ctx.from.id;
        s.status = 'ASSIGNED';
        clearDriverTimer(s);

        const driverActions = Markup.inlineKeyboard([
          [Markup.button.callback('Picked Up', `drv_picked:${s.ref}`)],
          [Markup.button.callback('Delivered ✅', `drv_done:${s.ref}`)]
        ]);
        await ctx.reply(`✅ Assigned job\nRef: ${s.ref}\n\nPickup & Order Summary:\n${s.summary.slice(0, 3900)}`, driverActions);
        await ctx.answerCbQuery('Assigned to you.');

        const d = drivers.get(ctx.from.id);
        if (STAFF_GROUP_ID) {
          await bot.telegram.sendMessage(STAFF_GROUP_ID, `🚗 Driver accepted\nRef: ${s.ref}\nDriver: ${d ? `${d.name} (${d.phone}) [${d.id}]` : `id ${ctx.from.id}`}`);
        }
        await bot.telegram.sendMessage(refs.get(s.ref), `🚚 Your order is on the way.\nDriver: ${d ? d.name : 'Assigned driver'}\nPhone: ${d ? d.phone : '—'}`);
        return;
      } else {
        return ctx.answerCbQuery('Declined. Thanks.');
      }
    }

    // Driver picked / delivered
    if (data.startsWith('drv_picked:') || data.startsWith('drv_done:')) {
      if (!isPrivate(ctx)) return ctx.answerCbQuery('Use your DM with the bot.');
      const [, ref] = data.split(':');                          // "drv_picked:GG_XXXX"
      const s = getSessionByRef(ref);
      if (!s) return ctx.answerCbQuery('Job not found.');
      if (s.assigned_driver_id !== ctx.from.id) return ctx.answerCbQuery('Not your job.');

      if (data.startsWith('drv_picked:')) {
        s.status = 'OUT_FOR_DELIVERY';
        await ctx.answerCbQuery('Marked picked up.');
        if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, `📦 Picked up\nRef: ${s.ref}\nDriver: ${ctx.from.id}`);
        return;
      } else {
        s.status = 'DELIVERED';
        await ctx.answerCbQuery('Marked delivered. Thank you!');
        if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, `✅ Delivered\nRef: ${s.ref}\nDriver: ${ctx.from.id}`);
        await bot.telegram.sendMessage(refs.get(s.ref), '✅ Delivered. Enjoy your coffee.');
        return;
      }
    }

    return next();
  } catch (e) {
    console.error('callback_query error', e);
    return ctx.answerCbQuery('Error.');
  }
});

// ---------- Receipt photo ----------
bot.on('photo', async (ctx) => {
  if (!isPrivate(ctx)) return;
  if (maintenance.on) return ctx.reply(`We’re temporarily paused for maintenance. Please try again shortly.${maintenance.note ? ` (Note: ${maintenance.note})` : ''}`);

  const s = sessions.get(ctx.from.id);
  if (!s || s.status !== 'AWAITING_RECEIPT') return ctx.reply('I need a screenshot of the payment receipt after you choose a payment method.');
  if (!STAFF_GROUP_ID) return ctx.reply('Staff group not configured yet. Please try again in a moment.');

  const best = ctx.message.photo.at(-1);
  const fileId = best.file_id;

  const caption =
`📸 Payment screenshot received
Ref: ${s.ref}
Method: ${s.method}
From: ${ctx.from.first_name || ''} ${ctx.from.last_name || ''} (@${ctx.from.username || 'no_username'})
Telegram ID: ${ctx.from.id}`;

  const actions = Markup.inlineKeyboard([
    [Markup.button.callback('Approve ✅', `approve:${ctx.from.id}:${s.ref}`), Markup.button.callback('Reject ❌', `reject:${ctx.from.id}:${s.ref}`)]
  ]);

  await ctx.telegram.sendPhoto(STAFF_GROUP_ID, fileId, { caption, ...actions });
  await ctx.telegram.sendMessage(STAFF_GROUP_ID, `🧾 Order Summary (${s.ref}):\n${s.summary.slice(0, 4000)}`);

  await ctx.reply(`Thanks, we’re verifying your payment now.
Once confirmed, your order will be on its way.
Typical delivery window: 2–4 hours in Addis.
We’ll send you the driver’s name and number.`);
});

// ---------- Guard: expecting photo but got text/other ----------
bot.on('message', async (ctx) => {
  if (isPrivate(ctx) && !ctx.message.photo && !ctx.message.text?.startsWith('/')) {
    const s = sessions.get(ctx.from.id);
    if (s && s.status === 'AWAITING_RECEIPT') return ctx.reply('I need a screenshot of the receipt. Please attach a photo.');
  }
});

// ---------- Driver broadcast ----------
async function broadcastToDrivers(s) {
  if (drivers.size === 0) {
    if (STAFF_GROUP_ID) await bot.telegram.sendMessage(STAFF_GROUP_ID, `⚠️ No drivers configured. Use /adddriver in owner DM.`);
    return;
  }
  const kb = (ref) => Markup.inlineKeyboard([
    [Markup.button.callback('✅ Accept', `drv_accept:${ref}`), Markup.button.callback('❌ Decline', `drv_decline:${ref}`)]
  ]);

  const failed = [];
  const sent = [];
  for (const d of drivers.values()) {
    try {
      await bot.telegram.sendMessage(
        d.id,
        `🚗 New delivery request\nRef: ${s.ref}\n\nShort Summary:\n${s.summary.slice(0, 900)}\n\n(Use the buttons below)`,
        kb(s.ref)
      );
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
