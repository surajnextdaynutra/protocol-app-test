import { connectDb } from "../db.server";
import { Setting } from "../models/index.server";
import { fillTemplate, sendEmail, sendSms } from "./brevo.server";
import { welcomeLinkForRole } from "../components/welcome-link";
import { getWelcomeTemplate, saveWelcomeTemplate, sendWelcomeEmail } from "./provisioning.server";
import { sendTemplated } from "./rep-signup.server";
import { READ_ONLY } from "./shopify-admin.server";
import { SETTINGS_DEFAULTS, getSettings, isTrue, setSettings } from "./settings.server";

/* Every message the portal sends a customer, for the Emails page. Each
   entry names the settings that hold its wording; nothing here changes
   when or how a message is sent - the senders read the same settings. */

const LINK = "https://protocoltherapeutics.com/pages/rx-cart?rx=RX-TEST";

/* "When it is sent" settings shown on a tab (were the Settings page's
   "Prescription reminders" group). The reminders master switch is shared by
   all three reminder emails. */
const REMINDERS_ON = { key: "REMINDERS_ENABLED", label: "Send prescription reminders (all three reminder emails)", type: "bool" };
const hours = (key, label, help) => ({ key, label, type: "hours", help });
const RX = [
  { token: "name", sample: "Jane", note: "patient's first name" },
  { token: "link", sample: LINK, note: "the patient's protocol / checkout link" },
  { token: "validity", sample: "December 31, 2026", note: "when the link expires" },
  { token: "doctor_name", sample: "John Carter", note: "physician's name, without “Dr”" },
];

