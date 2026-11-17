import { getSettings, isTrue } from "./settings.server";
import { READ_ONLY } from "./shopify-admin.server";
import { logEvent } from "./log.server";

/* Email + SMS through Brevo - same REST calls the Apps Script made, without
   the UrlFetch quota. Keys and kill switches live in Settings. */

const BREVO = "https://api.brevo.com/v3";

async function brevoPost(path, apiKey, payload) {
  const res = await fetch(BREVO + path, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Brevo ${path} failed (${res.status}): ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Strips tags for the plain-text fallback of a templated HTML email. */
export function htmlToText(html) {
  return String(html || "")
    .replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, "$2: $1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Fills [name] style placeholders. Unknown tokens are left as they are. */
export function fillTemplate(tpl, values) {
  let out = String(tpl || "");
  for (const [k, v] of Object.entries(values)) {
    out = out.split(`[${k}]`).join(String(v ?? ""));
  }
  return out;
}

/**
 * Sends one transactional email. With `templateId` the Brevo template's own
 * design + subject are used and only `params` are merged in; without it the
 * email is built from subject / htmlBody. Throws on failure (and when email
 * is switched off) so a caller never reports a send that did not happen.
 */
export async function sendEmail({ to, subject, htmlBody, params, templateId }) {
  try {
    return await sendEmailOnce({ to, subject, htmlBody, params, templateId });
  } catch (err) {
    // every failed / blocked email is logged with its reason
    logEvent("email", to, `NOT sent "${subject || `template ${templateId}`}": ${String(err?.message || err).slice(0, 300)}`, null, false);
    throw err;
  }
}

async function sendEmailOnce({ to, subject, htmlBody, params, templateId }) {
  const cfg = await getSettings();
  if (READ_ONLY) throw new Error("Read-only mode (RX_READ_ONLY): email was not sent.");
  if (isTrue(cfg.EMAIL_DISABLED)) {
    throw new Error("Email sending is temporarily disabled (EMAIL_DISABLED).");
  }
  const apiKey = cfg.BREVO_API_KEY;
  if (!apiKey) throw new Error("Set BREVO_API_KEY in Settings.");

  let result;
  if (templateId) {
    result = await brevoPost("/smtp/email", apiKey, {
      to: [{ email: to }],
      templateId: Number(templateId),
      params: params || {},
    });
  } else {
    if (!cfg.BREVO_SENDER_EMAIL) {
      throw new Error("Set BREVO_SENDER_EMAIL in Settings.");
    }
    result = await brevoPost("/smtp/email", apiKey, {
      sender: {
        name: cfg.BREVO_SENDER_NAME || "Protocol Therapeutics",
        email: cfg.BREVO_SENDER_EMAIL,
      },
      to: [{ email: to }],
      subject,
      htmlContent: htmlBody || undefined,
      textContent: htmlToText(htmlBody) || undefined,
    });
  }
  logEvent("email", to, subject || `template ${templateId}`);
  return result;
}

/* One character outside the GSM-7 set (curly quotes, long dashes, …) turns
   the whole SMS into Unicode: 70 characters a part instead of 160, and some
   North American carriers bounce it. The Apps Script templates were plain
   ASCII; edited templates (and pasted text) often are not. */
function gsmSafe(text) {
  return String(text)
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ");
}

/**
 * Sends one SMS. A missing key / phone or the kill switch is a silent skip
 * (returns false) - SMS is always additive, never a reason to fail the caller.
 */
export async function sendSms(phone, message) {
  message = gsmSafe(message);
  const cfg = await getSettings();
  // skipped SMS are logged with the reason (they used to vanish silently)
  const skip = (why) => {
    logEvent("sms", String(phone || "-"), `NOT sent (${why}): ${String(message).slice(0, 120)}`, null, false);
    return false;
  };
  if (READ_ONLY) return skip("read-only mode");
  if (isTrue(cfg.SMS_DISABLED)) return skip("SMS_DISABLED is on");
  const apiKey = cfg.BREVO_API_KEY;
  if (!apiKey) return skip("BREVO_API_KEY not set");

  // Brevo's alphanumeric sender allows only letters/digits, max 11 chars.
  const rawSender = String(cfg.BREVO_SMS_SENDER || "Rx");
  let sender = rawSender.replace(/[^A-Za-z0-9]/g, "");
  if (/[A-Za-z]/.test(sender)) sender = sender.slice(0, 11);
  if (!sender) sender = "Rx";

  const digits = String(phone || "").replace(/[^0-9]/g, "");
  if (!digits) return skip("no phone number");

  try {
    const res = await brevoPost("/transactionalSMS/sms", apiKey, {
      sender,
      recipient: digits,
      content: message,
      type: "transactional",
    });
    // 201 = Brevo ACCEPTED it, not that it was delivered - delivery (or
    // "skipped" / soft bounce) shows up later in Brevo's SMS logs. The
    // messageId is kept so the two can be matched. usedCredits /
    // remainingCredits in this reply read 0 even on an account with SMS
    // credits, so they say nothing about the balance.
    logEvent(
      "sms",
      digits,
      `accepted by Brevo (messageId ${res.messageId ?? "?"}, ${res.smsCount ?? "?"} part(s)): ${String(message).slice(0, 160)}`,
      { messageId: res.messageId ?? null, smsCount: res.smsCount ?? null, sender },
    );
    return true;
  } catch (err) {
    logEvent("sms", digits, String(err), null, false);
    return false;
  }
}

/* ----------------------- contact role (USER_ROLE) ------------------------ */

/* Every contact the app knows the role of carries a USER_ROLE text attribute
   (Patient / Provider / Clinic / Practice / Sales Rep / ...), so Brevo can
   filter, segment and search by user type. Optionally each role also has its
   own Brevo list (BREVO_ROLE_LISTS_JSON). Calls run one at a time - a full
   re-sync pushes hundreds of contacts and Brevo rate-limits bursts. */

export const BREVO_ROLE_ATTRIBUTE = "USER_ROLE";

let roleAttrReady = false;
async function ensureRoleAttribute(apiKey) {
  if (roleAttrReady) return;
  const res = await fetch(`${BREVO}/contacts/attributes/normal/${BREVO_ROLE_ATTRIBUTE}`, {
    method: "POST",
    headers: { "api-key": apiKey, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ type: "text" }),
    signal: AbortSignal.timeout(15000),
  });
  // 201 = created now; 400 = it already exists - both fine
  if (res.ok || res.status === 400) roleAttrReady = true;
}

function roleLists(cfg) {
  try {
    const map = JSON.parse(cfg.BREVO_ROLE_LISTS_JSON || "{}");
    const out = {};
    for (const [role, id] of Object.entries(map || {})) if (Number(id)) out[role] = Number(id);
    return out;
  } catch {
    return {};
  }
}

let roleQueue = Promise.resolve();

/**
 * Creates / updates the Brevo contact for `email` with its role. Resolves
 * true when Brevo accepted it, false when skipped or failed (logged) - never
 * throws, contact tagging must not break the caller.
 */
export function setBrevoContactRole({ email, first, last, role }) {
  const run = async () => {
    email = String(email || "").trim().toLowerCase();
    if (!email || !role) return false;
    const cfg = await getSettings();
    if (READ_ONLY || !cfg.BREVO_API_KEY || !isTrue(cfg.BREVO_ROLE_SYNC ?? "TRUE")) return false;
    try {
      await ensureRoleAttribute(cfg.BREVO_API_KEY);
      const attributes = { [BREVO_ROLE_ATTRIBUTE]: role };
      if (first) attributes.FIRSTNAME = first;
      if (last) attributes.LASTNAME = last;
      const payload = { email, attributes, updateEnabled: true };
      const lists = roleLists(cfg);
      if (lists[role]) payload.listIds = [lists[role]];
      await brevoPost("/contacts", cfg.BREVO_API_KEY, payload);
      // A changed role leaves the other roles' lists (update call only -
      // create doesn't take unlinkListIds). Best-effort: Brevo refuses it
      // when the contact isn't in those lists, which is the usual case.
      const others = Object.entries(lists).filter(([r]) => r !== role).map(([, id]) => id);
      if (others.length) {
        await fetch(`${BREVO}/contacts/${encodeURIComponent(email)}?identifierType=email_id`, {
          method: "PUT",
          headers: { "api-key": cfg.BREVO_API_KEY, accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ unlinkListIds: others }),
          signal: AbortSignal.timeout(15000),
        }).catch(() => {});
      }
      return true;
    } catch (err) {
      logEvent("error", email, `Brevo role "${role}": ${String(err?.message || err).slice(0, 300)}`, null, false);
      return false;
    }
  };
  const p = roleQueue.then(run, run);
  roleQueue = p.catch(() => {});
  return p;
}

/* ------------------------- sales rep sign-up data ------------------------ */

/* Every sales rep sign-up is saved on the applicant's Brevo contact, with
   timestamps, and kept in step when it is approved or rejected. The custom
   attributes are created in Brevo the first time (an existing one is left
   as it is). Optionally the contact is also added to a list
   (REP_SIGNUP_BREVO_LIST: a list id or exact list name). */
const REP_ATTRS = {
  REP_SIGNUP_STATUS: "text", // Pending / Approved / Rejected
  REP_SIGNUP_DATE: "date", // day submitted (for Brevo date filters)
  REP_SIGNUP_SUBMITTED_AT: "text", // e.g. "November 18, 2026, 2:05 PM CT"
  REP_SIGNUP_SUBMITTED_ISO: "text", // e.g. "2026-11-18T20:05:12.345Z"
  TERMS_ACCEPTED_AT: "text",
  TERMS_VERSION: "text",
  REP_BUSINESS_NAME: "text",
  ADDRESS: "text",
  CITY: "text",
  STATE: "text",
  ZIP: "text",
  PHONE_NUMBER: "text",
  REFERRED_BY: "text",
  REFERRED_BY_REP_ID: "text",
  REFERRAL_CODE: "text",
  REP_SIGNUP_REVIEWED_AT: "text",
  REP_SIGNUP_REVIEWED_BY: "text",
  REP_SIGNUP_REJECT_REASON: "text",
  REP_ID: "text",
};
let repAttrsReady = false;
async function ensureRepAttributes(apiKey) {
  if (repAttrsReady) return;
  let all = true;
  for (const [name, type] of Object.entries(REP_ATTRS)) {
    const res = await fetch(`${BREVO}/contacts/attributes/normal/${name}`, {
      method: "POST",
      headers: { "api-key": apiKey, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ type }),
      signal: AbortSignal.timeout(15000),
    });
    // 201 = created now; 400 = it already exists - both fine
    if (!(res.ok || res.status === 400)) all = false;
  }
  repAttrsReady = all;
}

