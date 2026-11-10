import { APP_USER_PASSWORD_MIN_LENGTH } from './app-users.types';

const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #111827; --muted: #6b7280; --border: #e5e7eb; --accent: #2563eb; --accent-soft: #dbeafe; --error: #b91c1c; --done: #15803d; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b0d12; --card: #151821; --text: #f3f4f6; --muted: #9ca3af; --border: #262a36; --accent: #60a5fa; --accent-soft: #1e293b; --error: #f87171; --done: #4ade80; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 28px; }
.mark { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; margin: 0 0 16px; background: var(--accent-soft); color: var(--accent); font-weight: 700; font-size: 18px; }
h1 { font-size: 20px; margin: 0 0 4px; text-wrap: balance; }
p { margin: 0 0 20px; color: var(--muted); }
label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
.forgot { margin: 6px 0 0; text-align: right; }
input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
input[aria-invalid] { border-color: var(--error); }
input[readonly] { color: var(--muted); }
button, .button { display: block; width: 100%; margin-top: 20px; padding: 10px 12px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; touch-action: manipulation; }
button:hover, .button:hover { filter: brightness(1.1); }
button:focus-visible, .button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
a { color: var(--accent); }
.small { font-size: 13px; }
.field-hint { margin: 6px 0 0; font-size: 13px; }
.error { color: var(--error); margin: 12px 0 0; }
.done { color: var(--done); }
.hint { margin: 16px 0 0; font-size: 13px; text-align: center; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0d12" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

const mark = (appName: string) =>
  `<div class="mark" aria-hidden="true">${escapeHtml([...appName.trim()][0]?.toUpperCase() ?? '?')}</div>`;

const errorOf = (error: string | undefined) =>
  error ? `<p class="error" id="form-error" role="alert">${escapeHtml(error)}</p>` : '';

const invalidIf = (error: string | undefined) => (error ? ' aria-invalid="true" aria-describedby="form-error"' : '');

export interface SignInPageInput {
  appName: string;
  action: string;
  request: string;
  csrf: string;
  forgotUrl?: string;
  email?: string;
  error?: string;
}

export function signInPage(input: SignInPageInput): string {
  const invalid = invalidIf(input.error);
  const emailFocus = input.email ? '' : ' autofocus';
  const passwordFocus = input.email ? ' autofocus' : '';
  const forgot = input.forgotUrl
    ? `<p class="forgot small"><a href="${escapeHtml(input.forgotUrl)}">Forgot password?</a></p>`
    : '';
  const hint = input.forgotUrl ? '' : '<p class="hint">Forgot your password? Ask the App’s owner for a reset link.</p>';
  return page(
    `Sign in to ${input.appName}`,
    `${mark(input.appName)}
<h1>Sign in to ${escapeHtml(input.appName)}</h1>
<p>Use the account the App’s owner created for you.</p>
<form method="post" action="${escapeHtml(input.action)}">
<input type="hidden" name="request" value="${escapeHtml(input.request)}">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" required${emailFocus}${invalid} value="${escapeHtml(input.email ?? '')}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required${passwordFocus}${invalid}>
${forgot}
${errorOf(input.error)}
<button type="submit">Sign In</button>
</form>
${hint}`
  );
}

export interface ForgotPasswordPageInput {
  appName: string;
  action: string;
  request: string;
  csrf: string;
  backUrl: string;
  sentTo?: string;
}

export function forgotPasswordPage(input: ForgotPasswordPageInput): string {
  if (input.sentTo !== undefined) {
    return page(
      'Check your email',
      `${mark(input.appName)}
<h1>Check your email</h1>
<p>If ${escapeHtml(input.sentTo)} has an account for ${escapeHtml(input.appName)}, a link to choose a new password is on its way. It works for 1 hour.</p>
<a class="button" href="${escapeHtml(input.backUrl)}">Back to Sign In</a>`
    );
  }
  return page(
    `Reset your password for ${input.appName}`,
    `${mark(input.appName)}
<h1>Reset your password</h1>
<p>Enter the email you sign in to ${escapeHtml(input.appName)} with, and we’ll email you a link to choose a new password.</p>
<form method="post" action="${escapeHtml(input.action)}">
<input type="hidden" name="request" value="${escapeHtml(input.request)}">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
<button type="submit">Email Me a Link</button>
</form>
<p class="hint"><a href="${escapeHtml(input.backUrl)}">Back to Sign In</a></p>`
  );
}

export interface SetPasswordPageInput {
  appName: string;
  action: string;
  token: string;
  email: string;
  purpose: 'invite' | 'reset';
  error?: string;
}

export function setPasswordPage(input: SetPasswordPageInput): string {
  const invalid = invalidIf(input.error);
  const heading = input.purpose === 'invite' ? `Join ${input.appName}` : 'Choose a new password';
  const intro =
    input.purpose === 'invite'
      ? `You’ve been invited to ${escapeHtml(input.appName)}. Choose a password to finish setting up your account.`
      : `Choose a new password for ${escapeHtml(input.appName)}. You’ll be signed out everywhere else.`;
  return page(
    heading,
    `${mark(input.appName)}
<h1>${escapeHtml(heading)}</h1>
<p>${intro}</p>
<form method="post" action="${escapeHtml(input.action)}">
<input type="hidden" name="token" value="${escapeHtml(input.token)}">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" value="${escapeHtml(input.email)}" readonly>
<label for="password">New password</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="${APP_USER_PASSWORD_MIN_LENGTH}" required autofocus${invalid} aria-describedby="password-hint">
<p class="field-hint" id="password-hint">At least ${APP_USER_PASSWORD_MIN_LENGTH} characters.</p>
<label for="confirm">Confirm password</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${APP_USER_PASSWORD_MIN_LENGTH}" required${invalid}>
${errorOf(input.error)}
<button type="submit">${input.purpose === 'invite' ? 'Create Account' : 'Save Password'}</button>
</form>`
  );
}

export interface MessagePageInput {
  title: string;
  message: string;
  appName?: string;
  link?: { href: string; label: string };
}

export function messagePage(input: MessagePageInput): string {
  const action = input.link
    ? `<a class="button" href="${escapeHtml(input.link.href)}">${escapeHtml(input.link.label)}</a>`
    : '';
  const brand = input.appName ? mark(input.appName) : '';
  return page(input.title, `${brand}<h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p>${action}`);
}
