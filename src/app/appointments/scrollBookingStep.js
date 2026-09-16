const SCROLL_DURATION_MS = 750;
const INTERRUPT_EVENTS = ["wheel", "touchstart", "touchmove"];

export function scrollBookingStep(target, reduceMotion = false) {
  if (!target) return () => {};

  const startY = window.scrollY;
  const left = window.scrollX;
  const offset = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const maxY = Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight);
  const endY = Math.min(maxY, Math.max(0, startY + target.getBoundingClientRect().top - offset));
  const distance = endY - startY;
  const scrollTo = top => window.scrollTo({ top, left, behavior: "instant" });

  if (reduceMotion || Math.abs(distance) < 1) {
    scrollTo(endY);
    return () => {};
  }

  let frame;
  let cancelled = false;
  const started = performance.now();
  const cancel = () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    INTERRUPT_EVENTS.forEach(event => window.removeEventListener(event, cancel));
  };
  const step = now => {
    if (cancelled) return;
    const progress = Math.min(1, Math.max(0, (now - started) / SCROLL_DURATION_MS));
    const eased = (1 - Math.cos(Math.PI * progress)) / 2;
    scrollTo(startY + distance * eased);
    if (progress < 1) frame = requestAnimationFrame(step);
    else cancel();
  };

  INTERRUPT_EVENTS.forEach(event => window.addEventListener(event, cancel, { passive: true }));
  frame = requestAnimationFrame(step);
  return cancel;
}
