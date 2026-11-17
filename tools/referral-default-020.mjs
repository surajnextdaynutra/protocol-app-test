/* Referral commission default = $0.20 per unit (client, 2026-11-18).

   The app's built-in default is already $0.20, but a value saved earlier in
   Settings (REFERRAL_COMMISSION_PER_UNIT) wins over it. This tool:
     1. shows the saved default and, with --apply, sets it to 0.20 exactly the
        way Shopify admin -> Sales reps -> "Save defaults" does (a history row
        effective now + a dashboard notice for every active agent on the
        default; orders already placed keep the rate they were paid at);
     2. lists every referral that has its OWN rate (set in the Finance
        dashboard Edit popup) - those do not follow the default. With
        --reset=RAP2,RAP5 the listed ones go back to the default.

   Look only:   node tools/referral-default-020.mjs
   Change:      node tools/referral-default-020.mjs --apply
   Also reset:  node tools/referral-default-020.mjs --apply --reset=RAP2,RAP5 */
import fs from "node:fs";
import mongoose from "mongoose";

const TARGET = 0.2;
const KEY = "REFERRAL_COMMISSION_PER_UNIT";
const BY = "tools/referral-default-020";
const apply = process.argv.includes("--apply");
const resetIds = (process.argv.find((a) => a.startsWith("--reset=")) || "").slice(8).split(",").map((s) => s.trim()).filter(Boolean);

const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const envVal = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "");
const uri = process.env.MONGODB_URI || envVal("MONGODB_URI");
if (!uri) { console.error("MONGODB_URI not found in .env"); process.exit(1); }
await mongoose.connect(uri, { dbName: process.env.MONGODB_DB || envVal("MONGODB_DB") || "protocol_rx" });
const db = mongoose.connection.db;
const money = (n) => "$" + Number(n || 0).toFixed(2);

// ---- 1. the default
const saved = await db.collection("settings").findOne({ key: KEY });
const raw = String(saved?.value ?? "").trim().replace(/^\$/, "");
const current = raw !== "" && !isNaN(Number(raw)) ? Math.round(Number(raw) * 100) / 100 : TARGET;
console.log(`Default referral commission: ${money(current)}${saved ? ` (saved in Settings as "${saved.value}")` : " (nothing saved - built-in default)"}`);

if (current === TARGET) {
  console.log("  already $0.20 - nothing to change.");
} else if (!apply) {
  console.log(`  would change ${money(current)} -> ${money(TARGET)} (add --apply)`);
} else {
  const now = new Date();
  await db.collection("settings").updateOne({ key: KEY }, { $set: { value: TARGET.toFixed(2), updatedAt: now } }, { upsert: true });
  const change = await db.collection("commission_changes").insertOne({
    scope: "default", repId: "", kind: "referral", from: current, to: TARGET, effectiveAt: now, by: BY, note: "", notified: 0, createdAt: now, updatedAt: now,
  });
  const onDefault = await db.collection("sales_reps").find({ active: { $ne: false }, referralRate: null }, { projection: { repId: 1 } }).toArray();
  if (onDefault.length) {
    await db.collection("rep_notices").insertMany(onDefault.map((r) => ({
      repId: r.repId,
      title: "Your referral commission is changing",
      message: `The referral commission changes from ${money(current)} to ${money(TARGET)} per unit for orders placed from ${now.toUTCString()}. Orders placed before then keep the earlier rate.`,
      changeId: String(change.insertedId), seenAt: null, createdAt: now, updatedAt: now,
    })));
  }
  await db.collection("commission_changes").updateOne({ _id: change.insertedId }, { $set: { notified: onDefault.length } });
  console.log(`  CHANGED ${money(current)} -> ${money(TARGET)}; ${onDefault.length} agent(s) on the default were notified.`);
  console.log("  The app caches Settings for 30 seconds - it shows the new default after that.");
}

// ---- 2. referrals / referrers with their own rate
const names = Object.fromEntries((await db.collection("sales_reps").find({}, { projection: { repId: 1, name: 1 } }).toArray()).map((r) => [r.repId, r.name || r.repId]));
const perReferral = await db.collection("sales_reps").find({ referredBy: { $nin: ["", null] }, sponsorRate: { $ne: null } }).toArray();
const perReferrer = await db.collection("sales_reps").find({ referralRate: { $ne: null } }).toArray();
console.log(`\nReferrals with their own rate (do NOT follow the default): ${perReferral.length}`);
for (const r of perReferral) console.log(`  ${r.repId}  ${names[r.repId]}  referred by ${names[r.referredBy] || r.referredBy}: ${money(r.sponsorRate)}`);
console.log(`Agents with their own referral rate for everyone they refer: ${perReferrer.length}`);
for (const r of perReferrer) console.log(`  ${r.repId}  ${names[r.repId]}: ${money(r.referralRate)}`);

if (resetIds.length) {
  const unknown = resetIds.filter((id) => !perReferral.some((r) => r.repId === id));
  if (unknown.length) {
    console.log(`\n--reset: not a referral with its own rate, skipped: ${unknown.join(", ")}`);
  }
  for (const r of perReferral.filter((x) => resetIds.includes(x.repId))) {
    if (!apply) { console.log(`  would reset ${r.repId} ${money(r.sponsorRate)} -> default (add --apply)`); continue; }
    const now = new Date();
    await db.collection("sales_reps").updateOne({ _id: r._id, sponsorRate: r.sponsorRate }, { $set: { sponsorRate: null } });
    await db.collection("commission_changes").insertOne({
      scope: "rep", repId: r.repId, kind: "sponsor", from: r.sponsorRate, to: null, effectiveAt: now, by: BY, note: "", notified: 0, createdAt: now, updatedAt: now,
    });
    console.log(`  RESET ${r.repId} ${names[r.repId]}: ${money(r.sponsorRate)} -> default`);
  }
}
if (!apply) console.log("\nLook only - nothing was changed. Add --apply to change.");
await mongoose.disconnect();
