import type { Field } from '@opsiforce/external-service-sdk/forms';
import { fieldLabelOfPath } from '~/components/external-service-form/form-values';
import { AlertTriangle } from '~/components/icons';

export function NeedsAttentionBanner(props: {
  serviceName: string;
  form: readonly Field[];
  missing: readonly string[];
}) {
  const labels = () => [...new Set(props.missing.map((path) => fieldLabelOfPath(props.form, path)))];
  return (
    <div
      role="alert"
      class="of-note of-tone-needs-you gap-2 text-[0.6875rem]"
    >
      <AlertTriangle class="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        <strong class="font-medium">Needs attention.</strong> {props.serviceName} needs{' '}
        {labels().length === 1 ? 'a value for a required field' : 'values for required fields'} here (
        {labels().join(', ')}). Until you save, every call from this environment is refused.
      </span>
    </div>
  );
}
