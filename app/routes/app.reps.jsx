import { useMemo, useState } from "react";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DataTable,
  FormLayout,
  InlineStack,
  InlineGrid,
  Page,
  Pagination,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";

import { ActionResult, dateTime, money, useBusy } from "../components/admin";
import { connectDb } from "../db.server";
import { Account, MonthlyPayout, SalesRep } from "../models/index.server";
import { PAID_EXPR } from "../services/commission.server";
import { commissionsOverview } from "../services/exec-commissions.server";
import {
  ensureReferralCode,
  setReferrer,
  setRepRate,
} from "../services/rep-rates.server";
import { TermsFrame } from "../components/terms-frame";
import {
  applicationTerms,
  approveApplication,
  listApplications,
  rejectApplication,
  resendFailedDecisionEmails,
} from "../services/rep-signup.server";
import { invalidateResponses } from "../services/response-cache.server";
import { getSettings } from "../services/settings.server";
import { authenticate } from "../shopify.server";

/* Sales reps - the "Admin tools" + executive controls for rep commission:
     - default direct / referral $ per unit (history + rep notices)
     - per rep: practices, own rates (blank = default), who referred them
     - sales rep sign-ups from referral links, waiting for approval
     - referral tree, change history, PT Profit
   Rate changes apply to orders placed from then on; older orders keep the
   commission frozen on them. */

