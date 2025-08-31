'use strict';

/**
 * Registers:
 *   /test_memory         -> writes a dummy order to Supabase, replies "Order Saved ✅"
 *   /export orders       -> sends CSV of all orders as a Telegram document
 *   /export range YYYY-MM-DD..YYYY-MM-DD -> CSV for that date window
 *
 * Requires: data_ops/memory (persist, fetchAllOrders, toCSV)
 */

const crypto = require('crypto');
const mem = require('../data_ops/memory');

function sig(name) {
  const salt = process.env.EXPORT_SALT || 'gg_salt';
  return crypto.createHash('sha1').update(salt + '|' + name).digest('hex').slice(0,8);
}

function parseRange(arg) {
  // "YYYY-MM-DD..YYYY-MM-DD"
  if (!arg) return {};
  const m = String(arg).trim().match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (!m) return {};
  return { fromDate: m[1], toDate: m[2] };
}

function buildDummyOrder() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth()+1).padStart(2,'0');
  const d = String(now.getDate()).padStart(2,'0');
  const HH = String(now.getHours()).padStart(2,'0');
  const MM = String(now.getMinutes()).padStart(2,'0');
  const order_id = `GG_TEST_${y}${m}${d}_${HH}${MM}`;

  return {
    order_id,
    date: `${y}-${m}-${d}`,             // adapter accepts YYYY-MM-DD or DD/MM/YYYY
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

async function replyCSV(ctx, rows, baseName='orders') {
  const csv = mem.toCSV(rows);
  const stamp = new Date().toISOString().slice(0,16).replace(/[:T]/g,'-'); // YYYY-MM-DD-HH-MM
  const filename = `${baseName}_${stamp}_${sig(baseName)}.csv`;
  const buf = Buffer.from(csv, 'utf8');

  await ctx.replyWithDocument(
    { source: buf, filename },
    { caption: `${rows.length} rows` }
  );
}

module.exports = function wireExportCommands(bot) {
  // /test_memory
  bot.command('test_memory', async (ctx) => {
    try {
      const dummy = buildDummyOrder();
      await mem.persist(dummy, 'payment_confirmed');
      await ctx.reply('Order Saved ✅');
    } catch (e) {
      console.error('test_memory error:', e);
      await ctx.reply('Save Error ❌');
    }
  });

  // /export orders  OR  /export range YYYY-MM-DD..YYYY-MM-DD
  bot.command('export', async (ctx) => {
    try {
      const args = String(ctx.message.text || '').split(' ').slice(1);
      if (args[0] && args[0].toLowerCase() === 'range' && args[1]) {
        const range = parseRange(args[1]);
        const rows = await mem.fetchAllOrders(range);
        return replyCSV(ctx, rows, 'orders_range');
      }
      // default: all
      const rows = await mem.fetchAllOrders();
      return replyCSV(ctx, rows, 'orders');
    } catch (e) {
      console.error('export error:', e);
      await ctx.reply('Export Error ❌');
    }
  });
};