export const MESSAGES = [
  {
    id: "welcome", group: "accounts", label: "Welcome email", kind: "email",
    subjectKey: "WELCOME_EMAIL_SUBJECT", bodyKey: "WELCOME_EMAIL_BODY",
    when: "Sent to a new practice, clinic, physician or sales rep created on the Accounts page with “Send welcome email” ticked.",
    looseMatch: true, // [First Name] == [first name] - see sendWelcomeEmail
    placeholders: [
      { token: "First Name", sample: "Jane" }, { token: "Last Name", sample: "Smith" },
      { token: "Name", sample: "Jane Smith" }, { token: "Email", sample: "jane.smith@example.com" },
      { token: "Role", sample: "Physician" }, { token: "Link", sample: "", note: "login, then the account's own dashboard" },
    ],
  },
  {
    id: "protocol-email", group: "protocols", label: "Protocol email", kind: "email",
    subjectKey: "CONFIRMED_SUBJECT", bodyKey: "CONFIRMED_BODY", templateIdKey: "CONFIRMED_TEMPLATE_ID",
    when: "Sent to the patient when a physician sends a protocol by email (Prescription builder → Send).",
    placeholders: RX,
  },
  {
    id: "protocol-sms", group: "protocols", label: "Protocol SMS", kind: "sms", bodyKey: "SMS_BODY",
    when: "Sent with the protocol email when the physician ticks “Also send by SMS”. [link] is shortened.",
    placeholders: RX,
  },
  {
    id: "not-opened", group: "protocols", label: "Reminder: not opened", kind: "email",
    subjectKey: "NOT_OPENED_SUBJECT", bodyKey: "NOT_OPENED_BODY", templateIdKey: "NOT_OPENED_TEMPLATE_ID",
    when: "Sent when the patient hasn't opened the protocol link - a first and a second reminder.",
    placeholders: RX,
    settings: [
      REMINDERS_ON,
      hours("REMINDER_1_HOURS", "First reminder", "Hours after the protocol was sent, if the link wasn't opened."),
      hours("REMINDER_2_HOURS", "Second reminder", "Hours after it was sent, if the link still wasn't opened."),
    ],
  },
  {
    id: "abandoned", group: "protocols", label: "Reminder: abandoned cart", kind: "email",
    subjectKey: "ABANDONED_SUBJECT", bodyKey: "ABANDONED_BODY", templateIdKey: "ABANDONED_TEMPLATE_ID",
    when: "Sent when the patient opened the link or started checkout but didn't buy.",
    placeholders: RX,
    settings: [
      REMINDERS_ON,
      hours("ABANDONED_AFTER_HOURS", "Abandoned after", "Hours after opening / starting checkout without buying."),
    ],
  },
  {
    id: "abandoned-sms", group: "protocols", label: "Abandoned cart SMS", kind: "sms",
    bodyKey: "ABANDONED_SMS_BODY", enabledKey: "ABANDONED_SMS_ENABLED",
    when: "Sent with the abandoned-cart reminder email when the prescription has a phone number.",
    placeholders: [
      { token: "First Name", sample: "Jane", note: "patient's first name" },
      { token: "Last Name", sample: "Carter", note: "physician's last name" },
      { token: "View Your Protocol", sample: "https://tinyurl.com/rx-test", note: "short protocol link" },
      ...RX,
    ],
  },
  {
    id: "expiry", group: "protocols", label: "Reminder: expiring", kind: "email",
    subjectKey: "EXPIRY_SUBJECT", bodyKey: "EXPIRY_BODY", templateIdKey: "EXPIRY_TEMPLATE_ID",
    when: "Sent shortly before the protocol link expires, if it still hasn't been bought.",
    placeholders: RX,
    settings: [
      REMINDERS_ON,
      hours("BEFORE_EXPIRY_HOURS", "Before expiry", "Hours before the link expires."),
    ],
  },
  {
    id: "order-confirm-email", group: "orders", label: "Order confirmation email", kind: "email",
    subjectKey: "ORDER_CONFIRM_SUBJECT", bodyKey: "ORDER_CONFIRM_BODY", enabledKey: "ORDER_CONFIRM_EMAIL_ENABLED",
    when: "Sent once to the customer of every paid Shopify order: products with their images, totals and the shipping address. Shopify's own order confirmation email is separate - see Shopify admin → Settings → Notifications.",
    // shown as the placeholder itself in the preview / test - no sample order data
    placeholders: ["name", "order-number", "order_date", "items", "subtotal", "discount_row", "shipping", "tax", "total", "shipping_address", "order_status_link"]
      .map((token) => ({ token, sample: "[" + token + "]" })),
    settings: [
      { key: "ORDER_PAID_SMS_START_AT", label: "Only orders created after", type: "datetime",
        help: "Shared with the order confirmation SMS: older orders never get it. Blank = set automatically the first time it runs." },
    ],
  },
  {
    id: "order-paid-sms", group: "orders", label: "Order confirmation SMS", kind: "sms",
    bodyKey: "ORDER_PAID_BODY", enabledKey: "ORDER_PAID_SMS_ENABLED",
    when: "Sent once to the customer of every paid Shopify order with a phone number.",
    placeholders: [
      { token: "name", sample: "Jane", note: "customer's first name" },
      { token: "order-number", sample: "#1001" },
    ],
    settings: [
      { key: "ORDER_PAID_SMS_START_AT", label: "Only orders created after", type: "datetime",
        help: "Orders created before this never get the confirmation (or shipped) SMS. Blank = set automatically the first time it runs, so the old backlog is never texted." },
    ],
  },
  {
    id: "order-shipped-sms", group: "orders", label: "Order shipped SMS", kind: "sms",
    bodyKey: "ORDER_FULFILLED_BODY", enabledKey: "ORDER_FULFILLED_SMS_ENABLED",
    when: "Sent once when an order is fulfilled and has a tracking link.",
    placeholders: [
      { token: "First Name", sample: "Jane" },
      { token: "Tracking Link", sample: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400TEST" },
    ],
  },
  {
    id: "order-updated-sms", group: "orders", label: "Order updated SMS", kind: "sms",
    bodyKey: "ORDER_UPDATED_BODY", enabledKey: "ORDER_UPDATED_SMS_ENABLED",
    when: "Sent when an order's phone, email or shipping address is changed.",
    placeholders: [
      { token: "First Name", sample: "Jane" },
      { token: "order-number", sample: "#1001" },
      { token: "Order Update Summary", sample: "Shipping address updated." },
    ],
  },
  ...SALES_AGENT_MESSAGES(),
];

/* Sales Agent sign-up decisions (Sales Agents page -> Approvals). Sent by
   rep-signup.server.js (decisionEmailSpec) with these same keys. A sample of
   "cfg:LINK" / "cfg:CONTACT" is read from Settings when the page loads, so
   the preview shows the real login link / contact address. */
function SALES_AGENT_MESSAGES() {
  const contact = {
    key: "REP_SIGNUP_NOTIFY_EMAIL", label: "Contact email", type: "text",
    help: "Shown as [Contact Email] in these emails, and where new sign-ups are emailed for approval. Blank = SALES_EMAIL.",
  };
  const applicant = [
    { token: "First Name", sample: "Jane" }, { token: "Last Name", sample: "Smith" },
    { token: "Name", sample: "Jane Smith" }, { token: "Email", sample: "jane.smith@example.com" },
  ];
  const referrer = [
    { token: "First Name", sample: "John", note: "the referring agent" },
    { token: "Name", sample: "John Carter", note: "the referring agent" },
    { token: "Agent Name", sample: "Jane Smith", note: "the new / rejected agent" },
    { token: "Agent First Name", sample: "Jane" },
  ];
  const contactToken = { token: "Contact Email", sample: "cfg:CONTACT", note: "the Contact email below (else SALES_EMAIL)" };
  const linkToken = { token: "Link", sample: "cfg:LINK", note: "Sales Agent login link (Welcome email tab)" };
  const reasonToken = { token: "Reason", sample: "(the reason typed when rejecting)", note: "the Reason box is left out when no reason is given" };
  const common = { group: "agents", kind: "email", settings: [contact], settingsTitle: "Contact address", sender: "rep-decision" };
  return [
    {
      ...common, id: "agent-approved", label: "Approved: new agent",
      subjectKey: "REP_SIGNUP_APPROVED_SUBJECT", bodyKey: "REP_SIGNUP_APPROVED_BODY",
      when: "Sent to the new Sales Agent when you approve their sign-up (Sales Agents → Approvals). It replaces the welcome email; if it can't be sent, the normal welcome email goes out instead.",
      placeholders: [...applicant, linkToken, { token: "Referrer Name", sample: "John Carter" }, contactToken],
    },
    {
      ...common, id: "agent-approved-referrer", label: "Approved: referrer",
      subjectKey: "REP_SIGNUP_REFERRER_APPROVED_SUBJECT", bodyKey: "REP_SIGNUP_REFERRER_APPROVED_BODY",
      when: "Sent to the Sales Agent who referred them, when the new agent signed up through a referral link.",
      placeholders: [...referrer, linkToken, contactToken],
    },
    {
      ...common, id: "agent-rejected", label: "Rejected: applicant",
      subjectKey: "REP_SIGNUP_REJECT_SUBJECT", bodyKey: "REP_SIGNUP_REJECT_BODY",
      when: "Sent to the applicant when you reject their sign-up with the emails ticked.",
      placeholders: [...applicant, reasonToken, contactToken],
    },
    {
      ...common, id: "agent-rejected-referrer", label: "Rejected: referrer",
      subjectKey: "REP_SIGNUP_REFERRER_REJECT_SUBJECT", bodyKey: "REP_SIGNUP_REFERRER_REJECT_BODY",
      when: "Sent to the Sales Agent who referred the applicant, when you reject with the emails ticked.",
      placeholders: [...referrer, reasonToken, contactToken],
    },
    {
      ...common, id: "agent-invite", label: "Invite: referral link",
      subjectKey: "REP_INVITE_SUBJECT", bodyKey: "REP_INVITE_BODY",
      settings: [{
        key: "REP_INVITE_DAILY_LIMIT", label: "Invites per agent per day", type: "text",
        help: "How many invites one Sales Agent can send in 24 hours. The same address can be invited once per 24 hours.",
      }],
      settingsTitle: "Limit",
      when: "Sent when a Sales Agent clicks Email Link on their dashboard's Referral Link card and enters someone's first name and email. It goes out from the store's address; replies go to the agent.",
      placeholders: [
        { token: "First Name", sample: "Jane", note: "the person invited" },
        { token: "Referring Sales Agent", sample: "John Carter", note: "the agent's name" },
        { token: "Link", sample: "cfg:SIGNUP", note: "the agent's referral sign-up link" },
        { token: "Agent Email", sample: "john.carter@example.com", note: "the agent's email" },
      ],
    },
  ];
}

/** Message categories, in the order the Emails page shows them. */
export const MESSAGE_GROUPS = [
  ["accounts", "Accounts"],
  ["protocols", "Protocols & reminders"],
  ["orders", "Orders"],
  ["agents", "Sales Agents"],
];

/** Every Settings key a message owns - the Settings page leaves these to the Emails page. */
export const MESSAGE_SETTING_KEYS = new Set(
  MESSAGES.flatMap((m) => [m.subjectKey, m.bodyKey, m.templateIdKey, m.enabledKey, ...(m.settings || []).map((x) => x.key)]).filter(Boolean),
);

const DEFAULTS = Object.fromEntries(SETTINGS_DEFAULTS.map(([k, v]) => [k, v]));
const byId = (id) => MESSAGES.find((m) => m.id === id);
/** "cfg:LINK" / "cfg:CONTACT" samples -> the real values from Settings. */
function liveSample(sample, cfg) {
  if (sample === "cfg:LINK") return welcomeLinkForRole(cfg.WELCOME_EMAIL_LINK, "Sales Rep");
  if (sample === "cfg:CONTACT") return String(cfg.REP_SIGNUP_NOTIFY_EMAIL || cfg.SALES_EMAIL || "").trim();
  if (sample === "cfg:SIGNUP") {
    // the sign-up page on the store's own address (a real agent's link adds ?ref=<code>)
    try { return new URL(String(cfg.WELCOME_EMAIL_LINK || "")).origin + "/pages/rep-signup"; } catch { return "/pages/rep-signup"; }
  }
  return sample;
}
const withLiveSamples = (m, cfg) => m.placeholders.map((p) => ({ ...p, sample: liveSample(p.sample, cfg) }));
const sampleValues = (m, cfg = {}) => Object.fromEntries(withLiveSamples(m, cfg).map((p) => [p.token, p.sample]));

/** Everything the Emails page shows, per message. */
export async function listMessages() {
  await connectDb();
  const cfg = await getSettings({ fresh: true });
  const stored = new Set((await Setting.find({}, { key: 1 }).lean()).map((r) => r.key));
  const welcome = await getWelcomeTemplate(cfg);
  return MESSAGES.map((m) => {
    const isWelcome = m.id === "welcome";
    const subject = isWelcome ? welcome.subject : m.subjectKey ? cfg[m.subjectKey] || "" : "";
    const body = isWelcome ? welcome.body : cfg[m.bodyKey] || "";
    const defaultSubject = m.subjectKey ? DEFAULTS[m.subjectKey] || "" : "";
    const defaultBody = DEFAULTS[m.bodyKey] || "";
    return {
      ...m,
      placeholders: withLiveSamples(m, cfg),
      subject,
      body,
      // welcome's defaults live in welcome-default.server (its settings default to blank)
      defaultSubject: isWelcome ? null : defaultSubject,
      defaultBody: isWelcome ? null : defaultBody,
      custom: isWelcome ? welcome.custom : subject !== defaultSubject || body !== defaultBody,
      enabled: m.enabledKey ? isTrue(cfg[m.enabledKey]) : null,
      settings: (m.settings || []).map((s) => ({ ...s, value: String(cfg[s.key] ?? "") })),
      templateId: m.templateIdKey ? cfg[m.templateIdKey] || "" : "",
      stored: [m.subjectKey, m.bodyKey].some((k) => k && stored.has(k)),
    };
  });
}

export async function saveMessage(id, { subject, body, templateId }) {
  const m = byId(id);
  if (!m) throw new Error("Unknown message: " + id);
  if (m.id === "welcome") return saveWelcomeTemplate({ subject, body });
  const map = { [m.bodyKey]: String(body ?? "") };
  if (m.subjectKey) map[m.subjectKey] = String(subject ?? "");
  if (m.templateIdKey) map[m.templateIdKey] = String(templateId ?? "").trim();
  await setSettings(map);
}

/** Back to the built-in wording (the stored rows are removed). */
export async function resetMessage(id) {
  const m = byId(id);
  if (!m) throw new Error("Unknown message: " + id);
  if (m.id === "welcome") return saveWelcomeTemplate({ subject: "", body: "" });
  await connectDb();
  await Setting.deleteMany({ key: { $in: [m.subjectKey, m.bodyKey].filter(Boolean) } });
  await getSettings({ fresh: true }); // drop the cached copy
}

/** Saves a tab's "when it is sent" settings - only keys that tab owns. */
export async function saveMessageSettings(id, input) {
  const m = byId(id);
  if (!m?.settings?.length) throw new Error("This message has no sending settings.");
  const map = {};
  for (const s of m.settings) {
    if (!(s.key in input)) continue;
    const raw = String(input[s.key] ?? "").trim();
    if (s.type === "bool") map[s.key] = raw === "TRUE" ? "TRUE" : "FALSE";
    else if (s.type === "hours") {
      const n = Number(raw);
      if (raw === "" || !(n >= 0)) throw new Error(`${s.label}: enter 0 or more hours.`);
      map[s.key] = String(n);
    } else if (s.type === "datetime") {
      if (raw && isNaN(new Date(raw).getTime())) throw new Error(`${s.label}: not a valid date/time.`);
      map[s.key] = raw;
    } else map[s.key] = raw;
  }
  await setSettings(map);
}

export async function setMessageEnabled(id, on) {
  const m = byId(id);
  if (!m?.enabledKey) throw new Error("This message can't be switched off here.");
  await setSettings({ [m.enabledKey]: on ? "TRUE" : "FALSE" });
}

/**
 * Sends the SAVED template once with the sample values, "[Test]" in the
 * subject. `to` is an email or (for SMS) a phone number. Returns a message
 * for the page.
 */
export async function sendTestMessage(id, to, role) {
  const m = byId(id);
  if (!m) throw new Error("Unknown message: " + id);
  to = String(to || "").trim();
  const cfg = await getSettings({ fresh: true });

  if (m.kind === "sms") {
    const digits = to.replace(/\D/g, "");
    if (digits.length < 10) return { ok: false, message: "Enter a phone number with country code, e.g. +1 555 123 4567." };
    if (READ_ONLY) return { ok: false, message: "Not sent - read-only mode (RX_READ_ONLY)." };
    if (isTrue(cfg.SMS_DISABLED)) return { ok: false, message: "Not sent - SMS_DISABLED is on in Settings." };
    if (!cfg.BREVO_API_KEY) return { ok: false, message: "Not sent - set BREVO_API_KEY in Settings." };
    const ok = await sendSms(digits, fillTemplate(cfg[m.bodyKey], sampleValues(m, cfg)));
    return ok
      ? { ok: true, message: `Test SMS sent to +${digits}.` }
      : { ok: false, message: "Brevo didn't accept the SMS - see Sync & logs for the reason." };
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, message: "Enter a valid email to send the test to." };
  if (m.id === "welcome") {
    const result = await sendWelcomeEmail({ firstName: "Test", lastName: "User", email: to, role: role || "Physician", test: true });
    return result === "sent"
      ? { ok: true, message: `Test welcome email (${role || "Physician"}) sent to ${to}.` }
      : { ok: false, message: "Test not sent - " + result };
  }
  const values = sampleValues(m, cfg);
  if (m.sender === "rep-decision") {
    await sendTemplated(cfg, {
      to, subjectKey: m.subjectKey, bodyKey: m.bodyKey, values, subjectPrefix: "[Test] ",
      subjectFallback: DEFAULTS[m.subjectKey] || "", bodyFallback: DEFAULTS[m.bodyKey] || "",
    });
    return { ok: true, message: `Test “${m.label}” sent to ${to}.` };
  }
  await sendEmail({
    to,
    subject: "[Test] " + fillTemplate(cfg[m.subjectKey], values),
    htmlBody: fillTemplate(cfg[m.bodyKey], values),
    params: { NAME: values.name, LINK: values.link, VALIDITY: values.validity, DOCTOR_NAME: values.doctor_name },
    templateId: m.templateIdKey ? cfg[m.templateIdKey] : "",
  });
  return { ok: true, message: `Test “${m.label}” sent to ${to}.` };
}
