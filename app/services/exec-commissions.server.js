import { connectDb } from "../db.server";
import { Account, Order, Product, SalesRep } from "../models/index.server";
import { monthKey } from "./ids.server";
import {
  currentRates,
  defaultRates,
  rateHistory,
  referralTree,
  setDefaultRate,
  setReferrer,
  setRepRate,
  setSponsorRate,
} from "./rep-rates.server";
import {
  applicationTerms,
  approveApplication,
  listApplications,
  rejectApplication,
} from "./rep-signup.server";
import { getSettings } from "./settings.server";

/* Executive view of sales commissions (Finance dashboard -> Commissions, and
   the Shopify admin Sales reps page): default + per-rep rates, change
   history, the referral tree with what each rep sells, pending sign-ups and
   PT Profit (wholesale - MFG COGS - rep - referral commission). */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const LIVE = { "commission.logged": true, "commission.status": { $ne: "Deleted" }, deletedAt: null, demo: { $ne: true } };

/** MFG COGS per product id today (master's value for a practice copy). */
async function cogsByProduct(productIds) {
  const ids = [...new Set(productIds.filter(Boolean).map(String))];
  if (!ids.length) return {};
  const rows = await Product.find({ productId: { $in: ids } }, { productId: 1, mfgCogs: 1, masterKey: 1 }).lean();
  const keys = [...new Set(rows.filter((r) => r.mfgCogs == null && r.masterKey).map((r) => r.masterKey))];
  const masters = keys.length
    ? await Product.find({ masterKey: { $in: keys }, practiceId: "", mfgCogs: { $ne: null } }, { masterKey: 1, mfgCogs: 1 }).lean()
    : [];
  const byKey = Object.fromEntries(masters.map((m) => [m.masterKey, m.mfgCogs]));
  return Object.fromEntries(rows.map((r) => [r.productId, r.mfgCogs ?? byKey[r.masterKey] ?? null]));
}

/**
 * PT Profit by month (last 12) and in total. Orders logged before PT Profit
 * was stored are estimated from their frozen wholesale and today's COGS
 * (`estimated` counts them). `cogsMissing` = orders with a product that has
 * no MFG COGS - their profit is overstated by that product's cost.
 */
export async function ptProfitSummary() {
  await connectDb();
  const cfg = await getSettings();
  const orders = await Order.find(LIVE, {
    orderCreatedAt: 1, units: 1, lineItems: 1,
    "commission.month": 1, "commission.repAmt": 1, "commission.refAmt": 1,
    "commission.ptRevenue": 1, "commission.cogs": 1, "commission.cogsMissing": 1, "commission.ptProfit": 1,
  }).lean();
  const need = orders.filter((o) => o.commission?.ptRevenue == null).flatMap((o) => (o.lineItems || []).map((li) => li.productId));
  const cogsNow = await cogsByProduct(need);

  const months = {};
  const total = { orders: 0, units: 0, revenue: 0, cogs: 0, rep: 0, referral: 0, profit: 0, cogsMissing: 0, estimated: 0 };
  for (const o of orders) {
    const c = o.commission || {};
    let revenue = c.ptRevenue;
    let cogs = c.cogs;
    let missing = !!c.cogsMissing;
    if (revenue == null) {
      revenue = 0;
      cogs = 0;
      for (const li of o.lineItems || []) {
        const qty = li.quantity || 1;
        revenue += Math.min(Number(li.price) || 0, Number(li.wholesale) || 0) * qty;
        const unit = li.cogs ?? cogsNow[li.productId] ?? null;
        if (unit == null) missing = true;
        else cogs += unit * qty;
      }
      total.estimated++;
    }
    const rep = c.repAmt || 0;
    const ref = c.refAmt || 0;
    const profit = revenue - (cogs || 0) - rep - ref;
    const key = c.month || monthKey(o.orderCreatedAt || new Date(), cfg.TIMEZONE);
    const m = (months[key] ||= { month: key, orders: 0, units: 0, revenue: 0, cogs: 0, rep: 0, referral: 0, profit: 0, cogsMissing: 0 });
    for (const b of [m, total]) {
      b.orders++;
      b.units += o.units || 0;
      b.revenue += revenue;
      b.cogs += cogs || 0;
      b.rep += rep;
      b.referral += ref;
      b.profit += profit;
      if (missing) b.cogsMissing++;
    }
  }
  const fix = (b) => {
    for (const k of ["revenue", "cogs", "rep", "referral", "profit"]) b[k] = round2(b[k]);
    return b;
  };
  const byMonth = Object.values(months).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 12).map(fix);
  const now = monthKey(new Date(), cfg.TIMEZONE);
  return { total: fix(total), byMonth, thisMonth: byMonth.find((m) => m.month === now) || null };
}

