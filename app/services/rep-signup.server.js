import crypto from "node:crypto";
import { connectDb } from "../db.server";
import { Account, RepApplication, SalesRep } from "../models/index.server";
import { sendEmail } from "./brevo.server";
import { tagVal } from "./ids.server";
import { kvGet, kvSet, logEvent } from "./log.server";
import { createPortalAccount } from "./provisioning.server";
import { repByReferralCode, setReferrer } from "./rep-rates.server";
import { invalidateResponses } from "./response-cache.server";
import { getSettings, isTrue } from "./settings.server";

/* Sales rep sign-up through a referral link (/pages/rep-signup?ref=CODE).

   1. The page asks `info`: is sign-up open, who referred them, and the terms
      (Settings -> REP_SIGNUP_TERMS) with their version.
   2. The applicant fills the form, then in the 4-step popup reads the terms,
      ticks "I agree" and types their full legal name as the signature.
      `submit` stores a Pending application with the exact terms text, the
      signature, time, IP and browser.
      The terms may hold [[placeholders]] (see fillAgreement) - the copy the
      applicant signed is stored filled in (signedHtml) and returned to the
      page, which offers it as a PDF download.
   3. An admin approves (Shopify admin -> Sales reps, or the Finance
      dashboard): that creates the Shopify login + SalesRep on the default
      rates, referred by the link's rep. Reject keeps the record. */

