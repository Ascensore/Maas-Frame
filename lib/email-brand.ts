export const EMAIL_COLORS = {
  bg: '#171717',
  card: '#252525',
  cardInner: '#2f2f2f',
  border: '#3a3a3a',
  accent: '#7aa7ff',
  accentDark: '#243656',
  text: '#f5f5f5',
  textSecondary: '#c6c6cc',
  textDim: '#8d8d95',
} as const;

function brandLogoSvg(): string {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;pointer-events:none;">
    <rect x="2" y="6" width="14" height="12" rx="2" stroke="${EMAIL_COLORS.accent}" stroke-width="2" />
    <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" stroke="${EMAIL_COLORS.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RAW_EMAIL_HTML = Symbol('rawEmailHtml');

/** Markup a caller has already built and vouches for. See {@link rawEmailHtml}. */
export type RawEmailHtml = { readonly [RAW_EMAIL_HTML]: string };

/**
 * Opt a value out of escaping. The helpers below escape everything they are given, so a
 * caller that genuinely needs markup, a `<span>` around one half of a label, has to say
 * so here. That keeps the default safe: a project name or a display name passed straight
 * into a helper is escaped whether or not the caller remembered to.
 */
export function rawEmailHtml(html: string): RawEmailHtml {
  return { [RAW_EMAIL_HTML]: html };
}

export type EmailText = string | RawEmailHtml;

function renderEmailText(value: EmailText): string {
  return typeof value === 'string' ? escapeHtml(value) : value[RAW_EMAIL_HTML];
}

export function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * `bodyHtml` is markup, not text: it is assembled from the helpers below, so it is the one
 * value here that is inserted verbatim. Everything a caller supplies as text, the footer
 * included, is escaped.
 */
export function brandedEmailTemplate(
  bodyHtml: string,
  options?: {
    footerText?: string;
    footerLinkText?: string;
    footerLinkUrl?: string;
  }
): string {
  const body = bodyHtml;
  const footerText = options?.footerText || '';
  const footerLinkText = options?.footerLinkText || '';
  const footerLinkUrl = options?.footerLinkUrl || '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="dark"></head>
<body style="margin:0;padding:0;background-color:${EMAIL_COLORS.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${EMAIL_COLORS.text};">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:${EMAIL_COLORS.bg};padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding:0 0 24px;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="padding-right:10px;vertical-align:middle;">${brandLogoSvg()}</td>
            <td style="vertical-align:middle;font-size:16px;font-weight:700;color:${EMAIL_COLORS.text};letter-spacing:0.08em;">OpenFrame</td>
          </tr></table>
        </td></tr>

        <tr><td style="background-color:${EMAIL_COLORS.card};border:1px solid ${EMAIL_COLORS.border};padding:0;">
          ${body}
        </td></tr>

        ${
          footerText || (footerLinkText && footerLinkUrl)
            ? `
        <tr><td style="padding:20px 0 0;text-align:center;">
          ${footerText ? `<p style="margin:0 0 6px;font-size:11px;color:${EMAIL_COLORS.textDim};">${escapeHtml(footerText)}</p>` : ''}
          ${footerLinkText && footerLinkUrl ? `<a href="${escapeAttr(footerLinkUrl)}" style="font-size:11px;color:${EMAIL_COLORS.accent};text-decoration:underline;">${escapeHtml(footerLinkText)}</a>` : ''}
        </td></tr>`
            : ''
        }
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function emailHeading(icon: EmailText, title: EmailText): string {
  return `<td style="padding:16px 20px;border-bottom:1px solid ${EMAIL_COLORS.border};background-color:${EMAIL_COLORS.accentDark};">
      <span style="font-size:14px;font-weight:600;color:${EMAIL_COLORS.accent};">${renderEmailText(icon)} &nbsp;${renderEmailText(title)}</span>
    </td>`;
}

export function emailRow(label: EmailText, value: EmailText, isHighlight = false): string {
  const valStyle = isHighlight
    ? `color:${EMAIL_COLORS.text};font-weight:600;`
    : `color:${EMAIL_COLORS.textSecondary};`;
  return `<tr>
      <td style="padding:6px 16px 6px 0;color:${EMAIL_COLORS.textDim};font-size:13px;white-space:nowrap;vertical-align:top;">${renderEmailText(label)}</td>
      <td style="padding:6px 0;font-size:13px;${valStyle}">${renderEmailText(value)}</td>
    </tr>`;
}

export function emailButton(text: EmailText, url: string): string {
  return `<a href="${escapeAttr(url)}" style="display:inline-block;padding:9px 22px;background-color:${EMAIL_COLORS.accent};color:#0f1114;font-size:13px;font-weight:700;text-decoration:none;letter-spacing:0.2px;">${renderEmailText(text)}</a>`;
}

export function emailHighlight(text: EmailText): string {
  return `<div style="border:1px solid ${EMAIL_COLORS.border};padding:10px 12px;margin:0 0 16px;background-color:${EMAIL_COLORS.cardInner};color:${EMAIL_COLORS.text};font-size:13px;line-height:1.5;">${renderEmailText(text)}</div>`;
}
