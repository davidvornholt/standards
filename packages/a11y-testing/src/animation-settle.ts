// What decides whether a page has stopped animating: its document.
export type AnimatedPage = {
  readonly document: {
    readonly getAnimations: () => ReadonlyArray<{
      readonly playState: AnimationPlayState;
      readonly timeline: object | null;
      readonly effect: {
        readonly getTiming: () => { readonly iterations?: number };
      } | null;
    }>;
  };
};

// Entrance animations fade and move content into place. Axe samples colour
// contrast and target positions from the current frame, so a scan taken
// mid-animation reports failures the settled page does not have. The page has
// settled once every finite time-based animation has finished. Animations
// that never finish on their own are ignored: looping indicators such as
// spinners, and animations not driven by a document timeline. The latter are
// scroll-driven animations, whose scroll or view timeline only advances when
// the page scrolls, and animations without a timeline, which never advance.
//
// Playwright serializes this predicate into the page, so it must not reference
// anything outside its own body. It reads the page's own document unless
// another is passed in. Timeline branding also recognizes document timelines
// from another realm, such as animations on nodes adopted from an iframe.
export const animationsSettled = (page: AnimatedPage = { document }): boolean =>
  page.document
    .getAnimations()
    .every(
      (animation) =>
        Object.prototype.toString.call(animation.timeline) !==
          '[object DocumentTimeline]' ||
        animation.playState === 'finished' ||
        animation.playState === 'idle' ||
        animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY,
    );
