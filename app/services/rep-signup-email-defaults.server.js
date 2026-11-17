/* Sales Agent sign-up emails - the built-in templates behind Settings ->
   Sales rep sign-up (REP_SIGNUP_APPROVED_* / _REFERRER_APPROVED_* /
   _REJECT_* / _REFERRER_REJECT_*). Same look as the welcome email
   (welcome-default.server.js): grey page, white card, logo, navy button,
   support footer. Email-client safe: tables + inline styles, Outlook button.

   A block wrapped in <!--reason--> ... <!--/reason--> is dropped when there
   is no reason (rep-signup.server.js, sendTemplated). */

const LOGO = "https://cdn.shopify.com/s/files/1/0781/6347/6651/files/Protocol_Therapeutics_logo.webp?v=1783570590";
const FONT = "font-family:Arial,Helvetica,sans-serif;";

function button(label, href) {
  return `
          <tr>
            <td align="center" class="pt-pad" style="padding:0 40px 30px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                           href="${href}" style="height:44px;v-text-anchor:middle;width:280px;" arcsize="14%" fillcolor="#1f2d3d" strokecolor="#1f2d3d">
                <w:anchorlock/>
                <center style="color:#ffffff;${FONT}font-size:16px;font-weight:bold;">${label}</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a href="${href}" target="_blank"
                 style="display:inline-block;background:#1f2d3d;color:#ffffff;text-decoration:none;${FONT}font-size:16px;font-weight:600;line-height:20px;padding:12px 40px;border-radius:6px;">
                ${label}
              </a>
              <!--<![endif]-->
            </td>
          </tr>`;
}

/* The grey "Reason" panel - dropped entirely when no reason is given. */
const REASON = `
          <!--reason-->
          <tr>
            <td class="pt-pad" style="padding:0 40px 24px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="background:#f4f6f8;border-left:4px solid #1f2d3d;border-radius:4px;padding:14px 18px;${FONT}font-size:15px;line-height:24px;color:#333333;">
                    <strong>Reason:</strong> [Reason]
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!--/reason-->`;

/**
 * One email in the house layout.
 *   title      <title> + hidden preview text (preheader)
 *   greeting   "Hi <strong>…</strong>,"
 *   message    the main paragraphs (HTML)
 *   reason     true = the Reason panel after the message
 *   cta        { label, href } button
 *   support    the line under the button
 */
