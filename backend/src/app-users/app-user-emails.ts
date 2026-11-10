import type { AppUserLinkPurpose } from './app-users.types';

export interface AppUserLinkEmail {
  purpose: AppUserLinkPurpose;
  appName: string;
  url: string;
  expiresAt: Date;
}

const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);

const EXPIRES = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

interface Copy {
  subject: string;
  preview: string;
  heading: string;
  intro: string;
  action: string;
  ignore: string;
}

const COPY: Record<AppUserLinkPurpose, (appName: string) => Copy> = {
  invite: (appName) => ({
    subject: `You’re invited to ${appName}`,
    preview: `Choose a password to start using ${appName}.`,
    heading: `Join ${appName}`,
    intro: `You’ve been invited to ${appName}. Choose a password to finish setting up your account, then sign in with this email address.`,
    action: 'Choose a Password',
    ignore: 'If you weren’t expecting this invite, you can ignore this email.',
  }),
  reset: (appName) => ({
    subject: `Reset your password for ${appName}`,
    preview: `Choose a new password for ${appName}.`,
    heading: 'Reset your password',
    intro: `Someone asked to reset the password for your ${appName} account. Choose a new one below; you’ll be signed out everywhere else.`,
    action: 'Choose a New Password',
    ignore: 'If you didn’t ask for this, you can ignore this email. Your password stays the same.',
  }),
};

const letterMark = (appName: string) => escapeHtml([...appName.trim()][0]?.toUpperCase() ?? '?');

export function appUserLinkEmail(email: AppUserLinkEmail): { subject: string; text: string; html: string } {
  const copy = COPY[email.purpose](email.appName);
  const expiry = `This link works once, until ${EXPIRES.format(email.expiresAt)} UTC.`;
  const url = escapeHtml(email.url);
  const text = [copy.heading, '', copy.intro, '', `${copy.action}: ${email.url}`, '', expiry, copy.ignore].join('\n');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f6f7f9;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(copy.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f7f9;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
<tr><td style="padding:32px;font-family:${FONT};color:#111827;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="40" height="40" align="center" valign="middle" style="width:40px;height:40px;border-radius:10px;background-color:#dbeafe;color:#2563eb;font-family:${FONT};font-size:18px;font-weight:700;">${letterMark(email.appName)}</td>
<td style="padding-left:12px;font-family:${FONT};font-size:15px;font-weight:600;color:#111827;">${escapeHtml(email.appName)}</td>
</tr></table>
<h1 style="margin:24px 0 8px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:#111827;">${escapeHtml(copy.heading)}</h1>
<p style="margin:0 0 24px;font-family:${FONT};font-size:15px;line-height:1.6;color:#4b5563;">${escapeHtml(copy.intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="#2563eb" style="border-radius:8px;background-color:#2563eb;">
<a href="${url}" target="_blank" style="display:inline-block;padding:12px 20px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(copy.action)}</a>
</td></tr></table>
<p style="margin:24px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:#6b7280;">${escapeHtml(expiry)}</p>
<p style="margin:16px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;font-family:${FONT};font-size:12px;line-height:1.5;color:#9ca3af;">Button not working? Paste this link into your browser:<br><a href="${url}" target="_blank" style="color:#2563eb;word-break:break-all;">${url}</a></p>
</td></tr>
</table>
<p style="margin:16px 0 0;max-width:480px;font-family:${FONT};font-size:12px;line-height:1.5;color:#9ca3af;text-align:center;">${escapeHtml(copy.ignore)}</p>
</td></tr>
</table>
</body>
</html>`;
  return { subject: copy.subject, text, html };
}
