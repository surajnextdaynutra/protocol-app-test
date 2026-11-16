import { useRef, useState } from "react";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { BlockStack, Button, Card, FormLayout, InlineStack, Page, Text, TextField } from "@shopify/polaris";

import { ActionResult, useBusy } from "../components/admin";
import { TermsFrame } from "../components/terms-frame";
import { listCounters, setCounter } from "../services/provisioning.server";
import { DEFAULT_RATE_KEYS, setDefaultRate } from "../services/rep-rates.server";
import { listSettings, setSetting } from "../services/settings.server";
import { authenticate } from "../shopify.server";

/* Settings - replaces the "Settings" tab and every script property (Brevo
   keys, kill switches, commission rate, email / SMS wording). Changes apply
   within 30 seconds; nothing needs a redeploy. */

const GROUPS = [
  ["general", "General"],
  ["channels", "Email / SMS switches"],
  ["brevo", "Brevo"],
  ["forms", "Website forms"],
  ["commission", "Commission"],
  ["repsignup", "Sales rep sign-up"],
  ["products", "Product copies"],
  ["demo", "Demo accounts"],
];
// Email / SMS wording, the welcome email and reminder timing are edited on the
// Emails page (one tab per message) - not listed here, so not edited twice.
const ON_EMAILS_PAGE = new Set(["reminders", "email", "sms", "welcome"]);

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await listSettings();
  return {
    // a stored secret is never sent back to the browser
    settings: rows.map((r) => (r.secret ? { ...r, value: "", hasValue: !!r.value } : r)),
    counters: await listCounters(),
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const f = await request.formData();
  const intent = f.get("intent");
  if (intent === "counters") {
    for (const [k, v] of f.entries()) {
      if (k.startsWith("counter:")) await setCounter(k.slice(8), v);
    }
    return { ok: true, message: "ID counters saved." };
  }
  const secretKeys = new Set(String(f.get("secretKeys") || "").split(",").filter(Boolean));
  let n = 0;
  for (const [k, v] of f.entries()) {
    if (!k.startsWith("s:")) continue;
    const key = k.slice(2);
    if (secretKeys.has(key) && !String(v).trim()) continue; // blank = keep the stored secret
    if (DEFAULT_RATE_KEYS[key]) {
      // a default rep rate: recorded in the history and shown to the reps on
      // that default (unchanged value = nothing happens)
      const res = await setDefaultRate(DEFAULT_RATE_KEYS[key], v, { by: "Shopify admin (Settings)" });
      if (!res.ok) return { ok: false, message: `${key}: ${res.error}` };
      if (res.changed) n++;
      continue;
    }
    await setSetting(key, v);
    n++;
  }
  return { ok: true, message: `Saved ${n} setting(s).` };
};

/** Under a *_TERMS setting: load the text from an .html / .txt file, and
 *  preview it exactly as the sign-up popup shows it. Nothing is stored until
 *  the group's Save button is pressed. */
function TermsTools({ value, onChange }) {
  const inputRef = useRef(null);
  const [preview, setPreview] = useState(false);
  const [note, setNote] = useState("");
  const onFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setNote("That file is over 2 MB - please use a smaller file."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      onChange(String(reader.result || "").trim());
      setPreview(true);
      setNote(`Loaded "${file.name}". Check the preview, then press Save.`);
    };
    reader.onerror = () => setNote("Could not read that file.");
    reader.readAsText(file);
  };
  return (
    <BlockStack gap="200">
      <InlineStack gap="200" blockAlign="center">
        <input ref={inputRef} type="file" accept=".html,.htm,.txt,text/html,text/plain" onChange={onFile} style={{ display: "none" }} />
        <Button onClick={() => inputRef.current && inputRef.current.click()}>Upload HTML file</Button>
        <Button onClick={() => setPreview((p) => !p)} disabled={!String(value || "").trim()}>
          {preview ? "Hide preview" : "Preview"}
        </Button>
        {note ? <Text as="span" tone="subdued" variant="bodySm">{note}</Text> : null}
      </InlineStack>
      {preview && String(value || "").trim() ? <TermsFrame terms={value} height={380} /> : null}
    </BlockStack>
  );
}