const BY = "Shopify admin (Sales reps)";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDb();
  const [overview, docs, owed, practices, cfg, allApps] = await Promise.all([
    commissionsOverview(),
    SalesRep.find({}).sort({ name: 1 }).lean(),
    MonthlyPayout.aggregate([
      { $match: { role: "Rep" } },
      { $group: { _id: "$entityId", amount: { $sum: "$amount" }, paid: { $sum: PAID_EXPR } } },
    ]),
    Account.find({ practiceId: { $ne: "" } }, { practiceId: 1, company: 1, first: 1, last: 1, doctorId: 1, clinicId: 1 }).lean(),
    getSettings(),
    listApplications({ limit: 500 }),
  ]);
  const totals = {};
  for (const o of owed) totals[o._id] = { paid: o.paid, pending: Math.max(0, o.amount - o.paid) };
  const practiceNames = {};
  for (const a of practices) {
    const isMaster = !a.doctorId && !a.clinicId;
    if (isMaster || !practiceNames[a.practiceId]) practiceNames[a.practiceId] = a.company || `${a.first} ${a.last}`.trim();
  }
  let origin = "";
  try {
    origin = new URL(cfg.WELCOME_EMAIL_LINK).origin;
  } catch {
    origin = "";
  }
  const pending = [];
  for (const a of overview.applications.pending) {
    const t = await applicationTerms(a.id);
    pending.push({ ...a, terms: t.ok ? t.terms : "" });
  }
  const stats = Object.fromEntries(overview.reps.map((r) => [r.repId, r]));
  return {
    tab: new URL(request.url).searchParams.get("tab") || "",
    defaults: overview.defaults,
    history: overview.history,
    tree: overview.tree,
    profit: overview.profit,
    pending,
    // every reviewed sign-up (newest first) - the Approvals tab pages through them
    recent: allApps.filter((a) => a.status !== "Pending"),
    practiceNames,
    signupBase: `${origin}/pages/rep-signup?ref=`,
    signupOpen: String(cfg.REP_SIGNUP_ENABLED).toUpperCase() === "TRUE" && !!String(cfg.REP_SIGNUP_TERMS || "").trim(),
    reps: docs.map((r) => ({
      repId: r.repId,
      name: r.name || "",
      email: r.email || "",
      notes: r.notes || "",
      active: r.active !== false,
      assigned: (r.assignedPracticeIds || []).join(", "),
      referredBy: r.referredBy || "",
      referralCode: r.referralCode || "",
      directRate: r.directRate === null || r.directRate === undefined ? "" : Number(r.directRate).toFixed(2),
      referralRate: r.referralRate === null || r.referralRate === undefined ? "" : Number(r.referralRate).toFixed(2),
      paid: totals[r.repId]?.paid || 0,
      pending: totals[r.repId]?.pending || 0,
      stats: stats[r.repId] || null,
    })),
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  await connectDb();
  const f = await request.formData();
  const intent = String(f.get("intent") || "");

  if (intent === "defaults") {
    // Default commission is changed on the executive (Finance) dashboard only.
    return { ok: false, message: "Default commission is changed on the Finance dashboard → Sales Agents → Default Commission." };
  }

  if (intent === "approve") {
    const res = await approveApplication(String(f.get("id") || ""), { by: BY });
    return { ok: res.ok && !res.warning, message: res.ok ? res.message : res.error };
  }
  if (intent === "reject") {
    const res = await rejectApplication(String(f.get("id") || ""), { by: BY, note: f.get("note"), notify: f.get("notify") === "true" });
    return { ok: res.ok && !res.warning, message: res.ok ? res.message : res.error };
  }
  if (intent === "resend") {
    const res = await resendFailedDecisionEmails(String(f.get("id") || ""));
    return { ok: res.ok && !res.warning, message: res.ok || res.warning ? res.message : res.error };
  }
  if (intent === "code") {
    const code = await ensureReferralCode(String(f.get("repId") || ""));
    invalidateResponses();
    return { ok: !!code, message: code ? `Referral link created (code ${code}).` : "Rep not found." };
  }

  // intent "rep": save one rep card
  const repId = String(f.get("repId") || "").trim();
  if (!repId) return { ok: false, message: "Rep ID is required." };
  const assigned = String(f.get("assigned") || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // a practice belongs to one rep
  await SalesRep.updateMany({ repId: { $ne: repId } }, { $pull: { assignedPracticeIds: { $in: assigned } } });
  await SalesRep.updateOne(
    { repId },
    {
      $set: {
        name: String(f.get("name") || "").trim(),
        email: String(f.get("email") || "").trim().toLowerCase(),
        notes: String(f.get("notes") || ""),
        active: f.get("active") === "true",
        assignedPracticeIds: assigned,
      },
    },
    { upsert: true },
  );
  const note = String(f.get("changeNote") || "");
  const done = [];
  for (const kind of ["direct", "referral"]) {
    const v = String(f.get(kind + "Rate") ?? "").trim();
    const res = await setRepRate(repId, kind, v === "" ? null : v, { by: BY, note });
    if (!res.ok) return { ok: false, message: `${repId} ${kind} rate: ${res.error}` };
    if (res.changed) done.push(`${kind} rate ${res.to === null ? "→ default" : "→ " + money(res.to)}`);
  }
  const ref = await setReferrer(repId, String(f.get("referredBy") || ""), { by: BY, note });
  if (!ref.ok) return { ok: false, message: `${repId}: ${ref.error}` };
  if (ref.changed) done.push(`referred by ${ref.to || "nobody"}`);
  invalidateResponses(); // rep + finance dashboards show the change at once
  return { ok: true, message: `Saved ${repId}${done.length ? " - " + done.join(", ") : ""}.` };
};

/* ------------------------------------------------------------------------ */

/** Read-only here: the default commission is changed on the executive
 *  (Finance) dashboard only. */
function DefaultsCard({ defaults, reps }) {
  const onDirect = reps.filter((r) => r.active && r.directRate === "").length;
  const onReferral = reps.filter((r) => r.active && r.referralRate === "").length;
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Default commission for all Sales Agents</Text>
        <Banner tone="info">
          <p>
            Change the default on the Finance dashboard → Sales Agents → Default Commission. A change applies to orders
            placed from that moment on; earlier orders keep their rate. Only agents on the default are affected and
            notified. Agents with their own rate are not.
          </p>
        </Banner>
        <FormLayout.Group>
          <TextField label="Direct sales ($ per unit)" value={defaults.direct.toFixed(2)} prefix="$" disabled autoComplete="off"
            helpText={`${onDirect} active agent(s) on this default`} />
          <TextField label="Referral ($ per unit)" value={defaults.referral.toFixed(2)} prefix="$" disabled autoComplete="off"
            helpText={`Starting rate of each new referral. ${onReferral} active agent(s) on this default.`} />
        </FormLayout.Group>
      </BlockStack>
    </Card>
  );
}

