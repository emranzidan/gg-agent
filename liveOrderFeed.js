"use strict";

/**
 * Green Gold — Live Order Feed (in-memory, no DB)
 * - Keeps last N orders in memory (ring buffer)
 * - Safe normalization so missing fields never crash the API
 * - Exported functions:
 *    addOrder(orderObj) -> adds an order to memory
 *    listOrders() -> returns newest-first list
 *    clearOrders() -> wipes memory (optional)
 */

const MAX_ORDERS = Number(process.env.LIVE_FEED_MAX || 200);

// In-memory store (newest at end)
let _orders = [];

/** safe number */
function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

/** safe string */
function s(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  return String(v).trim();
}

/** safe array */
function a(v) {
  return Array.isArray(v) ? v : [];
}

/** generate a simple ref if missing */
function fallbackRef() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, "0");
  return `GG-LIVE-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/**
 * Normalize any order-ish object into a stable shape
 * Expected fields (best effort):
 * - timestamp/date/time
 * - orderRef
 * - promoCodeUsed
 * - customerName
 * - arrivalPlace (address/placeId)
 * - items (type/size/qty/roast/unitPrice/lineTotal)
 * - totals (itemsSubtotal, promoDiscountAmount, deliveryFee, finalTotal)
 */
function normalizeOrder(input) {
  const now = new Date();

  const timestamp = s(input?.timestamp, now.toISOString());
  const orderRef = s(input?.orderRef || input?.order_id || input?.orderId, "") || fallbackRef();

  // Promo can arrive as string or object
  const promoCodeUsed =
    s(input?.promoCodeUsed, "") ||
    s(input?.promo?.code, "") ||
    s(input?.promoCode, "") ||
    "";

  const customerName =
    s(input?.customerName, "") ||
    s(input?.customer?.name, "") ||
    s(input?.name, "") ||
    "";

  const arrivalPlace =
    s(input?.arrivalPlace, "") ||
    s(input?.arrivalPlaceName, "") ||
    s(input?.delivery?.formatted_address, "") ||
    s(input?.delivery?.address, "") ||
    s(input?.address, "") ||
    "";

  const placeId =
    s(input?.placeId, "") ||
    s(input?.delivery?.place_id, "") ||
    s(input?.place_id, "") ||
    "";

  const distanceKm =
    n(input?.distanceKm, NaN) ||
    n(input?.delivery?.distance, NaN) ||
    n(input?.distance, 0);

  const deliveryFee =
    n(input?.deliveryFee, NaN) ||
    n(input?.delivery?.fee, NaN) ||
    n(input?.fee, 0);

  // Items can be an array on input.items OR input.cart OR input.orderItems
  const rawItems = a(input?.items).length ? a(input?.items) : (a(input?.cart).length ? a(input?.cart) : a(input?.orderItems));
  const items = rawItems.map((it) => {
    const roastLevel = s(it?.roastLevel, "") || s(it?.roast, "");
    const type = s(it?.type, "");
    const size = s(it?.size, "");
    const qty = n(it?.qty ?? it?.quantity, 0);
    const unitPrice = n(it?.unitPrice ?? it?.price, 0);
    const lineTotal = n(it?.lineTotal, unitPrice * qty);

    return {
      roastLevel,
      type,
      size,
      qty,
      unitPrice,
      lineTotal,
    };
  });

  const itemsSubtotal =
    n(input?.itemsSubtotal, NaN) ||
    n(input?.subtotal, NaN) ||
    items.reduce((sum, it) => sum + n(it.lineTotal, 0), 0);

  const promoDiscountAmount =
    n(input?.promoDiscountAmount, NaN) ||
    n(input?.discountAmount, NaN) ||
    0;

  const finalTotal =
    n(input?.finalTotal, NaN) ||
    n(input?.total, NaN) ||
    (itemsSubtotal - promoDiscountAmount + deliveryFee);

  // Derive date/time for dashboard convenience
  let dateOrdered = "";
  let timeOrdered = "";
  try {
    const d = new Date(timestamp);
    if (!Number.isNaN(d.getTime())) {
      dateOrdered = d.toISOString().slice(0, 10);
      timeOrdered = d.toTimeString().slice(0, 8);
    }
  } catch {}

  return {
    timestamp,
    dateOrdered,
    timeOrdered,
    orderRef,
    promoCodeUsed: promoCodeUsed || null,
    customerName: customerName || null,
    arrivalPlace: arrivalPlace || null,
    placeId: placeId || null,
    distanceKm: Number.isFinite(distanceKm) ? distanceKm : null,
    deliveryFee: Number.isFinite(deliveryFee) ? deliveryFee : 0,
    items,
    itemsSubtotal,
    promoDiscountAmount,
    finalTotal,
  };
}

function addOrder(orderObj) {
  try {
    const normalized = normalizeOrder(orderObj || {});
    _orders.push(normalized);

    // Trim to max
    if (_orders.length > MAX_ORDERS) {
      _orders = _orders.slice(_orders.length - MAX_ORDERS);
    }
    return normalized;
  } catch (e) {
    // Never crash your bot because of feed issues
    return null;
  }
}

function listOrders() {
  // newest-first
  return [..._orders].reverse();
}

function clearOrders() {
  _orders = [];
}

module.exports = {
  addOrder,
  listOrders,
  clearOrders,
};
