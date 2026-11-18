import crypto from "node:crypto";
import { connectDb } from "../db.server";
import { Account, RepApplication, SalesRep } from "../models/index.server";
import { fillTemplate, sendEmail, syncRepApplicantToBrevo } from "./brevo.server";
import { tagVal } from "./ids.server";
import { kvSet, logEvent } from "./log.server";
import { createPortalAccount, retryWelcomeEmail } from "./provisioning.server";
import { welcomeLinkForRole } from "../components/welcome-link";
import { repByReferralCode, setReferrer } from "./rep-rates.server";
import { invalidateResponses } from "./response-cache.server";
import {
  APPROVED_BODY_DEFAULT,
  APPROVED_SUBJECT_DEFAULT,
  getSettings,
  isTrue,
  REFERRER_APPROVED_BODY_DEFAULT,
  REFERRER_APPROVED_SUBJECT_DEFAULT,
  REFERRER_REJECT_BODY_DEFAULT,
  REFERRER_REJECT_SUBJECT_DEFAULT,
  REJECT_BODY_DEFAULT,
  REJECT_SUBJECT_DEFAULT,
} from "./settings.server";

/* Sales rep sign-up through a referral link (/pages/rep-signup?ref=CODE).

   1. The page asks `info`: is sign-up open, who referred them, and the terms
      (Settings -> REP_SIGNUP_TERMS) with their version.
   2. The applicant fills the form, then in the 3-step popup reads the terms
      to the end, ticks "I agree" and submits. `submit` stores a Pending
      application with the exact terms text, the time, IP and browser; the
      applicant's full name stands as their electronic acceptance.
      The terms may hold [[placeholders]] (see fillAgreement) - the copy the
      applicant agreed to is stored filled in (signedHtml) and returned to the
      page, which offers it as a PDF download.
      The application is also saved to the applicant's Brevo contact
      (syncRepApplicantToBrevo) and kept in step on approve / reject.
   3. An admin approves (Shopify admin -> Sales reps, or the Finance
      dashboard): that creates the Shopify login + SalesRep on the default
      rates, referred by the link's rep. Reject keeps the record and can
      email the applicant the reason (REP_SIGNUP_REJECT_SUBJECT / _BODY). */

const termsVersion = (text) => crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 12);

/* ------------------------------- validation -------------------------------
   Same rules as the sign-up page (rx-rep-signup.liquid) - keep in step. */