/** "emailed: a@x, b@y · not sent: c@z (why)" from an application's approve / reject emails. */
/** The last attempt of each approve / reject email (a resend replaces a failed one). */
function lastEmails(emails) {
  const last = {};
  for (const e of emails || []) last[e.kind] = e;
  return Object.values(last);
}
/** A failed email that "Resend failed emails" can send again (not the new agent's approval email - the welcome email covers it). */
function hasFailedEmail(emails) {
  return lastEmails(emails).some((e) => !e.ok && e.kind !== "approved");
}
function emailsText(emails) {
  const list = lastEmails(emails);
  if (!list.length) return "";
  const ok = list.filter((e) => e.ok).map((e) => e.to);
  const bad = list.filter((e) => !e.ok).map((e) => `${e.to || "(no address)"} (${e.error})`);
  return (ok.length ? ` · emailed: ${ok.join(", ")}` : "") + (bad.length ? ` · not sent: ${bad.join("; ")}` : "");
}

/** Client-side paging for one list on this page: { slice, pager, reset }. Same look as the
 *  shared <Pager> (components/admin), which pages through the URL - this page holds several
 *  lists at once, so each keeps its own page in state. `pager` is null when one page is enough. */
function usePaged(items, size) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(page, pages - 1); // the list can shrink (e.g. after an approval)
  const slice = items.slice(p * size, p * size + size);
  const pager =
    items.length > size ? (
      <InlineStack align="end" blockAlign="center" gap="300">
        <Text as="span" tone="subdued" variant="bodySm">
          {items.length.toLocaleString()} total · page {p + 1} of {pages}
        </Text>
        <Pagination hasPrevious={p > 0} onPrevious={() => setPage(p - 1)} hasNext={p < pages - 1} onNext={() => setPage(p + 1)} />
      </InlineStack>
    ) : null;
  return { slice, pager, reset: () => setPage(0) };
}

/** One sign-up waiting for approval: details, signed Agreement, Approve / Reject. */
function PendingSignup({ a, busy }) {
  const [showTerms, setShowTerms] = useState(false);
  const [note, setNote] = useState("");
  const [mail, setMail] = useState(true); // "Email the applicant (and the referring agent)"
  const approving = useBusy((fd) => fd.get("intent") === "approve" && fd.get("id") === a.id);
  const rejecting = useBusy((fd) => fd.get("intent") === "reject" && fd.get("id") === a.id);
  return (
    <Box padding="400" borderWidth="025" borderColor="border" borderRadius="200">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="start" gap="200">
          <BlockStack gap="100">
            <Text as="h3" variant="headingSm">{a.name}</Text>
            <Text as="p" tone="subdued">
              {a.email} · {a.phone}{a.company ? ` · ${a.company}` : ""}{a.address ? ` · ${a.address}` : a.state ? ` · ${a.state}` : ""}
            </Text>
          </BlockStack>
          <BlockStack gap="100" inlineAlign="end">
            <Badge tone="attention">Waiting for approval</Badge>
            <Text as="span" tone="subdued" variant="bodySm">Signed up {dateTime(a.ts)}</Text>
          </BlockStack>
        </InlineStack>
        <Text as="p">
          Referred by: <b>{a.referrerRepId ? `${a.referrerName} (${a.referrerRepId})` : "no referral link"}</b>
        </Text>
        {a.whyJoin ? (
          <Box background="bg-surface-secondary" padding="300" borderRadius="200">
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Why they want to be a Sales Agent</Text>
              <Text as="p"><span style={{ whiteSpace: "pre-wrap" }}>{a.whyJoin}</span></Text>
            </BlockStack>
          </Box>
        ) : null}
        {a.signedAt ? (
          <Text as="p" tone="subdued" variant="bodySm">
            Agreed to the Agreement on {dateTime(a.signedAt)} UTC · Agreement version {a.termsVersion}{a.ip ? ` · IP ${a.ip}` : ""}
            {a.brevoSyncedAt ? " · saved to Brevo" : a.brevoError ? ` · Brevo: ${a.brevoError}` : ""}
          </Text>
        ) : a.ip ? (
          <Text as="p" tone="subdued" variant="bodySm">IP {a.ip}</Text>
        ) : null}
        {a.terms ? (
          <InlineStack>
            <Button size="slim" variant="plain" onClick={() => setShowTerms((x) => !x)}>
              {showTerms ? "Hide signed Agreement" : "View signed Agreement"}
            </Button>
          </InlineStack>
        ) : null}
        {showTerms && a.terms ? <TermsFrame terms={a.terms} height={340} title={`Agreement signed by ${a.name}`} /> : null}

        <Box borderBlockStartWidth="025" borderColor="border" paddingBlockStart="300">
          <InlineGrid columns={{ xs: 1, md: ["oneThird", "twoThirds"] }} gap="400">
            <BlockStack gap="200">
              <Text as="h4" variant="headingXs">Approve</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Creates their login on the default rates and sends the approval email
                {a.referrerRepId ? " (and tells the referring agent)" : ""}.
              </Text>
              <Form method="post">
                <input type="hidden" name="intent" value="approve" />
                <input type="hidden" name="id" value={a.id} />
                <Button submit variant="primary" loading={approving} disabled={busy && !approving}>Approve &amp; create login</Button>
              </Form>
            </BlockStack>
            <Form method="post">
              <input type="hidden" name="intent" value="reject" />
              <input type="hidden" name="id" value={a.id} />
              <input type="hidden" name="notify" value={mail ? "true" : "false"} />
              <BlockStack gap="200">
                <Text as="h4" variant="headingXs">Reject</Text>
                <TextField
                  label="Reason"
                  requiredIndicator
                  name="note"
                  value={note}
                  onChange={setNote}
                  autoComplete="off"
                  multiline={2}
                  placeholder={mail ? "Required - included in the rejection emails" : "Required - kept on the sign-up"}
                />
                <InlineStack align="space-between" blockAlign="center" gap="200">
                  <Checkbox
                    label={a.referrerRepId ? "Email the applicant and the referring agent" : "Email the applicant"}
                    checked={mail}
                    onChange={setMail}
                  />
                  <Button submit tone="critical" loading={rejecting} disabled={(busy && !rejecting) || !note.trim()}>
                    Reject
                  </Button>
                </InlineStack>
                {!note.trim() ? (
                  <Text as="p" tone="subdued" variant="bodySm">Type the reason for rejecting to enable Reject.</Text>
                ) : null}
              </BlockStack>
            </Form>
          </InlineGrid>
        </Box>
      </BlockStack>
    </Box>
  );
}

