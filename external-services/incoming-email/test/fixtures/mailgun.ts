export function forwardedEmail(fields: Record<string, string> = {}): Record<string, string> {
  return {
    recipient: 'K3P9X2MQ7FD41ABV@mail.example.com',
    sender: 'ann@customer.example',
    from: 'Ann Customer <ann@customer.example>',
    subject: 'Invoice 42',
    'body-plain': 'Please find the invoice attached.\n\n> earlier reply',
    'stripped-text': 'Please find the invoice attached.',
    'body-html': '<p>Please find the invoice attached.</p>',
    'Message-Id': '<invoice-42@customer.example>',
    'message-headers': JSON.stringify([
      ['Message-Id', '<invoice-42@customer.example>'],
      ['X-Mailer', 'Example Mail'],
    ]),
    ...fields,
  };
}
