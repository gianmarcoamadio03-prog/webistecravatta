"use client";

import React, { useLayoutEffect, useRef, useCallback } from "react";
import Lenis from "lenis";
import styles from "./scrollStack.module.css";

type ScrollStackItemProps = {
  children: React.ReactNode;
  className?: string;
  itemClassName?: string; // compat
};

export const ScrollStackItem = ({ children, className = "", itemClassName = "" }: ScrollStackItemProps) => {
  const cn = [styles.card, itemClassName || className].filter(Boolean).join(" ");
  return <div className={cn}>{children}</div>;
};

type Props = {
  children: React.ReactNode;
  className?: string;

  itemDistance?: number;          // distanza tra le card (margin-bottom)
  itemScale?: number;             // quanto scala ogni card dietro
  itemStackDistance?: number;     // offset verticale nello stack (quanto “si vede” sotto)
  stackPosition?: string | number;
  scaleEndPosition?: string | number;
  baseScale?: number;
  scaleDuration?: number;         // compat (non indispensabile)
  rotationAmount?: number;        // tilt
  blurAmount?: number;            // blur su card dietro
  useWindowScroll?: boolean;

  /** ✅ smoothing vero dei transform */
  transformLerp?: number;         // 0..1 (consigliato 0.12–0.18)
  onStackComplete?: () => void;
};

