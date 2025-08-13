// index.js — GreenGold EMMA v1.2-secure
// Group admins can Approve/Reject. All settings & adds are OWNER-ONLY (DM).

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('Missing BOT_TOKEN in .env'); process.exit(1); }

const OWNER_ID = Number(process.env.OWNER_ID || 0); // YOU are the only owner
if (!OWNER_ID) console.warn('WARNING: OWNER_ID not set. Set it in .env to lock admin.');

let STAFF_GROUP_ID = process.env.STAFF_GROUP_ID ? Number(process.env.STAFF_GROUP_ID) : null;

// Payment texts (owner can update via DM)
let TELEBIRR_TEXT = (process.env.TELEBIRR_TEXT || `Telebirr Merchant: Green Gold Ethiopia plc
Merchant ID: 86555
Phone: +251 904122222

Please send a clear screenshot of your payment receipt here.`).trim();

let BANK_TEXT = (process.env.BANK_TEXT || `Bank: Commercial Bank of Ethiopia (CBE)
Account Name: Green Gold Ethiopia
Account Number: 1000387118806
Branch: Bambis Branch

Please send a clear screenshot of your payment receipt here.`).trim();

// In-memory stores (DB later when we deploy)
const sessions = new Map();           // user_id -> { ref, summary, status, method }
const waitFor = new Map();            // chat_id -> 'telebirr' | 'bank'
const drivers = new Map();            // tg_id -> { id, name, phone }

const bot = new Telegraf(BOT_TOKEN);

// Helpers
function genRef() { return 'GG_' + Math.random().toString(36).slice(2, 6).toUpperCase(); }
const isPrivate = (ctx) => ctx.chat?.type === 'private';
const isGroup = (ctx) => ['group','supergroup'].includes(ctx.chat?.type);
const isOwner = (ctx) => OWNER_ID && ctx.from?.id === OWNER_ID;
const clean = (s='') => s.replace(/\s+/g,' ').trim();

async function isGroupAdmin(ctx) {
  try {
    if (!isGroup(ctx)) return false;
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    const status = member.status; // 'creator' | 'administrator' | 'member' | ...
    return status === 'creator' || status === 'administrator';
  } catch {
    return false;
  }
}

// ===== Health =====
bot.start(async (ctx) => {
  await ctx.reply('EMMA online. Use /ping here. In your staff group, the owner runs /setstaff once.');
});
bot.command('ping', async (ctx) => { await ctx.reply(`pong | ${new Date().toISOString()}`); });
bot.command('me', async (ctx) => { await ctx.reply(`Your ID: ${ctx.from.id}`); });

// ===== Bind staff group (OWNER ONLY, IN GROUP) =====
bot.command('setstaff', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Run /setstaff inside the staff group.');
  if (!isOwner(ctx)) return ctx.reply('Not authorized (owner only).');
  STAFF_GROUP_ID = ctx.chat.id;
  await ctx.reply(`Staff group bound: ${STAFF_GROUP_ID}`);
});

// ===== Owner payment text updates (DM only) =====
bot.command('settelebirr', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  waitFor.set(ctx.chat.id, 'telebirr');
  await ctx.reply('Send the new Telebirr text as your next message (multi-line supported).');
});
bot.command('setbank', async (ctx) => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return;
  waitFor.set(ctx.chat.id, 'bank');
  await ctx.reply('Send the new Bank text as your next message (multi-line supported).');
});
bot.on('text', async (ctx, next) => {
  const pending = waitFor.get(ctx.chat.id);
  if (pending && isPrivate(ctx) && isOwner(ctx)) {
    if (pending === 'telebirr') { TELEBIRR_TEXT = ctx.message.text.trim(); await ctx.reply('✅ Telebirr text updated.'); }
    if (pending === 'bank') { BANK_TEXT = ctx.message.text.trim(); await ctx.reply('✅ Bank text updated.'); }
    waitFor.delete(ctx.chat.id);
    return;
  }
  return next();
});

