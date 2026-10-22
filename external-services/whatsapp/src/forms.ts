import type {
  ButtonResult,
  FormDraft,
  FormHandlerContext,
  InfoResult,
  OptionItem,
  OptionsDraft,
} from '@opsiforce/external-service-sdk';

import type { Manifest, ProjectConfiguration, ServiceConfiguration } from '../service.types.ts';
import {
  channelFailure,
  channelOf,
  namedPages,
  registeredSecretOf,
  registeredWebhooks,
  sameText,
  whapi,
  WhapiRefusal,
  type Channel,
  type WhapiWebhook,
} from './client.ts';

const groupChatSuffix = '@g.us';

function receivesMessages(webhook: WhapiWebhook): boolean {
  return (webhook.events ?? []).some((event) => event.type === 'messages' && event.method === 'post');
}

function webhookStatusOf(webhooks: WhapiWebhook[], webhookUrl: string, secret: string): InfoResult {
  const ours = webhooks.find((webhook) => webhook.url === webhookUrl);
  if (!ours && webhooks.length === 0) {
    return { text: 'No webhook is registered with Whapi. Rotate the webhook secret to register it.', level: 'warning' };
  }
  if (!ours) {
    return {
      text: 'Whapi sends this number’s messages to another URL. Rotate the webhook secret to register this deployment.',
      level: 'warning',
    };
  }
  const registered = registeredSecretOf(ours);
  if (!registered || !sameText(secret, registered)) {
    return {
      text: 'Whapi holds another webhook secret. Rotate the webhook secret to register it again.',
      level: 'warning',
    };
  }
  if (!receivesMessages(ours)) {
    return {
      text: 'The webhook is registered without the messages event. Rotate the webhook secret to fix it.',
      level: 'warning',
    };
  }
  return { text: 'Registered with Whapi', level: 'success' };
}

function chatOptionOf(chatId: string, name: string | undefined): OptionItem {
  return {
    value: chatId,
    label: name ?? chatId,
    description: chatId.endsWith(groupChatSuffix) ? 'Group' : chatId.slice(0, chatId.indexOf('@')),
  };
}

async function chatsOf(configuration: ServiceConfiguration, channel: Channel, signal: AbortSignal) {
  const names = new Map<string, string | undefined>();
  await namedPages(configuration, channel, 'chats', signal, names);
  await namedPages(configuration, channel, 'groups', signal, names);
  const groupsFirst = (option: OptionItem) => (option.value.endsWith(groupChatSuffix) ? 0 : 1);
  return [...names]
    .map(([chatId, name]) => chatOptionOf(chatId, name))
    .toSorted((a, b) => groupsFirst(a) - groupsFirst(b) || a.label.localeCompare(b.label));
}

function matchesQuery(option: OptionItem, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return wanted === '' || option.label.toLowerCase().includes(wanted) || option.value.toLowerCase().includes(wanted);
}

function qrImage(base64: string): { mimeType: string; base64: string } {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(base64);
  return dataUrl
    ? { mimeType: dataUrl[1] ?? 'image/png', base64: dataUrl[2] ?? '' }
    : { mimeType: 'image/png', base64 };
}

const formCallBudgetMs = 10_000;

type Context = FormHandlerContext<Manifest>;

function pickedChannelItem(draft: OptionsDraft): unknown {
  const items = (draft.values as ProjectConfiguration).channels ?? [];
  return items.find((item) => item.id === draft.item)?.channel;
}

export async function listChats(draft: OptionsDraft, ctx: Context): Promise<OptionItem[]> {
  const channel = channelOf(ctx.serviceConfiguration, pickedChannelItem(draft));
  if (!channel) return [];
  try {
    const chats = await chatsOf(ctx.serviceConfiguration, channel, AbortSignal.timeout(formCallBudgetMs));
    return chats.filter((chat) => matchesQuery(chat, draft.query));
  } catch (error) {
    throw channelFailure(error, channel);
  }
}

export async function webhookStatus(draft: FormDraft, ctx: Context): Promise<InfoResult> {
  const channel = channelOf(ctx.serviceConfiguration, draft.item);
  const secret = channel?.webhookSecret?.reveal();
  if (!channel || !secret) return { text: 'Save the number to register its webhook.', level: 'info' };
  const { webhookUrl } = ctx.service;
  if (!webhookUrl) {
    return { text: 'OPSIFORCE_PUBLIC_URL is not set, so no webhook can be registered.', level: 'error' };
  }
  try {
    return webhookStatusOf(
      await registeredWebhooks(ctx.serviceConfiguration, channel, AbortSignal.timeout(formCallBudgetMs)),
      webhookUrl,
      secret
    );
  } catch (error) {
    return { text: `Could not ask Whapi: ${(channelFailure(error, channel) as Error).message}`, level: 'error' };
  }
}

export async function showQr(draft: FormDraft, ctx: Context): Promise<ButtonResult> {
  const channel = channelOf(ctx.serviceConfiguration, draft.item);
  if (!channel) return { message: 'Save the number before linking it.', level: 'info' };
  try {
    const login = await whapi<{ base64?: string; expire?: number }>(ctx.serviceConfiguration, channel, {
      method: 'GET',
      path: '/users/login',
      signal: AbortSignal.timeout(formCallBudgetMs),
    });
    if (!login.base64) {
      return { message: 'Whapi sent no QR code; open the channel on the Whapi dashboard.', level: 'warning' };
    }
    const within = typeof login.expire === 'number' ? ` within ${login.expire} seconds` : '';
    return {
      image: qrImage(login.base64),
      caption: `Scan with WhatsApp on the phone of ${channel.label}${within}.`,
    };
  } catch (error) {
    if (error instanceof WhapiRefusal && error.status === 409) {
      return { message: `${channel.label} is already linked to WhatsApp.`, level: 'success' };
    }
    return { message: (channelFailure(error, channel) as Error).message, level: 'error' };
  }
}
