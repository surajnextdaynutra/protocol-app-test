/* Smoke test of the Sales Agent "Email Link" invite (services/rep-invite.server.js)
   against a throw-away in-memory MongoDB. Brevo is stubbed - nothing is sent.

     npx vite-node -c tools/vite.smoke.config.js tools/smoke-invite.mjs */

import { MongoMemoryServer } from "mongodb-memory-server";

const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
Object.assign(process.env, {
  MONGODB_URI: mongo.getUri(),
  MONGODB_DB: "rx_smoke_invite",
  ENCRYPTION_KEY: "smoke-test-encryption-key-0123456789",
  SHOPIFY_API_KEY: "smoke-key",
  SHOPIFY_API_SECRET: "smoke-secret",
  SHOPIFY_APP_URL: "https://rx.example.com",
  SHOPIFY_SHOP: "smoke-test.myshopify.com",
  SCOPES: "read_orders",
  RX_SCHEDULER: "off",
});
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("api.brevo.com/v3/smtp/email")) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ messageId: "m" + sent.length }), { status: 201 });
  }
  throw new Error("no network in the smoke test");
};

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (actual === expected) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const { connectDb } = await import("../app/db.server");
const M = await import("../app/models/index.server");
const { setSettings } = await import("../app/services/settings.server");
const { sendRepInvite } = await import("../app/services/rep-invite.server");
await connectDb();

await setSettings({ BREVO_API_KEY: "k", BREVO_SENDER_EMAIL: "noreply@store.test", REP_INVITE_DAILY_LIMIT: "3" });
await M.SalesRep.create({ repId: "RAP1", name: "Agent <One>", email: "agent1@store.test", active: true });
await M.SalesRep.create({ repId: "RAP2", name: "Agent Two", email: "agent2@store.test", active: true });

let r = await sendRepInvite({ repId: "RAP1", firstName: "", email: "x@store.test" });
check("first name required", r.field, "firstName");
r = await sendRepInvite({ repId: "RAP1", firstName: "A", email: "nope" });
check("bad email refused", r.field, "email");
r = await sendRepInvite({ repId: "RAP1", firstName: "A", email: "AGENT1@store.test" });
check("own email refused", r.error, "That is your own email address.");
r = await sendRepInvite({ repId: "RAP1", firstName: "A", email: "agent2@store.test" });
check("existing agent refused", r.error, "This person is already a Sales Agent.");
check("nothing sent yet", sent.length, 0);

r = await sendRepInvite({ repId: "RAP1", firstName: "Sam <b>", email: "Sam@Store.test", signupPath: "//evil.test/x" });
check("invite sent", r.ok, true);
const e = sent[0];
check("to", e.to[0].email, "sam@store.test");
check("reply-to is the agent", e.replyTo && e.replyTo.email, "agent1@store.test");
check("subject", e.subject, "You’re Invited to Become a Protocol Therapeutics Sales Agent!");
const code = (await M.SalesRep.findOne({ repId: "RAP1" }).lean()).referralCode;
check("referral code created", /^[A-Z0-9]{8}$/.test(code), true);
check("link uses store origin + safe path", e.htmlContent.includes(`https://protocoltherapeutics.com/pages/rep-signup?ref=${code}`), true);
check("first name escaped", e.htmlContent.includes("Hi Sam &lt;b&gt;,"), true);
check("agent name escaped", e.htmlContent.includes("Agent &lt;One&gt;"), true);
check("no raw tag", e.htmlContent.includes("Sam <b>"), false);
check("no placeholders left", /\[(First Name|Link|Referring Sales Agent)\]/.test(e.htmlContent), false);

r = await sendRepInvite({ repId: "RAP1", firstName: "Sam", email: "sam@store.test" });
check("same address twice in a day refused", r.field, "email");
r = await sendRepInvite({ repId: "RAP1", firstName: "B", email: "b@store.test", signupPath: "/pages/join" });
check("custom path kept", sent[1].htmlContent.includes(`/pages/join?ref=${code}`), true);
r = await sendRepInvite({ repId: "RAP1", firstName: "C", email: "c@store.test" });
check("3rd invite of 3 sent", r.ok, true);
r = await sendRepInvite({ repId: "RAP1", firstName: "D", email: "d@store.test" });
check("4th invite over the daily limit refused", /up to 3 invites a day/.test(r.error || ""), true);
check("rows logged", await M.RepInvite.countDocuments({ repId: "RAP1" }), 3);

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log("FAIL " + f);
await (await import("../app/db.server")).default.disconnect();
await mongo.stop();
process.exit(failures.length ? 1 : 0);
