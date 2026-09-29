---
name: animations
description: Animations and motion design with motion/react. Load whenever animating any UI element — entrance/exit, hover/tap, drag, swipe-to-dismiss, scroll reveal, layout/shared transition (layoutId, LayoutGroup), page change, staggered list, tab indicator, parallax, scroll progress, imperative sequencing (useAnimate), motion values + transforms (rotate-on-drag, opacity-on-scroll), or prefers-reduced-motion.
---

# Animations (motion/react)

The project uses **motion** (formerly Framer Motion) — preinstalled. All imports come from `motion/react`, not `framer-motion`. The runtime API is identical.

```tsx
import {
  motion,
  AnimatePresence,
  LayoutGroup,
  useInView,
  useScroll,
  useTransform,
  useMotionValue,
  useAnimate,
  useReducedMotion,
} from "motion/react"
```

## Project rules

- **Animate `transform` and `opacity`, not `width`/`height`/`top`/`left`** — only those are GPU-accelerated. Animating layout properties causes jank.
- **Wrap conditional renders in `AnimatePresence`** — exit animations don't fire without it. Every direct child needs a unique `key`.
- **Honor `prefers-reduced-motion`** — use `useReducedMotion` (or the helper below) to disable / shorten animations for users who set the OS flag.
- **Spring physics for UI feedback, tweens for content reveals** — springs feel natural for buttons/tabs; tweens are predictable for hero fades and stagger lists.

## Mount animation

```tsx
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.3 }}
>
  Content
</motion.div>
```

## Hover / tap

```tsx
<motion.button
  whileHover={{ scale: 1.02 }}
  whileTap={{ scale: 0.98 }}
  transition={{ type: "spring", stiffness: 400, damping: 17 }}
>
  Click me
</motion.button>

<motion.div
  whileHover={{ y: -2, boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}
  transition={{ duration: 0.2 }}
>
  <Card>Hoverable card</Card>
</motion.div>
```

## Modals

A modal is the `ui` skill's `Dialog`, which brings the focus trap, ARIA and ESC-to-close. Add motion to its open/close only when you need a non-default entrance.

## Variants — staggered list

Variants attach named animation states to a parent and let children inherit them. The `staggerChildren` transition fires the children one after another.

```tsx
const container = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.05, delayChildren: 0.1 },
  },
}

const item = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } },
}

<motion.ul initial="hidden" animate="visible" variants={container}>
  {items.map((i) => (
    <motion.li key={i.id} variants={item} className="border rounded-lg p-4">
      {i.title}
    </motion.li>
  ))}
</motion.ul>
```

## Animate list add / remove

```tsx
<AnimatePresence mode="popLayout">
  {items.map((item) => (
    <motion.div
      key={item.id}
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
    >
      {item.title}
    </motion.div>
  ))}
</AnimatePresence>
```

`layout` slides the remaining items into place with transforms, so no `height` is animated.

## Shared layout — tab indicator, expanding card

`layoutId` makes Motion smoothly animate the same logical element between positions when it remounts at a different parent.

```tsx
function Tabs({ tabs, activeTab, onChange }: {
  tabs: string[]
  activeTab: string
  onChange: (tab: string) => void
}) {
  return (
    <LayoutGroup>
      <div className="flex gap-1 relative">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => onChange(tab)}
            className="relative px-4 py-2 text-sm"
          >
            <span className="relative z-10">{tab}</span>
            {activeTab === tab && (
              <motion.div
                layoutId="active-tab"
                className="absolute inset-0 bg-primary/10 rounded-md"
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
              />
            )}
          </button>
        ))}
      </div>
    </LayoutGroup>
  )
}
```

The `layoutId` string must match across renders. `LayoutGroup` scopes the id so it doesn't collide with other tab groups elsewhere on the page.

## Page route transitions (react-router)

```tsx
import { Outlet, useLocation } from "react-router-dom"

function AnimatedOutlet() {
  const location = useLocation()
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.2 }}
      >
        <Outlet />
      </motion.div>
    </AnimatePresence>
  )
}
```

