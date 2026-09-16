import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scrollBookingStep } from "@/app/appointments/scrollBookingStep";

let now;
let frames;
let browser;
let nextFrame;

function advanceTo(time) {
  now = time;
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(time));
}

function targetAt(top, margin = "160px") {
  return { margin, getBoundingClientRect: () => ({ top: top - browser.scrollY }) };
}

beforeEach(() => {
  now = 0;
  nextFrame = 0;
  frames = new Map();
  browser = Object.assign(new EventTarget(), {
    scrollX: 0,
    scrollY: 100,
    scrollTo({ top, behavior }) {
      // Native/CSS smooth scrolling must not compete with the animation's frames.
      expect(behavior).toBe("instant");
      this.scrollY = top;
    },
  });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", { documentElement: { scrollHeight: 3000, clientHeight: 800 } });
  vi.stubGlobal("getComputedStyle", target => ({ scrollMarginTop: target.margin }));
  vi.stubGlobal("requestAnimationFrame", callback => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", id => frames.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => vi.unstubAllGlobals());

it("eases in and out over 750ms without an initial jump and keeps the header offset", () => {
  scrollBookingStep(targetAt(1260));
  expect(browser.scrollY).toBe(100);
  advanceTo(125);
  expect(browser.scrollY).toBeGreaterThan(100);
  expect(browser.scrollY).toBeLessThan(200);
  advanceTo(375);
  expect(browser.scrollY).toBeCloseTo(600);
  advanceTo(625);
  expect(browser.scrollY).toBeGreaterThan(1000);
  expect(browser.scrollY).toBeLessThan(1100);
  advanceTo(750);
  expect(browser.scrollY).toBe(1100);
  expect(frames.size).toBe(0);
});

it("scrolls instantly with reduced motion and schedules no animation", () => {
  scrollBookingStep(targetAt(1260), true);
  expect(browser.scrollY).toBe(1100);
  expect(frames.size).toBe(0);
});

it.each(["wheel", "touchstart", "touchmove"])("stops on user %s without overriding their new position", event => {
  scrollBookingStep(targetAt(1260));
  advanceTo(250);
  browser.dispatchEvent(new Event(event));
  browser.scrollY = 210;
  advanceTo(750);
  expect(browser.scrollY).toBe(210);
  expect(frames.size).toBe(0);
});

it("allows effect cleanup to cancel on unmount or before a new selection", () => {
  const cancel = scrollBookingStep(targetAt(1260));
  advanceTo(375);
  cancel();
  cancel();
  advanceTo(750);
  expect(browser.scrollY).toBeCloseTo(600);
  expect(frames.size).toBe(0);
  scrollBookingStep(targetAt(260));
  advanceTo(1125);
  expect(browser.scrollY).toBeCloseTo(350);
  advanceTo(1500);
  expect(browser.scrollY).toBe(100);
});

it.each([
  [50, "160px", 0],
  [2900, "160px", 2200],
  [1000, "200px", 800],
  [1000, "auto", 1000],
])("bounds target %s with margin %s to the scrollable document", (top, margin, expected) => {
  scrollBookingStep(targetAt(top, margin));
  advanceTo(750);
  expect(browser.scrollY).toBe(expected);
});

it("finishes on a delayed frame without overshooting", () => {
  scrollBookingStep(targetAt(1260));
  advanceTo(3000);
  expect(browser.scrollY).toBe(1100);
  expect(frames.size).toBe(0);
});

it("does not animate an absent or already aligned target", () => {
  scrollBookingStep(null)();
  scrollBookingStep(targetAt(260))();
  expect(browser.scrollY).toBe(100);
  expect(frames.size).toBe(0);
});
