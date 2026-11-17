/* Sales rep Terms & Conditions (Settings -> REP_SIGNUP_TERMS) can be plain
   text or HTML (pasted, or uploaded from an .html file). They are always shown
   inside a sandboxed iframe: the file keeps its own formatting, but no script
   in it can run and nothing in it can reach the page around it. The same
   wrapping is used by the storefront sign-up popup (rx-rep-signup.liquid) and
   the Finance dashboard (rx-finance-dashboard.liquid). */

const BASE_STYLE =
  "<style>html,body{margin:0}body{padding:16px 18px;font:14px/1.65 Inter,system-ui,-apple-system,'Segoe UI',sans-serif;" +
  "color:#2B3440;background:#fff;word-wrap:break-word}h1,h2,h3,h4{color:#143056;line-height:1.3;margin:1.1em 0 .45em}" +
  "h1{font-size:20px}h2{font-size:17px}h3{font-size:15px}p{margin:0 0 .8em}ul,ol{margin:0 0 .9em;padding-left:1.4em}" +
  "a{color:#143056}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #D5DBE3;padding:4px 8px}" +
  "img{max-width:100%;height:auto}.pt-plain{white-space:pre-wrap;margin:0;font:inherit}" +
  // the site's font (Inter) wins over the uploaded file's own fonts; only the signature keeps its script font
  "body,body *:not(.pt-signature){font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif !important}" +
  "</style>" +
  '<base target="_blank">' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Dancing+Script:wght@600&display=swap">';

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export const looksLikeHtml = (text) => /<\/?[a-z][a-z0-9]*[\s>/]/i.test(String(text || ""));

/** The terms as a complete HTML document for an iframe's srcdoc. */
export function termsDoc(text) {
  const t = String(text || "");
  if (!looksLikeHtml(t)) {
    return `<!doctype html><html><head><meta charset="utf-8">${BASE_STYLE}</head><body><pre class="pt-plain">${escapeHtml(t)}</pre></body></html>`;
  }
  // a whole .html file: put the base style first in its <head>, so its own styles win
  if (/<head[\s>]/i.test(t)) return t.replace(/<head(\s[^>]*)?>/i, (m) => m + '<meta charset="utf-8">' + BASE_STYLE);
  if (/<html[\s>]/i.test(t)) return t.replace(/<html(\s[^>]*)?>/i, (m) => m + "<head>" + BASE_STYLE + "</head>");
  return `<!doctype html><html><head><meta charset="utf-8">${BASE_STYLE}</head><body>${t}</body></html>`;
}

export function TermsFrame({ terms, height = 320, title = "Terms & Conditions" }) {
  return (
    <iframe
      title={title}
      srcDoc={termsDoc(terms)}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      style={{ width: "100%", height, border: "1px solid #D5DBE3", borderRadius: 8, background: "#fff", display: "block" }}
    />
  );
}
