// index.js — GreenGold EMMA (God Mode, Supabase memory wired)
// Stable entrypoint. Conversations are handled in ./flows/customerBotFlow.js
// State & refs live in ./core/session.js. Parsing in ./parser.js
'use strict';

// ────────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs   = require('fs');
const path = require('path');

// EMMA2: memory + export wiring
const { persist } = require('./data_ops/memory');           // ← NEW
const wireExportCommands = require('./commands/export');    // ← NEW

// Order detection / parsing brain
const {
isLikelyQuestion,
isOrderSummaryStrict,
parseOrderFields,
extractRef
} = require('./parser');

// ────────────────────────────────────────────────────────────────────────────────
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
flows: {
holdSeconds: 60,
buttonTtlSeconds: 900,
driverWindowMinutes: 30,
driverGiveUpMinutes: 2,
allowNewOrderWhileActive: true,
deepLinkTtlMs: 30*60*1000,
sessionTtlMinutes: 90,
tinEnabled: true,
...(f.flows || {}) },
intake: { strictMode: true, escalateOnQuestion: true, minTextLength: 50, ...(f.intake || {}) },
support: { enabled: true, phone: '+251 2601986', ...(f.support || {}) },
flags: {
flagDuplicateReceipts: true,
flagForwardedReceipts: true,
reReviewOnUndo: true,
opsUnassignEnabled: false,
sheetsExportEnabled: false,
notifySupersede: true,
...(f.flags || {}) },
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
const name  = String(d.name  || '').trim();
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

// ────────────────────────────────────────────────────────────────────────────────
// Bot config (env + features)
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('Missing BOT_TOKEN'); process.exit(1); }

const OWNER_IDS = String(process.env.OWNER_IDS || '')
.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
if (OWNER_IDS.length === 0) console.warn('WARNING: OWNER_IDS not set.');

// Chat IDs from env
let STAFF_GROUP_ID   = process.env.STAFF_GROUP_ID   ? Number(process.env.STAFF_GROUP_ID)   : null;
let SUPPORT_GROUP_ID = process.env.SUPPORT_GROUP_ID ? Number(process.env.SUPPORT_GROUP_ID) : null;

// Sheets webhook env (optional)
const SHEETS_URL    = process.env.SHEETS_WEBHOOK_URL || '';
const SHEETS_SECRET = process.env.SHEETS_SECRET || '';

// Derived runtime knobs
let APPROVE_SCOPE, RATE_LIMIT_MS, HOLD_SECONDS, BUTTON_TTL_SEC, DRIVER_WINDOW_MS, GIVEUP_MS, ALLOW_NEW_ORDER;
let SUPPORT_ENABLED, SUPPORT_PHONE, DUP_FLAG, FWD_FLAG, RE_REVIEW_ON_UNDO, OPS_UNASSIGN_EN, TIMEZONE, CUTOFF_HOUR, NOTIFY_SUPERSEDE;

function refreshDerived() {
APPROVE_SCOPE     = String(process.env.APPROVE_SCOPE || FEATURES.ops.approveScope || 'members').toLowerCase();
RATE_LIMIT_MS     = Number(process.env.RATE_LIMIT_MS || FEATURES.ops.rateLimitMs || 1500);
HOLD_SECONDS      = Number(process.env.HOLD_SECONDS || FEATURES.flows.holdSeconds || 60);
BUTTON_TTL_SEC    = Number(process.env.BUTTON_TTL_SEC || FEATURES.flows.buttonTtlSeconds || 900);
DRIVER_WINDOW_MS  = Number(process.env.DRIVER_WINDOW_MS || (FEATURES.flows.driverWindowMinutes * 60 * 1000));
GIVEUP_MS         = Number((FEATURES.flows.driverGiveUpMinutes || 2) * 60 * 1000);
ALLOW_NEW_ORDER   = !!FEATURES.flows.allowNewOrderWhileActive;

SUPPORT_ENABLED   = !!FEATURES.support.enabled;
SUPPORT_PHONE     = String(process.env.SUPPORT_PHONE || FEATURES.support.phone || '+251 2601986');

DUP_FLAG          = !!FEATURES.flags.flagDuplicateReceipts;
FWD_FLAG          = !!FEATURES.flags.flagForwardedReceipts;
RE_REVIEW_ON_UNDO = !!FEATURES.flags.reReviewOnUndo;
OPS_UNASSIGN_EN   = !!FEATURES.flags.opsUnassignEnabled;
NOTIFY_SUPERSEDE  = !!FEATURES.flags.notifySupersede;

TIMEZONE          = String(FEATURES.time.timezone || 'Africa/Addis_Ababa');
CUTOFF_HOUR       = Number(FEATURES.time.cutoffHourLocal || 18);
}
refreshDerived();

// ...[rest of file unmodified except below]

// Message templating
function get(obj, pathStr) {
return pathStr.split('.').reduce((o, k) => (o && k in o ? o[k] : undefined), obj);
}
function t(key, vars = {}) {
let s = get(MSG, key);
if (!s || typeof s !== 'string') return key;
// FIX: templating regex
return s.replace(/\{([A-Z0-9_]+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

// ...[rest of file unmodified except below]

// drivers_export chunking
bot.command('drivers_export', async (ctx) => {
if (!isOwner(ctx) || !isPrivate(ctx)) return;
const json = exportDriversJson();
if (json.length > 3500) {
// FIX: chunk regex
const chunks = json.match(/[\s\S]{1,3500}/g) || [json];
await ctx.reply(`Current drivers JSON (${chunks.length} part(s)) — paste into drivers.json:`);
for (const part of chunks) await ctx.reply(part);
return;
}
return ctx.reply(json);
});

// [Sanity checks completed]