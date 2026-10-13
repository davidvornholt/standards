#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import process from 'node:process';
import { networkIsolatedCommand } from './network-isolation';

// Runs `playwright test` with this command's arguments in a private
// loopback-only network namespace where the host supports one, and on the
// host network otherwise. The installed Playwright comes from PATH, as in a
// `playwright test` package script.

const forwardedSignals = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
const signalExitBase = 128;
const { command, notice } = networkIsolatedCommand([
  'playwright',
  'test',
  ...process.argv.slice(2),
]);
const [program = 'playwright', ...args] = command;

if (notice !== null) {
  process.stderr.write(`a11y-playwright: ${notice}\n`);
}

const tests = spawn(program, args, { stdio: 'inherit' });
const forward = (signal: NodeJS.Signals) => {
  tests.kill(signal);
};
for (const signal of forwardedSignals) {
  process.on(signal, forward);
}

tests.on('error', (error) => {
  process.stderr.write(
    `a11y-playwright: could not start ${program}: ${error.message}\n`,
  );
  process.exit(1);
});

tests.on('exit', (code, signal) => {
  for (const forwarded of forwardedSignals) {
    process.off(forwarded, forward);
  }
  if (signal === null) {
    process.exit(code ?? 1);
  }
  // End the same way Playwright ended, so callers see the signal. The exit
  // code is the shell's convention in case the signal does not end this
  // process.
  process.exitCode = signalExitBase + constants.signals[signal];
  process.kill(process.pid, signal);
});
