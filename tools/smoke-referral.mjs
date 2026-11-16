/* Smoke test of the two-layer sales commission (direct + referral),
   effective-dated rate changes, rep notices, referral sign-up and PT Profit,
   against a throw-away in-memory MongoDB. Nothing leaves this machine.

     npx vite-node -c tools/vite.smoke.config.js tools/smoke-referral.mjs */

import { MongoMemoryServer } from "mongodb-memory-server";

const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
Object.assign(process.env, {
  MONGODB_URI: mongo.getUri(),
  MONGODB_DB: "rx_smoke_referral",
  ENCRYPTION_KEY: "smoke-test-encryption-key-0123456789",
  SHOPIFY_API_KEY: "smoke-key",
  SHOPIFY_API_SECRET: "smoke-secret",
  SHOPIFY_APP_URL: "https://rx.example.com",
  SHOPIFY_SHOP: "smoke-test.myshopify.com",
  SCOPES: "read_orders",
  RX_SCHEDULER: "off",
});
// no network: Shopify / Brevo calls fail fast (they are best-effort here)
globalThis.fetch = async () => {
  throw new Error("no network in the smoke test");
};

let passed = 0;
const failures = [];
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
function check(name, actual, expected) {
  const ok = typeof expected === "number" ? near(actual, expected) : actual === expected;
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const { connectDb } = await import("../app/db.server.js");
const M = await import("../app/models/index.server.js");
const C = await import("../app/services/commission.server.js");
const R = await import("../app/services/rep-rates.server.js");
const { repTeam } = await import("../app/services/rep-team.server.js");
const S = await import("../app/services/rep-signup.server.js");
const { ptProfitSummary } = await import("../app/services/exec-commissions.server.js");
const { setSetting } = await import("../app/services/settings.server.js");
await connectDb();

/* ---- setup: A referred B; B is assigned PRA1; one product ---- */
await M.SalesRep.create({ repId: "RAP1", name: "Rep A", email: "a@test.local" });
await M.SalesRep.create({ repId: "RAP2", name: "Rep B", email: "b@test.local" });
await M.SalesRep.create({ repId: "RAP3", name: "Rep C", email: "c@test.local", assignedPracticeIds: ["PRA9"] });
check("referrer set", (await R.setReferrer("RAP2", "RAP1", { by: "test" })).ok, true);
check("self-referral refused", (await R.setReferrer("RAP1", "RAP1")).ok, false);
check("loop refused", (await R.setReferrer("RAP1", "RAP2")).ok, false);
await M.SalesRep.updateOne({ repId: "RAP2" }, { $set: { assignedPracticeIds: ["PRA1"] } });
await M.Product.create({ productId: "P1", title: "Prod", wholesale: 10, mfgCogs: 4 });
await M.Product.create({ productId: "P2", title: "No cogs", wholesale: 8 });

const t0 = new Date(Date.now() - 3 * 86400000); // placed 3 days ago
const lines = [{ productId: "P1", quantity: 3, price: 30, title: "Prod" }];
const ids = { practiceId: "PRA1" };

let c = await C.computeOrderCommission(lines, ids, { at: t0 });
check("defaults: rep B direct $1/unit x3", c.repAmt, 3);
check("defaults: referrer is A", c.refRepId, "RAP1");
check("defaults: A referral $0.20/unit x3", c.refAmt, 0.6);
check("PT revenue = wholesale x qty", c.ptRevenue, 30);
check("COGS = 4 x 3", c.cogs, 12);
check("PT profit = 30 - 12 - 3 - 0.6", c.ptProfit, 14.4);

/* ---- default change applies from now on only, notices to reps on default ---- */
const d = await R.setDefaultRate("direct", "1.10", { by: "test", note: "Test note." });
check("default change saved", d.changed, true);
check("all 3 reps on default notified", d.notified, 3);
check("unchanged default is a no-op", (await R.setDefaultRate("direct", "1.10")).changed, false);
check("bad rate refused", (await R.setDefaultRate("direct", "abc")).ok, false);
c = await C.computeOrderCommission(lines, ids, { at: t0 });
check("older order keeps $1.00", c.repAmt, 3);
c = await C.computeOrderCommission(lines, ids, { at: new Date(Date.now() + 1000) });
check("new order at $1.10", c.repAmt, 3.3);
const nA = await R.repNotices("RAP1");
check("A has a notice", nA.length, 1);
check("notice mentions both rates", /\$1\.00 to \$1\.10/.test(nA[0].message), true);

/* ---- per-rep rate: forward only, notice to that rep only ---- */
check("B own rate", (await R.setRepRate("RAP2", "direct", "1.50", { by: "test" })).ok, true);
c = await C.computeOrderCommission(lines, ids, { at: new Date(Date.now() + 1000) });
check("new order at B's own $1.50", c.repAmt, 4.5);
c = await C.computeOrderCommission(lines, ids, { at: t0 });
check("old order still $1.00 after B's own rate", c.repAmt, 3);
check("only B got the per-rep notice", (await R.repNotices("RAP1")).length, 1);
check("B has 2 notices", (await R.repNotices("RAP2")).length, 2);
check("referral rate above $0.20 allowed (no cap)", (await R.setRepRate("RAP1", "referral", "0.25")).ok, true);
check("A referral rate own", (await R.setRepRate("RAP1", "referral", "0.15")).ok, true);
c = await C.computeOrderCommission(lines, ids, { at: new Date(Date.now() + 1000) });
check("A earns own referral $0.15 x3", c.refAmt, 0.45);
check("back to default", (await R.setRepRate("RAP2", "direct", "default")).to, null);
c = await C.computeOrderCommission(lines, ids, { at: new Date(Date.now() + 1000) });
check("B back on default $1.10", c.repAmt, 3.3);

const hist = await R.rateHistory({ repId: "RAP2" });
check("B history: referrer + default + 2 own changes", hist.length, 4);
const histC = await R.rateHistory({ repId: "RAP3" });
check("C history shows the default change only", histC.length, 1);

/* ---- payouts: each rep paid into their own monthly Rep record ---- */
await M.Order.create({
  orderId: "9001", name: "#9001", orderCreatedAt: t0, financialStatus: "PAID", tags: ["rx"], practiceId: "PRA1",
  units: 3, total: 90, lineItems: lines,
});
check("order logged", await C.recordOrderPayoutIfNew({ orderId: "9001", name: "#9001" }, ids), true);
const o = await M.Order.findOne({ orderId: "9001" }).lean();
check("frozen repAmt", o.commission.repAmt, 3);
check("frozen refAmt", o.commission.refAmt, 0.6);
check("frozen ptProfit", o.commission.ptProfit, 14.4);
check("line COGS frozen", o.lineItems[0].cogs, 4);
const payB = await M.MonthlyPayout.findOne({ role: "Rep", entityId: "RAP2" }).lean();
const payA = await M.MonthlyPayout.findOne({ role: "Rep", entityId: "RAP1" }).lean();
check("B payout", payB?.amount, 3);
check("A referral payout", payA?.amount, 0.6);
const rebuilt = await C.rebuildMonthlyPayouts({ dryRun: true });
check("rebuild agrees with ledger", rebuilt.changed + rebuilt.created, 0);
check("reverse ok", await C.reverseOrderCommission("9001"), true);
check("A payout reversed", (await M.MonthlyPayout.findOne({ role: "Rep", entityId: "RAP1" }).lean()).amount, 0);
await M.Order.updateOne({ orderId: "9001" }, { $set: { "commission.status": "Active", "commission.counted": "Yes", deletedAt: null } });
await C.rebuildMonthlyPayouts({ dryRun: false });
check("rebuild restores A", (await M.MonthlyPayout.findOne({ role: "Rep", entityId: "RAP1" }).lean()).amount, 0.6);

/* ---- COGS missing ---- */
c = await C.computeOrderCommission([{ productId: "P2", quantity: 1, price: 20 }], ids, { at: t0 });
check("missing COGS flagged", c.cogsMissing, true);

/* ---- rep "My Team" ---- */
const team = await repTeam({ rep: "RAP1" });
check("team ok", team.ok, true);
check("A has a referral code", /^[A-Z2-9]{8}$/.test(team.referralCode), true);
check("A's team is B", team.team.map((t) => t.repId).join(), "RAP2");
check("B's units", team.team[0].units, 3);
check("A earned from B", team.team[0].earned, 0.6);
check("one referral order", team.referralOrders.length, 1);
check("A referral earnings", team.earnings.referral, 0.6);
check("A unseen notices (default change + 2 own referral rates)", team.unseenNotices, 3);
await R.markNoticesSeen("RAP1");
check("notices seen", (await repTeam({ rep: "RAP1" })).unseenNotices, 0);

/* ---- sign-up ---- */
check("closed without terms", (await S.signupInfo({ ref: team.referralCode })).open, false);
await setSetting("REP_SIGNUP_TERMS", "Agreement text for this test.");
const info = await S.signupInfo({ ref: team.referralCode });
check("open with terms", info.open, true);
check("referrer shown", info.referrer?.name, "Rep A");
check("bad code flagged", (await S.signupInfo({ ref: "ZZZZZZZZ" })).refInvalid, true);
const form = {
  ref: team.referralCode, firstName: "Dana", lastName: "Lee", email: "dana@test.local", phone: "(555) 123-4567",
  address: "1 Main St", city: "Austin", state: "TX", zip: "73301",
  agree: true, signatureName: "dana  lee", termsVersion: info.termsVersion,
};
const bad = await S.submitSignup({ ...form, signatureName: "Someone Else" }, null);
check("signature must match name", !!bad.fields?.signatureName, true);
check("must agree", !!(await S.submitSignup({ ...form, agree: false }, null)).fields?.agree, true);
check("stale terms refused", (await S.submitSignup({ ...form, termsVersion: "old" }, null)).termsChanged, true);
check("valid sign-up", (await S.submitSignup(form, null)).ok, true);
check("duplicate pending refused", (await S.submitSignup(form, null)).ok, false);
const apps = await S.listApplications({ status: "Pending" });
check("pending with referrer", apps[0]?.referrerRepId, "RAP1");
const terms = await S.applicationTerms(apps[0].id);
check("signed terms kept word for word", terms.terms, "Agreement text for this test.");
check("reject", (await S.rejectApplication(apps[0].id, { by: "test", note: "n" })).ok, true);

/* ---- per-referral rate, per-practice rate, Sales Reps History / Edit ---- */
const later = () => new Date(Date.now() + 1000);
check("referral rate per referral above $0.20 allowed (no cap)", (await R.setSponsorRate("RAP2", "0.30")).ok, true);
check("rate for B's referral", (await R.setSponsorRate("RAP2", "0.05", { by: "Finance dashboard (Exec)" })).ok, true);
c = await C.computeOrderCommission(lines, ids, { at: later() });
check("A earns $0.05 x3 on B (per referral)", c.refAmt, 0.15);
check("nobody referred C - no referral rate", (await R.setSponsorRate("RAP3", "0.05")).ok, false);
check("B's rate on PRA1", (await R.setPracticeRate("RAP2", "PRA1", "2.00", { by: "test", practiceName: "Practice One" })).ok, true);
c = await C.computeOrderCommission(lines, ids, { at: later() });
check("B earns $2.00 x3 on PRA1", c.repAmt, 6);
c = await C.computeOrderCommission(lines, { practiceId: "PRA1" }, { at: t0 });
check("old PRA1 order keeps the old rate", c.repAmt, 3);
check("B's PRA1 rate back to rep rate", (await R.setPracticeRate("RAP2", "PRA1", "default")).to, null);
c = await C.computeOrderCommission(lines, ids, { at: later() });
check("B back on rep rate on PRA1", c.repAmt, 3.3);

const row = await R.saveRepRow({ type: "referred", rep: "RAP1", child: "RAP2", name: "Rep B2", active: false, rate: "0.10" }, { by: "Finance dashboard (Exec)" });
check("edit referred row", row.ok, true);
const b2 = await M.SalesRep.findOne({ repId: "RAP2" }).lean();
check("referred rep renamed", b2.name, "Rep B2");
check("referred rep inactive", b2.active, false);
check("referred rate saved", b2.sponsorRate, 0.1);
check("edit refuses a bad rate, saves nothing",
  (await R.saveRepRow({ type: "referred", rep: "RAP1", child: "RAP2", name: "Changed", rate: "abc" })).ok, false);
check("name untouched after refused save", (await M.SalesRep.findOne({ repId: "RAP2" }).lean()).name, "Rep B2");
check("edit wrong referrer refused", (await R.saveRepRow({ type: "referred", rep: "RAP3", child: "RAP2", name: "x" })).ok, false);
check("edit rep row", (await R.saveRepRow({ type: "rep", rep: "RAP3", name: "Rep C", active: true, rate: "1.25" })).ok, true);
check("rep direct rate saved", (await M.SalesRep.findOne({ repId: "RAP3" }).lean()).directRate, 1.25);
check("blank rate refused", (await R.saveRepRow({ type: "rep", rep: "RAP3", name: "Rep C", rate: "" })).ok, false);
check("edit practice row", (await R.saveRepRow({ type: "practice", rep: "RAP3", practice: "PRA9", rate: "0.90" })).ok, true);
check("practice rate saved", (await M.SalesRep.findOne({ repId: "RAP3" }).lean()).practiceRates?.PRA9, 0.9);

const hRef = await R.rowHistory({ type: "referred", repId: "RAP1", childId: "RAP2" });
check("referred history ok", hRef.ok, true);
check("referred history: added under A", hRef.rows.some((h) => h.type === "Sales Rep Added"), true);
check("referred history: rate update", hRef.rows.some((h) => h.type === "Commission Update" && /\$0\.05 to \$0\.10/.test(h.details)), true);
check("referred history: status change", hRef.rows.some((h) => /Status changed from Active to Inactive/.test(h.details)), true);
check("changed-by shows the person", hRef.rows.find((h) => h.type === "Commission Update")?.by, "Exec");
const hPrac = await R.rowHistory({ type: "practice", repId: "RAP3", practiceId: "PRA9" });
check("practice history: set to $0.90", hPrac.rows[0]?.details, "Commission / Unit set to $0.90.");
const hRep = await R.rowHistory({ type: "rep", repId: "RAP3" });
check("rep history: added", hRep.rows.some((h) => h.type === "Sales Rep Added"), true);
check("rep history: own rate", hRep.rows.some((h) => /Commission \/ Unit set to \$1\.25/.test(h.details)), true);
await R.saveRepRow({ type: "referred", rep: "RAP1", child: "RAP2", active: true }); // back to active for the checks below

/* ---- rep dashboard: Earnings table, row history, commission updates ---- */
const E = await import("../app/services/rep-earnings.server.js");
const eA = await E.repEarnings({ rep: "RAP1" });
check("earnings ok", eA.ok, true);
const refB = eA.referred.rows.find((r) => r.id === "RAP2");
check("A's referred row for B", !!refB, true);
check("B's units in A's referral row", refB?.units, 3);
check("A's referral earnings on B", refB?.earnings, 0.6);
const eB = await E.repEarnings({ rep: "RAP2" });
const pr1 = eB.direct.rows.find((r) => r.id === "PRA1");
check("B's practice row PRA1", pr1?.units, 3);
check("B's direct earnings on PRA1", pr1?.earnings, 3);
check("future window has no units", (await E.repEarnings({ rep: "RAP2", from: Date.now() + 86400000 })).direct.units, 0);
const hB = await E.repEarningHistory({ rep: "RAP1", type: "referred", id: "RAP2" });
check("referred history ok", hB.ok, true);
check("referred history starts with the add", hB.rows[hB.rows.length - 1]?.type, "start");
check("referred history has rate changes", hB.rows.some((r) => r.type === "change"), true);
check("history of someone else's referral refused", (await E.repEarningHistory({ rep: "RAP3", type: "referred", id: "RAP2" })).ok, false);
const hP = await E.repEarningHistory({ rep: "RAP2", type: "practice", id: "PRA1" });
check("practice history shows the $2.00 change", hP.rows.some((r) => r.to === 2), true);
const upA = await E.repCommissionUpdates({ rep: "RAP1" });
check("A has unseen commission updates", upA.notices.length > 0, true);
check("updates point at B's referral", upA.targets.some((t) => t.key === "referred:RAP2"), true);
await R.markNoticesSeen("RAP1", upA.notices);
check("updates cleared once seen", (await E.repCommissionUpdates({ rep: "RAP1" })).targets.length, 0);

/* ---- PT Profit report ---- */
const p = await ptProfitSummary();
check("profit report total", p.total.profit, 14.4);
check("profit report orders", p.total.orders, 1);

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log("  FAIL " + f);
await M.default?.disconnect?.();
await mongo.stop();
process.exit(failures.length ? 1 : 0);
