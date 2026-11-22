import type * as playwright from '@playwright/test';

export type ResizablePage = Pick<
  playwright.Page,
  'viewportSize' | 'setViewportSize'
>;

export type PhoneWidthScanSteps<Violation> = {
  readonly scan: (
    viewport: playwright.ViewportSize,
  ) => Promise<ReadonlyArray<Violation>>;
  // Remembers the focused element before the page narrows and returns the step
  // that gives focus back to it, because narrowing can hide it and the browser
  // then moves focus to the body.
  readonly keepFocus: () => Promise<() => Promise<void>>;
  readonly settle: () => Promise<void>;
  // Whether an element is in fullscreen, such as a presented slide deck.
  readonly inFullscreen: () => Promise<boolean>;
};

// Scans at the page's current viewport and, when that is wider than the phone,
// again at the phone's viewport, then restores the viewport and focus and lets
// the page settle before the test continues at its own size. While an element
// is in fullscreen it scans only at the current viewport: the fullscreen
// element fills the screen instead of following the window's width, and the
// browser refuses to resize a fullscreen window.
export const scanAtPhoneWidthToo = async <Violation>(
  page: ResizablePage,
  phone: playwright.ViewportSize,
  { scan, keepFocus, settle, inFullscreen }: PhoneWidthScanSteps<Violation>,
): Promise<ReadonlyArray<Violation>> => {
  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error(
      'scanWcag22AaViolations needs a fixed viewport to restore after its phone-width scan; do not set `viewport: null`.',
    );
  }
  const atViewport = await scan(viewport);
  if (viewport.width <= phone.width || (await inFullscreen())) {
    return atViewport;
  }
  const restoreFocus = await keepFocus();
  await page.setViewportSize(phone);
  try {
    return [...atViewport, ...(await scan(phone))];
  } finally {
    await page.setViewportSize(viewport);
    await settle();
    await restoreFocus();
  }
};
