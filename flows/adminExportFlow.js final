// flows/adminExportFlow.js — /export orders & /clear_and_export_orders
// EMMA PRO MAX — FINAL
'use strict';

const { Buffer } = require('buffer');

function getOwnerSet() {
  const raw = (process.env.OWNER_IDS || '').trim();
  if (!raw) return new Set();
  return new Set(
    raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
  );
}
function isOwner(ctx) {
  const owners = getOwnerSet();
  const fromId = String(ctx.from?.id || '');
  return owners.has(fromId);
}
function isStaffChat(ctx) {
  const staffId = (process.env.STAFF_GROUP_ID || '').trim();
  const supportId = (process.env.SUPPORT_GROUP_ID || '').trim();
  const chatId = String(ctx.chat?.id || '');
  return (staffId && chatId === staffId) || (supportId && chatId === supportId);
}
function allowed(ctx) {
  return isOwner(ctx) || isStaffChat(ctx);
}

function filename(base) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${base}_${ts}.csv`;
}
async function sendCsv(ctx, baseName, csv) {
  const MAX_BYTES = 8 * 1024 * 1024;
  const bytes = Buffer.byteLength(csv, 'utf8');

  if (bytes <= MAX_BYTES) {
    const fn = filename(baseName);
    return ctx.replyWithDocument({ source: Buffer.from(csv, 'utf8'), filename: fn });
  }
  const lines = csv.split('\n');
  const header = lines.shift() || '';
  let part = 1;
  let chunk = header + '\n';
  let size = Buffer.byteLength(chunk, 'utf8');

  for (const line of lines) {
    const add = Buffer.byteLength(line + '\n', 'utf8');
    if (size + add > MAX_BYTES) {
      const fn = filename(`${baseName}.part${part}`);
      // eslint-disable-next-line no-await-in-loop
      await ctx.replyWithDocument({ source: Buffer.from(chunk, 'utf8'), filename: fn });
      part += 1;
      chunk = header + '\n';
      size = Buffer.byteLength(chunk, 'utf8');
    }
    chunk += line + '\n';
    size += add;
  }
  if (chunk.trim().length) {
    const fn = filename(`${baseName}.part${part}`);
    await ctx.replyWithDocument({ source: Buffer.from(chunk, 'utf8'), filename: fn });
  }
}

module.exports = function wireAdminExportFlow(bot, deps) {
  const store = deps?.store;
  if (!store) {
    console.warn('[exportFlow] deps.store missing — export commands disabled');
    return;
  }

  bot.command('export', async (ctx) => {
    try {
      const text = String(ctx.message?.text || '');
      const arg = text.split(/\s+/)[1] || '';
      if (arg.toLowerCase() !== 'orders') return ctx.reply('Usage: /export orders');
      if (!allowed(ctx)) return ctx.reply('Not allowed.');

      await ctx.reply('Preparing CSV…');
      const csv = await store.exportAllCSV();
      const lineCount = (csv.match(/\n/g) || []).length + 1;
      if (lineCount <= 1) return ctx.reply('No rows found to export.');

      await sendCsv(ctx, 'orders', csv);
    } catch (e) {
      console.error('[exportFlow] /export orders error:', e);
      await ctx.reply('Export failed.');
    }
  });

  bot.command('clear_and_export_orders', async (ctx) => {
    try {
      if (!allowed(ctx)) return ctx.reply('Not allowed.');
      await ctx.reply('Exporting all and clearing…');
      const csv = await store.clearAndExportAllCSV();

      const lineCount = (csv.match(/\n/g) || []).length + 1;
      if (lineCount <= 1) {
        await ctx.reply('No rows found. Cleared anyway.');
        return;
      }

      await sendCsv(ctx, 'orders_all_time', csv);
      await ctx.reply('Cleared live orders after export ✅');
    } catch (e) {
      console.error('[exportFlow] clear_and_export error:', e);
      await ctx.reply('Clear & export failed.');
    }
  });

  // Alias for "/clear and export orders" typed with spaces
  bot.hears(/^\/clear(?:\s+and)?\s+export\s+orders\b/i, async (ctx) => {
    try {
      if (!allowed(ctx)) return ctx.reply('Not allowed.');
      await ctx.reply('Exporting all and clearing…');
      const csv = await store.clearAndExportAllCSV();

      const lineCount = (csv.match(/\n/g) || []).length + 1;
      if (lineCount <= 1) {
        await ctx.reply('No rows found. Cleared anyway.');
        return;
      }

      await sendCsv(ctx, 'orders_all_time', csv);
      await ctx.reply('Cleared live orders after export ✅');
    } catch (e) {
      console.error('[exportFlow] alias clear/export error:', e);
      await ctx.reply('Clear & export failed.');
    }
  });
};
