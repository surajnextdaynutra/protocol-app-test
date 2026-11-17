import crypto from "node:crypto";
import { connectDb } from "../db.server";
import { CommissionChange, RepNotice, SalesRep } from "../models/index.server";
import { logEvent } from "./log.server";
import { invalidateResponses } from "./response-cache.server";
import { getSettings, setSetting } from "./settings.server";

/* Sales rep commission rates - two layers:
     direct   $ per unit the rep earns on what they sell themselves
     referral $ per unit a rep earns on what a rep THEY referred sells
   Each has a default (Settings) and an optional per-rep rate (null = follows
   the default).

   EFFECTIVE DATES. Every change is a CommissionChange row effective from the
   moment it is made. An order is paid at the rate in force when it was
   PLACED (rateAt), so a change never touches older orders - even when an
   older order is paid, re-synced or re-imported later. */

export const KINDS = {
  direct: { key: "COMMISSION_PER_UNIT", field: "directRate", fallback: 1, label: "direct sales" },
  // (a kind may set `max` to cap its rates; referral has no cap since 2026-11-14)
  referral: { key: "REFERRAL_COMMISSION_PER_UNIT", field: "referralRate", fallback: 0.2, label: "referral" },
};
/** $ per unit a referrer earns on a NEW referral - set as that referral's own
 *  rate when the referrer is attached (setReferrer), editable afterwards. */
export const NEW_REFERRAL_RATE = 0.2;
/** Settings key -> rate kind (the Settings page routes these through setDefaultRate). */
export const DEFAULT_RATE_KEYS = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v.key, k]));

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const fmtRate = (n) => "$" + Number(n || 0).toFixed(2);

/** "1.10" / "$1.10" -> 1.1, or { error }. Blank -> { blank: true }.
 *  With `kind`, that kind's cap (KINDS[kind].max) applies too. */
export function parseRate(v, kind) {
  const s = String(v ?? "").trim().replace(/^\$/, "");
  if (!s) return { blank: true };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { error: "Enter a dollar amount like 1.00 (up to 2 decimals)." };
  const n = Number(s);
  const k = kind && KINDS[kind];
  if (k && k.max !== undefined && n > k.max) {
    return { error: `The ${k.label} rate cannot be more than ${fmtRate(k.max)} per unit.` };
  }
  if (n > 1000) return { error: "That rate is too high (max $1000 per unit)." };
  return { value: round2(n) };
}

function checkKind(kind) {
  if (!KINDS[kind]) throw new Error("Unknown commission type: " + kind);
  return KINDS[kind];
}

/* ------------------------------ history cache --------------------------- */

const HIST_TTL = 30_000;
const histCache = new Map(); // "scope|repId|kind" -> { at, rows }

async function history(scope, repId, kind) {
  const k = `${scope}|${repId}|${kind}`;
  const hit = histCache.get(k);
  if (hit && Date.now() - hit.at < HIST_TTL) return hit.rows;
  await connectDb();
  const rows = await CommissionChange.find(
    { scope, repId: scope === "default" ? "" : repId, kind },
    { from: 1, to: 1, effectiveAt: 1 },
  )
    .sort({ effectiveAt: 1, _id: 1 })
    .lean();
  histCache.set(k, { at: Date.now(), rows });
  return rows;
}

function clearCaches() {
  histCache.clear();
  invalidateResponses();
}

/** The value in force at `at`, from a change list sorted oldest first.
 *  Before the first change: that change's `from`. No changes: `current`. */
function valueAt(rows, at, current) {
  const t = (at instanceof Date ? at : new Date(at || Date.now())).getTime();
  let found = false;
  let v;
  for (const r of rows) {
    if (new Date(r.effectiveAt).getTime() <= t) {
      v = r.to;
      found = true;
    } else break;
  }
  if (found) return v;
  if (rows.length) return rows[0].from;
  return current;
}

/* --------------------------------- reads -------------------------------- */