const NAME_RE = /^[A-Za-z][A-Za-z .'-]{0,49}$/;
const CITY_RE = /^[A-Za-z][A-Za-z .'-]{1,59}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const COMPANY_RE = /^[A-Za-z0-9][A-Za-z0-9 &.,'()/#+-]{0,99}$/;
const ADDRESS_RE = /^[A-Za-z0-9#][A-Za-z0-9 #.,'/-]{3,119}$/;
export const WHY_MAX = 500; // "Why I want to be a Sales Agent for Protocol Therapeutics"

export const US_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
/** "tx" / "Texas" -> "TX"; anything else -> "". */
function stateCode(s) {
  const t = String(s || "").trim();
  if (US_STATES[t.toUpperCase()]) return t.toUpperCase();
  const hit = Object.entries(US_STATES).find(([, name]) => name.toLowerCase() === t.toLowerCase());
  return hit ? hit[0] : "";
}
/** US phone -> "555-234-5678", or "" when it is not a valid 10-digit number
 *  (area code and exchange may not start with 0 or 1). */
function usPhone(s) {
  const raw = String(s || "").trim();
  if (!/^[0-9 ()+.-]+$/.test(raw)) return "";
  let d = raw.replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return "";
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Cleans + checks the sign-up form. Returns { v, fields } (fields = errors). */
export function validateSignupFields(p) {
  const clean = (x, max) => String(x || "").trim().replace(/\s+/g, " ").slice(0, max);
  const v = {
    firstName: clean(p.firstName, 60),
    lastName: clean(p.lastName, 60),
    email: String(p.email || "").trim().toLowerCase(),
    phone: String(p.phone || "").trim(),
    company: clean(p.company, 120),
    address: clean(p.address, 140),
    city: clean(p.city, 80),
    state: String(p.state || "").trim(),
    zip: String(p.zip || "").trim(),
    // the long answer keeps its line breaks (control characters dropped)
    whyJoin: String(p.whyJoin || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[^\S\n]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
      .trim(),
  };
  const fields = {};
  if (!v.firstName) fields.firstName = "Enter your first name.";
  else if (!NAME_RE.test(v.firstName)) fields.firstName = "Use letters only (spaces, - . ' allowed), up to 50 characters.";
  if (!v.lastName) fields.lastName = "Enter your last name.";
  else if (!NAME_RE.test(v.lastName)) fields.lastName = "Use letters only (spaces, - . ' allowed), up to 50 characters.";
  if (!v.email) fields.email = "Enter your email address.";
  else if (!EMAIL_RE.test(v.email) || v.email.length > 120 || v.email.includes("..")) fields.email = "Enter a valid email address.";
  const phone = usPhone(v.phone);
  if (!v.phone) fields.phone = "Enter your phone number.";
  else if (!phone) fields.phone = "Enter a valid 10-digit US phone number (XXX-XXX-XXXX).";
  else v.phone = phone;
  if (v.company && !COMPANY_RE.test(v.company)) fields.company = "Use letters, numbers and & . , ' ( ) / # + - only, up to 100 characters.";
  if (!v.whyJoin) fields.whyJoin = "Please tell us why you want to be a Sales Agent.";
  else if (v.whyJoin.length > WHY_MAX) fields.whyJoin = `Please keep this to ${WHY_MAX} characters or fewer.`;
  // The sign-up page no longer asks for an address (it comes with the banking
  // details later) - these stay optional, and are only checked when sent.
  if (v.address && (!ADDRESS_RE.test(v.address) || !/[A-Za-z]/.test(v.address))) {
    fields.address = "Enter a valid street address (4-120 characters, letters, numbers and # . , ' / - only).";
  }
  if (v.city && !CITY_RE.test(v.city)) fields.city = "Use letters only (spaces, - . ' allowed).";
  if (v.state) {
    const st = stateCode(v.state);
    if (!st) fields.state = "Select a US state from the list.";
    else v.state = st;
  }
  if (v.zip && !ZIP_RE.test(v.zip)) fields.zip = "Enter a 5-digit ZIP code (or ZIP+4: XXXXX-XXXX).";
  return { v, fields };
}

/* ------------------------- agreement placeholders -------------------------
   REP_SIGNUP_TERMS can contain these; the sign-up popup previews them filled
   in and the signed copy is stored filled in. Keep in step with fillAgreement
   in rx-rep-signup.liquid (the popup preview).
     [[date]]          execution date (the day signed, US Central time)
     [[agent_name]]    the applicant's first + last name (never the business name)
     [[full_name]] [[first_name]] [[last_name]] [[business_name]]
     [[email]] [[phone]] [[address]]
     [[signature]]     the applicant's full name + "Accepted electronically ..." line */
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
    `<span style="display:block;font:11px/1.4 Arial,Helvetica,sans-serif;color:#4A5562">Accepted electronically ${escHtml(fmtDateTime(when))}</span>` +
    "</span>"
  );
}

export function fillAgreement(terms, v, signedAt) {
  const full = `${v.firstName || ""} ${v.lastName || ""}`.trim();
  const map = {
    date: fmtDate(signedAt),
    agent_name: full, // always the person's name, never the business name (client, 2026-11-18)
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

/* The visitor's address. Sign-ups come in through Shopify's app proxy (and,
   in development, a Cloudflare tunnel), so cf-connecting-ip is the address of
   SHOPIFY's server, the same for every visitor - reading it first made every
   sign-up share one rate limit (2026-11-18). The first entry of
   X-Forwarded-For is the original client when a proxy passes it on; the raw
   headers are kept with each application so this can be checked. */
function clientInfo(request) {
  const h = request?.headers;
  const get = (k) => String(h?.get(k) || "").trim();
  const xff = get("x-forwarded-for");
  const ip = (xff.split(",")[0].trim() || get("x-real-ip") || get("cf-connecting-ip")).slice(0, 200);
  return {
    ip,
    ipHeaders: { xForwardedFor: xff.slice(0, 300), xRealIp: get("x-real-ip").slice(0, 100), cfConnectingIp: get("cf-connecting-ip").slice(0, 100) },
    userAgent: get("user-agent").slice(0, 300),
  };
}

/* No per-address sign-up limit (removed 2026-11-18 at the client's request):
   behind Shopify's app proxy every visitor can arrive from the same address,
   so a limit blocked real applicants. Duplicates are still refused per email,
   and every application waits for approval. */

/** Validates and stores one signed application. Public. */
export async function submitSignup(p, request) {
  const { cfg, terms, version, open } = await signupConfig();
  if (!open) return { ok: false, error: "Sales rep sign-up is not open right now." };

  const { v, fields } = validateSignupFields(p);
  // no typed signature any more: agreeing + submitting under their own name is the acceptance
  v.signatureName = `${v.firstName} ${v.lastName}`.trim();
  const agreed = p.agree === true || String(p.agree) === "true";
  if (!agreed) fields.agree = "You must agree to the Agreement to sign up.";
  if (Object.keys(fields).length) return { ok: false, fields, error: "Please fix the highlighted fields." };
  if (String(p.termsVersion || "") !== version) {
    return { ok: false, termsChanged: true, error: "The Agreement was updated while you were signing. Please read it again and re-sign." };
  }

  await connectDb();
  const { ip, ipHeaders, userAgent } = clientInfo(request);

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
    ipHeaders,
    userAgent,
  });
  invalidateResponses();
  logEvent("sync", v.email, `sales rep sign-up received${referrer ? ` (referred by ${referrer.repId})` : ""}`, { applicationId: String(app._id) });

  // the whole application on the applicant's Brevo contact - best effort
  pushToBrevo(app.toObject(), { referrerName: referrer?.name || "" });

  // tell the team - best effort, the application is already saved
  const to = String(cfg.REP_SIGNUP_NOTIFY_EMAIL || cfg.SALES_EMAIL || "").trim();
  if (to) {
    const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const rows = [
      ["Name", `${v.firstName} ${v.lastName}`],
      ["Email", v.email],
      ["Phone", v.phone],
      ["Business", v.company || "-"],
      ["Why they want to be a Sales Agent", v.whyJoin],
      ["Referred by", referrer ? `${referrer.name || referrer.repId} (${referrer.repId})` : "No referral link"],
      ["Agreed to terms", fmtDateTime(signedAt)],
    ];
    sendEmail({
      to,
      subject: `New sales rep sign-up: ${v.firstName} ${v.lastName}`,
      htmlBody:
        "<p>A new sales rep has signed up and is waiting for approval (Shopify admin &rarr; Rx Portal &rarr; Sales reps).</p>" +
        "<table>" +
        rows.map(([k, val]) => `<tr><td valign="top"><b>${esc(k)}</b></td><td>${esc(val).replace(/\n/g, "<br>")}</td></tr>`).join("") +
        "</table>",
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
    whyJoin: r.whyJoin || "",
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
    rejectEmailSentAt: r.rejectEmailSentAt ? r.rejectEmailSentAt.getTime() : 0,
    rejectEmailError: r.rejectEmailError || "",
    emails: (r.emails || []).map((e) => ({ kind: e.kind, to: e.to, ok: !!e.ok, error: e.error || "", at: e.at ? new Date(e.at).getTime() : 0 })),
    brevoSyncedAt: r.brevoSyncedAt ? r.brevoSyncedAt.getTime() : 0,
    brevoError: r.brevoError || "",
    ts: r.createdAt ? r.createdAt.getTime() : 0,
  }));
}

/* --------------------------------- Brevo -------------------------------- */

/**
 * The "brevo-rep-signups" job (Sync & logs, run by hand): saves EVERY sales
 * agent sign-up to Brevo again - contact attributes + the sign-up list
 * (REP_SIGNUP_BREVO_LIST). For sign-ups made before the list existed, or
 * whose Brevo save failed. One at a time (Brevo rate-limits bursts).
 */
export async function syncAllRepApplicationsToBrevo() {
  await connectDb();
  const apps = await RepApplication.find({}, { termsText: 0, signedHtml: 0 }).sort({ createdAt: 1 }).lean();
  let saved = 0;
  const failed = [];
  for (const app of apps) {
    const res = await pushToBrevo(app);
    if (res?.ok) saved++;
    else if (!res?.skipped) failed.push(`${app.email}: ${res?.error || "failed"}`);
    else return { total: apps.length, saved, skipped: "Brevo sync is off or BREVO_API_KEY is not set" };
  }
  return { total: apps.length, saved, failed: failed.length, errors: failed.slice(0, 5) };
}

/** Saves the application to Brevo and records the outcome on it. Never throws. */
async function pushToBrevo(app, { referrerName } = {}) {
  try {
    let name = referrerName;
    if (name === undefined && app.referrerRepId) {
      name = (await SalesRep.findOne({ repId: app.referrerRepId }, { name: 1 }).lean())?.name || app.referrerRepId;
    }
    const res = await syncRepApplicantToBrevo(app, { referrerName: name || "" });
    if (res.skipped) return res;
    await RepApplication.updateOne(
      { _id: app._id },
      res.ok ? { $set: { brevoSyncedAt: new Date(), brevoError: "" } } : { $set: { brevoError: String(res.error || "failed").slice(0, 300) } },
    );
    return res;
  } catch (err) {
    logEvent("error", app.email, "rep sign-up -> Brevo: " + String(err?.message || err).slice(0, 300), null, false);
    return { ok: false, error: String(err?.message || err) };
  }
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

/* ---------------------------- decision emails ----------------------------
   Approve and Reject each email BOTH people: the applicant (the new Sales
   Agent) and, when they came through a referral link, the Sales Agent who
   referred them. Templates: Settings -> Sales rep sign-up. Every attempt is
   kept on the application (`emails`) and shown to the admin; a failed email
   never undoes the decision. */

/** Fills a Settings template and sends it. A paragraph / line holding [Reason] is dropped when there is no reason.
 *  Also used by the Emails page's "Send test" (subjectPrefix "[Test] "). */
export async function sendTemplated(cfg, { to, subjectKey, bodyKey, subjectFallback, bodyFallback, values, subjectPrefix = "" }) {
  const reason = values.Reason || "";
  const htmlValues = { ...values, Reason: escHtml(reason).replace(/\r?\n/g, "<br>") };
  let body = String(cfg[bodyKey] || "").trim() || bodyFallback;
  if (!reason) {
    body = body
      .replace(/<!--reason-->[\s\S]*?<!--\/reason-->/gi, "") // the template's Reason panel
      .replace(/<p[^>]*>(?:(?!<\/p>)[\s\S])*\[Reason\][\s\S]*?<\/p>/gi, "")
      .replace(/^.*\[Reason\].*$\n?/gm, "");
  }
  if (!/<[a-z][\s\S]*>/i.test(body)) body = body.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
  const subject = fillTemplate(String(cfg[subjectKey] || "").trim() || subjectFallback, values);
  await sendEmail({ to, subject: subjectPrefix + subject, htmlBody: fillTemplate(body, htmlValues) });
}

/** The referring Sales Agent of an application: { repId, name, firstName, email } or null. */
async function referrerOf(app) {
  if (!app.referrerRepId) return null;
  const r = await SalesRep.findOne({ repId: app.referrerRepId }, { repId: 1, name: 1, email: 1, customerId: 1 }).lean();
  if (!r) return null;
  let email = String(r.email || "").trim();
  if (!email && r.customerId) email = (await Account.findOne({ customerId: r.customerId }, { email: 1 }).lean())?.email || "";
  const name = String(r.name || r.repId).trim();
  return { repId: r.repId, name, firstName: name.split(/\s+/)[0] || name, email };
}

/** Sends one decision email and records the outcome. Returns { ok, to, error }. */
async function decisionEmail(app, kind, to, send) {
  const at = new Date();
  if (!to) {
    const out = { kind, to: "", ok: false, error: "no email address on file", at };
    await RepApplication.updateOne({ _id: app._id }, { $push: { emails: out } });
    return out;
  }
  try {
    await send();
    const out = { kind, to, ok: true, error: "", at };
    await RepApplication.updateOne({ _id: app._id }, { $push: { emails: out } });
    return out;
  } catch (err) {
    const out = { kind, to, ok: false, error: String(err?.message || err).slice(0, 300), at };
    await RepApplication.updateOne({ _id: app._id }, { $push: { emails: out } });
    return out;
  }
}

/** "x@y emailed; referrer a@b could not be emailed (why)". */
function emailSummary(results) {
  return results
    .map((r) => (r.ok ? `${r.label} (${r.to}) emailed` : `${r.label} could not be emailed${r.to ? ` (${r.to})` : ""}: ${r.error}`))
    .join("; ");
}

/**
 * One decision email, ready to send: { to, args } for sendTemplated.
 *   approved           -> the new Sales Agent (replaces the welcome email)
 *   referrer-approved  -> the agent who referred them
 *   rejected           -> the applicant (with the reason)
 *   referrer-rejected  -> the agent who referred them (with the reason)
 * Returns null when it does not apply (no referrer).
 */
function decisionEmailSpec(app, kind, cfg, referrer) {
  const contact = String(cfg.REP_SIGNUP_NOTIFY_EMAIL || cfg.SALES_EMAIL || "").trim();
  const name = `${app.firstName || ""} ${app.lastName || ""}`.trim();
  const link = welcomeLinkForRole(cfg.WELCOME_EMAIL_LINK, "Sales Rep");
  const reason = String(app.reviewNote || "");
  const applicant = { "First Name": app.firstName || "", "Last Name": app.lastName || "", Name: name, Email: app.email || "", "Contact Email": contact };
  const aboutAgent = referrer && {
    "First Name": referrer.firstName, Name: referrer.name, "Agent Name": name, "Agent First Name": app.firstName || "", "Contact Email": contact,
  };
  switch (kind) {
    case "approved":
      return {
        to: app.email,
        args: {
          subjectKey: "REP_SIGNUP_APPROVED_SUBJECT", bodyKey: "REP_SIGNUP_APPROVED_BODY",
          subjectFallback: APPROVED_SUBJECT_DEFAULT, bodyFallback: APPROVED_BODY_DEFAULT,
          values: { ...applicant, Link: link, "Referrer Name": referrer?.name || "" },
        },
      };
    case "referrer-approved":
      return referrer && {
        to: referrer.email,
        args: {
          subjectKey: "REP_SIGNUP_REFERRER_APPROVED_SUBJECT", bodyKey: "REP_SIGNUP_REFERRER_APPROVED_BODY",
          subjectFallback: REFERRER_APPROVED_SUBJECT_DEFAULT, bodyFallback: REFERRER_APPROVED_BODY_DEFAULT,
          values: { ...aboutAgent, Link: link },
        },
      };
    case "rejected":
      return {
        to: app.email,
        args: {
          subjectKey: "REP_SIGNUP_REJECT_SUBJECT", bodyKey: "REP_SIGNUP_REJECT_BODY",
          subjectFallback: REJECT_SUBJECT_DEFAULT, bodyFallback: REJECT_BODY_DEFAULT,
          values: { ...applicant, Reason: reason },
        },
      };
    case "referrer-rejected":
      return referrer && {
        to: referrer.email,
        args: {
          subjectKey: "REP_SIGNUP_REFERRER_REJECT_SUBJECT", bodyKey: "REP_SIGNUP_REFERRER_REJECT_BODY",
          subjectFallback: REFERRER_REJECT_SUBJECT_DEFAULT, bodyFallback: REFERRER_REJECT_BODY_DEFAULT,
          values: { ...aboutAgent, Reason: reason },
        },
      };
    default:
      return null;
  }
}

/** Sends one decision email, records it, and returns the result with a label for messages. */
async function sendDecision(app, kind, cfg, referrer) {
  const spec = decisionEmailSpec(app, kind, cfg, referrer);
  if (!spec) return null;
  const out = await decisionEmail(app, kind, spec.to, () => sendTemplated(cfg, { to: spec.to, ...spec.args }));
  const name = `${app.firstName || ""} ${app.lastName || ""}`.trim();
  const label = kind.startsWith("referrer-") ? `referrer ${referrer.name}` : name || "the applicant";
  // bookkeeping that depends on the email having gone out
  if (kind === "rejected") {
    await RepApplication.updateOne(
      { _id: app._id },
      out.ok ? { $set: { rejectEmailSentAt: new Date(), rejectEmailError: "" } } : { $set: { rejectEmailError: out.error } },
    );
  }
  return { ...out, label };
}

/**
 * Approve: creates the Sales Agent login on the default rates, referred by
 * the link's agent. Instead of the usual welcome email the new agent gets the
 * approval email (same login link); should that fail, the welcome email is
 * sent as before. The referring agent is emailed too.
 */
export async function approveApplication(id, { by = "" } = {}) {
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
    sendWelcome: "false", // the approval email below is the welcome
  });
  if (!res.ok) {
    await RepApplication.updateOne({ _id: app._id }, { $set: { status: "Pending" } });
    return { ok: false, error: res.error || "Could not create the account." };
  }
  const repId = tagVal(res.tags || [], "rep_id:");
  const customerId = String(res.customerId || "");
  await SalesRep.updateOne({ repId }, { $set: { phone: app.phone, applicationId: String(app._id) } });
  let referrerNote = "";
  if (app.referrerRepId) {
    const r = await setReferrer(repId, app.referrerRepId, { by, note: "Sales agent sign-up approved" });
    if (!r.ok) referrerNote = ` Referrer not set: ${r.error}`;
  }
  await RepApplication.updateOne(
    { _id: app._id },
    { $set: { status: "Approved", repId, customerId, reviewedBy: String(by), reviewedAt: new Date() } },
  );
  invalidateResponses();
  logEvent("sync", app.email, `sales agent sign-up approved -> ${repId} by ${by || "?"}`);

  // ---- emails: the new agent (replaces the welcome email) + the referrer
  const cfg = await getSettings();
  const referrer = await referrerOf(app);
  const name = `${app.firstName || ""} ${app.lastName || ""}`.trim();
  const mine = await sendDecision(app, "approved", cfg, referrer);
  if (mine.ok) {
    // it was the welcome email - never send the standard one on top
    await kvSet("welcome_sent:" + app.email.toLowerCase(), new Date().toISOString());
    if (customerId) {
      await Account.updateOne(
        { customerId },
        { $set: { welcomeEmailSentAt: new Date(), welcomeDueAt: null, welcomeResult: "sent (sales agent approval email)" } },
      );
    }
  } else if (customerId) {
    // fall back to the standard welcome email so they still get their login link
    await retryWelcomeEmail(customerId).catch(() => {});
  }
  const results = [mine, await sendDecision(app, "referrer-approved", cfg, referrer)].filter(Boolean);

  pushToBrevo(await RepApplication.findById(app._id).lean());
  const allOk = results.every((r) => r.ok);
  return {
    ok: true,
    warning: !allOk,
    repId,
    message:
      `Approved - ${name} is now ${repId}.${referrerNote} ${emailSummary(results)}.` +
      (mine.ok ? "" : " The standard welcome email (with the login link) was queued instead."),
  };
}

/**
 * Reject: keeps the record. With `notify`, the applicant AND the agent who
 * referred them are emailed the reason (Settings -> REP_SIGNUP_REJECT_* and
 * REP_SIGNUP_REFERRER_REJECT_*); the reason is then required. The reason and
 * the decision always go to Brevo.
 */
export async function rejectApplication(id, { by = "", note = "", notify = false } = {}) {
  await connectDb();
  const reason = String(note || "").trim().slice(0, 500);
  if (notify && !reason) return { ok: false, error: "Enter the reason - it is included in the rejection emails." };
  const res = await RepApplication.updateOne(
    { _id: id, status: "Pending" },
    { $set: { status: "Rejected", reviewedBy: String(by), reviewedAt: new Date(), reviewNote: reason } },
  );
  if (!res.modifiedCount) return { ok: false, error: "Only a pending sign-up can be rejected." };
  invalidateResponses();
  logEvent("sync", String(id), `sales agent sign-up rejected by ${by || "?"}`);
  const app = await RepApplication.findById(id).lean();

  if (!notify) {
    pushToBrevo(app);
    return { ok: true, message: "Sign-up rejected (no emails sent)." };
  }
  const cfg = await getSettings();
  const referrer = await referrerOf(app);
  const results = [
    await sendDecision(app, "rejected", cfg, referrer),
    await sendDecision(app, "referrer-rejected", cfg, referrer),
  ].filter(Boolean);

  pushToBrevo(await RepApplication.findById(app._id).lean());
  const allOk = results.every((r) => r.ok);
  return { ok: true, warning: !allOk, message: `Sign-up rejected - ${emailSummary(results)}.` };
}

/**
 * "Resend failed emails": sends again every decision email of an approved /
 * rejected sign-up whose LAST attempt failed. The new agent's approval email
 * is not resent - when it failed, the standard welcome email (with the same
 * login link) already went out instead.
 */
export async function resendFailedDecisionEmails(id) {
  await connectDb();
  const app = await RepApplication.findById(id).lean();
  if (!app) return { ok: false, error: "Sign-up not found." };
  const last = {};
  for (const e of app.emails || []) last[e.kind] = e; // kept in send order - the last one wins
  const kinds = Object.keys(last).filter((k) => !last[k].ok && k !== "approved");
  if (!kinds.length) return { ok: true, message: "No failed emails to resend." };
  const cfg = await getSettings();
  const referrer = await referrerOf(app);
  const results = [];
  for (const kind of kinds) {
    const r = await sendDecision(app, kind, cfg, referrer);
    if (r) results.push(r);
  }
  invalidateResponses();
  const allOk = results.every((r) => r.ok);
  return { ok: allOk, warning: !allOk, message: `Resent - ${emailSummary(results)}.` };
}