function Group({ title, rows, busy }) {
  const [values, setValues] = useState(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  const saving = useBusy((fd) => fd.has("s:" + rows[0].key));
  return (
    <Card>
      <Form method="post">
        <input type="hidden" name="secretKeys" value={rows.filter((r) => r.secret).map((r) => r.key).join(",")} />
        <FormLayout>
          <Text as="h2" variant="headingMd">{title}</Text>
          {rows.map((r) => {
            const long = String(r.value).length > 70 || /_BODY$|_JSON$|_TERMS$/.test(r.key);
            const field = (
              <TextField
                key={r.key}
                label={r.key}
                name={"s:" + r.key}
                value={values[r.key]}
                onChange={(v) => setValues((s) => ({ ...s, [r.key]: v }))}
                helpText={r.notes}
                multiline={long ? 4 : false}
                maxHeight={/_TERMS$/.test(r.key) ? 260 : undefined}
                type={r.secret ? "password" : "text"}
                placeholder={r.secret && r.hasValue ? "•••••••• (saved - leave blank to keep)" : undefined}
                autoComplete="off"
              />
            );
            if (!/_TERMS$/.test(r.key)) return field;
            return (
              <BlockStack key={r.key} gap="200">
                {field}
                <TermsTools value={values[r.key]} onChange={(v) => setValues((s) => ({ ...s, [r.key]: v }))} />
              </BlockStack>
            );
          })}
          <InlineStack>
            <Button submit variant="primary" loading={saving} disabled={busy && !saving}>Save {title.toLowerCase()}</Button>
          </InlineStack>
        </FormLayout>
      </Form>
    </Card>
  );
}

export default function Settings() {
  const { settings, counters } = useLoaderData();
  const actionData = useActionData();
  const busy = useBusy();
  const savingCounters = useBusy("counters");
  const known = new Set(GROUPS.map((g) => g[0]));
  const other = settings.filter((s) => !known.has(s.group) && !ON_EMAILS_PAGE.has(s.group));
  const [counterValues, setCounterValues] = useState(Object.fromEntries(counters.map((c) => [c.prefix, String(c.seq)])));

  return (
    <Page title="Settings">
      <BlockStack gap="400">
        <ActionResult data={actionData} />
        <Card>
          <InlineStack align="space-between" blockAlign="center" gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Emails &amp; SMS</Text>
              <Text as="p" tone="subdued">
                Prescription emails, reminders and their timing, SMS messages and the welcome email are edited on the
                Emails page - one tab per message, with a preview and a test send.
              </Text>
            </BlockStack>
            <Button url="/app/emails">Open Emails</Button>
          </InlineStack>
        </Card>
        {GROUPS.map(([id, title]) => {
          const rows = settings.filter((s) => s.group === id);
          return rows.length ? <Group key={id} title={title} rows={rows} busy={busy} /> : null;
        })}
        {other.length ? <Group title="Other (imported)" rows={other} busy={busy} /> : null}
        <Card>
          <Form method="post">
            <input type="hidden" name="intent" value="counters" />
            <FormLayout>
              <Text as="h2" variant="headingMd">ID counters</Text>
              <Text as="p" tone="subdued">
                The last number used for each id prefix. The next account gets the following number.
              </Text>
              <FormLayout.Group condensed>
                {counters.map((c) => (
                  <TextField
                    key={c.prefix}
                    label={c.prefix}
                    name={"counter:" + c.prefix}
                    type="number"
                    value={counterValues[c.prefix]}
                    onChange={(v) => setCounterValues((s) => ({ ...s, [c.prefix]: v }))}
                    autoComplete="off"
                  />
                ))}
              </FormLayout.Group>
              <InlineStack>
                <Button submit loading={savingCounters} disabled={busy && !savingCounters}>Save counters</Button>
              </InlineStack>
            </FormLayout>
          </Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
