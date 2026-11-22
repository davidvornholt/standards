import { describe, expect, it } from 'bun:test';
import { type ResizablePage, scanAtPhoneWidthToo } from './phone-width-scan';

type Viewport = { readonly width: number; readonly height: number };

const phone: Viewport = { width: 412, height: 839 };
const desktop: Viewport = { width: 1280, height: 720 };

const recordingPage = (initial: Viewport | null, fullscreen = false) => {
  const events: Array<string> = [];
  let viewport = initial;
  const page: ResizablePage = {
    viewportSize: () => viewport,
    setViewportSize: (size) => {
      viewport = size;
      events.push(`resize ${size.width}x${size.height}`);
      return Promise.resolve();
    },
  };
  const scan = (size: Viewport) => {
    events.push(`scan ${size.width}x${size.height}`);
    return Promise.resolve([`violation at ${size.width}`]);
  };
  const settle = () => {
    events.push('settle');
    return Promise.resolve();
  };
  const keepFocus = () => {
    events.push('remember focus');
    return Promise.resolve(() => {
      events.push('restore focus');
      return Promise.resolve();
    });
  };
  const inFullscreen = () => Promise.resolve(fullscreen);
  return {
    events,
    page,
    steps: { scan, keepFocus, settle, inFullscreen },
    scan,
    current: () => viewport,
  };
};

describe('scanAtPhoneWidthToo', () => {
  it('scans a desktop page again at phone width and restores its viewport and focus', async () => {
    const run = recordingPage(desktop);

    const violations = await scanAtPhoneWidthToo(run.page, phone, run.steps);

    expect(violations).toEqual(['violation at 1280', 'violation at 412']);
    expect(run.events).toEqual([
      'scan 1280x720',
      'remember focus',
      'resize 412x839',
      'scan 412x839',
      'resize 1280x720',
      'settle',
      'restore focus',
    ]);
    expect(run.current()).toEqual(desktop);
  });

  it('scans a page already at phone width or narrower once', async () => {
    const run = recordingPage({ width: 320, height: 900 });

    const violations = await scanAtPhoneWidthToo(run.page, phone, run.steps);

    expect(violations).toEqual(['violation at 320']);
    expect(run.events).toEqual(['scan 320x900']);
  });

  it('scans a page with an element in fullscreen once, without resizing it', async () => {
    const run = recordingPage(desktop, true);

    const violations = await scanAtPhoneWidthToo(run.page, phone, run.steps);

    expect(violations).toEqual(['violation at 1280']);
    expect(run.events).toEqual(['scan 1280x720']);
    expect(run.current()).toEqual(desktop);
  });

  it('restores the viewport and focus when the phone-width scan fails', async () => {
    const run = recordingPage(desktop);
    const failAtPhone = (size: Viewport) =>
      size.width === phone.width
        ? Promise.reject(new Error('axe failed'))
        : run.scan(size);

    await expect(
      scanAtPhoneWidthToo(run.page, phone, {
        ...run.steps,
        scan: failAtPhone,
      }),
    ).rejects.toThrow('axe failed');
    expect(run.current()).toEqual(desktop);
    expect(run.events.slice(-2)).toEqual(['settle', 'restore focus']);
  });

  it('refuses a page without a fixed viewport', async () => {
    const run = recordingPage(null);

    await expect(
      scanAtPhoneWidthToo(run.page, phone, run.steps),
    ).rejects.toThrow('needs a fixed viewport');
    expect(run.events).toEqual([]);
  });
});
