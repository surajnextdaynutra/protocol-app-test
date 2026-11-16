/* Deletes the FAILED image files the old product sync left in Content > Files
   (it uploaded from image URLs that no longer exist, so every upload FAILED).
   Only files with status FAILED are touched - a FAILED file has no image, so
   deleting it only removes a broken placeholder (also from the products that
   show it). READY files are never deleted.

   Dry run (list only):  node tools/delete-failed-image-files.mjs
   Delete:               node tools/delete-failed-image-files.mjs --apply */
import fs from "node:fs";
import mongoose from "mongoose";

const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const val = (k) => process.env[k] || (env.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "");
const uri = val("MONGODB_URI"), dbName = val("MONGODB_DB"), shop = val("SHOPIFY_SHOP");
if (!uri || !shop) { console.error("MONGODB_URI / SHOPIFY_SHOP not found in .env"); process.exit(1); }

await mongoose.connect(uri, { dbName });
const db = mongoose.connection.db;
const sessCol = (await db.listCollections().toArray()).map((c) => c.name).find((n) => /session/i.test(n));
const sess = (await db.collection(sessCol).findOne({ shop, isOnline: false })) || (await db.collection(sessCol).findOne({ shop }));
await mongoose.disconnect();
if (!sess?.accessToken) { console.error("No Shopify session for " + shop); process.exit(1); }

async function gql(query, variables) {
  const r = await fetch(`https://${shop}/admin/api/2026-07/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": sess.accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}

const failed = [];
let after = null;
do {
  const d = await gql(
    `query($after: String) {
      files(first: 250, after: $after, query: "status:FAILED") {
        pageInfo { hasNextPage endCursor }
        nodes { id fileStatus createdAt alt ... on MediaImage { originalSource { url } } }
      }
    }`,
    { after },
  );
  for (const n of d.files.nodes) if (n.fileStatus === "FAILED" && n.id.includes("/MediaImage/")) failed.push(n);
  after = d.files.pageInfo.hasNextPage ? d.files.pageInfo.endCursor : null;
} while (after);

console.log(`${failed.length} FAILED image file(s) in ${shop}:`);
for (const f of failed) console.log(`  ${f.createdAt.slice(0, 16)}  ${f.id}  ${String(f.originalSource?.url || f.alt || "").split("/").pop().split("?")[0]}`);

const apply = process.argv.includes("--apply");
if (!apply) console.log("\nDry run - nothing deleted. Add --apply to delete these FAILED files.");
let done = 0;
for (let i = 0; apply && i < failed.length; i += 50) {
  const ids = failed.slice(i, i + 50).map((f) => f.id);
  const d = await gql(
    `mutation($ids: [ID!]!) { fileDelete(fileIds: $ids) { deletedFileIds userErrors { field message } } }`,
    { ids },
  );
  done += d.fileDelete.deletedFileIds?.length || 0;
  if (d.fileDelete.userErrors?.length) console.log("  errors:", JSON.stringify(d.fileDelete.userErrors));
}
if (apply) console.log(`Deleted ${done} FAILED file(s).`);
