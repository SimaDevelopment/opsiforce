---
name: send-email
description: The platform does NOT currently support sending emails. Use when the user asks for email features (notifications, reports, welcome emails, password resets, etc.) to explain this limitation.
---

# Sending Emails — NOT SUPPORTED

Sending is unsupported (the `platform` skill). When the user asks for a feature that would normally send an email:

1. **Tell the user directly** that the App cannot send email.
2. **Suggest an in-app alternative** that delivers the same value without email, for example:
   - A dashboard page, list view, or banner that surfaces the information the user would have received by email.
   - A scheduled job (see the `schedules` skill) that updates an in-app record the user checks when they open the app.
   - An export button (CSV/JSON download) for reports the user would otherwise receive by email.
3. **No mail library works** (`nodemailer`, `@sendgrid/mail`, `mailgun.js`, `resend`, …) — the App has no outbound SMTP or API credentials.
4. **Do not call** the service gateway with `service: "email"`. The backend rejects that request with an error.