/** Today's default $ per unit of one kind. */
export async function defaultRateNow(kind) {
  const k = checkKind(kind);
  const raw = String((await getSettings())[k.key] ?? "").trim().replace(/^\$/, "");
  const v = Number(raw);
  return raw !== "" && !isNaN(v) && v >= 0 ? round2(v) : k.fallback;
}

export async function defaultRates() {
  return { direct: await defaultRateNow("direct"), referral: await defaultRateNow("referral") };
}

async function defaultAt(kind, at) {
  const v = valueAt(await history("default", "", kind), at, await defaultRateNow(kind));
  return v === null || v === undefined || isNaN(Number(v)) ? await defaultRateNow(kind) : round2(v);
}

/** The rep's OWN setting at `at`: a number, or null = on the default. */
async function repSettingAt(repId, kind, at, current) {
  const v = valueAt(await history("rep", repId, kind), at, current);
  return v === null || v === undefined || v === "" ? null : round2(v);
}

/**
 * $ per unit a rep earns of `kind` for an order placed at `at`.
 * `rep` may be the SalesRep document (saves a read) or the rep id.
 */
export async function rateAt(rep, kind, at = new Date()) {
  const k = checkKind(kind);
  await connectDb();
  const doc = typeof rep === "string" ? await SalesRep.findOne({ repId: rep }, { repId: 1, [k.field]: 1 }).lean() : rep;
  if (!doc) return defaultAt(kind, at);
  const own = await repSettingAt(doc.repId, kind, at, doc[k.field] ?? null);
  return own === null ? defaultAt(kind, at) : own;
}

/**
 * $ per unit the referrer earns on ONE referred rep's order placed at `at`:
 * the rate set for that referral (the referred rep's sponsorRate) when there
 * is one, else the referrer's own referral rate (or the default).
 * `rep` = the referred rep's SalesRep doc, `referrer` = the referrer's doc.
 */
export async function referralRateFor(rep, referrer, at = new Date()) {
  const own = await repSettingAt(rep.repId, "sponsor", at, rep.sponsorRate ?? null);
  return own === null ? rateAt(referrer, "referral", at) : own;
}

/**
 * $ per unit a rep earns on an order of ONE practice placed at `at`: the rate
 * set for that practice (rep.practiceRates) when there is one, else the
 * rep's direct rate (or the default).
 */
export async function practiceRateFor(rep, practiceId, at = new Date()) {
  if (practiceId) {
    const cur = rep.practiceRates?.[practiceId];
    const own = await repSettingAt(rep.repId, "practice:" + practiceId, at, cur === undefined ? null : cur);
    if (own !== null) return own;
  }
  return rateAt(rep, "direct", at);
}

/** Today's rates of one rep: { direct, referral, directDefault, referralDefault, defaults }. */
export async function currentRates(rep) {
  const defaults = await defaultRates();
  const own = (f) => (rep && rep[f] !== null && rep[f] !== undefined ? round2(rep[f]) : null);
  const d = own("directRate");
  const r = own("referralRate");
  return {
    direct: d ?? defaults.direct,
    referral: r ?? defaults.referral,
    directDefault: d === null,
    referralDefault: r === null,
    defaults,
  };
}

/* -------------------------------- notices ------------------------------- */