Use `<AnimatedOutlet />` inside your `Layout` component instead of the bare `<Outlet />`. `mode="wait"` ensures the exit completes before the new page mounts (no double-render flash).

## Drag

```tsx
function DraggableCard() {
  return (
    <motion.div
      drag
      dragConstraints={{ left: -100, right: 100, top: -100, bottom: 100 }}
      dragElastic={0.2}
      dragTransition={{ bounceStiffness: 600, bounceDamping: 20 }}
      whileDrag={{ scale: 1.05, cursor: "grabbing" }}
      className="w-32 h-32 rounded-lg bg-primary cursor-grab"
    />
  )
}
```

Constrain to one axis with `drag="x"` or `drag="y"`. `dragElastic` (0–1) controls how far past the constraint it can stretch.

## Swipe to dismiss

```tsx
function SwipeToDelete({ onDelete, children }: {
  onDelete: () => void
  children: React.ReactNode
}) {
  return (
    <motion.div
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      onDragEnd={(_event, info) => {
        if (info.offset.x < -100) onDelete()
      }}
      className="relative bg-card"
    >
      {children}
    </motion.div>
  )
}
```

Threshold (`-100` here) is the distance the user has to drag before the action fires. `info.velocity.x` is also available if you'd rather trigger on a fast flick.

## Scroll-triggered reveal

```tsx
import { useRef } from "react"
import { motion, useInView } from "motion/react"

function ScrollReveal({ children }: { children: React.ReactNode }) {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: "-100px" })

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5 }}
    >
      {children}
    </motion.div>
  )
}
```

`once: true` plays the animation only on first reveal. `margin: "-100px"` triggers when the element is 100px from the viewport (so it animates as it enters, not after).

## Scroll progress bar

```tsx
function ScrollProgress() {
  const { scrollYProgress } = useScroll()
  return (
    <motion.div
      style={{ scaleX: scrollYProgress }}
      className="fixed top-0 left-0 right-0 h-1 bg-primary origin-left z-50"
    />
  )
}
```

`scrollYProgress` is a `MotionValue` between 0 and 1 — bind it to `scaleX` for a width-based bar, no recalculation needed.

## Parallax with useScroll + useTransform

```tsx
function ParallaxHero() {
  const { scrollY } = useScroll()
  const y = useTransform(scrollY, [0, 500], [0, 150])
  const opacity = useTransform(scrollY, [0, 300], [1, 0])

  return (
    <motion.div
      style={{ y, opacity }}
      className="h-screen flex items-center justify-center"
    >
      <h1 className="text-6xl font-bold">Hero</h1>
    </motion.div>
  )
}
```

`useTransform(input, inputRange, outputRange)` maps scroll position (or any motion value) to a derived value without React re-renders.

## Imperative sequencing — useAnimate

For multi-step animations triggered by an event (form submit, success ping):

```tsx
function SubmitButton() {
  const [scope, animate] = useAnimate()

  const handleClick = async () => {
    await animate(scope.current, { scale: 0.95 }, { duration: 0.1 })
    await animate(scope.current, { scale: 1 }, { type: "spring" })
    await animate(scope.current, { backgroundColor: "hsl(143 71% 45%)" }, { duration: 0.2 })
  }

  return (
    <motion.button ref={scope} onClick={handleClick} className="px-4 py-2 rounded-md bg-primary text-primary-foreground">
      Submit
    </motion.button>
  )
}
```

Use `animate(scope.current, ...)` for the root, or pass a CSS selector to target descendants: `animate("li", { opacity: 1 }, { delay: stagger(0.1) })`.

## Drag-driven values — useMotionValue + useTransform

Bind a draggable element's `x` value to derived properties (rotate, opacity, color) so the transform follows the gesture:

```tsx
function RotatingCard() {
  const x = useMotionValue(0)
  const rotateY = useTransform(x, [-200, 200], [-45, 45])
  const opacity = useTransform(x, [-200, 0, 200], [0.5, 1, 0.5])

  return (
    <motion.div
      drag="x"
      dragConstraints={{ left: -200, right: 200 }}
      style={{ x, rotateY, opacity }}
      className="w-64 h-96 rounded-xl bg-gradient-to-br from-primary to-accent"
    />
  )
}
```