/** Everything the executive Commissions view shows. */
export async function commissionsOverview() {
  await connectDb();
  const cfg = await getSettings();
  const thisMonth = monthKey(new Date(), cfg.TIMEZONE);
  const [reps, defaults, history, tree, pending, recent, profit, directAgg, refAgg, liveRepIds] = await Promise.all([
    SalesRep.find({}).sort({ name: 1 }).lean(),
    defaultRates(),
    rateHistory({ limit: 300 }),
    referralTree(),
    listApplications({ status: "Pending" }),
    listApplications({ limit: 30 }),
    ptProfitSummary(),
    Order.aggregate([
      { $match: LIVE },
      {
        $group: {
          _id: "$commission.repId",
          orders: { $sum: 1 },
          units: { $sum: "$units" },
          sales: { $sum: "$total" },
          earned: { $sum: "$commission.repAmt" },
          monthEarned: { $sum: { $cond: [{ $eq: ["$commission.month", thisMonth] }, "$commission.repAmt", 0] } },
        },
      },
    ]),
    Order.aggregate([
      { $match: { ...LIVE, "commission.refRepId": { $ne: "" } } },
      {
        $group: {
          _id: "$commission.refRepId",
          earned: { $sum: "$commission.refAmt" },
          monthEarned: { $sum: { $cond: [{ $eq: ["$commission.month", thisMonth] }, "$commission.refAmt", 0] } },
        },
      },
    ]),
    Account.distinct("repId", { repId: { $ne: "" } }),
  ]);
  const d = Object.fromEntries(directAgg.map((r) => [r._id, r]));
  const r = Object.fromEntries(refAgg.map((x) => [x._id, x]));
  const nameOf = Object.fromEntries(reps.map((x) => [x.repId, x.name || x.repId]));
  const referredCount = {};
  for (const x of reps) if (x.referredBy) referredCount[x.referredBy] = (referredCount[x.referredBy] || 0) + 1;
  const live = new Set(liveRepIds);

  const ratesOf = {};
  for (const x of reps) ratesOf[x.repId] = await currentRates(x);

  const repRows = [];
  for (const x of reps) {
    const rates = ratesOf[x.repId];
    // what the referrer earns on THIS rep's sales: the rate set for this
    // referral, else the referrer's own referral rate (shown as the fallback)
    const sponsorOwn = x.sponsorRate === null || x.sponsorRate === undefined ? null : round2(x.sponsorRate);
    const sponsorFallback = x.referredBy ? ratesOf[x.referredBy]?.referral ?? defaults.referral : null;
    repRows.push({
      repId: x.repId,
      name: x.name || x.repId,
      email: x.email || "",
      active: x.active !== false,
      hasLogin: live.has(x.repId),
      referredBy: x.referredBy || "",
      referredByName: x.referredBy ? nameOf[x.referredBy] || x.referredBy : "",
      referredCount: referredCount[x.repId] || 0,
      directRate: rates.direct,
      directDefault: rates.directDefault,
      referralRate: rates.referral,
      referralDefault: rates.referralDefault,
      sponsorRate: x.referredBy ? sponsorOwn ?? sponsorFallback : null,
      sponsorDefault: sponsorOwn === null,
      sponsorFallback,
      orders: d[x.repId]?.orders || 0,
      units: d[x.repId]?.units || 0,
      sales: round2(d[x.repId]?.sales || 0),
      directEarned: round2(d[x.repId]?.earned || 0),
      directThisMonth: round2(d[x.repId]?.monthEarned || 0),
      referralEarned: round2(r[x.repId]?.earned || 0),
      referralThisMonth: round2(r[x.repId]?.monthEarned || 0),
    });
  }

  // the tree carries each rep's sales so "what are they selling" reads off it
  const byId = Object.fromEntries(repRows.map((x) => [x.repId, x]));
  const decorate = (n) => ({
    repId: n.repId,
    name: n.name,
    active: n.active,
    units: byId[n.repId]?.units || 0,
    sales: byId[n.repId]?.sales || 0,
    referralEarned: byId[n.repId]?.referralEarned || 0,
    children: n.children.map(decorate),
  });

  return {
    ok: true,
    defaults,
    reps: repRows,
    tree: tree.map(decorate),
    history: history.map((h) => ({ ...h, repName: h.repId ? nameOf[h.repId] || h.repId : "", fromName: h.kind === "referrer" && h.from ? nameOf[h.from] || h.from : "", toName: h.kind === "referrer" && h.to ? nameOf[h.to] || h.to : "" })),
    applications: { pending, recent },
    profit,
  };
}

/** Who made a change from the Finance dashboard, for the history. */
export async function financeActor(caller) {
  if (!caller?.customerId) return "Finance dashboard";
  await connectDb();
  const a = await Account.findOne({ customerId: caller.customerId }, { first: 1, last: 1, email: 1 }).lean();
  const who = a ? `${a.first || ""} ${a.last || ""}`.trim() || a.email : caller.customerId;
  return `Finance dashboard (${who})`;
}

export {
  applicationTerms,
  approveApplication,
  rejectApplication,
  setDefaultRate,
  setReferrer,
  setRepRate,
  setSponsorRate,
};