function PendingSignups({ pending, signupOpen, busy }) {
  const { slice, pager } = usePaged(pending, 5);
  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">Sales Agents waiting for approval</Text>
            <Text as="p" tone="subdued">{pending.length ? `${pending.length} sign-up(s) to review, newest first.` : "Nothing to review."}</Text>
          </BlockStack>
          <Badge tone={signupOpen ? "success" : "attention"}>{signupOpen ? "Sign-up open" : "Sign-up closed"}</Badge>
        </InlineStack>
        {!signupOpen ? (
          <Banner tone="warning">
            <p>
              Sign-up opens when Settings → Sales Agent sign-up has REP_SIGNUP_ENABLED = TRUE and the Agreement text in
              REP_SIGNUP_TERMS.
            </p>
          </Banner>
        ) : null}
        {!pending.length ? (
          <Box padding="600">
            <Text as="p" alignment="center" tone="subdued">No sign-ups waiting for approval.</Text>
          </Box>
        ) : null}
        {slice.map((a) => <PendingSignup key={a.id} a={a} busy={busy} />)}
        {pager}
      </BlockStack>
    </Card>
  );
}

const STATUS_TONE = { Approved: "success", Rejected: "critical", Approving: "info" };

function ReviewedSignups({ recent, busy }) {
  const [status, setStatus] = useState("");
  const rows = useMemo(() => recent.filter((a) => !status || a.status === status), [recent, status]);
  const { slice, pager, reset } = usePaged(rows, 10);
  const resending = useBusy("resend");
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <Text as="h2" variant="headingMd">Reviewed sign-ups</Text>
          <div style={{ minWidth: 200 }}>
            <Select label="Show" labelHidden value={status} onChange={(v) => { setStatus(v); reset(); }}
              options={[{ label: "All reviewed", value: "" }, { label: "Approved", value: "Approved" }, { label: "Rejected", value: "Rejected" }]} />
          </div>
        </InlineStack>
        {!rows.length ? <Text as="p" tone="subdued">No reviewed sign-ups yet.</Text> : (
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text", "text"]}
            headings={["Reviewed", "Name", "Referred by", "Status", "Rep ID", ""]}
            rows={slice.map((a) => [
              dateTime(a.reviewedAt || a.ts),
              a.name,
              a.referrerName || "-",
              <BlockStack key={a.id} gap="100">
                <InlineStack><Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge></InlineStack>
                {a.reviewNote ? <Text as="span" variant="bodySm" tone="subdued">Reason: {a.reviewNote}</Text> : null}
                {emailsText(a.emails) ? (
                  <Text as="span" variant="bodySm" tone="subdued" breakWord>{emailsText(a.emails).replace(/^ · /, "")}</Text>
                ) : null}
              </BlockStack>,
              a.repId || "-",
              hasFailedEmail(a.emails) ? (
                <Form method="post" key={a.id}>
                  <input type="hidden" name="intent" value="resend" />
                  <input type="hidden" name="id" value={a.id} />
                  <Button submit size="slim" loading={resending} disabled={busy && !resending}>Resend failed emails</Button>
                </Form>
              ) : "",
            ])}
          />
        )}
        {pager}
      </BlockStack>
    </Card>
  );
}

