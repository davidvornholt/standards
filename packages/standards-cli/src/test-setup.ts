import { afterEach, mock } from 'bun:test';

// Console spies are spies on shared global state: bun returns the existing
// mock object when a test re-spies an already-spied function, so a spy left
// unrestored leaks its recorded calls into whichever later test spies the
// same function — an order-dependent full-suite flake that never reproduces
// in a focused run (issue #247). Restoring every spy after every test makes
// each test's mock state its own without touching any individual test.
afterEach(() => {
  mock.restore();
});
