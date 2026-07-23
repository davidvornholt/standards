// Best-effort browser opener for login flows. The URL is always printed too,
// so a failure to spawn an opener is never an error.

import { spawn } from 'node:child_process';
import process from 'node:process';

const openerFor = (platform: string): 'open' | 'start' | 'xdg-open' => {
  if (platform === 'darwin') {
    return 'open';
  }
  if (platform === 'win32') {
    return 'start';
  }
  return 'xdg-open';
};

export const openInBrowser = (url: string): void => {
  try {
    const child = spawn(openerFor(process.platform), [url], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Printed URL remains the fallback.
  }
};