function TreeNode({ node, depth }) {
  return (
    <>
      <div style={{ paddingLeft: depth * 22, padding: "4px 0 4px " + depth * 22 + "px", borderLeft: depth ? "2px solid #e1e3e5" : "none", marginLeft: depth ? 8 : 0 }}>
        <Text as="span" fontWeight="semibold">{node.name}</Text>{" "}
        <Text as="span" tone="subdued" variant="bodySm">
          ({node.repId}){node.active ? "" : " · inactive"} · {node.units} units · {money(node.sales)} sales
          {node.referralEarned ? ` · ${money(node.referralEarned)} referral earned` : ""}
        </Text>
      </div>
      {node.children.map((c) => (
        <TreeNode key={c.repId} node={c} depth={depth + 1} />
      ))}
    </>
  );
}

function TreeCard({ tree }) {
  const withTeams = tree.filter((n) => n.children.length);
  const solo = tree.filter((n) => !n.children.length);
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="headingMd">Referral tree</Text>
        <Text as="p" tone="subdued">Who referred whom, with what each rep has sold (all time).</Text>
        {withTeams.map((n) => (
          <TreeNode key={n.repId} node={n} depth={0} />
        ))}
        {solo.length ? (
          <Text as="p" tone="subdued" variant="bodySm">
            No referrals yet: {solo.map((n) => n.name).join(", ")}
          </Text>
        ) : null}
      </BlockStack>
    </Card>
  );
}

function ProfitCard({ profit }) {
  const t = profit.total;
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="headingMd">PT Profit</Text>
        <Text as="p" tone="subdued">
          Wholesale price − MFG COGS (product metafield custom.mfg_cogs) − sales commission (direct + referral), on paid
          orders. Reporting only - prices are not changed.
        </Text>
        <InlineStack gap="600">
          <Text as="span">All time: <b>{money(t.profit)}</b></Text>
          <Text as="span">This month: <b>{money(profit.thisMonth?.profit || 0)}</b></Text>
          <Text as="span">Orders: <b>{t.orders}</b></Text>
        </InlineStack>
        {t.cogsMissing ? (
          <Text as="p" tone="caution">
            {t.cogsMissing} order(s) include a product with no MFG COGS - their profit is shown too high until COGS is
            filled in.
          </Text>
        ) : null}
        {t.estimated ? (
          <Text as="p" tone="subdued" variant="bodySm">
            {t.estimated} order(s) were paid before PT Profit was recorded - estimated from today's COGS.
          </Text>
        ) : null}
        <DataTable
          columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric"]}
          headings={["Month", "Units", "Wholesale", "MFG COGS", "Direct comm.", "Referral comm.", "PT Profit"]}
          rows={profit.byMonth.map((m) => [m.month, m.units, money(m.revenue), money(m.cogs), money(m.rep), money(m.referral), money(m.profit)])}
        />
      </BlockStack>
    </Card>
  );
}

