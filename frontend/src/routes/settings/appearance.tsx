import { For, Show, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { createFileRoute } from '@tanstack/solid-router';
import {
  CONTRASTS,
  DENSITIES,
  FONT_SIZES,
  MODES,
  createAppearance,
  type Contrast,
  type Density,
  type FontSize,
  type Mode,
} from '~/lib/appearance';
import { Contrast as ContrastIcon, Droplet, Monitor, Moon, Palette, Rows3, Sun, Type } from '~/components/icons';
import { ACCENT_SEEDS, BASE_SEEDS, type Seed } from '~/lib/theme-seeds';

export const Route = createFileRoute('/settings/appearance')({
  component: AppearancePage,
});

type IconComponent = Component<{ class?: string }>;

const MODE_LABEL: Record<Mode, string> = { light: 'Light', dark: 'Dark', system: 'System' };
const MODE_ICON: Record<Mode, IconComponent> = { light: Sun, dark: Moon, system: Monitor };
const CONTRAST_LABEL: Record<Contrast, string> = { softer: 'Softer', normal: 'Standard', high: 'High contrast' };
const DENSITY_LABEL: Record<Density, string> = {
  comfortable: 'Comfortable',
  default: 'Default',
  compact: 'Compact',
};
const DENSITY_ROWS: Record<Density, string> = { comfortable: '36px rows', default: '32px rows', compact: '24px rows' };
const FONT_SIZE_LABEL: Record<FontSize, string> = { small: 'Small', default: 'Default', large: 'Large' };
const FONT_SIZE_VALUE: Record<FontSize, string> = { small: '12px base', default: '13px base', large: '14px base' };

/**
 * A seed row. Picking one re-runs the OKLCH generator over the whole semantic
 * layer, so the swatch is the input and every other colour is the output.
 */
function Swatches(props: { label: string; seeds: Seed[]; value: Seed; onChange: (id: string) => void }) {
  return (
    <div class="of-swatch-row">
      <div class="of-swatches" role="radiogroup" aria-label={props.label}>
        <For each={props.seeds}>
          {(seed) => (
            <button
              type="button"
              role="radio"
              class="of-swatch fr"
              aria-checked={props.value.id === seed.id}
              aria-label={seed.name}
              title={seed.name}
              style={{ '--sw-color': seed.color }}
              onClick={() => props.onChange(seed.id)}
            />
          )}
        </For>
      </div>
      <span class="of-swatch-name">
        <b>{props.value.name}</b>
        <Show when={props.value.note}> · {props.value.note}</Show>
      </span>
    </div>
  );
}

/** One segmented control. Every option is authored, so the choice is visible. */
function Segmented<T extends string>(props: {
  label: string;
  values: readonly T[];
  labels: Record<T, string>;
  icons?: Record<string, IconComponent>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div class="of-seg of-seg-wide" role="radiogroup" aria-label={props.label}>
      <For each={props.values}>
        {(value) => (
          <button
            type="button"
            role="radio"
            class="fr"
            aria-checked={props.value === value}
            onClick={() => props.onChange(value)}
          >
            <Show when={props.icons?.[value]}>{(Icon) => <Dynamic component={Icon()} class="w-3.5 h-3.5" />}</Show>
            {props.labels[value]}
          </button>
        )}
      </For>
    </div>
  );
}

function Field(props: {
  icon: IconComponent;
  title: string;
  description: string;
  /** The resolved value, stated rather than implied — e.g. "36px rows". */
  value?: string;
  children: JSX.Element;
}) {
  return (
    <div class="of-field">
      <div class="of-field-head">
        <span class="of-field-icon">
          <props.icon class="w-4 h-4 shrink-0" />
        </span>
        <span class="tx">
          <b>{props.title}</b>
          <span>{props.description}</span>
        </span>
        <Show when={props.value}>
          <span class="of-chip of-chip-mono">{props.value}</span>
        </Show>
      </div>
      {props.children}
    </div>
  );
}

/**
 * The preview renders real components rather than abstract swatches: a chosen
 * row, an environment badge, a diff line and the primary action are the four
 * places the palette actually has to hold up.
 */
function ThemePreview() {
  return (
    <aside class="of-tprev">
      <p class="t-label t-sub">Preview</p>
      <div class="of-tprev-card">
        <div class="of-row">
          <span class="of-working">
            <i />
            <i />
            <i />
          </span>
          <span class="lbl">Meter Reading Digest</span>
        </div>
        <div class="of-row" data-active="true">
          <span class="of-dot" />
          <span class="lbl">Spend Dashboard</span>
          <span class="of-count">3</span>
        </div>
      </div>

      <div class="of-tprev-card">
        <div class="flex items-center gap-2">
          <b class="t-ui-med t-strong flex-1 truncate">Invoice Reconciliation</b>
          <span class="of-env" style={{ '--env-color': '#1c9a6b' }}>
            <span class="of-dot" />
            PROD
          </span>
        </div>
        <div class="of-tprev-diff">
          <span class="t-mono flex-1 truncate">weekly-digest.ts</span>
          <span class="of-tprev-add">+34</span>
          <span class="of-tprev-del">−6</span>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <button type="button" class="of-btn of-btn-primary fr">
          Publish
        </button>
        <button type="button" class="of-btn of-btn-outline fr">
          Cancel
        </button>
      </div>

      <p class="of-tprev-foot">
        Mode, Contrast, Density and Font apply to the whole page. This panel is here so a choice can be judged against
        real components rather than a row of swatches.
      </p>
    </aside>
  );
}

function AppearancePage() {
  const appearance = createAppearance();

  return (
    <div class="h-full overflow-y-auto">
      <div class="px-6 py-6 max-w-5xl">
        <header class="mb-2">
          <h2 class="t-title" style={{ color: 'var(--ink-strong)' }}>
            Appearance
          </h2>
          <p class="t-body t-sub mt-1 max-w-prose">
            How this app looks on this browser. The choices are stored locally and apply the moment you make them —
            nothing here changes what anyone else sees.
          </p>
        </header>

        <div class="of-set-grid">
          <div>
            <Field
              icon={MODE_ICON[appearance.mode()]}
              title="Mode"
              description={
                appearance.mode() === 'system'
                  ? 'Follows the operating system and keeps following it.'
                  : 'Light and dark are both authored, not inverted.'
              }
              value={appearance.mode() === 'system' ? `System · ${appearance.scheme()}` : undefined}
            >
              <Segmented
                label="Mode"
                values={MODES}
                labels={MODE_LABEL}
                icons={MODE_ICON}
                value={appearance.mode()}
                onChange={appearance.setMode}
              />
            </Field>

            <Field
              icon={Palette}
              title="Base"
              description="The neutral the whole interface is mixed from. Opsiforce tints its greys toward the deep brand indigo rather than sitting on zinc."
            >
              <Swatches
                label="Base"
                seeds={BASE_SEEDS}
                value={appearance.base()}
                onChange={appearance.setBase}
              />
            </Field>

            <Field
              icon={Droplet}
              title="Accent"
              description="Used for the primary action, the focus ring, the open row and the publish fill. Nothing else."
            >
              <Swatches
                label="Accent"
                seeds={ACCENT_SEEDS}
                value={appearance.accent()}
                onChange={appearance.setAccent}
              />
            </Field>

            <Field
              icon={ContrastIcon}
              title="Contrast"
              description="Raises text and border contrast against the canvas. Both text ramps are mixed from their authored base, so a user never types a resolved value."
              value={CONTRAST_LABEL[appearance.contrast()]}
            >
              <Segmented
                label="Contrast"
                values={CONTRASTS}
                labels={CONTRAST_LABEL}
                value={appearance.contrast()}
                onChange={appearance.setContrast}
              />
            </Field>

            <Field
              icon={Rows3}
              title="Density"
              description="Row height for the sidebar lists, the project list, the project tabs, the command palette and the runs dock."
              value={DENSITY_ROWS[appearance.density()]}
            >
              <Segmented
                label="Density"
                values={DENSITIES}
                labels={DENSITY_LABEL}
                value={appearance.density()}
                onChange={appearance.setDensity}
              />
            </Field>

            <Field
              icon={Type}
              title="Font size"
              description="Scales the whole type ramp, not one size in isolation. Both families ship in the repo as web fonts — there is no font CDN, which is what an air-gapped install needs."
              value={FONT_SIZE_VALUE[appearance.fontSize()]}
            >
              <Segmented
                label="Font size"
                values={FONT_SIZES}
                labels={FONT_SIZE_LABEL}
                value={appearance.fontSize()}
                onChange={appearance.setFontSize}
              />
              <div class="of-specimen">
                <span class="sans">Publish Meter Reading Digest to Production</span>
                <span class="mono-s">src/jobs/weekly-digest.ts · 2 changed files</span>
              </div>
            </Field>
          </div>

          <ThemePreview />
        </div>
      </div>
    </div>
  );
}
