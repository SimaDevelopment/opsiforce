import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';

export function createElementWidth(element: () => HTMLElement | null | undefined, fallback: number): Accessor<number> {
  const [width, setWidth] = createSignal(fallback);

  onMount(() => {
    const target = element();
    if (!target) return;
    const measure = () => setWidth(target.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    onCleanup(() => observer.disconnect());
  });

  return width;
}