type T = { translateY: number; scale: number; rotation: number; blur: number };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export default function ScrollStack({
  children,
  className = "",
  itemDistance = 28,
  itemScale = 0.03,
  itemStackDistance = 24,
  stackPosition = "38%",
  scaleEndPosition = "16%",
  baseScale = 0.92,
  scaleDuration = 0.5, // compat
  rotationAmount = 0.12,
  blurAmount = 0,
  useWindowScroll = true,
  transformLerp = 0.14,
  onStackComplete,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lenisRef = useRef<Lenis | null>(null);

  const cardsRef = useRef<HTMLElement[]>([]);
  const lastRef = useRef<Map<number, T>>(new Map());
  const stackCompletedRef = useRef(false);
  const isUpdatingRef = useRef(false);

  const parsePos = useCallback((value: string | number, containerHeight: number) => {
    if (typeof value === "string" && value.includes("%")) {
      return (parseFloat(value) / 100) * containerHeight;
    }
    return typeof value === "number" ? value : parseFloat(value);
  }, []);

  const getScrollData = useCallback(() => {
    if (useWindowScroll) {
      return {
        scrollTop: window.scrollY || 0,
        containerHeight: window.innerHeight || 0,
      };
    }
    const scroller = scrollerRef.current!;
    return {
      scrollTop: scroller.scrollTop,
      containerHeight: scroller.clientHeight,
    };
  }, [useWindowScroll]);

  const getOffsetTop = useCallback(
    (el: HTMLElement) => {
      if (useWindowScroll) {
        const r = el.getBoundingClientRect();
        return r.top + (window.scrollY || 0);
      }
      return el.offsetTop;
    },
    [useWindowScroll]
  );

  const progress = useCallback((scrollTop: number, start: number, end: number) => {
    if (end === start) return 1;
    return clamp01((scrollTop - start) / (end - start));
  }, []);

  const update = useCallback(() => {
    if (!cardsRef.current.length || isUpdatingRef.current) return;
    isUpdatingRef.current = true;

    const { scrollTop, containerHeight } = getScrollData();
    const stackPosPx = parsePos(stackPosition, containerHeight);
    const scaleEndPx = parsePos(scaleEndPosition, containerHeight);

    const root = scrollerRef.current;
    const endEl = root?.querySelector(`.${styles.end}`) as HTMLElement | null;
    const endTop = endEl ? getOffsetTop(endEl) : 0;

    // per calcolare blur “profondità”
    let topCardIndex = 0;
    for (let j = 0; j < cardsRef.current.length; j++) {
      const jTop = getOffsetTop(cardsRef.current[j]);
      const jPinStart = jTop - stackPosPx - itemStackDistance * j;
      if (scrollTop >= jPinStart) topCardIndex = j;
    }

    cardsRef.current.forEach((card, i) => {
      const cardTop = getOffsetTop(card);

      const triggerStart = cardTop - stackPosPx - itemStackDistance * i;
      const triggerEnd = cardTop - scaleEndPx;

      const pinStart = triggerStart;
      const pinEnd = endTop - containerHeight * 0.5;

      const scaleP = progress(scrollTop, triggerStart, triggerEnd);
      const targetScale = baseScale + i * itemScale;
      const scaleTarget = 1 - scaleP * (1 - targetScale);

      const rotTarget = rotationAmount ? i * rotationAmount * scaleP : 0;

      let blurTarget = 0;
      if (blurAmount && i < topCardIndex) {
        blurTarget = Math.max(0, (topCardIndex - i) * blurAmount);
      }

      let yTarget = 0;
      const pinned = scrollTop >= pinStart && scrollTop <= pinEnd;

      if (pinned) {
        yTarget = scrollTop - cardTop + stackPosPx + itemStackDistance * i;
      } else if (scrollTop > pinEnd) {
        yTarget = pinEnd - cardTop + stackPosPx + itemStackDistance * i;
      }

      const prev = lastRef.current.get(i);
      const t = clamp01(transformLerp);

      const next: T = {
        translateY: prev ? lerp(prev.translateY, yTarget, t) : yTarget,
        scale: prev ? lerp(prev.scale, scaleTarget, t) : scaleTarget,
        rotation: prev ? lerp(prev.rotation, rotTarget, t) : rotTarget,
        blur: prev ? lerp(prev.blur, blurTarget, t) : blurTarget,
      };

      card.style.transform = `translate3d(0, ${next.translateY}px, 0) scale(${next.scale}) rotate(${next.rotation}deg)`;
      card.style.filter = next.blur > 0 ? `blur(${next.blur}px)` : "";

      lastRef.current.set(i, next);

      if (i === cardsRef.current.length - 1) {
        const inView = scrollTop >= pinStart && scrollTop <= pinEnd;
        if (inView && !stackCompletedRef.current) {
          stackCompletedRef.current = true;
          onStackComplete?.();
        } else if (!inView && stackCompletedRef.current) {
          stackCompletedRef.current = false;
        }
      }
    });

    isUpdatingRef.current = false;
  }, [
    baseScale,
    blurAmount,
    getOffsetTop,
    getScrollData,
    itemScale,
    itemStackDistance,
    onStackComplete,
    parsePos,
    progress,
    rotationAmount,
    scaleEndPosition,
    stackPosition,
    transformLerp,
  ]);

  const setupLenis = useCallback(() => {
    const root = scrollerRef.current;
    if (!root) return;

    const lenis = new Lenis({
      duration: 1.05,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      lerp: 0.1,
      wheelMultiplier: 1,
      touchMultiplier: 1.8,
      infinite: false,
      ...(useWindowScroll
        ? {}
        : {
            wrapper: root,
            content: root.querySelector(`.${styles.inner}`) as HTMLElement,
            normalizeWheel: true,
          }),
    });

    lenis.on("scroll", update);

    const raf = (time: number) => {
      lenis.raf(time);
      animationFrameRef.current = requestAnimationFrame(raf);
    };
    animationFrameRef.current = requestAnimationFrame(raf);

    lenisRef.current = lenis;
  }, [update, useWindowScroll]);

  useLayoutEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;

    const cards = Array.from(root.querySelectorAll(`.${styles.card}`)) as HTMLElement[];
    cardsRef.current = cards;

    cards.forEach((card, i) => {
      // ✅ distanza controllata da JS (niente margin in CSS)
      if (i < cards.length - 1) card.style.marginBottom = `${itemDistance}px`;
      card.style.willChange = "transform, filter";
      card.style.transformOrigin = "top center";
      card.style.backfaceVisibility = "hidden";
      card.style.transform = "translateZ(0)";
    });

    setupLenis();
    update();

    const onResize = () => update();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (lenisRef.current) lenisRef.current.destroy();
      lastRef.current.clear();
      cardsRef.current = [];
      stackCompletedRef.current = false;
      isUpdatingRef.current = false;
    };
  }, [itemDistance, setupLenis, update, scaleDuration]);

  const scrollerClass = [
    styles.scroller,
    useWindowScroll ? styles.window : styles.local,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={scrollerRef} className={scrollerClass}>
      <div className={styles.inner}>
        {children}
        <div className={styles.end} />
      </div>
    </div>
  );
}
