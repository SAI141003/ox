'use client';

import { useEffect, useRef, useState } from 'react';
import { useInView } from 'react-intersection-observer';

/**
 * Lenis-compatible scroll reveal hook.
 *
 * Uses react-intersection-observer with `fallbackInView: true` so it
 * works correctly regardless of the active scroll library (Lenis,
 * Locomotive Scroll, native, etc.).
 *
 * NEVER use Framer Motion's `whileInView` with Lenis — it breaks
 * because Lenis intercepts scroll events. Always use this hook instead.
 */
export function useScrollReveal(options?: {
  threshold?: number;
  triggerOnce?: boolean;
  offset?: readonly number[];
}) {
  const { threshold = 0.1, triggerOnce = true, offset = [0, 0.5, 0, 0.5] } = options ?? {};
  const ref = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);

  const { ref: inViewRef, inView: viewInView } = useInView({
    threshold,
    triggerOnce,
    fallbackInView: true,
    rootMargin: `${offset[0] * 100}px ${offset[1] * 100}px ${offset[2] * 100}px ${offset[3] * 100}px`,
  });

  useEffect(() => {
    if (viewInView) setInView(true);
  }, [viewInView]);

  const mergedRef = (node: HTMLElement | null) => {
    if (typeof inViewRef === 'function') inViewRef(node);
    ref.current = node;
  };

  return { ref: mergedRef, inView };
}
