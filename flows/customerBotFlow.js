// flows/customerBotFlow.js — all customer-facing conversation & payment flow
'use strict';

const { Markup } = require('telegraf');

module.exports = function wireCustomerFlow(bot, deps) {
  const {
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
    // optional raw messages
    MSG: RAW_MSG
  } = deps;

  const MSG = RAW_MSG || {};

  // ───────────────────────────────────────────────────────────────────────────
  // Config & guards
  const RATE_LIMIT_MS   = Number(FEATURES?.ops?.rateLimitMs ?? 1500);
  const STRICT_MODE     = !!(FEATURES?.intake?.strictMode ?? true);
  const MIN_TEXT_LEN    = Number(FEATURES?.intake?.minTextLength ?? 50);
  const ESCALATE_ON_Q   = !!(FEATURES?.intake?.escalateOnQuestion ?? true);
  const DUP_FLAG        = !!(FEATURES?.flags?.flagDuplicateReceipts ?? true);
  const FWD_FLAG        = !!(FEATURES?.flags?.flagForwardedReceipts ?? true);
  const TIN_ENABLED     = !!(FEATURES?.flows?.tinEnabled ?? true);
  const NOTIFY_SUPERSEDE= !!(FEATURES?.flags?.notifySupersede ?? true);

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
    return !!(FEATURES?.support?.enabled && SUPPORT_GROUP_ID);
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
      SUPPORT_GROUP_ID,
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

    if (rateLimited(ctx.from.id)) {
      return ctx.reply(get(MSG,'customer.rate_limited') || 'Please wait a moment.');
    }

    const text = (ctx.message.text || '').trim();
    const isQ = isLikelyQuestion(text);

    const looksLikeOrder = isOrderSummaryStrict(text, {
      strictMode: STRICT_MODE,
      minTextLength: MIN_TEXT_LEN
    });

    let s = Session.getSession(ctx.from.id);

    // No session yet
    if (!s) {
      if (!looksLikeOrder) {
        if (isQ && ESCALATE_ON_Q) return escalateToSupport(ctx, text);
        return ctx.reply(t('customer.invalid_intake', { SUPPORT_PHONE: SUPPORT_PHONE || '' }));
      }
      // New order: create
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
        _customerId: ctx.from.id,
      };
      Session.setSession(ctx.from.id, s);
      Session.setRef(ref, ctx.from.id);
      return sendSummaryWithPay(ctx, text, ref);
    }

    // Existing session present
    if (looksLikeOrder) {
      if (!ALLOW_NEW_ORDER) {
        return ctx.reply(t('customer.order_in_progress_note', { REF: s.ref, SUPPORT_PHONE: SUPPORT_PHONE || '' }));
      }

      // Cache the new summary on the *session*, not ctx.session
      s.pendingNewSummary = text;

      // Ask to clear previous (works for AWAITING_RECEIPT and any other progress state)
      const promptKey = 'customer.clear_previous_q';
      return ctx.reply(t(promptKey, { REF: s.ref }) || 'Clear previous order?', clearAskKeyboard(s.ref));
    }

    // Not an order text
    if (s.status === 'AWAITING_RECEIPT') {
      return ctx.reply(get(MSG,'customer.awaiting_receipt_text') || 'Send receipt photo.');
    }
    if (isQ && ESCALATE_ON_Q) return escalateToSupport(ctx, text);

    return ctx.reply(t('customer.order_in_progress_note', { REF: s.ref, SUPPORT_PHONE: SUPPORT_PHONE || '' }));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PHOTO (receipt)

  bot.on('photo', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;

    const s = Session.getSession(ctx.from.id);
    if (!s || s.status !== 'AWAITING_RECEIPT') {
      return ctx.reply(get(MSG,'customer.awaiting_receipt_text') || 'Send receipt photo after choosing payment.');
    }
    if (!STAFF_GROUP_ID) {
      return ctx.reply('Staff group not configured yet. Please try again shortly.');
    }

    const best = ctx.message.photo.at(-1);
    const fileId = best.file_id;
    s.receiptFileId = fileId;

    const flags = [];
    if (DUP_FLAG) {
      const isDup = seenReceiptIds.has(fileId);
      seenReceiptIds.add(fileId);
      if (isDup) flags.push('⚠️ Duplicate receipt (same photo sent before)');
    }
    if (FWD_FLAG) {
      const isFwd = !!(ctx.message.forward_from || ctx.message.forward_from_chat || ctx.message.forward_date);
      if (isFwd) flags.push('⚠️ Forwarded receipt');
    }

    if (TIN_ENABLED) {
      s.status = 'AWAITING_TIN';
      s._receiptFlags = flags;
      await ctx.reply(get(MSG,'customer.tin_ask') || 'Do you have a TIN to use for this order?', tinAskKeyboard(s.ref));
      return;
    }

    await postReceiptToStaff(ctx, s, { flags });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CALLBACKS (customer)

  bot.on('callback_query', async (ctx, next) => {
    try {
      const data = String(ctx.callbackQuery.data || '');

      // Payment choice
      if (data.startsWith('pay:')) {
        const [, method, ref] = data.split(':');
        const s = Session.getSessionByRef(ref);
        if (!s) return ctx.answerCbQuery('No active order.');
        s.method = method.toUpperCase();
        s.status = 'AWAITING_RECEIPT';

        const f = parseOrderFields(s.summary || '');
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
              USERNAME: ctx.from.username ? '@' + ctx.from.username : 'no_username'
            })
          );
        }
        return;
      }

      // Clear previous?
      if (data.startsWith('clearprev:')) {
        const [, yn, oldRef] = data.split(':');
        // Try resolve the user's current session and the one by ref
        const sUser = Session.getSession(ctx.from.id);
        const sOld  = Session.getSessionByRef(oldRef) || sUser;
        const pendingText = sOld?.pendingNewSummary;

        if (!pendingText) {
          await ctx.answerCbQuery('No new order found.');
          await ctx.editMessageText(get(MSG,'errors.no_pending_new_order') || 'No new order found — please paste your new order again.').catch(()=>{});
          return;
        }

        // Close/supersede old and promote new
        const newRef = Session.genRef();

        // Remove old ref mapping
        if (sOld?.ref) {
          try { Session.deleteRef(sOld.ref); } catch {}
          sOld.supersededRefs = Array.isArray(sOld.supersededRefs) ? sOld.supersededRefs : [];
          sOld.supersededRefs.push(sOld.ref);
        }

        // Overwrite user's session with the new one
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
          _customerId: ctx.from.id
        };
        Session.setSession(ctx.from.id, sNew);
        Session.setRef(newRef, ctx.from.id);

        // Clear the temp field on the old holder (if same object)
        if (sOld) delete sOld.pendingNewSummary;

        // Customer confirmation text
        if (yn === 'yes') {
          await ctx.editMessageText((get(MSG,'customer.previous_cleared') || 'Previous order cleared.') + ` ${t('customer.new_order_ready', { REF: newRef })}`).catch(()=>{});
          // Staff notice
          if (NOTIFY_SUPERSEDE && STAFF_GROUP_ID) {
            await bot.telegram.sendMessage(
              STAFF_GROUP_ID,
              t('staff.superseded_notice', { OLD_REF: oldRef, NEW_REF: newRef }) || `❗ Order ${oldRef} canceled/superseded. New order pending (${newRef}).`
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
        if (!s.receiptFileId) return ctx.answerCbQuery('No receipt found.');

        if (yn === 'yes') {
          s.status = 'AWAITING_TIN_TEXT';
          await ctx.editMessageText(get(MSG,'customer.tin_prompt') || 'Please send your TIN number.').catch(()=>{});
          await ctx.answerCbQuery('Okay.');
          return;
        } else {
          await ctx.answerCbQuery('Okay.');
          await ctx.editMessageText(get(MSG,'customer.tin_skip') || 'No TIN used.').catch(()=>{});
          const flags = s._receiptFlags || [];
          delete s._receiptFlags;
          await postReceiptToStaff(ctx, s, { flags });
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
  // TIN text capture

  bot.on('message', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next && next();
    if (ctx.message.photo || (ctx.message.text || '').startsWith('/')) return next && next();

    const s = Session.getSession(ctx.from.id);
    if (!s) return next && next();

    if (s.status === 'AWAITING_TIN_TEXT') {
      const tin = (ctx.message.text || '').trim().slice(0, 64);
      if (!tin) return ctx.reply(get(MSG,'customer.tin_retry') || 'Please send a valid TIN.');
      s.tin = tin;
      const flags = s._receiptFlags || [];
      delete s._receiptFlags;
      await ctx.reply(get(MSG,'customer.tin_saved') || 'TIN saved.');
      return postReceiptToStaff(ctx, s, { flags });
    }

    if (s.status === 'AWAITING_RECEIPT') {
      return ctx.reply(get(MSG,'customer.awaiting_receipt_text') || 'Send receipt photo.');
    }

    return next && next();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Staff posting

  async function postReceiptToStaff(ctx, s, { flags = [] } = {}) {
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
        s.tin ? `${get(MSG,'staff.tin_prefix') || 'TIN:'} ${s.tin}` : '',
        flags.length ? `${get(MSG,'staff.receipt_flags_prefix') || 'Flags:'} ${flags.join(' | ')}` : ''
      ].filter(Boolean).join('\n');

      const actions = Markup.inlineKeyboard([
        [
          Markup.button.callback(get(MSG,'buttons.approve') || 'Approve ✅', `approve:${ctx.from.id}:${s.ref}`),
          Markup.button.callback(get(MSG,'buttons.reject')  || 'Reject ❌',  `reject:${ctx.from.id}:${s.ref}`)
        ]
      ]);

      await ctx.telegram.sendPhoto(STAFF_GROUP_ID, s.receiptFileId, { caption, ...actions });
      await ctx.telegram.sendMessage(
        STAFF_GROUP_ID,
        (get(MSG,'staff.order_summary_prefix') || '🧾 Order Summary:\n') + (s.summary || '').slice(0, 4000)
      );
      await ctx.reply(t('customer.receipt_received', { REF: s.ref }) || 'We received your receipt.');

    } catch (err) {
      console.error('postReceiptToStaff error', err);
      await ctx.reply('There was an issue posting your receipt. Our team has been notified.').catch(()=>{});
      if (STAFF_GROUP_ID) {
        await bot.telegram.sendMessage(STAFF_GROUP_ID, `⚠️ Error posting receipt for ${s.ref || 'ref'} — please check logs.`).catch(()=>{});
      }
    }
  }
};
