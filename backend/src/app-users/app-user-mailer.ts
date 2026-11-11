import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import formData from 'form-data';
import Mailgun from 'mailgun.js';
import type { Interfaces } from 'mailgun.js/definitions';
import { appUserLinkEmail, type AppUserLinkEmail } from './app-user-emails';

@Injectable()
export class AppUserMailer {
  private readonly logger = new Logger(AppUserMailer.name);
  private readonly client: Interfaces.IMailgunClient | null;
  private readonly domain: string;
  private readonly sender: string;

  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('mailgunApiKey') ?? '';
    const url = configService.get<string>('mailgunUrl') ?? '';
    this.domain = configService.get<string>('mailgunDomain') ?? '';
    this.sender = configService.get<string>('mailgunSender') ?? '';
    this.client =
      apiKey && this.domain && this.sender
        ? new Mailgun(formData).client({ username: 'api', key: apiKey, ...(url ? { url } : {}) })
        : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async sendLink(to: string, email: AppUserLinkEmail): Promise<void> {
    if (!this.client) throw new Error('Mailgun is not configured');
    const message = appUserLinkEmail(email);
    try {
      await this.client.messages.create(this.domain, { from: this.sender, to, ...message });
    } catch (err) {
      this.logger.error(`App User ${email.purpose} email to ${to} failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
