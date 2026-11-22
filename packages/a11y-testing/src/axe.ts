import process from 'node:process';
import AxeBuilder from '@axe-core/playwright';
import type * as playwright from '@playwright/test';
import { animationsSettled } from './animation-settle';
import { scanAtPhoneWidthToo } from './phone-width-scan';
import { mobileDevice } from './playwright-config';

export const wcag22AaTags: ReadonlyArray<string> = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
];

const explicitlyEnabledWcag22AaRules: ReadonlyArray<string> = ['target-size'];

export type AccessibilityViolation = {
  // The viewport the scan saw it at, as `<width>x<height>`.
  readonly viewport: string;
  readonly id: string;
  readonly impact: string | null | undefined;
  readonly help: string;
  readonly nodes: ReadonlyArray<string>;
};

// React/Next.js streaming leaves `<template id="P:n">`/`<template id="B:n">`
// placeholders in the DOM until the postponed or suspended content arrives,
// which can be after `load`. Even once a placeholder is removed, the streamed
// segment is briefly inserted as a raw wrapper element before React unwraps
// it into the final markup, so scanning mid-stream sees transient invalid
// states (for example a `div` standing in for a list item). Wait until every
// placeholder is gone and the DOM structure has stopped changing before
// running Axe.
const reactStreamingPlaceholders = ['P:', 'B:']
  .map((idPrefix) => `template[id^="${idPrefix}"]`)
  .join(', ');
const structuralSettleMilliseconds = 250;
const structuralSettleDeadlineMilliseconds = 10_000;

const waitForStreamedDom = async (page: playwright.Page): Promise<void> => {
  await page.waitForFunction(
    (selector) => document.querySelector(selector) === null,
    reactStreamingPlaceholders,
  );
  const settled = await page.evaluate(
    ({ settleMilliseconds, deadlineMilliseconds }) =>
      new Promise<boolean>((resolve) => {
        const observer = new MutationObserver(() => {
          globalThis.clearTimeout(settleTimer);
          settleTimer = globalThis.setTimeout(
            () => finish(true),
            settleMilliseconds,
          );
        });
        const finish = (quiesced: boolean) => {
          observer.disconnect();
          globalThis.clearTimeout(settleTimer);
          globalThis.clearTimeout(deadlineTimer);
          resolve(quiesced);
        };
        let settleTimer = globalThis.setTimeout(
          () => finish(true),
          settleMilliseconds,
        );
        const deadlineTimer = globalThis.setTimeout(
          () => finish(false),
          deadlineMilliseconds,
        );
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      }),
    {
      settleMilliseconds: structuralSettleMilliseconds,
      deadlineMilliseconds: structuralSettleDeadlineMilliseconds,
    },
  );
  if (!settled) {
    // Written to stderr directly: a console call would need an inline
    // suppression, and suppressions in synced sources break consumer gates
    // that disable the suppressed rule.
    process.stderr.write(
      `Axe scan of ${page.url()} proceeded after the ${structuralSettleDeadlineMilliseconds}ms DOM quiescence deadline; results may reflect a still-mutating page.\n`,
    );
  }
};

const animationSettleDeadlineMilliseconds = 10_000;

const waitForAnimations = async (page: playwright.Page): Promise<void> => {
  try {
    await page.waitForFunction(animationsSettled, undefined, {
      timeout: animationSettleDeadlineMilliseconds,
    });
  } catch {
    process.stderr.write(
      `Axe scan of ${page.url()} proceeded after the ${animationSettleDeadlineMilliseconds}ms animation deadline; results may reflect a still-animating page.\n`,
    );
  }
};

const scanCurrentViewport = async (
  page: playwright.Page,
  viewport: playwright.ViewportSize,
): Promise<ReadonlyArray<AccessibilityViolation>> => {
  await waitForStreamedDom(page);
  await waitForAnimations(page);
  const results = await new AxeBuilder({ page })
    .options({
      runOnly: {
        type: 'tag',
        values: [...wcag22AaTags],
      },
      rules: Object.fromEntries(
        explicitlyEnabledWcag22AaRules.map((ruleId) => [
          ruleId,
          { enabled: true },
        ]),
      ),
    })
    .analyze();

  return results.violations.map((violation) => ({
    viewport: `${viewport.width}x${viewport.height}`,
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => node.target.join(' ')),
  }));
};

// Every scan covers the page's own viewport and the phone's, because layout,
// contrast, and target sizes change with the width, so a test that scans
// needs no second run on a phone. The narrowed page keeps the desktop
// browser's pointer, hover, user agent, and pixel density, so styles that
// depend on those, such as larger touch targets under `pointer: coarse`, are
// scanned as a desktop browser renders them at the phone's width. Tag a test
// that scans such a page with `mobileDeviceTag`, so it also scans on the
// emulated phone. Narrowing can hide the focused element, and the browser then
// moves focus to the body, so the scan gives focus back afterwards.
// Focus moves only if narrowing dropped it to the body, so an element that kept
// focus, or one the page focused on purpose, doesn't run its focus handlers
// again. The focused element is found through open shadow roots, and a
// responsive component that rendered a fresh copy of it gets focus on the copy
// with the same `id`.
const keepFocus = async (
  page: playwright.Page,
): Promise<() => Promise<void>> => {
  const focused = await page.evaluateHandle(() => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) {
      element = element.shadowRoot.activeElement;
    }
    return { element, id: element?.id ?? '' };
  });
  return async () => {
    try {
      await focused.evaluate(({ element, id }) => {
        const focusDropped =
          document.activeElement === null ||
          document.activeElement === document.body;
        const replacement =
          id === '' ? null : document.querySelector(`#${CSS.escape(id)}`);
        const target = element?.isConnected ? element : replacement;
        if (
          focusDropped &&
          (target instanceof HTMLElement || target instanceof SVGElement) &&
          target !== document.body
        ) {
          target.focus({ preventScroll: true });
        }
      });
      await focused.dispose();
    } catch {
      // The page navigated or closed during the scan and took the remembered
      // element with it, so there is nothing to give focus back to.
    }
  };
};

export const scanWcag22AaViolations = (
  page: playwright.Page,
): Promise<ReadonlyArray<AccessibilityViolation>> =>
  scanAtPhoneWidthToo(page, mobileDevice.viewport, {
    scan: (viewport) => scanCurrentViewport(page, viewport),
    keepFocus: () => keepFocus(page),
    // Layout-driven re-renders, such as a navigation rail replacing a drawer,
    // finish before the test continues at its own viewport.
    settle: () => waitForStreamedDom(page),
    inFullscreen: () =>
      page.evaluate(() => document.fullscreenElement !== null),
  });
