// What decides whether a page has stopped animating: its document and its
// `DocumentTimeline` class.
export type AnimatedPage = {
  readonly documentTimelineClass: abstract new () => object;
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
// anything outside its own body. It reads the page's own document and
// `DocumentTimeline` class unless others are passed in.
export const animationsSettled = (
  page: AnimatedPage = { document, documentTimelineClass: DocumentTimeline },
): boolean =>
  page.document
    .getAnimations()
    .every(
      (animation) =>
        !(animation.timeline instanceof page.documentTimelineClass) ||
        animation.playState === 'finished' ||
        animation.playState === 'idle' ||
        animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY,
    );
