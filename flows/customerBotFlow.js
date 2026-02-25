// flows/customerBotFlow.js — all customer-facing conversation & payment flow
'use strict';

const { Markup } = require('telegraf');

module.exports = function wireCustomerFlow(bot, deps) {
  const {
    FEATURES,
    SUPPORT_PHONE,
    SUPPORT_GROUP_ID,
    STAFF_GROUP_ID,
    getSupportGroupId,
    getStaffGroupId,

    BUTTON_TTL_SEC, // not used here but kept for parity
    ALLOW_NEW_ORDER,

    isLikelyQuestion,
    isOrderSummaryStrict,
    parseOrderFields,
    extractRef,

    t, get,

    Session,

    afterCutoff,

    MSG: RAW_MSG
  } = deps;

  const MSG = RAW_MSG || {};

  // ───────────────────────────────────────────────────────────────────────────
  // Runtime getters (so /setstaff updates work without restart)
  function staffId() {
    const v = (typeof getStaffGroupId === 'function')
      ? getStaffGroupId()
      : (STAFF_GROUP_ID || (process.env.STAFF_GROUP_ID ? Number(process.env.STAFF_GROUP_ID) : null));
    return v ? Number(v) : null;
  }
  function supportId() {
    const v = (typeof getSupportGroupId === 'function')
      ? getSupportGroupId()
      : (SUPPORT_GROUP_ID || (process.env.SUPPORT_GROUP_ID ? Number(process.env.SUPPORT_GROUP_ID) : null));
    return v ? Number(v) : null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Config & guards
  const RATE_LIMIT_MS    = Number(FEATURES?.ops?.rateLimitMs ?? 1500);
  const STRICT_MODE      = !!(FEATURES?.intake?.strictMode ?? true);
  const MIN_TEXT_LEN     = Number(FEATURES?.intake?.minTextLength ?? 50);
  const ESCALATE_ON_Q    = !!(FEATURES?.intake?.escalateOnQuestion ?? true);
  const DUP_FLAG         = !!(FEATURES?.flags?.flagDuplicateReceipts ?? true);
  const FWD_FLAG         = !!(FEATURES?.flags?.flagForwardedReceipts ?? true);
  const TIN_ENABLED      = !!(FEATURES?.flows?.tinEnabled ?? true);
  const NOTIFY_SUPERSEDE = !!(FEATURES?.flags?.notifySupersede ?? true);

  const seenReceiptIds = new Set();
  const userRate = new Map();
  const now = () => Date.now();

  function rateLimited(uid) {
    const last = userRate.get(uid) || 0;
    const ok = now() - last >= RATE_LIMIT_MS;
    if (ok) userRate.set(uid, now());
    return !ok;
  }

  function supportEnabled() {
    return !!(FEATURES?.support?.enabled && supportId());
  }

  // ───────────────────────────────────────────────────────────────────────────
  // UI helpers

  function clearAskKeyboard(ref) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(get(MSG,'buttons.clear_prev_yes') || 'Clear previous', `clearprev:yes:${ref}`),
        Markup.button.callback(get(MSG,'buttons.clear_prev_no')  || 'Keep & continue', `clearprev:no:${ref}`)
      ]
    ]);
  }

  function tinAskKeyboard(ref) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(get(MSG,'buttons.tin_yes') || 'Yes, I have TIN', `tinask:yes:${ref}`),
        Markup.button.callback(get(MSG,'buttons.tin_no')  || 'No',              `tinask:no:${ref}`)
      ]
    ]);
  }

  async function sendSummaryWithPay(ctx, summary, ref) {
    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback(get(MSG,'buttons.payment_telebirr') || 'Telebirr', `pay:telebirr:${ref}`),
        Markup.button.callback(get(MSG,'buttons.payment_cbe')      || 'CBE Bank', `pay:bank:${ref}`)
      ]
    ]);
    const welcomeKey = afterCutoff() ? 'customer.welcome_after_cutoff' : 'customer.welcome';
    await ctx.reply(t(welcomeKey, { REF: ref }), kb);
  }

  async function escalateToSupport(ctx, rawText) {
    if (!supportEnabled()) {
      return ctx.reply(t('customer.invalid_intake', { SUPPORT_PHONE: SUPPORT_PHONE || '' }));
    }
    const user = ctx.from;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback(get(MSG,'buttons.support_claim') || 'I’ll handle', `support_claim:${user.id}`)]
    ]);
    await bot.telegram.sendMessage(
      supportId(),
      t('support.escalation_post', {
        CUSTOMER_NAME: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Customer',
        USERNAME: user.username ? '@' + user.username : 'no_username',
        USER_ID: user.id,
        MESSAGE: (rawText || '').slice(0, 1000)
      }),
      kb
    );
    return ctx.reply(t('support.customer_claim_dm', { SUPPORT_PHONE: SUPPORT_PHONE || '' }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEXT (customer DM)

  bot.on('text', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next && next();
    if ((ctx.message.text || '').startsWith('/')) return next && next();

    const uid = ctx.from.id;
    if (rateLimited(uid)) {
      return ctx.reply(get(MSG,'customer.rate_limited') || 'Please wait a moment.');
    }

    const text = (ctx.message.text || '').trim();
    let s = Session.getSession(uid);

    // Expecting TIN text after user pressed "Yes"
    if (s && s.awaitingTinExpectText === true) {
      const tin = text.slice(0, 128);
      s.tin = tin;
      s.awaitingTinExpectText = false;
      s.awaitingTin = false;

      await ctx.reply(get(MSG,'customer.tin_saved') || 'TIN saved.');
      const sid = staffId();
      if (sid) {
        const prefix = get(MSG,'staff.tin_prefix') || 'TIN:';
        await bot.telegram.sendMessage(sid, `${prefix} ${tin}\nRef: ${s.ref}`).catch(()=>{});
      }
      return;
    }

    const isQ = isLikelyQuestion(text);
    const looksLikeOrder = isOrderSummaryStrict(text, {
      strictMode: !!STRICT_MODE,
      minTextLength: MIN_TEXT_LEN
    });

    // No session yet
    if (!s) {
      if (!looksLikeOrder) {
        if (isQ && ESCALATE_ON_Q) return escalateToSupport(ctx, text);
        return ctx.reply(t('customer.invalid_intake', { SUPPORT_PHONE: SUPPORT_PHONE || '' }));
      }
      const ref = Session.genRef();
      s = {
        ref,
        summary: text,
        status: 'AWAITING_PAYMENT',
        method: null,
        assigned_driver_id: null,
        driverTimer: null,
        approvalTimer: null,
        holdMsgId: null,
        giveupUntil: null,
        createdAt: now(),
        _customerId: uid
      };
      Session.setSession(uid, s);
      Session.setRef(ref, uid);
      return sendSummaryWithPay(ctx, text, ref);
    }

    // Existing session present
    if (looksLikeOrder) {
      if (!ALLOW_NEW_ORDER) {
        return ctx.reply(t('customer.order_in_progress_note', { REF: s.ref, SUPPORT_PHONE: SUPPORT_PHONE || '' }));
      }
      s.pendingNewSummary = text;
      return ctx.reply(t('customer.clear_previous_q', { REF: s.ref }) || 'Clear previous order?', clearAskKeyboard(s.ref));
    }

    if (s.status === 'AWAITING_RECEIPT') {
      return ctx.reply(get(MSG,'customer.awaiting_receipt_text') || 'Send receipt photo.');
    }

    // If they’re already in review and they type, keep it simple
    if (s.status === 'AWAITING_REVIEW') {
      return ctx.reply(get(MSG,'customer.awaiting_review_text') || 'Receipt received. Please wait for confirmation.');
    }

    if (isQ && ESCALATE_ON_Q) return escalateToSupport(ctx, text);
    return ctx.reply(t('customer.order_in_progress_note', { REF: s.ref, SUPPORT_PHONE: SUPPORT_PHONE || '' }));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PHOTO (receipt)
  // ✅ Accept receipt photo BOTH when:
  // - AWAITING_RECEIPT (normal)
  // - AWAITING_REVIEW  (updated/clearer receipt, resend to staff)
  // This fixes your "send clear screenshot" issue.

  bot.on('photo', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;

    const uid = ctx.from.id;
    const s = Session.getSession(uid);

    if (!s) {
      return ctx.reply(get(MSG,'customer.awaiting_receipt_text') || 'Choose payment first, then send receipt photo.');
    }

    const sid = staffId();
    if (!sid) {
      return ctx.reply('Staff group not configured yet. Please try again shortly.');
    }

    if (!(s.status === 'AWAITING_RECEIPT' || s.status === 'AWAITING_REVIEW')) {
      return ctx.reply(get(MSG,'customer.awaiting_receipt_text') || 'Send receipt photo after choosing payment.');
    }

    const best = ctx.message.photo.at(-1);
    const fileId = best.file_id;

    const isReplacement = (s.status === 'AWAITING_REVIEW');
    s.receiptFileId = fileId;

    const flags = [];
    if (isReplacement) flags.push('🟦 Updated receipt (customer resent)');
    if (DUP_FLAG) {
      const isDup = seenReceiptIds.has(fileId);
      seenReceiptIds.add(fileId);
      if (isDup) flags.push('⚠️ Duplicate receipt (same photo sent before)');
    }
    if (FWD_FLAG) {
      const isFwd = !!(ctx.message.forward_from || ctx.message.forward_from_chat || ctx.message.forward_date);
      if (isFwd) flags.push('⚠️ Forwarded receipt');
    }

    await postReceiptToStaff(ctx, s, { flags, staffGroupId: sid });

    // Ask for TIN after posting (optional), does not block staff
    if (TIN_ENABLED) {
      s.awaitingTin = true;
      s.awaitingTinExpectText = false;
      await ctx.reply(get(MSG,'customer.tin_ask') || 'Do you have a TIN to use for this order?', tinAskKeyboard(s.ref));
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CALLBACKS (customer)

  bot.on('callback_query', async (ctx, next) => {
    try {
      const data = String(ctx.callbackQuery.data || '');
      const uid = ctx.from.id;

      // Payment choice
      if (data.startsWith('pay:')) {
        const [, method, ref] = data.split(':');
        const s = Session.getSessionByRef(ref);
        if (!s) return ctx.answerCbQuery('No active order.');

        s.method = method.toUpperCase();
        s.status = 'AWAITING_RECEIPT';

        const f = parseOrderFields(s.summary || '');

        if (method === 'telebirr') {
          await ctx.reply(
            t('customer.payment_info_telebirr', { TOTAL: f.total || '—' }),
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: get(MSG,'buttons.copy_merchant_id') || 'Copy Merchant ID', copy_text: { text: '86555' } }]
                ]
              }
            }
          );
        } else {
          await ctx.reply(
            t('customer.payment_info_cbe', { TOTAL: f.total || '—' }),
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: get(MSG,'buttons.copy_cbe_account') || 'Copy Account Number', copy_text: { text: '1000387118806' } }]
                ]
              }
            }
          );
        }

        await ctx.answerCbQuery('Payment info sent.');

        const sid = staffId();
        if (sid) {
          await ctx.telegram.sendMessage(
            sid,
            t('staff.method_selected', {
              REF: s.ref, METHOD: s.method,
              CUSTOMER_NAME: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
              USERNAME: ctx.from.username ? '@' + ctx.from.username : 'no_username'
            })
          ).catch(()=>{});
        }

        return;
      }

      // Clear previous?
      if (data.startsWith('clearprev:')) {
        const [, yn, oldRef] = data.split(':');
        const sUser = Session.getSession(uid);
        const sOld  = Session.getSessionByRef(oldRef) || sUser;
        const pendingText = sOld?.pendingNewSummary;

        if (!pendingText) {
          await ctx.answerCbQuery('No new order found.');
          await ctx.editMessageText(get(MSG,'errors.no_pending_new_order') || 'No new order found — please paste your new order again.').catch(()=>{});
          return;
        }

        const newRef = Session.genRef();

        if (sOld?.ref) {
          try { Session.deleteRef(sOld.ref); } catch {}
          sOld.supersededRefs = Array.isArray(sOld.supersededRefs) ? sOld.supersededRefs : [];
          sOld.supersededRefs.push(sOld.ref);
        }

        const sNew = {
          ref: newRef,
          summary: pendingText,
          status: 'AWAITING_PAYMENT',
          method: null,
          assigned_driver_id: null,
          driverTimer: null,
          approvalTimer: null,
          holdMsgId: null,
          giveupUntil: null,
          createdAt: now(),
          _customerId: uid
        };
        Session.setSession(uid, sNew);
        Session.setRef(newRef, uid);

        if (sOld) delete sOld.pendingNewSummary;

        const sid = staffId();
        if (yn === 'yes') {
          await ctx.editMessageText((get(MSG,'customer.previous_cleared') || 'Previous order cleared.') + ` ${t('customer.new_order_ready', { REF: newRef })}`).catch(()=>{});
          if (NOTIFY_SUPERSEDE && sid) {
            await bot.telegram.sendMessage(
              sid,
              t('staff.superseded_notice', { OLD_REF: oldRef, NEW_REF: newRef }) ||
                `❗ Order ${oldRef} canceled/superseded. New order pending (${newRef}).`
            ).catch(()=>{});
          }
        } else {
          await ctx.editMessageText((get(MSG,'customer.previous_archived') || 'Continuing with a new order.') + ` ${t('customer.new_order_ready', { REF: newRef })}`).catch(()=>{});
        }

        await sendSummaryWithPay(ctx, pendingText, newRef);
        return;
      }

      // TIN ask result
      if (data.startsWith('tinask:')) {
        const [, yn, ref] = data.split(':');
        const s = Session.getSessionByRef(ref);
        if (!s) return ctx.answerCbQuery('No active order.');

        if (yn === 'yes') {
          s.awaitingTin = true;
          s.awaitingTinExpectText = true;
          await ctx.editMessageText(get(MSG,'customer.tin_prompt') || 'Please send your TIN number.').catch(()=>{});
          await ctx.answerCbQuery('Okay.');
          return;
        } else {
          s.awaitingTin = false;
          s.awaitingTinExpectText = false;
          await ctx.editMessageText(get(MSG,'customer.tin_skip') || 'No TIN used.').catch(()=>{});
          await ctx.answerCbQuery('Okay.');
          return;
        }
      }

      return next && next();
    } catch (e) {
      console.error('customerBotFlow callback error', e);
      return ctx.answerCbQuery('Error.');
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Staff posting — used on receipt; sets AWAITING_REVIEW and posts immediately

  async function postReceiptToStaff(ctx, s, { flags = [], staffGroupId } = {}) {
    try {
      s.status = 'AWAITING_REVIEW';

      const caption = [
        t('staff.receipt_caption', {
          REF: s.ref,
          METHOD: s.method || '—',
          CUSTOMER_NAME: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
          USERNAME: ctx.from.username ? '@' + ctx.from.username : 'no_username',
          USER_ID: ctx.from.id
        }),
        flags.length ? `${get(MSG,'staff.receipt_flags_prefix') || 'Flags:'} ${flags.join(' | ')}` : ''
      ].filter(Boolean).join('\n');

      const actions = Markup.inlineKeyboard([
        [
          Markup.button.callback(get(MSG,'buttons.approve') || 'Approve ✅', `approve:${ctx.from.id}:${s.ref}`),
          Markup.button.callback(get(MSG,'buttons.reject')  || 'Reject ❌',  `reject:${ctx.from.id}:${s.ref}`)
        ]
      ]);

      await ctx.telegram.sendPhoto(staffGroupId, s.receiptFileId, { caption, ...actions });
      await ctx.telegram.sendMessage(
        staffGroupId,
        (get(MSG,'staff.order_summary_prefix') || '🧾 Order Summary:\n') + (s.summary || '').slice(0, 4000)
      );

      await ctx.reply(t('customer.receipt_received', { REF: s.ref }) || 'We received your receipt.');
    } catch (err) {
      console.error('postReceiptToStaff error', err);
      await ctx.reply('There was an issue posting your receipt. Our team has been notified.').catch(()=>{});
      const sid = staffId();
      if (sid) {
        await bot.telegram.sendMessage(sid, `⚠️ Error posting receipt for ${s.ref || 'ref'} — please check logs.`).catch(()=>{});
      }
    }
  }
};
