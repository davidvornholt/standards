import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export const wcag22AaTags: ReadonlyArray<string> = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
];

const explicitlyEnabledWcag22AaRules: ReadonlyArray<string> = ['target-size'];

export type AccessibilityViolation = {
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
// biome-ignore lint/security/noSecrets: CSS selector for React streaming placeholders, not a credential.
const reactStreamingPlaceholders = 'template[id^="P:"], template[id^="B:"]';
const structuralSettleMilliseconds = 250;
const structuralSettleDeadlineMilliseconds = 10_000;

const waitForStreamedDom = async (page: Page): Promise<void> => {
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
    // biome-ignore lint/suspicious/noConsole: deliberate test-runner diagnostic so a starved quiescence wait is visible instead of resurfacing as a random Axe flake.
    console.warn(
      `Axe scan of ${page.url()} proceeded after the ${structuralSettleDeadlineMilliseconds}ms DOM quiescence deadline; results may reflect a still-mutating page.`,
    );
  }
};

export const scanWcag22AaViolations = async (
  page: Page,
): Promise<ReadonlyArray<AccessibilityViolation>> => {
  await waitForStreamedDom(page);
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
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => node.target.join(' ')),
  }));
};
