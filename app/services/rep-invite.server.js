import { connectDb } from "../db.server";
import { RepInvite, SalesRep } from "../models/index.server";
import { fillTemplate, sendEmail } from "./brevo.server";
import { ensureReferralCode } from "./rep-rates.server";
import { INVITE_BODY_DEFAULT, INVITE_SUBJECT_DEFAULT, getSettings } from "./settings.server";

/* "Email Link" on the Sales Agent dashboard's Referral Link card: the agent
   types a first name + email and the app emails that person an invite to
   apply, with the agent's referral sign-up link (Settings / Emails page:
   REP_INVITE_SUBJECT / REP_INVITE_BODY). Sent from the store's address,
   reply-to the agent. Every attempt is kept in rep_invites. */

const DAY = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DEFAULT_SIGNUP_PATH = "/pages/rep-signup";

const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const oneLine = (s) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim();

/** The store's public address - the origin of the welcome email's login link. */
function storeOrigin(cfg) {
  try {
    return new URL(String(cfg.WELCOME_EMAIL_LINK || "").trim()).origin;
  } catch {
    return "";
  }
}

/** The theme's sign-up page path (section setting). Only a plain same-site path is accepted. */
function signupPath(raw) {
  const p = String(raw || "").trim().split(/[?#]/)[0];
  return /^\/(?!\/)[A-Za-z0-9\-_/]{1,120}$/.test(p) ? p : DEFAULT_SIGNUP_PATH;
}

/** The referral sign-up link for one agent, or "" when the store address isn't set. */
export async function referralLinkFor(repId, rawPath, cfg) {
  const origin = storeOrigin(cfg || (await getSettings()));
  if (!origin) return "";
  const code = await ensureReferralCode(repId);
  if (!code) return "";
  return `${origin}${signupPath(rawPath)}?ref=${encodeURIComponent(code)}`;
}

/** Sends one invite. Returns { ok, message } or { ok: false, error, field? }. */
export async function sendRepInvite({ repId, firstName, email, signupPath: rawPath }) {
  repId = String(repId || "").trim();
  firstName = oneLine(firstName).slice(0, 60);
  email = String(email || "").trim().toLowerCase();
  if (!firstName) return { ok: false, field: "firstName", error: "Enter their first name." };
  if (!EMAIL_RE.test(email) || email.length > 200) return { ok: false, field: "email", error: "Enter a valid email address." };

  await connectDb();
  const rep = await SalesRep.findOne({ repId, active: { $ne: false } }, { repId: 1, name: 1, email: 1 }).lean();
  if (!rep) return { ok: false, error: "Your Sales Agent account was not found." };
  if (email === String(rep.email || "").trim().toLowerCase()) {
    return { ok: false, field: "email", error: "That is your own email address." };
  }
  if (await SalesRep.exists({ email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), active: { $ne: false } })) {
    return { ok: false, field: "email", error: "This person is already a Sales Agent." };
  }

  const cfg = await getSettings();
  const since = new Date(Date.now() - DAY);
  const limit = Math.max(1, Number(cfg.REP_INVITE_DAILY_LIMIT) || 25);
  if ((await RepInvite.countDocuments({ repId, sentAt: { $gte: since } })) >= limit) {
    return { ok: false, error: `You can send up to ${limit} invites a day. Please try again tomorrow.` };
  }
  if (await RepInvite.exists({ repId, email, ok: true, sentAt: { $gte: since } })) {
    return { ok: false, field: "email", error: "You already sent an invite to this address today." };
  }

  const link = await referralLinkFor(repId, rawPath, cfg);
  if (!link) return { ok: false, error: "The invite can't be sent right now. Please copy your link instead." };

  const agentName = oneLine(rep.name) || "Your Protocol Therapeutics Sales Agent";
  const values = { "First Name": firstName, "Referring Sales Agent": agentName, Link: link, "Agent Email": rep.email || "" };
  // the HTML body gets escaped values (names are typed by people); the subject is plain text
  const htmlValues = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, escHtml(v)]));
  let body = String(cfg.REP_INVITE_BODY || "").trim() || INVITE_BODY_DEFAULT;
  if (!/<[a-z][\s\S]*>/i.test(body)) body = body.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
  const subject = oneLine(fillTemplate(String(cfg.REP_INVITE_SUBJECT || "").trim() || INVITE_SUBJECT_DEFAULT, values));

  try {
    await sendEmail({
      to: email,
      subject,
      htmlBody: fillTemplate(body, htmlValues),
      replyTo: rep.email ? { email: rep.email, name: oneLine(rep.name) } : null,
    });
  } catch (err) {
    await RepInvite.create({ repId, email, firstName, ok: false, error: String(err?.message || err).slice(0, 300) });
    return { ok: false, error: "The invite could not be sent. Please try again later, or copy your link instead." };
  }
  await RepInvite.create({ repId, email, firstName, ok: true });
  return { ok: true, message: `Invite sent to ${email}.` };
}
