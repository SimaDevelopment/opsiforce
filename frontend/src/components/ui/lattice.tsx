import { createUniqueId, For } from 'solid-js';
import { cn } from '~/lib/cn';

/**
 * The hexagonal lattice — the one brand field in the product, and the one
 * texture that stands for absence. It is drawn, never an image, so it takes
 * its colour from the theme and costs nothing to ship.
 *
 * `variant="empty"` is the absence texture: the same geometry in the subtle
 * ink at a higher opacity, for empty states. The default is the brand field,
 * faint enough to read as a surface rather than a pattern.
 */
export function Lattice(props: { scale?: number; variant?: 'brand' | 'empty'; class?: string }) {
  // the brand field is drawn large and faint, the absence texture small and
  // denser — the two are not the same pattern at two opacities
  const scale = () => props.scale ?? (props.variant === 'empty' ? 0.7 : 1.35);
  const pathId = createUniqueId();
  const patternId = createUniqueId();

  // one hexagon, point-up, then the seven offsets that tile it seamlessly
  const geometry = () => {
    const s = 14 * scale();
    const hw = 12.124 * scale();
    const hh = 7 * scale();
    const width = 24.249 * scale();
    const height = 42 * scale();
    const hex = [
      `M0,${(-s).toFixed(2)}`,
      `L${hw.toFixed(2)},${(-hh).toFixed(2)}`,
      `L${hw.toFixed(2)},${hh.toFixed(2)}`,
      `L0,${s.toFixed(2)}`,
      `L${(-hw).toFixed(2)},${hh.toFixed(2)}`,
      `L${(-hw).toFixed(2)},${(-hh).toFixed(2)}`,
      'Z',
    ].join(' ');
    const offsets: [number, number][] = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
      [width / 2, height / 2],
      [width / 2, -height / 2],
      [width / 2, height * 1.5],
    ];
    return { hex, offsets, width, height };
  };

  return (
    <svg
      class={cn('of-lattice', props.variant === 'empty' && 'of-lattice-empty', props.class)}
      aria-hidden="true"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <path id={pathId} d={geometry().hex} />
        <pattern
          id={patternId}
          patternUnits="userSpaceOnUse"
          width={geometry().width.toFixed(3)}
          height={geometry().height.toFixed(3)}
        >
          <g fill="none" stroke="currentColor" stroke-width="1">
            <For each={geometry().offsets}>{([x, y]) => (
              <use href={`#${pathId}`} x={x.toFixed(2)} y={y.toFixed(2)} />
            )}</For>
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  );
}
