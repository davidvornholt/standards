import { afterEach, expect, it } from 'bun:test';
import {
  type BudgetScenario,
  runBudgetScenario,
} from './poller-acknowledgement-budget-test-support';

const originalFetch = globalThis.fetch;
const API_REQUESTS_PER_HOUR = 5000;
const MAX_ACKNOWLEDGEMENT_REQUESTS_PER_HOUR = 3600;
const MINIMUM_REQUEST_HEADROOM = 1400;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it.each([
  [
    'mixed 12-repository queue',
    { fixes: 1, reviews: 1, persistedPlans: false },
  ],
  ['persisted review plans', { fixes: 0, reviews: 1, persistedPlans: true }],
  [
    'four fixes and reviews per repo',
    { fixes: 4, reviews: 4, persistedPlans: false },
  ],
] as const)('retains API headroom for a %s', async (_description, scenario: BudgetScenario) => {
  const { hourlyRequests, problems } = await runBudgetScenario(scenario);
  expect(problems).toEqual([]);
  expect(hourlyRequests).toBeLessThanOrEqual(
    MAX_ACKNOWLEDGEMENT_REQUESTS_PER_HOUR,
  );
  expect(API_REQUESTS_PER_HOUR - hourlyRequests).toBeGreaterThanOrEqual(
    MINIMUM_REQUEST_HEADROOM,
  );
});
