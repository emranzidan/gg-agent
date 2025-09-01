'use strict';

/**
 * Registers:
 *   /test_memory                     -> writes a dummy order
 *   /export                          -> CSV of all orders
 *   /export orders                   -> (same as /export)
 *   /export range YYYY-MM-DD..YYYY-MM-DD
 *   /export last-month | before-this-month | older N | before YYYY-MM-DD
 *
 * Requires: data_ops/memory (persist, exportCsv, pruneOrders [for cleaners])
 */

const crypto = require('crypto');
const mem = require('../data_ops/memory');

function sig(name) {
  const salt = process.env.EXPORT_SALT || 'gg_salt';
  return crypto.createHash('sha1').update(salt + '|' + name).digest('hex').slice(0, 8);
}

function parseRangeWords(args) {
  // supports: range A..B | last-month | before-this-month | older N | before YYYY-MM-DD
  const [a0, a1] = args;
  if (!a0) return {};

  if (a0.toLowerCase() === 'range' && a1) {
    const m = a1.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
    if (m) return { fromDate: m[1], toDate: m[2] };
    return {};
  }
  if (a0.toLowerCase() === 'last-month') return { lastMonth: true };
  if (a0.toLowerCase() === 'before-this-month') return { beforeThisMonth: true };

  if (a0.toLowerCase() === 'older' && a1) {
    const days = Number(a1);
    if (Number.isFinite(days) && days > 0) return { olderDays: days };
    return {};
  }

  if (a0.toLowerCase() === 'before' && a1) {
    const d = a1.match(/^\d{4}-\d{2}-\d{2}$/) ? a1 : null;
    if (d) return { beforeDate: d };
    return {};
  }

  // "orders" is accepted but ignored (means "all")
  if (a0.toLowerCase() === 'orders') return {};
  return {};
}

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
    date: `${y}-${m}-${d}`,           // supports YYYY-MM-DD
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

module.exports = function wireExportCommands(bot) {
  // /test_memory — quick insert to verify persistence path
  bot.command('test_memory', async (ctx) => {
    try {
      const dummy = buildDummyOrder();
      await mem.persist(dummy, 'payment_confirmed');
      await ctx.reply('Order Saved ✅');
    } catch (e) {
      console.error('test_memory error:', e);
      await ctx.reply(`Save Error ❌ ${e.message || e}`);
    }
  });

  // /export …
  bot.command('export', async (ctx) => {
    try {
      const args = String(ctx.message?.text || '').split(' ').slice(1);
      const filter = parseRangeWords(args);

      // use new API — returns { csv, rows }
      const { csv, rows, filenameBase = 'orders' } = await mem.exportCsv(filter, { returnRows: true });

      if (!rows || rows.length === 0) {
        await ctx.reply('No rows found for that filter.');
        return;
      }

      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); // YYYY-MM-DD-HH-MM
      const fname = `${filenameBase}_${stamp}_${sig(filenameBase)}.csv`;
      await ctx.replyWithDocument({ source: Buffer.from(csv, 'utf8'), filename: fname }, { caption: `${rows.length} rows` });
    } catch (e) {
      console.error('export error:', e);
      await ctx.reply(`Export Error ❌ ${e.message || e}`);
    }
  });
};