Motion values bypass React's render loop — only the affected style updates each frame.

## Reusable AnimatedContainer

Project-friendly entrance wrapper. Pick one of a small set of named entrances; pass `delay` for staggered hero sections.

```tsx
import { motion, type Variants } from "motion/react"

const presets: Record<string, Variants> = {
  fadeIn:       { hidden: { opacity: 0 },             visible: { opacity: 1 } },
  fadeInUp:     { hidden: { opacity: 0, y: 20 },      visible: { opacity: 1, y: 0 } },
  fadeInDown:   { hidden: { opacity: 0, y: -20 },     visible: { opacity: 1, y: 0 } },
  scaleIn:      { hidden: { opacity: 0, scale: 0.9 }, visible: { opacity: 1, scale: 1 } },
  slideInLeft:  { hidden: { opacity: 0, x: -50 },     visible: { opacity: 1, x: 0 } },
  slideInRight: { hidden: { opacity: 0, x: 50 },      visible: { opacity: 1, x: 0 } },
}

interface AnimatedContainerProps {
  children: React.ReactNode
  animation?: keyof typeof presets
  delay?: number
  duration?: number
  className?: string
}

export function AnimatedContainer({
  children,
  animation = "fadeInUp",
  delay = 0,
  duration = 0.5,
  className,
}: AnimatedContainerProps) {
  return (
    <motion.div
      variants={presets[animation]}
      initial="hidden"
      animate="visible"
      transition={{ duration, delay, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  )
}
```

## Transition presets

Centralize transition objects so the app feels consistent:

```ts
// frontend/src/lib/transitions.ts
export const transitions = {
  spring:       { type: "spring", stiffness: 300, damping: 24 },   // default UI feedback
  springSnappy: { type: "spring", stiffness: 400, damping: 17 },   // buttons, tabs
  springSoft:   { type: "spring", stiffness: 300, damping: 30 },   // layout shifts
  smooth:       { type: "tween", duration: 0.3, ease: "easeInOut" },     // content reveals
  fast:         { type: "tween", duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }, // micro-interactions
  page:         { type: "tween", duration: 0.2, ease: "easeOut" },        // route transitions
} as const

// Usage
import { transitions } from "@/lib/transitions"
<motion.div transition={transitions.springSnappy} />
```

## Reduced motion (accessibility)

```tsx
import { useReducedMotion } from "motion/react"

function AccessibleFadeIn({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion()
  return (
    <motion.div
      initial={{ opacity: 0, y: reduced ? 0 : 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0 : 0.5 }}
    >
      {children}
    </motion.div>
  )
}
```

The rule of thumb: when `reduced` is true, **keep opacity changes** (low motion, useful for state) but **drop transforms** (parallax, slide-in, scale) to zero or skip them. Don't disable animation entirely — fades are fine for almost all users.

## Best practices

- **Add the `layout` prop** to a `motion.div` whose size or position changes due to React state — Motion infers the FLIP transition for free: `<motion.div layout>`.
- **Stagger lists**, don't animate items individually — much smoother and far less code.
- **Use `AnimatePresence mode="wait"`** for page transitions, default mode for list add/remove.
- **Test on a low-end device.** Spring animations with 50+ children will drop frames on a budget Android phone — switch to `duration`-based tweens.
- **Stick to a small palette of presets** (the `transitions` object above). Inconsistent timings make a UI feel chaotic.

## Common mistakes

1. **Missing unique `key` on `AnimatePresence` children** — exit transitions never fire if React reuses the DOM node (a subtler failure than omitting `AnimatePresence` entirely).
2. **Mismatched `layoutId`** — `layoutId` only animates between elements that share the exact same string. If the active tab id changes shape, layout transitions break.
3. **Heavy spring on long lists** — visible jank past ~30 items. Use `duration: 0.2, ease: "easeOut"` for big lists.
4. **Triggering `useInView` re-renders** — pass `once: true` for one-shot reveals, otherwise the hook fires every time the element enters/exits.
5. **Importing from `framer-motion`** — the package was renamed to `motion`. Always import from `motion/react`.