const KIND_LABEL = { direct: "Direct rate", referral: "Referral rate", referrer: "Referred by" };
const showVal = (h, v, name) =>
  h.kind === "referrer" ? (v ? `${name || v}` : "nobody") : v === null || v === undefined || v === "" ? "default" : money(v);

function HistoryCard({ history, reps }) {
  const [rep, setRep] = useState("");
  const rows = useMemo(
    () => history.filter((h) => !rep || (rep === "_default" ? h.scope === "default" : h.repId === rep)),
    [history, rep],
  );
  const { slice, pager, reset } = usePaged(rows, 15);
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Commission change history</Text>
          <div style={{ minWidth: 220 }}>
            <Select label="Show" labelHidden value={rep} onChange={(v) => { setRep(v); reset(); }}
              options={[{ label: "All changes", value: "" }, { label: "Default rates only", value: "_default" },
                ...reps.map((r) => ({ label: `${r.name || r.repId} (${r.repId})`, value: r.repId }))]} />
          </div>
        </InlineStack>
        {!rows.length ? <Text as="p" tone="subdued">No changes recorded yet.</Text> : (
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
            headings={["Effective", "Applies to", "Change", "From", "To", "By", "Note"]}
            rows={slice.map((h) => [
              dateTime(h.ts),
              h.scope === "default" ? `Default (${h.notified} rep(s) notified)` : `${h.repName} (${h.repId})`,
              KIND_LABEL[h.kind] || h.kind,
              showVal(h, h.from, h.fromName),
              showVal(h, h.to, h.toName),
              h.by || "-",
              h.note || "",
            ])}
          />
        )}
        {pager}
      </BlockStack>
    </Card>
  );
}

function RepCard({ rep, reps, practiceNames, defaults, signupBase, busy, isNew }) {
  const [v, setV] = useState({ ...rep, changeNote: "" });
  const set = (k) => (val) => setV((s) => ({ ...s, [k]: val }));
  // every card posts the same fields; _card tells which one is saving
  const card = isNew ? "new" : rep.repId;
  const saving = useBusy((fd) => fd.get("intent") === "rep" && fd.get("_card") === card);
  const names = v.assigned
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((id) => (practiceNames[id] ? `${practiceNames[id]} (${id})` : id));
  const s = rep.stats;
  const link = rep.referralCode ? signupBase + rep.referralCode : "";

  return (
    <Card>
      <BlockStack gap="300">
        <Form method="post">
          <input type="hidden" name="intent" value="rep" />
          <input type="hidden" name="_card" value={card} />
          <FormLayout>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">{isNew ? "Add a Sales Agent" : `${v.name || v.repId}`}</Text>
              {!isNew ? (
                <Text as="span" tone="subdued" variant="bodySm">
                  Paid {money(rep.paid)} · Pending {money(rep.pending)}
                  {s ? ` · Direct ${money(s.directEarned)} · Referral ${money(s.referralEarned)}` : ""}
                </Text>
              ) : null}
            </InlineStack>
            <FormLayout.Group>
              {isNew ? (
                <TextField label="Rep ID" name="repId" value={v.repId} onChange={set("repId")} placeholder="RAP…" autoComplete="off"
                  helpText="Normally created from Accounts → role Sales Rep, which also makes the Shopify login." />
              ) : (
                <>
                  <input type="hidden" name="repId" value={v.repId} />
                  <TextField label="Rep ID" value={v.repId} disabled autoComplete="off" />
                </>
              )}
              <TextField label="Name" name="name" value={v.name} onChange={set("name")} autoComplete="off" />
              <TextField label="Email" name="email" value={v.email} onChange={set("email")} autoComplete="off" />
            </FormLayout.Group>
            <TextField
              label="Assigned practice ID(s)"
              name="assigned"
              value={v.assigned}
              onChange={set("assigned")}
              autoComplete="off"
              helpText={names.length ? names.join(" · ") : "Comma-separated practice ids (PRA…); a clinic id (CLN…) for a clinic with no parent practice."}
            />
            <FormLayout.Group>
              <TextField label="Direct rate ($ per unit)" name="directRate" value={v.directRate} onChange={set("directRate")} prefix="$"
                placeholder={defaults.direct.toFixed(2)} autoComplete="off"
                helpText={v.directRate === "" ? `Blank = default (${money(defaults.direct)})` : "This rep's own rate"} />
              <TextField label="Referral rate ($ per unit)" name="referralRate" value={v.referralRate} onChange={set("referralRate")} prefix="$"
                placeholder={defaults.referral.toFixed(2)} autoComplete="off"
                helpText={(v.referralRate === "" ? `Blank = default (${money(defaults.referral)})` : "This rep's own rate") +
                  ". Each new referral starts at its own $0.20 (change it in the Finance dashboard → Sales Agents → Edit)."} />
              <Select label="Referred by" name="referredBy" value={v.referredBy} onChange={set("referredBy")}
                options={[{ label: "Nobody", value: "" },
                  ...reps.filter((r) => r.repId !== rep.repId).map((r) => ({ label: `${r.name || r.repId} (${r.repId})`, value: r.repId }))]}
                helpText="That rep earns their referral rate on everything this rep sells." />
            </FormLayout.Group>
            <TextField label="Notes" name="notes" value={v.notes} onChange={set("notes")} autoComplete="off" />
            <TextField label="Message to the rep about a rate change (optional)" name="changeNote" value={v.changeNote}
              onChange={set("changeNote")} autoComplete="off" />
            <input type="hidden" name="active" value={String(v.active)} />
            <InlineStack gap="400" blockAlign="center">
              <Checkbox label="Active (earns commission)" checked={v.active} onChange={set("active")} />
              <Button submit variant="primary" loading={saving} disabled={busy && !saving}>Save</Button>
            </InlineStack>
          </FormLayout>
        </Form>
        {!isNew ? (
          link ? (
            <Text as="p" variant="bodySm">Referral link: <code>{link}</code></Text>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="code" />
              <input type="hidden" name="repId" value={rep.repId} />
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" tone="subdued" variant="bodySm">No referral link yet (made automatically when the rep opens My Team).</Text>
                <Button submit size="micro" disabled={busy}>Create now</Button>
              </InlineStack>
            </Form>
          )
        ) : null}
      </BlockStack>
    </Card>
  );
}

