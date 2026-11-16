import { connectDb } from "../db.server";
import { Account, CommissionChange, Order, RepNotice, SalesRep } from "../models/index.server";
import {
  currentRates,
  ensureReferralCode,
  practiceRateFor,
  rateAt,
  referralRateFor,
} from "./rep-rates.server";

/* Sales Rep dashboard -> Dashboard "Referral" table, Earnings table, the
   History popup of an Earnings row, and the commission-change alert +
   "Commission Updates" popup.

   An Earnings row is one of:
     practice:<practiceId>  what the rep earns on that practice's orders
     referred:<repId>       what the rep earns on a rep they referred
   Units / earnings are the amounts frozen on the paid orders (the ledger),
   in the From / To window when one is given. A row's history is the
   timeline of its EFFECTIVE $ per unit: the row's own rate, the rep's rate
   and the standard rate all feed it, so each step shows the rate that was
   actually paid before and after. */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const LIVE = { "commission.logged": true, "commission.status": { $ne: "Deleted" }, deletedAt: null };

function windowQuery(from, to) {
  const f = Number(from) || 0;
  const t = Number(to) || 0;
  if (!f && !t) return {};
  const q = {};
  if (f) q.$gte = new Date(f);
  if (t) q.$lte = new Date(t);
  return { orderCreatedAt: q };
}

