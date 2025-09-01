// commands/export.js
// Owner-only export command (NO DELETE). Uses data_ops/memory.exportCsv/toCsv.
// Usage (DM with the bot):
//   /export                          -> default (e.g., before-this-month or all, per backend rules)
//   /export orders                   -> same as /export (compat alias)
//   /export last-month
//   /export before-this-month
//   /export older 90
//   /export before 2025-09-01
//   /export range 2025-08-01..2025-08-31
//
// Also provides:
//   /test_memory  -> persists a dummy approved order for quick end-to-end test

'use strict';

module.exports = (bot) => {
  const ownerIds = String(process.env.OWNER_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Number.isFinite);

  const isOwner   = (ctx) => ownerIds.includes(ctx.from?.id);
  const isPrivate = (ctx) => ctx.chat?.type === 'private';

  const mem = require('../data_ops/memory'); // expects exportCsv, toCsv, persist

  // small helper: parse "YYYY-MM-DD..YYYY-MM-DD" into a pass-through string or null
  function normalizeRangeArg(arg) {
    if (!arg) return null;
    const s = String(arg).trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
    return m ? `${m[1]}..${m[2]}` : null;
  }

  // Quick dummy order for smoke-testing persist + export path
  function buildDummyOrder() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const MM = String(now.getMinutes()).padStart(2, '0');
    const order_id = `GG_TEST_${y}${m}${d}_${HH}${MM}`;

    return {
      order_id,
      date: `${y}-${m}-${d}`,        // accepts YYYY-MM-DD or DD/MM/YYYY in adapter
      time_ordered: `${HH}:${MM}`,
      customer_name: 'Test Customer',
      email: 'test@example.com',
      phone: '0000000000',
      payment_status: 'approved',
      driver_name: 'Test Driver',
      driver_accepted_time: null,
      driver_picked_time: null,
      driver_delivered_time: null,
      delivery_location: 'Test Location',
      product_price: 1000,
      delivery_price: 50,
      type_chosen: 'Powder',
      roast_level: 'Medium',
      size: '250g',
      qty: 1
    };
  }

  // ─────────────────────────────────────────────────────────────
  // /test_memory  → write a dummy order (approved) via persist()
  bot.command('test_memory', async (ctx) => {
    if (!isOwner(ctx) || !isPrivate(ctx)) return;
    try {
      const dummy = buildDummyOrder();
      await mem.persist(dummy, 'payment_confirmed'); // respects your new persist API
      await ctx.reply('Order Saved ✅');
    } catch (e) {
      console.error('test_memory error:', e);
      await ctx.reply(`Save Error ❌ ${e.message || ''}`.trim());
    }
  });

  // ─────────────────────────────────────────────────────────────
  // /export [range-spec]
  // Sends a CSV file as a Telegram document. NEVER deletes anything.
  bot.command('export', async (ctx) => {
    if (!isOwner(ctx) || !isPrivate(ctx)) return;

    try {
      // parse args
      const parts = String(ctx.message?.text || '').split(' ').slice(1);
      let spec = parts.join(' ').trim(); // free-form spec, e.g., "older 90" | "last-month" | "before 2025-09-01" | "orders" | "range 2025-08-01..2025-08-31"

      if (!spec || spec.toLowerCase() === 'orders') {
        // default export
        spec = ''; // let backend choose its default (e.g., all/before-this-month)
      } else if (spec.toLowerCase().startsWith('range ')) {
        const raw = spec.slice(6).trim();
        const norm = normalizeRangeArg(raw);
        if (!norm) {
          await ctx.reply('⚠️ Bad range format. Use: /export range YYYY-MM-DD..YYYY-MM-DD');
          return;
        }
        spec = norm; // pass "YYYY-MM-DD..YYYY-MM-DD" through to mem.exportCsv
      }

      // Call the new API
      const { filename, rows } = await mem.exportCsv(spec);
      const csv = mem.toCsv(rows || []);
      const buf = Buffer.from(csv, 'utf8');

      if (!rows || rows.length === 0) {
        await ctx.reply('No rows found for that range.');
        return;
      }

      await ctx.replyWithDocument(
        { source: buf, filename: filename || 'orders.csv' },
        { caption: `${rows.length} row${rows.length === 1 ? '' : 's'}` }
      );
    } catch (e) {
      console.error('export error:', e);
      await ctx.reply(`⚠️ Export failed: ${e.message || 'unknown error'}`);
    }
  });
};
