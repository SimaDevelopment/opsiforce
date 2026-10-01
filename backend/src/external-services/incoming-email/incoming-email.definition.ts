import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import type {
  AdminRouteContext,
  AgentRouteContext,
  ExternalServiceDefinition,
  JsonValue,
  ServiceRouteTables,
  StoredAttachment,
  StoredMessage,
  WebhookRequest,
  WebhookVerification,
} from '../platform/external-service-definition';
import { environmentIdParam } from '../http/dispatch-request';
import { INCOMING_EMAIL_SERVICE, IncomingEmailAddressService } from './incoming-email-address.service';
import { timingSafeStringEqual } from '../../common/secret-crypto';

const ATTACHMENT_FIELD_PREFIX = 'attachment-';
const SIGNATURE_TOLERANCE_SECONDS = 300;

@Injectable()
export class IncomingEmailDefinition implements ExternalServiceDefinition {
  readonly serviceName = INCOMING_EMAIL_SERVICE;
  readonly displayName = 'Incoming email';
  readonly unroutableResponse = 'reject' as const;

  readonly routes: ServiceRouteTables = {
    agent: [
      {
        method: 'POST',
        path: 'regenerate',
        handler: (context: AgentRouteContext): Promise<JsonValue> => this.regenerate(context.environmentId),
      },
    ],
    admin: [
      {
        method: 'GET',
        path: 'environments/:projectEnvironmentId/address',
        handler: (context: AdminRouteContext): Promise<JsonValue> => this.identity(environmentIdParam(context)),
      },
      {
        method: 'POST',
        path: 'environments/:projectEnvironmentId/address/regenerate',
        handler: (context: AdminRouteContext): Promise<JsonValue> => this.regenerate(environmentIdParam(context)),
      },
    ],
  };

  private readonly logger = new Logger(IncomingEmailDefinition.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly incomingEmailAddressService: IncomingEmailAddressService
  ) {}

  async identity(projectEnvironmentId: string): Promise<JsonValue> {
    return { address: await this.incomingEmailAddressService.getOrCreateAddress(projectEnvironmentId) };
  }

  verify(request: WebhookRequest): WebhookVerification {
    const signingKey = this.configService.get<string>('mailgunWebhookSigningKey', '').trim();
    if (!signingKey) {
      throw new ServiceUnavailableException('Incoming email is not configured on this platform');
    }

    const { timestamp, token, signature } = request.fields;
    if (!timestamp || !token || !signature) {
      return { verified: false, reason: 'Missing Mailgun signature fields' };
    }

    if (!isWithinSignatureWindow(timestamp)) {
      return { verified: false, reason: 'Mailgun signature timestamp is outside the accepted window' };
    }

    const expected = createHmac('sha256', signingKey)
      .update(timestamp + token)
      .digest('hex');
    if (!timingSafeStringEqual(expected, signature)) {
      return { verified: false, reason: 'Invalid Mailgun signature' };
    }

    return { verified: true };
  }

  extractRoutingKeys(request: WebhookRequest): string[] {
    const recipient = request.fields.recipient?.trim().toLowerCase();
    return recipient ? [recipient] : [];
  }

  async resolveEnvironments(routingKey: string): Promise<string[]> {
    const projectEnvironmentId = await this.incomingEmailAddressService.findEnvironmentIdByAddress(routingKey);
    if (!projectEnvironmentId) {
      this.logger.warn(`No environment is routed to incoming-email address ${routingKey}`);
      return [];
    }
    return [projectEnvironmentId];
  }

  async regenerate(projectEnvironmentId: string): Promise<JsonValue> {
    return { address: await this.incomingEmailAddressService.regenerateAddress(projectEnvironmentId) };
  }

  async provisionEnvironment(projectEnvironmentId: string): Promise<void> {
    await this.incomingEmailAddressService.getOrCreateAddress(projectEnvironmentId);
  }

  buildRows(request: WebhookRequest, routingKey: string): StoredMessage[] {
    const { fields } = request;

    return [
      {
        providerMessageId: providerMessageIdOf(fields),
        rawPayload: JSON.stringify(fields),
        routingKey,
        sender: fields.sender ?? null,
        textBody: fields['stripped-text'] ?? null,
        payload: {
          from_header: fields.from ?? null,
          subject: fields.subject ?? null,
          body_plain: fields['body-plain'] ?? null,
          body_html: fields['body-html'] ?? null,
          message_headers: fields['message-headers'] ?? null,
        },
        attachments: attachmentsOf(request),
      },
    ];
  }
}

function isWithinSignatureWindow(timestamp: string): boolean {
  const signedAtSeconds = Number(timestamp);
  if (!Number.isFinite(signedAtSeconds)) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - signedAtSeconds);
  return ageSeconds <= SIGNATURE_TOLERANCE_SECONDS;
}

function attachmentsOf(request: WebhookRequest): StoredAttachment[] {
  return request.files
    .filter((file) => file.fieldName.startsWith(ATTACHMENT_FIELD_PREFIX))
    .map((file) => ({
      filename: file.filename || null,
      contentType: file.contentType || null,
      sizeBytes: file.bytes.byteLength,
      content: file.bytes,
    }));
}

function providerMessageIdOf(fields: Record<string, string>): string {
  return fields['Message-Id'] ?? fields['message-id'] ?? messageIdFromHeaders(fields) ?? fields.token;
}

function messageIdFromHeaders(fields: Record<string, string>): string | null {
  const headers = fields['message-headers'];
  if (!headers) return null;

  try {
    const parsed = JSON.parse(headers) as JsonValue;
    if (!Array.isArray(parsed)) return null;
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [name, value] = entry;
      if (typeof name === 'string' && name.toLowerCase() === 'message-id' && typeof value === 'string') return value;
    }
  } catch {
    return null;
  }
  return null;
}