/** A small number card in the summary row above the tabs. */
function Stat({ label, value, sub, action }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="p" variant="headingLg">{value}</Text>
        {sub ? <Text as="p" variant="bodySm" tone="subdued">{sub}</Text> : null}
        {action}
      </BlockStack>
    </Card>
  );
}

const NEW_REP = {
  repId: "", name: "", email: "", notes: "", active: true, assigned: "", referredBy: "", referralCode: "",
  directRate: "", referralRate: "", paid: 0, pending: 0, stats: null,
};

/** Sales Agents tab: search, filter and page through the agent cards; add a new agent. */
function AgentsList({ reps, practiceNames, defaults, signupBase, busy }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [adding, setAdding] = useState(false);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return reps.filter((r) => {
      if (status === "active" && !r.active) return false;
      if (status === "inactive" && r.active) return false;
      if (status === "own" && r.directRate === "" && r.referralRate === "") return false;
      return !term || `${r.name} ${r.repId} ${r.email}`.toLowerCase().includes(term);
    });
  }, [reps, q, status]);
  const { slice, pager, reset } = usePaged(rows, 10);
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="200">
          <InlineStack gap="300" blockAlign="end" wrap>
            <div style={{ flex: "1 1 260px" }}>
              <TextField label="Search" labelHidden placeholder="Search by name, Rep ID or email" value={q} autoComplete="off"
                onChange={(v) => { setQ(v); reset(); }} clearButton onClearButtonClick={() => { setQ(""); reset(); }} />
            </div>
            <div style={{ minWidth: 190 }}>
              <Select label="Show" labelHidden value={status} onChange={(v) => { setStatus(v); reset(); }}
                options={[
                  { label: "All Sales Agents", value: "" },
                  { label: "Active", value: "active" },
                  { label: "Inactive", value: "inactive" },
                  { label: "On their own rates", value: "own" },
                ]} />
            </div>
            <Button variant={adding ? "secondary" : "primary"} onClick={() => setAdding((x) => !x)}>
              {adding ? "Cancel new agent" : "Add Sales Agent"}
            </Button>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            Showing {rows.length} of {reps.length} Sales Agent(s). Blank rates = the defaults on the Commission tab.
          </Text>
        </BlockStack>
      </Card>
      {adding ? (
        <RepCard isNew rep={NEW_REP} reps={reps} practiceNames={practiceNames} defaults={defaults} signupBase={signupBase} busy={busy} />
      ) : null}
      {!rows.length ? (
        <Card>
          <Box padding="400">
            <Text as="p" alignment="center" tone="subdued">No Sales Agents match this search.</Text>
          </Box>
        </Card>
      ) : null}
      {slice.map((r) => (
        <RepCard key={r.repId + ":" + r.directRate + ":" + r.referralRate + ":" + r.referredBy} rep={r} reps={reps}
          practiceNames={practiceNames} defaults={defaults} signupBase={signupBase} busy={busy} />
      ))}
      {pager}
    </BlockStack>
  );
}

