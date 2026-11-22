import type * as playwright from '@playwright/test';

export type ResizablePage = Pick<
  playwright.Page,
  'viewportSize' | 'setViewportSize'
>;

// Scans at the page's current viewport and, when that is wider than the phone,
// again at the phone's viewport, then restores the viewport and lets the page
// settle before the test continues at its own size.
export const scanAtPhoneWidthToo = async <Violation>(
  page: ResizablePage,
  phone: playwright.ViewportSize,
  scan: (
    viewport: playwright.ViewportSize,
  ) => Promise<ReadonlyArray<Violation>>,
  settle: () => Promise<void>,
): Promise<ReadonlyArray<Violation>> => {
  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error(
      'scanWcag22AaViolations needs a fixed viewport to restore after its phone-width scan; do not set `viewport: null`.',
    );
  }
  const atViewport = await scan(viewport);
  if (viewport.width <= phone.width) {
    return atViewport;
  }
  await page.setViewportSize(phone);
  try {
    return [...atViewport, ...(await scan(phone))];
  } finally {
    await page.setViewportSize(viewport);
    await settle();
  }
};