const termsVersion = (text) => crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 12);
const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
const NAME_RE = /^[A-Za-z][A-Za-z .'-]{0,49}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;

/* ------------------------- agreement placeholders -------------------------
   REP_SIGNUP_TERMS can contain these; the sign-up popup previews them filled
   in and the signed copy is stored filled in. Keep in step with fillAgreement
   in rx-rep-signup.liquid (the popup preview).
     [[date]]          execution date (the day signed, US Central time)
     [[agent_name]]    business name, or the full name when there is none
     [[full_name]] [[first_name]] [[last_name]] [[business_name]]
     [[email]] [[phone]] [[address]]
     [[signature]]     the typed signature + "Electronically signed ..." line */
const escHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const TZ = "America/Chicago";
const fmtDate = (d) => d.toLocaleDateString("en-US", { timeZone: TZ, year: "numeric", month: "long", day: "numeric" });
const fmtDateTime = (d) =>
  d.toLocaleString("en-US", { timeZone: TZ, year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";

export const fullAddress = (v) =>
  [v.address, v.city, [v.state, v.zip].filter(Boolean).join(" ")].map((x) => String(x || "").trim()).filter(Boolean).join(", ");

export function signatureHtml(name, when) {
  return (
    '<span style="display:inline-block;line-height:1.15">' +
    `<span class="pt-signature" style="font-family:'Dancing Script','Segoe Script','Brush Script MT',cursive;font-size:30px;font-weight:600;color:#143056">${escHtml(name)}</span>` +
    `<span style="display:block;font:11px/1.4 Arial,Helvetica,sans-serif;color:#4A5562">Electronically signed ${escHtml(fmtDateTime(when))}</span>` +
    "</span>"
  );
}

export function fillAgreement(terms, v, signedAt) {
  const full = `${v.firstName || ""} ${v.lastName || ""}`.trim();
  const map = {
    date: fmtDate(signedAt),
    agent_name: v.company || full,
    full_name: full,
    first_name: v.firstName,
    last_name: v.lastName,
    business_name: v.company,
    email: v.email,
    phone: v.phone,
    address: fullAddress(v),
  };
  return String(terms || "").replace(/\[\[\s*([a-z_]+)\s*\]\]/gi, (m, key) => {
    const k = key.toLowerCase();
    if (k === "signature") return signatureHtml(v.signatureName || full, signedAt);
    return k in map ? escHtml(map[k]) : m;
  });
}

async function signupConfig() {
  const cfg = await getSettings();
  const terms = String(cfg.REP_SIGNUP_TERMS || "").trim();
  return {
    cfg,
    terms,
    version: terms ? termsVersion(terms) : "",
    open: isTrue(cfg.REP_SIGNUP_ENABLED) && !!terms,
  };
}

/** What the sign-up page shows. Public. */
export async function signupInfo({ ref = "" }) {
  const { terms, version, open } = await signupConfig();
  const referrer = ref ? await repByReferralCode(ref) : null;
  return {
    ok: true,
    open,
    closedReason: open ? "" : "Sales rep sign-up is not open right now. Please contact Protocol Therapeutics.",
    referrer: referrer ? { name: referrer.name || "" } : null,
    refInvalid: !!ref && !referrer,
    terms: open ? terms : "",
    termsVersion: open ? version : "",
  };
}

function clientInfo(request) {
  const h = request?.headers;
  const ip = String(h?.get("cf-connecting-ip") || h?.get("x-forwarded-for") || h?.get("x-real-ip") || "").slice(0, 200);
  return { ip, userAgent: String(h?.get("user-agent") || "").slice(0, 300) };
}

/** Validates and stores one signed application. Public. */
export async function submitSignup(p, request) {
  const { cfg, terms, version, open } = await signupConfig();
  if (!open) return { ok: false, error: "Sales rep sign-up is not open right now." };

  const v = {
    firstName: String(p.firstName || "").trim(),
    lastName: String(p.lastName || "").trim(),
    email: String(p.email || "").trim().toLowerCase(),
    phone: String(p.phone || "").trim(),
    company: String(p.company || "").trim().slice(0, 100),
    address: String(p.address || "").trim().replace(/\s+/g, " ").slice(0, 120),
    city: String(p.city || "").trim().replace(/\s+/g, " ").slice(0, 60),
    state: String(p.state || "").trim().slice(0, 50),
    zip: String(p.zip || "").trim(),
    signatureName: String(p.signatureName || "").trim().replace(/\s+/g, " "),
  };
  const fields = {};
  if (!NAME_RE.test(v.firstName)) fields.firstName = "Enter your first name (letters only).";
  if (!NAME_RE.test(v.lastName)) fields.lastName = "Enter your last name (letters only).";
  if (!EMAIL_RE.test(v.email) || v.email.length > 120) fields.email = "Enter a valid email address.";
  const digits = v.phone.replace(/\D/g, "");
  if (!(digits.length === 10 || (digits.length === 11 && digits[0] === "1")) || !/^[0-9 ()+.-]+$/.test(v.phone)) {
    fields.phone = "Enter a valid 10-digit phone number.";
  }
  if (v.address.length < 3) fields.address = "Enter your street address.";
  if (!v.city) fields.city = "Enter your city.";
  if (!v.state) fields.state = "Enter your state.";
  if (!ZIP_RE.test(v.zip)) fields.zip = "Enter a 5-digit ZIP code.";
  const agreed = p.agree === true || String(p.agree) === "true";
  if (!agreed) fields.agree = "You must agree to the Terms & Conditions to sign up.";
  if (!v.signatureName) fields.signatureName = "Type your full legal name to sign.";
  else if (norm(v.signatureName) !== norm(`${v.firstName} ${v.lastName}`)) {
    fields.signatureName = "Your signature must match your first and last name exactly.";
  }
  if (Object.keys(fields).length) return { ok: false, fields, error: "Please fix the highlighted fields." };
  if (String(p.termsVersion || "") !== version) {
    return { ok: false, termsChanged: true, error: "The Terms & Conditions were updated while you were signing. Please read them again and re-sign." };
  }

  await connectDb();
  const { ip, userAgent } = clientInfo(request);
  // at most 5 sign-ups an hour from one connection
  const rlKey = "repsignup:" + (ip || "unknown");
  const count = Number((await kvGet(rlKey)) || 0);
  if (count >= 5) return { ok: false, error: "Too many sign-ups from this connection. Please try again later." };
  await kvSet(rlKey, count + 1, 3600);

  if (await Account.exists({ email: v.email })) {
    return { ok: false, fields: { email: "An account with this email already exists. Please log in instead." }, error: "This email is already registered." };
  }
  if (await RepApplication.exists({ email: v.email, status: "Pending" })) {
    return { ok: false, fields: { email: "A sign-up with this email is already waiting for approval." }, error: "Already submitted." };
  }

  const referrer = p.ref ? await repByReferralCode(p.ref) : null;
  const signedAt = new Date();
  const signedHtml = fillAgreement(terms, v, signedAt);
  const app = await RepApplication.create({
    ...v,
    status: "Pending",
    referrerRepId: referrer?.repId || "",
    referralCode: referrer ? String(p.ref).trim().toUpperCase() : "",
    agreed: true,
    signedAt,
    termsVersion: version,
    termsText: terms,
    signedHtml,
    ip,
    userAgent,
  });
  invalidateResponses();
  logEvent("sync", v.email, `sales rep sign-up received${referrer ? ` (referred by ${referrer.repId})` : ""}`, { applicationId: String(app._id) });

  // tell the team - best effort, the application is already saved
  const to = String(cfg.REP_SIGNUP_NOTIFY_EMAIL || cfg.SALES_EMAIL || "").trim();
  if (to) {
    const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const rows = [
      ["Name", `${v.firstName} ${v.lastName}`],
      ["Email", v.email],
      ["Phone", v.phone],
      ["Business", v.company || "-"],
      ["Address", fullAddress(v) || "-"],
      ["Referred by", referrer ? `${referrer.name || referrer.repId} (${referrer.repId})` : "No referral link"],
      ["Signed", `${v.signatureName}, ${fmtDateTime(signedAt)}`],
    ];
    sendEmail({
      to,
      subject: `New sales rep sign-up: ${v.firstName} ${v.lastName}`,
      htmlBody:
        "<p>A new sales rep has signed up and is waiting for approval (Shopify admin &rarr; Rx Portal &rarr; Sales reps).</p>" +
        "<table>" + rows.map(([k, val]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(val)}</td></tr>`).join("") + "</table>",
    }).catch(() => {});
  }
  return {
    ok: true,
    message: "Your referral registration has been received and is now under review. You will receive an email with next steps shortly.",
    referrerName: referrer ? referrer.name || "" : "",
    // the signed agreement, for the page's "Download PDF"
    signedHtml,
    fileName: `Protocol Therapeutics - Sales Agreement - ${v.firstName} ${v.lastName}.pdf`.replace(/[\\/:*?"<>|]+/g, ""),
  };
}

/* --------------------------------- admin -------------------------------- */

export async function listApplications({ status = "", limit = 200 } = {}) {
  await connectDb();
  const q = status ? { status } : {};
  const rows = await RepApplication.find(q, { termsText: 0, signedHtml: 0 }).sort({ createdAt: -1 }).limit(limit).lean();
  const refIds = [...new Set(rows.map((r) => r.referrerRepId).filter(Boolean))];
  const reps = refIds.length ? await SalesRep.find({ repId: { $in: refIds } }, { repId: 1, name: 1 }).lean() : [];
  const nameOf = Object.fromEntries(reps.map((r) => [r.repId, r.name || r.repId]));
  return rows.map((r) => ({
    id: String(r._id),
    status: r.status,
    name: `${r.firstName} ${r.lastName}`.trim(),
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    phone: r.phone,
    company: r.company,
    state: r.state,
    address: fullAddress(r),
    referrerRepId: r.referrerRepId,
    referrerName: r.referrerRepId ? nameOf[r.referrerRepId] || r.referrerRepId : "",
    signatureName: r.signatureName,
    signedAt: r.signedAt ? r.signedAt.getTime() : 0,
    termsVersion: r.termsVersion,
    ip: r.ip,
    repId: r.repId,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt ? r.reviewedAt.getTime() : 0,
    reviewNote: r.reviewNote,
    ts: r.createdAt ? r.createdAt.getTime() : 0,
  }));
}

/** The agreement an application signed: the filled-in, signed copy when
 *  there is one, else the exact terms text it was signed against. */
export async function applicationTerms(id) {
  await connectDb();
  const r = await RepApplication.findById(id, { termsText: 1, signedHtml: 1, termsVersion: 1, signatureName: 1, signedAt: 1 }).lean();
  return r
    ? { ok: true, terms: r.signedHtml || r.termsText, version: r.termsVersion, signatureName: r.signatureName, signedAt: r.signedAt }
    : { ok: false, error: "Not found." };
}

/**
 * Approve: creates the Sales Rep login (welcome email as for any new
 * account), on the default rates, referred by the link's rep.
 */
export async function approveApplication(id, { by = "", sendWelcome = true } = {}) {
  await connectDb();
  const app = await RepApplication.findById(id).lean();
  if (!app) return { ok: false, error: "Sign-up not found." };
  if (app.status !== "Pending") return { ok: false, error: `This sign-up is already ${app.status.toLowerCase()}.` };
  // claim it so a double click cannot create two accounts
  const claimed = await RepApplication.updateOne({ _id: app._id, status: "Pending" }, { $set: { status: "Approving" } });
  if (!claimed.modifiedCount) return { ok: false, error: "This sign-up is already being processed." };

  const res = await createPortalAccount({
    role: "Sales Rep",
    firstName: app.firstName,
    lastName: app.lastName,
    email: app.email,
    sendWelcome: String(sendWelcome),
  });
  if (!res.ok) {
    await RepApplication.updateOne({ _id: app._id }, { $set: { status: "Pending" } });
    return { ok: false, error: res.error || "Could not create the account." };
  }
  const repId = tagVal(res.tags || [], "rep_id:");
  await SalesRep.updateOne({ repId }, { $set: { phone: app.phone, applicationId: String(app._id) } });
  let referrerNote = "";
  if (app.referrerRepId) {
    const r = await setReferrer(repId, app.referrerRepId, { by, note: "Sales rep sign-up approved" });
    if (!r.ok) referrerNote = ` Referrer not set: ${r.error}`;
  }
  await RepApplication.updateOne(
    { _id: app._id },
    { $set: { status: "Approved", repId, customerId: String(res.customerId || ""), reviewedBy: String(by), reviewedAt: new Date() } },
  );
  invalidateResponses();
  logEvent("sync", app.email, `sales rep sign-up approved -> ${repId} by ${by || "?"}`);
  return { ok: true, repId, message: `Approved - ${app.firstName} ${app.lastName} is now ${repId}.${referrerNote}` };
}

export async function rejectApplication(id, { by = "", note = "" } = {}) {
  await connectDb();
  const res = await RepApplication.updateOne(
    { _id: id, status: "Pending" },
    { $set: { status: "Rejected", reviewedBy: String(by), reviewedAt: new Date(), reviewNote: String(note || "").slice(0, 500) } },
  );
  if (!res.modifiedCount) return { ok: false, error: "Only a pending sign-up can be rejected." };
  invalidateResponses();
  logEvent("sync", String(id), `sales rep sign-up rejected by ${by || "?"}`);
  return { ok: true, message: "Sign-up rejected." };
}