/** "Finance dashboard (Jane Doe)" -> "Jane Doe" (the person who made the change). */
function byName(b) {
  const s = String(b || "").trim();
  const m = s.match(/^[^(]*\((.*)\)$/);
  return m ? m[1] : s;
}

/** practiceId -> display name: the Practice Master's company / name, else any
 *  account's practice_location: tag or company. */
async function practiceNames(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const accts = await Account.find(
    { practiceId: { $in: list } },
    { practiceId: 1, doctorId: 1, clinicId: 1, company: 1, first: 1, last: 1, tags: 1 },
  ).lean();
  const out = {};
  const person = (a) => `${a.first || ""} ${a.last || ""}`.trim();
  for (const a of accts) {
    if (!a.doctorId && !a.clinicId && !out[a.practiceId]) out[a.practiceId] = a.company || person(a);
  }
  for (const a of accts) {
    if (out[a.practiceId]) continue;
    const tag = (a.tags || []).find((t) => /^practice_location:/i.test(t));
    if (tag) out[a.practiceId] = tag.split(":").slice(1).join(":").trim();
  }
  for (const a of accts) if (!out[a.practiceId] && a.company) out[a.practiceId] = a.company;
  // no practice account (a solo provider's practice): its providers' names,
  // the same fallback the Sales Performance table uses
  const doctors = {};
  for (const a of accts) {
    const n = person(a);
    if (a.doctorId && n && !out[a.practiceId]) (doctors[a.practiceId] ||= new Set()).add(n);
  }
  for (const [pid, set] of Object.entries(doctors)) out[pid] = [...set].join(", ");
  for (const id of list) out[id] ||= id;
  return out;
}

/* ------------------------------ Earnings data --------------------------- */

/**
 * The Earnings table + the Dashboard's Referral table, for the window.
 * { direct: { rows, units, earnings }, referred: { rows, units, earnings },
 *   total: { units, earnings }, referralCode }
 */
export async function repEarnings({ rep: repId = "", from = 0, to = 0 } = {}) {
  repId = String(repId || "").trim();
  if (!repId) return { ok: false, error: "missing rep id" };
  await connectDb();
  const rep = await SalesRep.findOne({ repId }).lean();
  if (!rep) return { ok: false, error: "Sales rep not found." };
  const win = windowQuery(from, to);

  const [directAgg, referred, code] = await Promise.all([
    Order.aggregate([
      { $match: { ...LIVE, ...win, "commission.repId": repId } },
      { $group: { _id: "$commission.practiceId", units: { $sum: "$units" }, earned: { $sum: "$commission.repAmt" } } },
    ]),
    SalesRep.find({ referredBy: repId }).sort({ name: 1 }).lean(),
    ensureReferralCode(repId),
  ]);

  /* direct: every assigned practice, plus any practice this rep still has commission on */
  const byPrac = Object.fromEntries(directAgg.map((r) => [r._id || "", r]));
  const pids = [...new Set([
    ...(rep.assignedPracticeIds || []).filter((x) => x && !/^CLN/i.test(String(x))),
    ...Object.keys(byPrac).filter(Boolean),
  ])];
  const names = await practiceNames(pids);
  const now = new Date();
  const directRows = [];
  for (const pid of pids) {
    directRows.push({
      key: "practice:" + pid,
      type: "practice",
      id: pid,
      name: names[pid] || pid,
      rate: await practiceRateFor(rep, pid, now),
      units: byPrac[pid]?.units || 0,
      earnings: round2(byPrac[pid]?.earned || 0),
    });
  }
  directRows.sort((a, b) => b.earnings - a.earnings || a.name.localeCompare(b.name));
  // commission on orders with no practice id still counts toward the totals
  const loose = byPrac[""] || { units: 0, earned: 0 };

  /* referred: each rep this rep referred - their units, and what this rep earned on them */
  const ids = referred.map((r) => r.repId);
  const [unitsAgg, mineAgg] = ids.length
    ? await Promise.all([
        Order.aggregate([
          { $match: { ...LIVE, ...win, "commission.repId": { $in: ids } } },
          { $group: { _id: "$commission.repId", units: { $sum: "$units" } } },
        ]),
        Order.aggregate([
          { $match: { ...LIVE, ...win, "commission.refRepId": repId, "commission.repId": { $in: ids } } },
          { $group: { _id: "$commission.repId", earned: { $sum: "$commission.refAmt" } } },
        ]),
      ])
    : [[], []];
  const unitsBy = Object.fromEntries(unitsAgg.map((r) => [r._id, r.units]));
  const mineBy = Object.fromEntries(mineAgg.map((r) => [r._id, r.earned]));
  const refRows = [];
  for (const c of referred) {
    refRows.push({
      key: "referred:" + c.repId,
      type: "referred",
      id: c.repId,
      name: c.name || c.repId,
      active: c.active !== false,
      rate: await referralRateFor(c, rep, now),
      units: unitsBy[c.repId] || 0,
      earnings: round2(mineBy[c.repId] || 0),
    });
  }

  const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const direct = { rows: directRows, units: sum(directRows, "units") + loose.units, earnings: round2(sum(directRows, "earnings") + loose.earned) };
  const ref = { rows: refRows, units: sum(refRows, "units"), earnings: round2(sum(refRows, "earnings")) };
  return {
    ok: true,
    referralCode: code,
    rates: await currentRates(rep),
    direct,
    referred: ref,
    total: { units: direct.units + ref.units, earnings: round2(direct.earnings + ref.earnings) },
  };
}

/* ------------------------------ row history ----------------------------- */

/**
 * Timeline of a row's effective $ per unit, newest first:
 *   [{ ts, type: "start" | "change", from, to, by }]
 * `start` = when the row began (rate in force then); `specs` = the change
 * records that can move the rate; `rateAtFn(t)` = the effective rate at t.
 */
async function timeline(start, startBy, specs, rateAtFn) {
  const startTs = start instanceof Date ? start : new Date(start || Date.now());
  const changes = await CommissionChange.find({
    $or: specs.map((s) => ({ scope: s.scope, repId: s.repId, kind: s.kind })),
    effectiveAt: { $gt: startTs },
  })
    .sort({ effectiveAt: 1, _id: 1 })
    .lean();
  const rows = [{ ts: startTs.getTime(), type: "start", from: null, to: await rateAtFn(startTs), by: byName(startBy) }];
  const seen = new Set();
  for (const c of changes) {
    const t = new Date(c.effectiveAt).getTime();
    if (seen.has(t)) continue;
    seen.add(t);
    const before = await rateAtFn(new Date(t - 1));
    const after = await rateAtFn(new Date(t));
    if (before === after) continue;
    rows.push({ ts: t, type: "change", from: before, to: after, by: byName(c.by), changeId: String(c._id) });
  }
  return rows.reverse();
}

async function practiceTimeline(rep, pid) {
  return timeline(rep.createdAt, "", [
    { scope: "rep", repId: rep.repId, kind: "practice:" + pid },
    { scope: "rep", repId: rep.repId, kind: "direct" },
    { scope: "default", repId: "", kind: "direct" },
  ], (t) => practiceRateFor(rep, pid, t));
}

async function referredTimeline(rep, child) {
  // started when the child was put under this rep (else when the child was created)
  const added = await CommissionChange.findOne({ scope: "rep", repId: child.repId, kind: "referrer", to: rep.repId })
    .sort({ effectiveAt: -1 })
    .lean();
  return timeline(added?.effectiveAt || child.createdAt, added?.by || "", [
    { scope: "rep", repId: child.repId, kind: "sponsor" },
    { scope: "rep", repId: rep.repId, kind: "referral" },
    { scope: "default", repId: "", kind: "referral" },
  ], (t) => referralRateFor(child, rep, t));
}

async function ownTimeline(rep, kind) {
  return timeline(rep.createdAt, "", [
    { scope: "rep", repId: rep.repId, kind },
    { scope: "default", repId: "", kind },
  ], (t) => rateAt(rep, kind, t));
}

/** History popup of one Earnings row: type "practice" | "referred", id. */
export async function repEarningHistory({ rep: repId = "", type = "", id = "" } = {}) {
  repId = String(repId || "").trim();
  id = String(id || "").trim();
  await connectDb();
  const rep = await SalesRep.findOne({ repId }).lean();
  if (!rep) return { ok: false, error: "Sales rep not found." };
  if (type === "practice") {
    if (!id) return { ok: false, error: "Practice is required." };
    return { ok: true, rows: await practiceTimeline(rep, id) };
  }
  if (type === "referred") {
    const child = await SalesRep.findOne({ repId: id }).lean();
    if (!child || child.referredBy !== repId) return { ok: false, error: "That rep was not referred by you." };
    return { ok: true, rows: await referredTimeline(rep, child) };
  }
  return { ok: false, error: "Unknown row type." };
}

/* --------------------------- commission updates ------------------------- */

/**
 * The commission-change alert: the rep's unseen notices, resolved to the
 * Earnings rows whose rate they changed, each with its rate history.
 * { notices: [ids], targets: [{ key, type, id, name, rows }] }
 */
export async function repCommissionUpdates({ rep: repId = "" } = {}) {
  repId = String(repId || "").trim();
  await connectDb();
  const rep = await SalesRep.findOne({ repId }).lean();
  if (!rep) return { ok: false, error: "Sales rep not found." };
  const notices = await RepNotice.find({ repId, seenAt: null }).sort({ createdAt: -1 }).limit(50).lean();
  if (!notices.length) return { ok: true, notices: [], targets: [] };
  const changeIds = notices.map((n) => n.changeId).filter((x) => /^[a-f0-9]{24}$/i.test(String(x || "")));
  const changes = changeIds.length ? await CommissionChange.find({ _id: { $in: changeIds } }).lean() : [];

  const referred = await SalesRep.find({ referredBy: repId }).lean();
  const childById = Object.fromEntries(referred.map((c) => [c.repId, c]));
  const ownPracRates = rep.practiceRates || {};
  const assigned = (rep.assignedPracticeIds || []).filter((x) => x && !/^CLN/i.test(String(x)));

  const wanted = new Map(); // key -> { type, id }
  const want = (type, id) => wanted.set(`${type}:${id}`, { type, id });
  for (const c of changes) {
    if (c.kind === "sponsor" && childById[c.repId]) want("referred", c.repId);
    else if (/^practice:/.test(c.kind)) want("practice", c.kind.slice(9));
    else if (c.kind === "referral") {
      // the rep's / standard referral rate moves every referral without its own rate
      const hit = referred.filter((ch) => ch.sponsorRate === null || ch.sponsorRate === undefined);
      if (hit.length) hit.forEach((ch) => want("referred", ch.repId));
      else want("own", "referral");
    } else if (c.kind === "direct") {
      const hit = assigned.filter((pid) => ownPracRates[pid] === null || ownPracRates[pid] === undefined);
      if (hit.length) hit.forEach((pid) => want("practice", pid));
      else want("own", "direct");
    }
  }

  const pNames = await practiceNames([...wanted.values()].filter((w) => w.type === "practice").map((w) => w.id));
  const targets = [];
  for (const [key, w] of wanted) {
    let name = w.id;
    let rows = [];
    if (w.type === "referred") {
      name = childById[w.id]?.name || w.id;
      rows = await referredTimeline(rep, childById[w.id]);
    } else if (w.type === "practice") {
      name = pNames[w.id] || w.id;
      rows = await practiceTimeline(rep, w.id);
    } else {
      name = w.id === "direct" ? "Direct Sales" : "Referral Commission";
      rows = await ownTimeline(rep, w.id);
    }
    targets.push({ key, type: w.type, id: w.id, name, rows, latest: rows[0]?.ts || 0 });
  }
  targets.sort((a, b) => b.latest - a.latest || a.name.localeCompare(b.name));
  return { ok: true, notices: notices.map((n) => String(n._id)), targets };
}