async function whenText(date) {
  const cfg = await getSettings();
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: cfg.TIMEZONE || "America/New_York",
      dateStyle: "medium",
      timeStyle: "short",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

async function notify(repIds, { title, message, changeId }) {
  if (!repIds.length) return 0;
  await RepNotice.insertMany(repIds.map((repId) => ({ repId, title, message, changeId: String(changeId || "") })));
  return repIds.length;
}

/** A rep's notices, newest first. */
export async function repNotices(repId, { limit = 20 } = {}) {
  await connectDb();
  const rows = await RepNotice.find({ repId }).sort({ createdAt: -1 }).limit(limit).lean();
  return rows.map((n) => ({
    id: String(n._id),
    title: n.title,
    message: n.message,
    ts: n.createdAt ? n.createdAt.getTime() : 0,
    seen: !!n.seenAt,
  }));
}

/** Marks the rep's notices seen (all, or the ids given). */
export async function markNoticesSeen(repId, ids = []) {
  await connectDb();
  const q = { repId, seenAt: null };
  const list = (Array.isArray(ids) ? ids : String(ids || "").split(",")).map(String).filter((x) => /^[a-f0-9]{24}$/i.test(x));
  if (list.length) q._id = { $in: list };
  const res = await RepNotice.updateMany(q, { $set: { seenAt: new Date() } });
  invalidateResponses();
  return { ok: true, seen: res.modifiedCount };
}

/* -------------------------------- changes ------------------------------- */

/**
 * Changes the default rate of one kind from now on. Every active rep on that
 * default gets a dashboard notice. Returns { ok, changed, notified } / { ok: false, error }.
 */
export async function setDefaultRate(kind, value, { by = "", note = "" } = {}) {
  const k = checkKind(kind);
  const parsed = parseRate(value, kind);
  if (parsed.blank) return { ok: false, error: "Enter a rate." };
  if (parsed.error) return { ok: false, error: parsed.error };
  const prev = await defaultRateNow(kind);
  if (prev === parsed.value) return { ok: true, changed: false };

  await connectDb();
  const effectiveAt = new Date();
  await setSetting(k.key, parsed.value.toFixed(2));
  const change = await CommissionChange.create({
    scope: "default", repId: "", kind, from: prev, to: parsed.value, effectiveAt, by: String(by), note: String(note || ""),
  });
  const affected = await SalesRep.find({ active: { $ne: false }, [k.field]: null }, { repId: 1 }).lean();
  const when = await whenText(effectiveAt);
  const notified = await notify(
    affected.map((r) => r.repId),
    {
      title: `Your ${k.label} commission is changing`,
      message:
        `The ${k.label} commission changes from ${fmtRate(prev)} to ${fmtRate(parsed.value)} per unit ` +
        `for orders placed from ${when}. Orders placed before then keep the earlier rate.` +
        (note ? ` ${String(note).trim()}` : ""),
      changeId: change._id,
    },
  );
  await CommissionChange.updateOne({ _id: change._id }, { $set: { notified } });
  clearCaches();
  logEvent("job", "commission-default", `${kind} default ${fmtRate(prev)} -> ${fmtRate(parsed.value)} by ${by || "?"}; ${notified} rep(s) notified`);
  return { ok: true, changed: true, notified, from: prev, to: parsed.value };
}

/**
 * Sets ONE rep's own rate of `kind` from now on. value: a dollar amount, or
 * "" / "default" / null = back on the default. The rep gets a notice.
 */
export async function setRepRate(repId, kind, value, { by = "", note = "" } = {}) {
  const k = checkKind(kind);
  repId = String(repId || "").trim();
  await connectDb();
  const rep = await SalesRep.findOne({ repId }).lean();
  if (!rep) return { ok: false, error: "Sales rep not found: " + repId };
  let to = null;
  if (!(value === null || value === undefined || String(value).trim().toLowerCase() === "default")) {
    const parsed = parseRate(value, kind);
    if (parsed.error) return { ok: false, error: parsed.error };
    to = parsed.blank ? null : parsed.value;
  }
  const from = rep[k.field] === null || rep[k.field] === undefined ? null : round2(rep[k.field]);
  if (from === to) return { ok: true, changed: false };

  const effectiveAt = new Date();
  const defaults = await defaultRates();
  const oldEff = from ?? defaults[kind];
  const newEff = to ?? defaults[kind];
  await SalesRep.updateOne({ repId }, { $set: { [k.field]: to } });
  const change = await CommissionChange.create({
    scope: "rep", repId, kind, from, to, effectiveAt, by: String(by), note: String(note || ""),
  });
  const when = await whenText(effectiveAt);
  const what =
    oldEff === newEff
      ? `Your ${k.label} commission stays at ${fmtRate(newEff)} per unit` +
        (to === null ? " and now follows the standard rate." : " and is now set for you individually.")
      : `Your ${k.label} commission changes from ${fmtRate(oldEff)} to ${fmtRate(newEff)} per unit ` +
        `for orders placed from ${when}. Orders placed before then keep the earlier rate.`;
  const notified = await notify([repId], {
    title: `Your ${k.label} commission has been updated`,
    message: what + (note ? ` ${String(note).trim()}` : ""),
    changeId: change._id,
  });
  await CommissionChange.updateOne({ _id: change._id }, { $set: { notified } });
  clearCaches();
  logEvent("job", "rep:" + repId, `${kind} rate ${from === null ? "default" : fmtRate(from)} -> ${to === null ? "default" : fmtRate(to)} by ${by || "?"}`);
  return { ok: true, changed: true, from, to };
}

/**
 * Sets the referral rate for ONE referral: what `repId`'s referrer earns per
 * unit on `repId`'s sales, from now on. value: a dollar amount (max as the
 * referral cap), or "" / "default" / null = back on the referrer's own rate.
 * The referrer (who earns it) gets the notice.
 */
export async function setSponsorRate(repId, value, { by = "", note = "" } = {}) {
  repId = String(repId || "").trim();
  await connectDb();
  const rep = await SalesRep.findOne({ repId }).lean();
  if (!rep) return { ok: false, error: "Sales rep not found: " + repId };
  if (!rep.referredBy) return { ok: false, error: `${rep.name || repId} was not referred by anyone, so there is no referral rate to set.` };
  const referrer = await SalesRep.findOne({ repId: rep.referredBy }).lean();
  if (!referrer) return { ok: false, error: "Referring rep not found: " + rep.referredBy };
  let to = null;
  if (!(value === null || value === undefined || String(value).trim().toLowerCase() === "default")) {
    const parsed = parseRate(value, "referral");
    if (parsed.error) return { ok: false, error: parsed.error };
    to = parsed.blank ? null : parsed.value;
  }
  const from = rep.sponsorRate === null || rep.sponsorRate === undefined ? null : round2(rep.sponsorRate);
  if (from === to) return { ok: true, changed: false };

  const effectiveAt = new Date();
  const fallback = (await currentRates(referrer)).referral;
  const oldEff = from ?? fallback;
  const newEff = to ?? fallback;
  await SalesRep.updateOne({ repId }, { $set: { sponsorRate: to } });
  const change = await CommissionChange.create({
    scope: "rep", repId, kind: "sponsor", from, to, effectiveAt, by: String(by), note: String(note || ""),
  });
  const who = rep.name || repId;
  const when = await whenText(effectiveAt);
  const what =
    oldEff === newEff
      ? `Your referral commission on ${who}'s sales stays at ${fmtRate(newEff)} per unit.`
      : `Your referral commission on ${who}'s sales changes from ${fmtRate(oldEff)} to ${fmtRate(newEff)} per unit ` +
        `for orders placed from ${when}. Orders placed before then keep the earlier rate.`;
  const notified = await notify([referrer.repId], {
    title: "Your referral commission has been updated",
    message: what + (note ? ` ${String(note).trim()}` : ""),
    changeId: change._id,
  });
  await CommissionChange.updateOne({ _id: change._id }, { $set: { notified } });
  clearCaches();
  logEvent("job", "rep:" + repId, `referral rate paid to ${referrer.repId} ${from === null ? "default" : fmtRate(from)} -> ${to === null ? "default" : fmtRate(to)} by ${by || "?"}`);
  return { ok: true, changed: true, from, to };
}

/**
 * Sets a rep's direct rate on ONE practice's orders, from now on. value: a
 * dollar amount, or "" / "default" / null = back on the rep's direct rate.
 * The rep gets a notice. `practiceName` is only used in that notice.
 */
export async function setPracticeRate(repId, practiceId, value, { by = "", note = "", practiceName = "" } = {}) {
  repId = String(repId || "").trim();
  practiceId = String(practiceId || "").trim();
  if (!practiceId) return { ok: false, error: "Practice is required." };
  await connectDb();
  const rep = await SalesRep.findOne({ repId }).lean();
  if (!rep) return { ok: false, error: "Sales rep not found: " + repId };
  let to = null;
  if (!(value === null || value === undefined || String(value).trim().toLowerCase() === "default")) {
    const parsed = parseRate(value, "direct");
    if (parsed.error) return { ok: false, error: parsed.error };
    to = parsed.blank ? null : parsed.value;
  }
  const curRaw = rep.practiceRates?.[practiceId];
  const from = curRaw === null || curRaw === undefined ? null : round2(curRaw);
  if (from === to) return { ok: true, changed: false };

  const effectiveAt = new Date();
  const fallback = (await currentRates(rep)).direct;
  const oldEff = from ?? fallback;
  const newEff = to ?? fallback;
  const field = `practiceRates.${practiceId}`;
  await SalesRep.updateOne({ repId }, to === null ? { $unset: { [field]: "" } } : { $set: { [field]: to } });
  const change = await CommissionChange.create({
    scope: "rep", repId, kind: "practice:" + practiceId, from, to, effectiveAt, by: String(by), note: String(note || ""),
  });
  const where = String(practiceName || practiceId).slice(0, 120);
  const when = await whenText(effectiveAt);
  const what =
    oldEff === newEff
      ? `Your commission on ${where}'s orders stays at ${fmtRate(newEff)} per unit.`
      : `Your commission on ${where}'s orders changes from ${fmtRate(oldEff)} to ${fmtRate(newEff)} per unit ` +
        `for orders placed from ${when}. Orders placed before then keep the earlier rate.`;
  const notified = await notify([repId], {
    title: "Your commission has been updated",
    message: what + (note ? ` ${String(note).trim()}` : ""),
    changeId: change._id,
  });
  await CommissionChange.updateOne({ _id: change._id }, { $set: { notified } });
  clearCaches();
  logEvent("job", "rep:" + repId, `${practiceId} rate ${from === null ? "rep rate" : fmtRate(from)} -> ${to === null ? "rep rate" : fmtRate(to)} by ${by || "?"}`);
  return { ok: true, changed: true, from, to };
}

/** Renames a rep and/or sets them active / inactive; both go in the history. */
export async function updateRepProfile(repId, { name, active } = {}, { by = "" } = {}) {
  repId = String(repId || "").trim();
  await connectDb();
  const rep = await SalesRep.findOne({ repId }, { repId: 1, name: 1, active: 1 }).lean();
  if (!rep) return { ok: false, error: "Sales rep not found: " + repId };
  const set = {};
  const changes = [];
  const effectiveAt = new Date();
  if (name !== undefined) {
    const n = String(name || "").trim();
    if (!n) return { ok: false, error: "Sales Agent Name is required." };
    if (n.length > 120) return { ok: false, error: "Sales Agent Name is too long." };
    if (n !== (rep.name || "")) {
      set.name = n;
      changes.push({ kind: "name", from: rep.name || "", to: n });
    }
  }
  if (active !== undefined) {
    const a = active === true || active === "true";
    if (a !== (rep.active !== false)) {
      set.active = a;
      changes.push({ kind: "status", from: rep.active !== false ? "Active" : "Inactive", to: a ? "Active" : "Inactive" });
    }
  }
  if (!changes.length) return { ok: true, changed: false };
  await SalesRep.updateOne({ repId }, { $set: set });
  await CommissionChange.insertMany(changes.map((c) => ({ scope: "rep", repId, ...c, effectiveAt, by: String(by) })));
  clearCaches();
  logEvent("job", "rep:" + repId, changes.map((c) => `${c.kind} ${c.from} -> ${c.to}`).join("; ") + ` by ${by || "?"}`);
  return { ok: true, changed: true };
}

/**
 * The History popup of one Sales Reps row, newest first:
 *   type "rep"      - the rep: added, name / status, own rates, referrer,
 *                     and default-rate changes that applied to them
 *   type "practice" - the rep's rate on that one practice
 *   type "referred" - `childId` as a referral of `repId`: when they were
 *                     added under that rep, the referral rate, name / status
 * Rows: { ts, type: "Commission Update" | "Sales Agent Added" | "Settings", details, by }.
 */
export async function rowHistory({ type = "rep", repId = "", practiceId = "", childId = "" } = {}) {
  await connectDb();
  const who = String(type === "referred" ? childId : repId).trim();
  const rep = await SalesRep.findOne({ repId: who }).lean();
  if (!rep) return { ok: false, error: "Sales rep not found: " + who };
  const names = Object.fromEntries((await SalesRep.find({}, { repId: 1, name: 1 }).lean()).map((r) => [r.repId, r.name || r.repId]));
  const byName = (b) => {
    const s = String(b || "").trim();
    const m = s.match(/^Finance dashboard \((.*)\)$/);
    return m ? m[1] : s || "-";
  };
  const money = (v) => fmtRate(v);
  const out = [];
  const push = (ts, t, details, by) => out.push({ ts: new Date(ts).getTime(), type: t, details, by: byName(by) });

  // a rate change; `std` is what null means for this rate
  const rateRow = (c, label, std) => {
    if (c.from === null && c.to !== null) return push(c.effectiveAt, "Settings", `${label} set to ${money(c.to)}.`, c.by);
    if (c.to === null) return push(c.effectiveAt, "Settings", `${label} set back to ${std}${c.from !== null ? ` (was ${money(c.from)})` : ""}.`, c.by);
    return push(c.effectiveAt, "Commission Update", `${label} changed from ${money(c.from)} to ${money(c.to)}.`, c.by);
  };
  const profileRow = (c) =>
    c.kind === "name"
      ? push(c.effectiveAt, "Settings", `Name changed from ${c.from || "-"} to ${c.to}.`, c.by)
      : push(c.effectiveAt, "Settings", `Status changed from ${c.from} to ${c.to}.`, c.by);

  if (type === "practice") {
    const rows = await CommissionChange.find({ scope: "rep", repId: who, kind: "practice:" + practiceId }).sort({ effectiveAt: -1 }).lean();
    for (const c of rows) rateRow(c, "Commission / Unit", "the rep's rate");
  } else if (type === "referred") {
    const rows = await CommissionChange.find({ scope: "rep", repId: who, kind: { $in: ["sponsor", "referrer", "name", "status"] } }).sort({ effectiveAt: -1 }).lean();
    for (const c of rows) {
      if (c.kind === "sponsor") rateRow(c, "Commission / Unit", "the referrer's rate");
      else if (c.kind === "referrer") {
        if (c.to === repId) push(c.effectiveAt, "Sales Agent Added", `${rep.name || who} was added as a referred Sales Agent.`, c.by);
        else if (c.from === repId) push(c.effectiveAt, "Settings", `${rep.name || who} was moved to ${c.to ? names[c.to] || c.to : "no referrer"}.`, c.by);
      } else profileRow(c);
    }
  } else {
    const rows = await CommissionChange.find({ scope: "rep", repId: who, kind: { $in: ["direct", "referral", "referrer", "name", "status"] } }).sort({ effectiveAt: -1 }).lean();
    for (const c of rows) {
      if (c.kind === "direct") rateRow(c, "Commission / Unit", "the standard rate");
      else if (c.kind === "referral") rateRow(c, "Referral Commission / Unit", "the standard rate");
      else if (c.kind === "referrer") push(c.effectiveAt, "Settings", c.to ? `Referred by ${names[c.to] || c.to}.` : "No longer referred by anyone.", c.by);
      else profileRow(c);
    }
    // standard-rate changes that applied while this rep was on the standard rate
    for (const h of await rateHistory({ repId: who, limit: 200 })) {
      if (h.scope === "default" && h.kind === "direct") {
        push(h.ts, "Commission Update", `Standard Commission / Unit changed from ${money(h.from)} to ${money(h.to)}.`, h.by);
      }
    }
    if (rep.createdAt) push(rep.createdAt, "Sales Agent Added", `${rep.name || who} was added as a Sales Agent.`, "");
  }
  out.sort((a, b) => b.ts - a.ts);
  return { ok: true, rows: out.slice(0, 200) };
}

/**
 * Saves the Edit popup of one Sales Reps row (Finance dashboard).
 *   type "rep"      - name, status, Commission / Unit = the rep's direct rate
 *   type "referred" - the referred rep's name, status, and Commission / Unit =
 *                     what their referrer earns on their sales
 *   type "practice" - Commission / Unit = the rep's rate on that practice
 * `rate` is only sent when it was changed.
 */
export async function saveRepRow(p, { by = "" } = {}) {
  const type = String(p.type || "");
  const repId = String(p.rep || "").trim();
  const rate = p.rate === undefined || p.rate === null ? undefined : String(p.rate).trim();
  if (rate === "") return { ok: false, error: "Commission / Unit is required." };
  if (type === "practice") {
    if (rate === undefined) return { ok: true, changed: false };
    return setPracticeRate(repId, String(p.practice || ""), rate, { by, practiceName: p.practiceName });
  }
  if (type !== "rep" && type !== "referred") return { ok: false, error: "Unknown row type." };
  const target = type === "referred" ? String(p.child || "").trim() : repId;
  if (type === "referred") {
    const child = await SalesRep.findOne({ repId: target }, { referredBy: 1 }).lean();
    if (!child || child.referredBy !== repId) return { ok: false, error: "That agent is not referred by this Sales Agent." };
  }
  if (rate !== undefined) {
    // check the rate first, so a refused rate saves nothing
    const parsed = parseRate(rate, type === "referred" ? "referral" : "direct");
    if (parsed.error) return { ok: false, error: parsed.error };
  }
  const prof = await updateRepProfile(target, { name: p.name, active: p.active }, { by });
  if (!prof.ok) return prof;
  if (rate !== undefined) {
    const r = type === "referred" ? await setSponsorRate(target, rate, { by }) : await setRepRate(target, "direct", rate, { by });
    if (!r.ok) return r;
  }
  return { ok: true };
}

/**
 * Who referred `repId` ("" = nobody). Refuses self-referral and loops
 * (A referred B referred A). Recorded in the history; applies to orders
 * paid from now on.
 */
export async function setReferrer(repId, referrerRepId, { by = "", note = "" } = {}) {
  repId = String(repId || "").trim();
  const to = String(referrerRepId || "").trim();
  await connectDb();
  const rep = await SalesRep.findOne({ repId }, { repId: 1, referredBy: 1, sponsorRate: 1 }).lean();
  if (!rep) return { ok: false, error: "Sales rep not found: " + repId };
  const from = rep.referredBy || "";
  if (from === to) return { ok: true, changed: false };
  if (to) {
    if (to === repId) return { ok: false, error: "A rep cannot refer themselves." };
    if (!(await SalesRep.exists({ repId: to }))) return { ok: false, error: "Referring rep not found: " + to };
    // walk up from the new referrer: meeting repId means a loop
    const seen = new Set();
    let cur = to;
    while (cur && !seen.has(cur)) {
      if (cur === repId) return { ok: false, error: `${to} is already in ${repId}'s referral line - that would make a loop.` };
      seen.add(cur);
      cur = (await SalesRep.findOne({ repId: cur }, { referredBy: 1 }).lean())?.referredBy || "";
    }
  }
  const effectiveAt = new Date();
  // A newly added referral always starts at NEW_REFERRAL_RATE ($0.20 per
  // unit, client 2026-11-18) as its own per-referral rate - whatever the
  // saved default is. It can be changed later in the Edit popup. Removing the
  // referrer clears the per-referral rate (there is nobody to pay it to).
  const oldSponsor = rep.sponsorRate !== null && rep.sponsorRate !== undefined ? round2(rep.sponsorRate) : null;
  const newSponsor = to ? NEW_REFERRAL_RATE : null;
  await SalesRep.updateOne({ repId }, { $set: { referredBy: to, sponsorRate: newSponsor } });
  await CommissionChange.create({
    scope: "rep", repId, kind: "referrer", from, to, effectiveAt, by: String(by), note: String(note || ""),
  });
  if (oldSponsor !== newSponsor) {
    await CommissionChange.create({
      scope: "rep", repId, kind: "sponsor", from: oldSponsor, to: newSponsor, effectiveAt, by: String(by),
      note: to ? "Default for a new referral" : "Referrer removed",
    });
  }
  clearCaches();
  logEvent("job", "rep:" + repId, `referred by ${from || "nobody"} -> ${to || "nobody"} by ${by || "?"}`);
  return { ok: true, changed: true, from, to };
}

/**
 * Commission change history, newest first. With `repId`: that rep's own
 * changes plus every default change made while the rep was on that default
 * (`applied: true`). Without: everything.
 */
export async function rateHistory({ repId = "", limit = 200 } = {}) {
  await connectDb();
  const q = repId ? { $or: [{ scope: "rep", repId }, { scope: "default" }] } : {};
  const rows = await CommissionChange.find(q).sort({ effectiveAt: -1, _id: -1 }).limit(limit * 2).lean();
  const rep = repId ? await SalesRep.findOne({ repId }).lean() : null;
  const out = [];
  for (const r of rows) {
    let applied = r.scope === "rep";
    if (r.scope === "default" && rep) {
      const k = KINDS[r.kind];
      const own = k ? await repSettingAt(repId, r.kind, new Date(new Date(r.effectiveAt).getTime() - 1), rep[k.field] ?? null) : 0;
      applied = own === null && (!rep.createdAt || new Date(rep.createdAt) <= new Date(r.effectiveAt));
      if (!applied) continue; // the rep had their own rate - this default change did not touch them
    }
    out.push({
      id: String(r._id),
      scope: r.scope,
      repId: r.repId || "",
      kind: r.kind,
      from: r.from,
      to: r.to,
      ts: new Date(r.effectiveAt).getTime(),
      by: r.by || "",
      note: r.note || "",
      notified: r.notified || 0,
      applied,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/* ----------------------------- referral links --------------------------- */

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

/** The rep's referral code, created on first use. */
export async function ensureReferralCode(repId) {
  await connectDb();
  const rep = await SalesRep.findOne({ repId }, { referralCode: 1 }).lean();
  if (!rep) return "";
  if (rep.referralCode) return rep.referralCode;
  for (let i = 0; i < 10; i++) {
    const bytes = crypto.randomBytes(8);
    const code = Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
    if (await SalesRep.exists({ referralCode: code })) continue;
    const res = await SalesRep.updateOne({ repId, referralCode: { $in: ["", null] } }, { $set: { referralCode: code } });
    if (res.modifiedCount) return code;
    return (await SalesRep.findOne({ repId }, { referralCode: 1 }).lean())?.referralCode || "";
  }
  throw new Error("could not create a referral code");
}

/** The active rep behind a ?ref= code, or null. */
export async function repByReferralCode(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(c)) return null;
  await connectDb();
  return SalesRep.findOne({ referralCode: c, active: { $ne: false } }, { repId: 1, name: 1, email: 1 }).lean();
}

/* ------------------------------ referral tree --------------------------- */

/** Every rep as a tree by referrer: [{ repId, name, active, referredBy, children: [...] }]. */
export async function referralTree() {
  await connectDb();
  const reps = await SalesRep.find({}, { repId: 1, name: 1, email: 1, active: 1, referredBy: 1, createdAt: 1 }).sort({ name: 1 }).lean();
  const byId = new Map(reps.map((r) => [r.repId, { repId: r.repId, name: r.name || r.repId, email: r.email || "", active: r.active !== false, referredBy: r.referredBy || "", children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.referredBy && byId.get(node.referredBy);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
