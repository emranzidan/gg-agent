"use strict";

const express = require("express");
const router = express.Router();

const { listOrders, clearOrders } = require("../services/liveOrderFeed");

/**
 * SECURITY (optional but recommended)
 * If you set LIVE_FEED_TOKEN in Render env:
 * - Requests must include:  x-live-feed-token: YOUR_TOKEN
 * If not set, endpoint is public.
 */
function requireToken(req, res, next) {
  const token = process.env.LIVE_FEED_TOKEN;
  if (!token) return next();

  const got = req.headers["x-live-feed-token"];
  if (!got || String(got) !== String(token)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

/**
 * CORS: allow your dashboard domain ONLY (recommended)
 * Set LIVE_FEED_ALLOWED_ORIGIN="https://your-new-dashboard-domain.com"
 * If not set, we allow all (*) to keep it simple.
 */
function setCors(req, res, next) {
  const allowed = process.env.LIVE_FEED_ALLOWED_ORIGIN;
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-live-feed-token");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, DELETE");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

/**
 * GET /api/live-orders
 * returns:
 * { ok:true, count:n, orders:[...] }
 */
router.get("/live-orders", setCors, requireToken, (req, res) => {
  try {
    const orders = listOrders();
    return res.json({ ok: true, count: orders.length, orders });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Failed to read live orders" });
  }
});

/**
 * DELETE /api/live-orders  (optional admin wipe)
 * requires token if LIVE_FEED_TOKEN is set
 */
router.delete("/live-orders", setCors, requireToken, (req, res) => {
  try {
    clearOrders();
    return res.json({ ok: true, cleared: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Failed to clear live orders" });
  }
});

module.exports = router;
