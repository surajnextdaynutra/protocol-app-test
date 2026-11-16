import { connectDb } from "../db.server";
import { Order, RepApplication, SalesRep } from "../models/index.server";
import { monthKey } from "./ids.server";
import {
  currentRates,
  ensureReferralCode,
  rateHistory,
  repNotices,
} from "./rep-rates.server";
import { getSettings } from "./settings.server";

/* The Sales Rep dashboard's "My Team" data (action=team): the rep's two
   commission rates, referral link, the reps they referred and what those
   sell, the orders that paid them referral commission, their notices and
   their rate history. All amounts are the ones frozen on the orders. */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const LIVE = { "commission.logged": true, "commission.status": { $ne: "Deleted" }, deletedAt: null };

export async function repTeam({ rep: repId = "" }) {
  repId = String(repId || "").trim();
  if (!repId) return { ok: false, error: "missing rep id" };
  await connectDb();
  const rep = await SalesRep.findOne({ repId }).lean();
  if (!rep) return { ok: false, error: "Sales rep not found." };
  const cfg = await getSettings();
  const thisMonth = monthKey(new Date(), cfg.TIMEZONE);

  const [code, rates, notices, history, referred, applications] = await Promise.all([
    ensureReferralCode(repId),
    currentRates(rep),
    repNotices(repId, { limit: 20 }),
    rateHistory({ repId, limit: 50 }),
    SalesRep.find({ referredBy: repId }, { repId: 1, name: 1, email: 1, active: 1, createdAt: 1 }).sort({ createdAt: -1 }).lean(),
    RepApplication.find({ referrerRepId: repId }, { firstName: 1, lastName: 1, status: 1, createdAt: 1, repId: 1 })
      .sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  /* ---- earnings: direct (own sales) + referral (referred reps' sales) ---- */
  const [directAgg, referralAgg] = await Promise.all([
    Order.aggregate([
      { $match: { ...LIVE, "commission.repId": repId } },
      { $group: { _id: "$commission.month", amt: { $sum: "$commission.repAmt" }, units: { $sum: "$units" } } },
    ]),
    Order.aggregate([
      { $match: { ...LIVE, "commission.refRepId": repId } },
      { $group: { _id: "$commission.month", amt: { $sum: "$commission.refAmt" }, units: { $sum: "$units" } } },
    ]),
  ]);
  const sumOf = (rows, month) => round2(rows.filter((r) => !month || r._id === month).reduce((s, r) => s + (r.amt || 0), 0));
  const earnings = {
    direct: sumOf(directAgg),
    directThisMonth: sumOf(directAgg, thisMonth),
    referral: sumOf(referralAgg),
    referralThisMonth: sumOf(referralAgg, thisMonth),
  };
  earnings.total = round2(earnings.direct + earnings.referral);

  /* ---- the reps this rep referred, with what each sells ---- */
  const ids = referred.map((r) => r.repId);
  const [salesAgg, mineAgg] = ids.length
    ? await Promise.all([
        Order.aggregate([
          { $match: { ...LIVE, "commission.repId": { $in: ids } } },
          {
            $group: {
              _id: "$commission.repId",
              orders: { $sum: 1 },
              units: { $sum: "$units" },
              sales: { $sum: "$total" },
              monthUnits: { $sum: { $cond: [{ $eq: ["$commission.month", thisMonth] }, "$units", 0] } },
            },
          },
        ]),
        Order.aggregate([
          { $match: { ...LIVE, "commission.refRepId": repId, "commission.repId": { $in: ids } } },
          {
            $group: {
              _id: "$commission.repId",
              earned: { $sum: "$commission.refAmt" },
              monthEarned: { $sum: { $cond: [{ $eq: ["$commission.month", thisMonth] }, "$commission.refAmt", 0] } },
            },
          },
        ]),
      ])
    : [[], []];
  const salesBy = Object.fromEntries(salesAgg.map((r) => [r._id, r]));
  const mineBy = Object.fromEntries(mineAgg.map((r) => [r._id, r]));
  const team = referred.map((r) => ({
    repId: r.repId,
    name: r.name || r.repId,
    email: r.email || "",
    active: r.active !== false,
    joined: r.createdAt ? r.createdAt.getTime() : 0,
    orders: salesBy[r.repId]?.orders || 0,
    units: salesBy[r.repId]?.units || 0,
    sales: round2(salesBy[r.repId]?.sales || 0),
    unitsThisMonth: salesBy[r.repId]?.monthUnits || 0,
    earned: round2(mineBy[r.repId]?.earned || 0),
    earnedThisMonth: round2(mineBy[r.repId]?.monthEarned || 0),
  }));

  /* ---- orders that paid this rep referral commission (latest 100) ---- */
  const refOrders = await Order.find(
    { ...LIVE, "commission.refRepId": repId },
    { name: 1, orderCreatedAt: 1, units: 1, total: 1, "commission.repId": 1, "commission.refAmt": 1, "commission.refRate": 1 },
  )
    .sort({ orderCreatedAt: -1 })
    .limit(100)
    .lean();
  const nameOf = Object.fromEntries(referred.map((r) => [r.repId, r.name || r.repId]));
  const referralOrders = refOrders.map((o) => ({
    order: o.name,
    ts: o.orderCreatedAt ? o.orderCreatedAt.getTime() : 0,
    repId: o.commission?.repId || "",
    repName: nameOf[o.commission?.repId] || o.commission?.repId || "",
    units: o.units || 0,
    amount: round2(o.total || 0),
    rate: o.commission?.refRate || 0,
    commission: round2(o.commission?.refAmt || 0),
  }));

  return {
    ok: true,
    rep: { id: repId, name: rep.name || repId },
    referralCode: code,
    rates,
    earnings,
    team,
    referralOrders,
    applications: applications.map((a) => ({
      name: `${a.firstName || ""} ${a.lastName || ""}`.trim(),
      status: a.status,
      ts: a.createdAt ? a.createdAt.getTime() : 0,
    })),
    notices,
    unseenNotices: notices.filter((n) => !n.seen).length,
    history,
  };
}