const SIGNUP_TZ = "America/Chicago";
const human = (d) =>
  d
    ? new Date(d).toLocaleString("en-US", { timeZone: SIGNUP_TZ, year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT"
    : "";
const ymd = (d) => (d ? new Date(d).toLocaleDateString("en-CA", { timeZone: SIGNUP_TZ }) : "");

async function brevoListId(cfg, wanted) {
  const w = String(wanted || "").trim();
  if (!w) return 0;
  if (/^\d+$/.test(w)) return Number(w);
  for (let offset = 0; offset < 500; offset += 50) {
    const res = await fetch(`${BREVO}/contacts/lists?limit=50&offset=${offset}&sort=desc`, {
      headers: { "api-key": cfg.BREVO_API_KEY, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return 0;
    const lists = (await res.json())?.lists || [];
    const hit = lists.find((l) => String(l.name || "").trim().toLowerCase() === w.toLowerCase());
    if (hit) return hit.id;
    if (lists.length < 50) return 0;
  }
  return 0;
}

let repQueue = Promise.resolve();

/**
 * Creates / updates the applicant's Brevo contact with the whole sign-up.
 * `app` = the RepApplication document. Resolves { ok } / { ok:false, error }
 * / { skipped } - never throws.
 */
export function syncRepApplicantToBrevo(app, { referrerName = "" } = {}) {
  const run = async () => {
    const email = String(app?.email || "").trim().toLowerCase();
    if (!email) return { skipped: true };
    const cfg = await getSettings();
    if (READ_ONLY || !cfg.BREVO_API_KEY || !isTrue(cfg.REP_SIGNUP_BREVO_SYNC ?? "TRUE")) return { skipped: true };
    try {
      await ensureRepAttributes(cfg.BREVO_API_KEY);
      const digits = String(app.phone || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      const attributes = {
        FIRSTNAME: app.firstName || "",
        LASTNAME: app.lastName || "",
        REP_SIGNUP_STATUS: app.status === "Approving" ? "Pending" : app.status || "Pending",
        REP_SIGNUP_DATE: ymd(app.createdAt || app.signedAt),
        REP_SIGNUP_SUBMITTED_AT: human(app.createdAt || app.signedAt),
        REP_SIGNUP_SUBMITTED_ISO: app.createdAt || app.signedAt ? new Date(app.createdAt || app.signedAt).toISOString() : "",
        TERMS_ACCEPTED_AT: human(app.signedAt),
        TERMS_VERSION: app.termsVersion || "",
        REP_BUSINESS_NAME: app.company || "",
        ADDRESS: app.address || "",
        CITY: app.city || "",
        STATE: app.state || "",
        ZIP: app.zip || "",
        PHONE_NUMBER: app.phone || "",
        REFERRED_BY: referrerName || "",
        REFERRED_BY_REP_ID: app.referrerRepId || "",
        REFERRAL_CODE: app.referralCode || "",
        REP_SIGNUP_REVIEWED_AT: human(app.reviewedAt),
        REP_SIGNUP_REVIEWED_BY: app.reviewedBy || "",
        REP_SIGNUP_REJECT_REASON: app.status === "Rejected" ? app.reviewNote || "" : "",
        REP_ID: app.repId || "",
      };
      if (!attributes.REP_SIGNUP_DATE) delete attributes.REP_SIGNUP_DATE; // a blank date is refused
      const payload = { email, attributes: { ...attributes }, updateEnabled: true };
      if (digits.length === 10) payload.attributes.SMS = "+1" + digits;
      const listId = await brevoListId(cfg, cfg.REP_SIGNUP_BREVO_LIST);
      if (listId) payload.listIds = [listId];
      try {
        await brevoPost("/contacts", cfg.BREVO_API_KEY, payload);
      } catch (err) {
        // the SMS number is unique in Brevo - one already on another contact fails the call
        if (!payload.attributes.SMS) throw err;
        delete payload.attributes.SMS;
        await brevoPost("/contacts", cfg.BREVO_API_KEY, payload);
      }
      logEvent("sync", email, `Brevo: sales rep sign-up saved (${attributes.REP_SIGNUP_STATUS})`);
      return { ok: true };
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 300);
      logEvent("error", email, `Brevo sales rep sign-up: ${msg}`, null, false);
      return { ok: false, error: msg };
    }
  };
  const p = repQueue.then(run, run);
  repQueue = p.catch(() => {});
  return p;
}

/** Shortens a link for SMS via TinyURL; falls back to the long URL. */
export async function shortenUrl(longUrl) {
  longUrl = String(longUrl || "").trim();
  if (!longUrl) return longUrl;
  try {
    const res = await fetch(
      "https://tinyurl.com/api-create.php?url=" + encodeURIComponent(longUrl),
      { signal: AbortSignal.timeout(6000) },
    );
    const short = (await res.text()).trim();
    if (res.ok && /^https?:\/\//i.test(short)) return short;
  } catch {
    // a longer SMS is fine; a broken link is not
  }
  return longUrl;
}
