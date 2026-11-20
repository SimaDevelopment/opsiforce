import type { CustomDomainStatus } from '~/api/custom-domains';

export const DOMAIN_STATUS: Record<CustomDomainStatus, { label: string; tone: string; hint: string }> = {
  waiting: {
    label: 'Waiting for DNS',
    tone: 'of-tone-needs-you',
    hint: 'Add the record below at your DNS provider. Changes can take from minutes to a few hours to show up.',
  },
  issuing: {
    label: 'Issuing certificate',
    tone: 'of-tone-running',
    hint: 'DNS is right. A certificate for https is being issued, which usually takes a minute.',
  },
  connected: {
    label: 'Connected',
    tone: 'of-tone-done',
    hint: 'The App is served at this address over https.',
  },
  failed: {
    label: 'Certificate failed',
    tone: 'of-tone-failed',
    hint: 'DNS is right, but the certificate could not be issued.',
  },
};