// ===== Driver management (OWNER DM ONLY) =====
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
  const idStr = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const id = Number(idStr);
  if (!Number.isFinite(id)) return ctx.reply('Format:\n/removedriver <tg_id>');
  if (!drivers.has(id)) return ctx.reply(`No driver with id ${id}.`);
  drivers.delete(id);
  return ctx.reply(`✅ Driver removed: ${id}`);
});

// ===== Customer DM: paste-mode intake =====
bot.on('text', async (ctx) => {
  if (!isPrivate(ctx)) return;
  if (ctx.message.text.startsWith('/')) return;
  const summary = ctx.message.text.trim();
  const ref = genRef();
  sessions.set(ctx.from.id, { ref, summary, status: 'AWAITING_PAYMENT', method: null });
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('Pay with Telebirr', `pay:telebirr:${ref}`)],
    [Markup.button.callback('Pay with Bank (CBE)', `pay:bank:${ref}`)]
  ]);
  await ctx.reply(`🧾 Green Gold Order Summary\n\n${summary}\n\nPick a payment method:`, kb);
});

// ===== Buttons: payment selection + group approvals =====
bot.on('callback_query', async (ctx, next) => {
  try {
    const data = String(ctx.callbackQuery.data || '');

    // Customer payment selection
    if (data.startsWith('pay:')) {
      const [, method, ref] = data.split(':');
      const s = sessions.get(ctx.from.id);
      if (!s || s.ref !== ref) return ctx.answerCbQuery('No active order.');
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

    // Group Approve/Reject (admins only)
    if (data.startsWith('approve:') || data.startsWith('reject:')) {
      if (!isGroup(ctx)) return ctx.answerCbQuery('Use inside staff group.');
      if (!STAFF_GROUP_ID || ctx.chat.id !== STAFF_GROUP_ID) return ctx.answerCbQuery('Wrong group.');
      const admin = await isGroupAdmin(ctx);
      if (!admin) return ctx.answerCbQuery('Not authorized (group admin only).');

      const [, action, userId, ref] = data.split(':'); // approve:USERID:REF
      const uid = Number(userId);
      const s = sessions.get(uid);
      if (!s || s.ref !== ref) return ctx.answerCbQuery('Order not found.');

      if (data.startsWith('approve:')) {
        s.status = 'PAID';
        await ctx.telegram.sendMessage(uid, '✅ Payment confirmed.\nWe’re assigning a driver now. You’ll receive their name and phone shortly.');
        await ctx.editMessageCaption({ caption: `📸 Payment screenshot received\nRef: ${s.ref}\nStatus: ✅ Approved` }).catch(()=>{});
        await ctx.telegram.sendMessage(STAFF_GROUP_ID, `✅ Approved\nRef: ${s.ref}\nNow dispatching to drivers…`);
        // v2: broadcast to drivers, first-accept wins
      } else {
        s.status = 'REJECTED';
        await ctx.telegram.sendMessage(uid, '❌ We couldn’t verify the receipt.\nPlease resend a clear screenshot or reply here if you need help.');
        await ctx.editMessageCaption({ caption: `📸 Payment screenshot received\nRef: ${s.ref}\nStatus: ❌ Rejected` }).catch(()=>{});
        await ctx.telegram.sendMessage(STAFF_GROUP_ID, `❌ Rejected\nRef: ${s.ref}\nCustomer notified to resend.`);
      }
      return ctx.answerCbQuery('Done.');
    }

    return next();
  } catch (e) {
    console.error(e);
    return ctx.answerCbQuery('Error.');
  }
});

// ===== Receipt screenshot handling =====
bot.on('photo', async (ctx) => {
  if (!isPrivate(ctx)) return;
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

// ===== Guard: DM text while awaiting receipt but no photo =====
bot.on('message', async (ctx) => {
  if (isPrivate(ctx) && !ctx.message.photo && !ctx.message.text?.startsWith('/')) {
    const s = sessions.get(ctx.from.id);
    if (s && s.status === 'AWAITING_RECEIPT') await ctx.reply('I need a screenshot of the receipt. Please attach a photo.');
  }
});

// Launch
bot.launch().then(() => console.log('Polling started…'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
