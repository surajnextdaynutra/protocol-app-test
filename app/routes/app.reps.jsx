import { useMemo, useState } from "react";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DataTable,
  FormLayout,
  InlineStack,
  Layout,
  Page,
  Select,
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
  setDefaultRate,
  setReferrer,
  setRepRate,
} from "../services/rep-rates.server";
import { TermsFrame } from "../components/terms-frame";
import { applicationTerms, approveApplication, rejectApplication } from "../services/rep-signup.server";
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
  const [overview, docs, owed, practices, cfg] = await Promise.all([
    commissionsOverview(),
    SalesRep.find({}).sort({ name: 1 }).lean(),
    MonthlyPayout.aggregate([
      { $match: { role: "Rep" } },
      { $group: { _id: "$entityId", amount: { $sum: "$amount" }, paid: { $sum: PAID_EXPR } } },
    ]),
    Account.find({ practiceId: { $ne: "" } }, { practiceId: 1, company: 1, first: 1, last: 1, doctorId: 1, clinicId: 1 }).lean(),
    getSettings(),
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
    defaults: overview.defaults,
    history: overview.history,
    tree: overview.tree,
    profit: overview.profit,
    pending,
    recent: overview.applications.recent.filter((a) => a.status !== "Pending").slice(0, 15),
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
    const note = String(f.get("note") || "");
    const msgs = [];
    for (const kind of ["direct", "referral"]) {
      const res = await setDefaultRate(kind, f.get(kind), { by: BY, note });
      if (!res.ok) return { ok: false, message: `Default ${kind}: ${res.error}` };
      if (res.changed) msgs.push(`default ${kind} ${money(res.from)} → ${money(res.to)} (${res.notified} rep(s) notified)`);
    }
    return { ok: true, message: msgs.length ? "Saved: " + msgs.join("; ") + "." : "No change." };
  }

  if (intent === "approve") {
    const res = await approveApplication(String(f.get("id") || ""), { by: BY });
    return { ok: res.ok, message: res.ok ? res.message : res.error };
  }
  if (intent === "reject") {
    const res = await rejectApplication(String(f.get("id") || ""), { by: BY, note: f.get("note") });
    return { ok: res.ok, message: res.ok ? res.message : res.error };
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

function DefaultsCard({ defaults, reps, busy }) {
  const [v, setV] = useState({ direct: defaults.direct.toFixed(2), referral: defaults.referral.toFixed(2), note: "" });
  const set = (k) => (val) => setV((s) => ({ ...s, [k]: val }));
  const saving = useBusy("defaults");
  const onDirect = reps.filter((r) => r.active && r.directRate === "").length;
  const onReferral = reps.filter((r) => r.active && r.referralRate === "").length;
  return (
    <Card>
      <Form method="post">
        <input type="hidden" name="intent" value="defaults" />
        <FormLayout>
          <Text as="h2" variant="headingMd">Default sales commission</Text>
          <Text as="p" tone="subdued">
            A change applies to orders placed from the moment you save; earlier orders keep their rate. Reps on the
            default see the change on their dashboard.
          </Text>
          <FormLayout.Group>
            <TextField label="Direct sales ($ per unit)" name="direct" value={v.direct} onChange={set("direct")} prefix="$" autoComplete="off"
              helpText={`${onDirect} active rep(s) on this default`} />
            <TextField label="Referral ($ per unit)" name="referral" value={v.referral} onChange={set("referral")} prefix="$" autoComplete="off"
              helpText={`Paid to the referring rep on every unit their referred reps sell. ${onReferral} active rep(s) on this default.`} />
          </FormLayout.Group>
          <TextField label="Message to reps (optional)" name="note" value={v.note} onChange={set("note")} autoComplete="off"
            helpText="Added to the dashboard notice the affected reps see." />
          <InlineStack>
            <Button submit variant="primary" loading={saving} disabled={busy && !saving}>Save defaults</Button>
          </InlineStack>
        </FormLayout>
      </Form>
    </Card>
  );
}

function SignupsCard({ pending, recent, signupOpen, busy }) {
  const [openTerms, setOpenTerms] = useState("");
  const [notes, setNotes] = useState({});
  const approving = useBusy("approve");
  const rejecting = useBusy("reject");
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Sales rep sign-ups</Text>
          <Badge tone={signupOpen ? "success" : "attention"}>{signupOpen ? "Sign-up open" : "Sign-up closed"}</Badge>
        </InlineStack>
        {!signupOpen ? (
          <Text as="p" tone="subdued">
            Sign-up opens when Settings → Sales rep sign-up has REP_SIGNUP_ENABLED = TRUE and the Terms &amp; Conditions
            text in REP_SIGNUP_TERMS.
          </Text>
        ) : null}
        {!pending.length ? <Text as="p" tone="subdued">No sign-ups waiting for approval.</Text> : null}
        {pending.map((a) => (
          <Box key={a.id} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
            <BlockStack gap="200">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">{a.name}</Text>
                <Text as="span" tone="subdued" variant="bodySm">{dateTime(a.ts)}</Text>
              </InlineStack>
              <Text as="p">
                {a.email} · {a.phone}{a.company ? ` · ${a.company}` : ""}{a.address ? ` · ${a.address}` : a.state ? ` · ${a.state}` : ""}
              </Text>
              <Text as="p">Referred by: <b>{a.referrerRepId ? `${a.referrerName} (${a.referrerRepId})` : "no referral link"}</b></Text>
              {a.signatureName ? (
                <Text as="p" tone="subdued" variant="bodySm">
                  Signed “{a.signatureName}” on {dateTime(a.signedAt)} UTC · terms version {a.termsVersion}{a.ip ? ` · IP ${a.ip}` : ""}
                </Text>
              ) : a.ip ? (
                <Text as="p" tone="subdued" variant="bodySm">IP {a.ip}</Text>
              ) : null}
              {a.terms ? (
                <InlineStack gap="200">
                  <Button size="slim" onClick={() => setOpenTerms(openTerms === a.id ? "" : a.id)}>
                    {openTerms === a.id ? "Hide signed terms" : "View signed terms"}
                  </Button>
                </InlineStack>
              ) : null}
              {openTerms === a.id && a.terms ? (
                <TermsFrame terms={a.terms} height={340} title={`Terms signed by ${a.name}`} />
              ) : null}
              <InlineStack gap="200" blockAlign="end">
                <Form method="post">
                  <input type="hidden" name="intent" value="approve" />
                  <input type="hidden" name="id" value={a.id} />
                  <Button submit variant="primary" loading={approving} disabled={busy && !approving}>Approve &amp; create login</Button>
                </Form>
                <Form method="post">
                  <input type="hidden" name="intent" value="reject" />
                  <input type="hidden" name="id" value={a.id} />
                  <InlineStack gap="200" blockAlign="end">
                    <TextField label="Reason (optional)" labelHidden placeholder="Reason (optional)" name="note"
                      value={notes[a.id] || ""} onChange={(v) => setNotes((s) => ({ ...s, [a.id]: v }))} autoComplete="off" />
                    <Button submit tone="critical" loading={rejecting} disabled={busy && !rejecting}>Reject</Button>
                  </InlineStack>
                </Form>
              </InlineStack>
            </BlockStack>
          </Box>
        ))}
        {recent.length ? (
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text"]}
            headings={["Reviewed", "Name", "Referred by", "Status", "Rep ID"]}
            rows={recent.map((a) => [
              dateTime(a.reviewedAt || a.ts),
              a.name,
              a.referrerName || "-",
              a.status + (a.reviewNote ? ` (${a.reviewNote})` : ""),
              a.repId || "-",
            ])}
          />
        ) : null}
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
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Commission change history</Text>
          <div style={{ minWidth: 220 }}>
            <Select label="Show" labelHidden value={rep} onChange={setRep}
              options={[{ label: "All changes", value: "" }, { label: "Default rates only", value: "_default" },
                ...reps.map((r) => ({ label: `${r.name || r.repId} (${r.repId})`, value: r.repId }))]} />
          </div>
        </InlineStack>
        {!rows.length ? <Text as="p" tone="subdued">No changes recorded yet.</Text> : (
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
            headings={["Effective", "Applies to", "Change", "From", "To", "By", "Note"]}
            rows={rows.slice(0, 200).map((h) => [
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
              <Text as="h2" variant="headingMd">{isNew ? "Add a sales rep" : `${v.name || v.repId}`}</Text>
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
                helpText={v.referralRate === "" ? `Blank = default (${money(defaults.referral)})` : "This rep's own rate"} />
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

export default function Reps() {
  const data = useLoaderData();
  const actionData = useActionData();
  const busy = useBusy();
  const { reps, practiceNames, defaults } = data;
  return (
    <Page
      title="Sales reps"
      subtitle={`Default ${money(defaults.direct)} per unit direct, ${money(defaults.referral)} per unit to the referring rep. Each rep can have their own rates.`}
    >
      <BlockStack gap="400">
        <ActionResult data={actionData} />
        <Layout>
          <Layout.Section variant="oneHalf">
            <DefaultsCard defaults={defaults} reps={reps} busy={busy} />
          </Layout.Section>
          <Layout.Section variant="oneHalf">
            <SignupsCard pending={data.pending} recent={data.recent} signupOpen={data.signupOpen} busy={busy} />
          </Layout.Section>
        </Layout>
        <TreeCard tree={data.tree} />
        {reps.map((r) => (
          <RepCard key={r.repId + ":" + r.directRate + ":" + r.referralRate + ":" + r.referredBy} rep={r} reps={reps}
            practiceNames={practiceNames} defaults={defaults} signupBase={data.signupBase} busy={busy} />
        ))}
        <RepCard
          isNew
          rep={{ repId: "", name: "", email: "", notes: "", active: true, assigned: "", referredBy: "", referralCode: "",
            directRate: "", referralRate: "", paid: 0, pending: 0, stats: null }}
          reps={reps}
          practiceNames={practiceNames}
          defaults={defaults}
          signupBase={data.signupBase}
          busy={busy}
        />
        <HistoryCard history={data.history} reps={reps} />
        <ProfitCard profit={data.profit} />
      </BlockStack>
    </Page>
  );
}
