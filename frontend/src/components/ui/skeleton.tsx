import { splitProps, type JSX } from 'solid-js';
import { cn } from '~/lib/cn';

export function Skeleton(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <div class={cn('animate-pulse rounded-md bg-muted/70', local.class)} {...rest} />;
}
