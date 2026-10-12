import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Mailgun from 'mailgun.js';
import formData from 'form-data';
import type { Interfaces } from 'mailgun.js/definitions';
import type { ServiceProvider, ServiceProviderContext, ServiceProviderResult } from './service-provider.interface';

interface EmailPayload {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

function isValidEmailPayload(payload: unknown): payload is EmailPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (!p.to || !p.subject) return false;
  if (typeof p.subject !== 'string') return false;
  if (typeof p.to !== 'string' && !Array.isArray(p.to)) return false;
  if (!p.text && !p.html) return false;
  return true;
}

// TODO: remove in the release after External Services v2 ships: the dead POST /api/gateway dispatcher (it refuses email, its only provider)
@Injectable()
export class EmailProvider implements ServiceProvider {
  readonly serviceName = 'email';
  private readonly logger = new Logger(EmailProvider.name);
  private readonly client: Interfaces.IMailgunClient | null;
  private readonly domain: string;
  private readonly sender: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('mailgunApiKey', '');
    this.domain = this.configService.get<string>('mailgunDomain', '');
    this.sender = this.configService.get<string>('mailgunSender', '');
    const mailgunUrl = this.configService.get<string>('mailgunUrl', '');

    if (!apiKey || !this.domain || !this.sender) {
      this.logger.warn('Mailgun not configured — email provider disabled');
      this.client = null;
      return;
    }

    const mailgun = new Mailgun(formData);
    this.client = mailgun.client({
      username: 'api',
      key: apiKey,
      ...(mailgunUrl ? { url: mailgunUrl } : {}),
    });
  }

  async execute(payload: unknown, context: ServiceProviderContext): Promise<ServiceProviderResult> {
    if (!this.client) {
      return { success: false, error: 'Email provider not configured' };
    }

    if (!isValidEmailPayload(payload)) {
      return { success: false, error: "Invalid payload: requires 'to', 'subject', and 'text' or 'html'" };
    }

    try {
      const message = await this.client.messages.create(this.domain, {
        from: this.sender,
        to: payload.to,
        subject: payload.subject,
        ...(payload.text ? { text: payload.text } : {}),
        ...(payload.html ? { html: payload.html } : {}),
      } as Parameters<typeof this.client.messages.create>[1]);

      this.logger.log(`Email sent for project ${context.projectId}: ${message.id}`);
      return { success: true, data: { messageId: message.id } };
    } catch (err) {
      const errorMessage = (err as Error).message;
      this.logger.error(`Email failed for project ${context.projectId}: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }
}