function layout({ title, preheader, greeting, message, reason = false, cta = null, support }) {
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${title}</title>
  <!--[if mso]>
  <style>table,td,a{font-family:Arial,Helvetica,sans-serif !important;}</style>
  <![endif]-->
  <style>
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
    table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
    img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none;}
    body{margin:0 !important;padding:0 !important;width:100% !important;}
    a{color:#1f2d3d;}
    @media only screen and (max-width:620px){
      .pt-container{width:100% !important;}
      .pt-pad{padding-left:24px !important;padding-right:24px !important;}
    }
  </style>
</head>

<body style="margin:0;padding:0;background:#f4f6f8;">

  <!-- Preheader (hidden preview text) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f6f8;">
    ${preheader}
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f6f8;">
    <tr>
      <td align="center" style="padding:40px 15px;">

        <table role="presentation" class="pt-container" cellpadding="0" cellspacing="0" border="0" width="600"
               style="width:600px;max-width:600px;background:#ffffff;border-radius:8px;">

          <!-- Logo -->
          <tr>
            <td align="center" class="pt-pad" style="padding:35px 30px 20px;">
              <img src="${LOGO}" alt="Protocol Therapeutics" width="180"
                   style="display:block;width:180px;max-width:180px;height:auto;" />
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td class="pt-pad" style="padding:10px 40px 0;${FONT}font-size:16px;line-height:26px;color:#333333;">
              Hi <strong>${greeting}</strong>,
            </td>
          </tr>

          <!-- Message -->
          <tr>
            <td class="pt-pad" style="padding:20px 40px;${FONT}font-size:16px;line-height:26px;color:#555555;">
              ${message}
            </td>
          </tr>
${reason ? REASON : ""}${cta ? button(cta.label, cta.href) : ""}
          <!-- Support line -->
          <tr>
            <td class="pt-pad" style="padding:0 40px 8px;${FONT}font-size:16px;line-height:26px;color:#555555;">
              ${support}
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td class="pt-pad" style="padding:30px 40px 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr><td style="border-top:1px solid #e5e7eb;font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td class="pt-pad" style="padding:0 40px 40px;${FONT}font-size:15px;line-height:24px;color:#777777;">
              The Protocol Therapeutics Support Team
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>
`;
}

const SUPPORT = 'If you have any questions, contact us at <a href="mailto:[Contact Email]" style="color:#1f2d3d;">[Contact Email]</a>.';

/** To the new Sales Agent on Approve - replaces the welcome email. */
export const APPROVED_BODY_DEFAULT = layout({
  title: "Your Sales Agent Account Is Approved",
  preheader: "Your Protocol Therapeutics Sales Agent account is approved. Log in to get started.",
  greeting: "[First Name] [Last Name]",
  message:
    "<strong>Welcome to Protocol Therapeutics.</strong><br /><br />" +
    "Your application to become a Sales Agent has been approved, and your account is ready to use.<br /><br />" +
    "Log in with <strong>[Email]</strong> to find your referral link and follow your sales and commissions.",
  cta: { label: "Log In to Your Dashboard", href: "[Link]" },
  support: SUPPORT,
});

/** To the referring Sales Agent on Approve. */
export const REFERRER_APPROVED_BODY_DEFAULT = layout({
  title: "Your Referral Has Been Approved",
  preheader: "[Agent Name] has been approved as a Protocol Therapeutics Sales Agent.",
  greeting: "[First Name]",
  message:
    "<strong>Good news - [Agent Name] has been approved.</strong><br /><br />" +
    "[Agent Name] signed up with your referral link and is now a Protocol Therapeutics Sales Agent.<br /><br />" +
    "You will earn a referral commission on their sales. You can follow them on your Sales Agent dashboard.",
  cta: { label: "View Your Dashboard", href: "[Link]" },
  support: SUPPORT,
});

/** To the applicant on Reject (with "send emails" ticked). */
export const REJECT_BODY_DEFAULT = layout({
  title: "Update on Your Sales Agent Application",
  preheader: "An update on your Protocol Therapeutics Sales Agent application.",
  greeting: "[First Name] [Last Name]",
  message:
    "Thank you for your interest in becoming a Sales Agent with Protocol Therapeutics.<br /><br />" +
    "After reviewing your application, we are unable to approve it at this time.",
  reason: true,
  support: SUPPORT,
});

/** To the referring Sales Agent on Reject (with "send emails" ticked). */
export const REFERRER_REJECT_BODY_DEFAULT = layout({
  title: "Update on Your Referral",
  preheader: "An update on your referral [Agent Name].",
  greeting: "[First Name]",
  message:
    "Thank you for referring <strong>[Agent Name]</strong> to Protocol Therapeutics.<br /><br />" +
    "After reviewing their application, we are unable to approve it at this time.",
  reason: true,
  support: SUPPORT,
});

/* The plain versions these replaced (2026-11-18). Settings saved with them
   untouched are switched to the templates above (settings.server.js,
   OLD_DEFAULTS) - an edited template is never overwritten. */
export const PREVIOUS = {
  // the sign-up list was blank (= no list) until 2026-11-18; now "Referred Sales Agents"
  REP_SIGNUP_BREVO_LIST: "",
  REP_SIGNUP_APPROVED_BODY:
    "<p>Hi [First Name],</p>" +
    "<p>Great news - your application to become a Sales Agent with Protocol Therapeutics has been approved, and your account is ready.</p>" +
    '<p><a href="[Link]" style="display:inline-block;background:#E0B156;color:#143056;font-weight:700;text-decoration:none;padding:12px 24px;border-radius:8px">Log In to Your Sales Agent Dashboard</a></p>' +
    "<p>Log in with this email address ([Email]). Your dashboard shows your referral link, your sales and your commissions.</p>" +
    "<p>If you have any questions, please contact us at [Contact Email].</p>" +
    "<p>Protocol Therapeutics</p>",
  REP_SIGNUP_REFERRER_APPROVED_BODY:
    "<p>Hi [First Name],</p>" +
    "<p>[Agent Name], who signed up with your referral link, has been approved as a Protocol Therapeutics Sales Agent.</p>" +
    "<p>You will earn a referral commission on their sales, shown on your Sales Agent dashboard.</p>" +
    "<p>Protocol Therapeutics</p>",
  REP_SIGNUP_REFERRER_REJECT_BODY:
    "<p>Hi [First Name],</p>" +
    "<p>Thank you for referring [Agent Name] to Protocol Therapeutics. After reviewing their application, we are unable to approve it at this time.</p>" +
    "<p><b>Reason:</b> [Reason]</p>" +
    "<p>If you have any questions, please contact us at [Contact Email].</p>" +
    "<p>Protocol Therapeutics</p>",
  REP_SIGNUP_REJECT_BODY: [
    "<p>Hi [First Name],</p>" +
      "<p>Thank you for your interest in becoming a Sales Agent with Protocol Therapeutics. " +
      "After reviewing your application, we are unable to approve it at this time.</p>" +
      "<p><b>Reason:</b> [Reason]</p>" +
      "<p>If you have any questions, please contact us at [Contact Email].</p>" +
      "<p>Protocol Therapeutics</p>",
    "<p>Hi [First Name],</p><p>Thank you for your interest in becoming a sales representative with Protocol Therapeutics. " +
      "After reviewing your application, we are unable to approve it at this time.</p><p><b>Reason:</b> [Reason]</p>" +
      "<p>If you have any questions, please contact us at [Contact Email].</p><p>Protocol Therapeutics</p>",
  ],
};