const TAB_IDS = ["commission", "approvals", "agents", "tree", "profit"];

export default function Reps() {
  const data = useLoaderData();
  const actionData = useActionData();
  const busy = useBusy();
  const { reps, practiceNames, defaults, pending } = data;
  const [tab, setTab] = useState(TAB_IDS.includes(data.tab) ? data.tab : "commission");
  const open = (id) => {
    setTab(id);
    // ?tab= keeps the open tab across a reload / shared link (no data reload)
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("tab", id);
      window.history.replaceState(window.history.state, "", u.toString());
    } catch { /* ignore */ }
  };
  const active = reps.filter((r) => r.active).length;
  const tabs = [
    { id: "commission", content: "Commission" },
    { id: "approvals", content: pending.length ? `Approvals (${pending.length})` : "Approvals" },
    { id: "agents", content: `Sales Agents (${reps.length})` },
    { id: "tree", content: "Referral tree" },
    { id: "profit", content: "PT Profit" },
  ];

  return (
    <Page title="Sales Agents" subtitle="Commission for every agent, sign-up approvals, each agent's rates and practices, referrals and PT Profit.">
      <BlockStack gap="400">
        <ActionResult data={actionData} />
        <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
          <Stat label="Default direct commission" value={`${money(defaults.direct)} / unit`}
            sub={`${reps.filter((r) => r.active && r.directRate === "").length} active agent(s) on it`} />
          <Stat label="Default referral commission" value={`${money(defaults.referral)} / unit`}
            sub={`${reps.filter((r) => r.active && r.referralRate === "").length} active agent(s) on it`} />
          <Stat label="Active Sales Agents" value={`${active}`} sub={`${reps.length - active} inactive`} />
          <Stat label="Waiting for approval" value={`${pending.length}`}
            sub={data.signupOpen ? "Sign-up is open" : "Sign-up is closed"}
            action={pending.length && tab !== "approvals" ? (
              <InlineStack><Button size="slim" onClick={() => open("approvals")}>Review now</Button></InlineStack>
            ) : null} />
        </InlineGrid>
        <Card padding="0">
          <Tabs tabs={tabs} selected={Math.max(0, TAB_IDS.indexOf(tab))} onSelect={(i) => open(TAB_IDS[i])} fitted={false} />
        </Card>

        {tab === "commission" ? (
          <BlockStack gap="400">
            <DefaultsCard defaults={defaults} reps={reps} />
            <HistoryCard history={data.history} reps={reps} />
          </BlockStack>
        ) : null}
        {tab === "approvals" ? (
          <BlockStack gap="400">
            <PendingSignups pending={pending} signupOpen={data.signupOpen} busy={busy} />
            <ReviewedSignups recent={data.recent} busy={busy} />
          </BlockStack>
        ) : null}
        {tab === "agents" ? (
          <AgentsList reps={reps} practiceNames={practiceNames} defaults={defaults} signupBase={data.signupBase} busy={busy} />
        ) : null}
        {tab === "tree" ? <TreeCard tree={data.tree} /> : null}
        {tab === "profit" ? <ProfitCard profit={data.profit} /> : null}
      </BlockStack>
    </Page>
  );
}
