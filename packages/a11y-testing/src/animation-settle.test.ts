import { describe, expect, it } from 'bun:test';
import { type AnimatedPage, animationsSettled } from './animation-settle';

type PageAnimation = ReturnType<
  AnimatedPage['document']['getAnimations']
>[number];

class ForeignDocumentTimeline {
  readonly [Symbol.toStringTag] = 'DocumentTimeline';
}

const documentTimeline = { [Symbol.toStringTag]: 'DocumentTimeline' };
const scrollTimeline = {};
const viewTimeline = {};

const animation = (
  timeline: object | null,
  playState: AnimationPlayState,
  iterations = 1,
): PageAnimation => ({
  playState,
  timeline,
  effect: { getTiming: () => ({ iterations }) },
});

const pageWith = (
  ...animations: ReadonlyArray<PageAnimation>
): AnimatedPage => ({
  document: { getAnimations: () => animations },
});

describe('animationsSettled', () => {
  it('does not wait for scroll-driven animations', () => {
    expect(
      animationsSettled(
        pageWith(
          animation(scrollTimeline, 'running'),
          animation(viewTimeline, 'running'),
          animation(documentTimeline, 'finished'),
        ),
      ),
    ).toBe(true);
  });

  it('waits for a finite time-based animation next to a scroll-driven one', () => {
    expect(
      animationsSettled(
        pageWith(
          animation(scrollTimeline, 'running'),
          animation(documentTimeline, 'running'),
        ),
      ),
    ).toBe(false);
  });

  it('waits for a finite animation on another document timeline', () => {
    for (const timeline of [
      { ...documentTimeline },
      new ForeignDocumentTimeline(),
    ]) {
      expect(animationsSettled(pageWith(animation(timeline, 'running')))).toBe(
        false,
      );
    }
  });

  it('does not wait for looping or idle time-based animations', () => {
    expect(
      animationsSettled(
        pageWith(
          animation(documentTimeline, 'running', Number.POSITIVE_INFINITY),
          animation(documentTimeline, 'idle'),
        ),
      ),
    ).toBe(true);
  });

  it('does not wait for animations without a timeline', () => {
    expect(animationsSettled(pageWith(animation(null, 'running')))).toBe(true);
  });
});
