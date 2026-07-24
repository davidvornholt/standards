import { afterEach, expect, it } from 'bun:test';
import {
  type BudgetScenario,
  runBudgetScenario,
} from './poller-acknowledgement-budget-test-support';

const originalFetch = globalThis.fetch;
const API_REQUESTS_PER_HOUR = 5000;
const MAX_ACKNOWLEDGEMENT_REQUESTS_PER_HOUR = 3600;
const MINIMUM_REQUEST_HEADROOM = 1400;
const MAX_COMPOUND_QUEUE_REQUESTS_PER_HOUR = 3312;
const MAX_FIVE_PLAN_REQUESTS_PER_HOUR = 2592;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it.each([
  [
    'mixed 12-repository queue',
    { fixes: 1, reviews: 1, persistedPlans: false },
    MAX_ACKNOWLEDGEMENT_REQUESTS_PER_HOUR,
  ],
  [
    'persisted review plans',
    { fixes: 0, reviews: 1, persistedPlans: true },
    MAX_ACKNOWLEDGEMENT_REQUESTS_PER_HOUR,
  ],
  [
    'four fixes and reviews per repo',
    { fixes: 4, reviews: 4, persistedPlans: false },
    MAX_ACKNOWLEDGEMENT_REQUESTS_PER_HOUR,
  ],
  [
    'four fixes and persisted-plan reviews per repo',
    { fixes: 4, reviews: 4, persistedPlans: true },
    MAX_COMPOUND_QUEUE_REQUESTS_PER_HOUR,
  ],
  [
    'five persisted-plan reviews per repo',
    { fixes: 0, reviews: 5, persistedPlans: true },
    MAX_FIVE_PLAN_REQUESTS_PER_HOUR,
  ],
] as const)('retains API headroom for a %s', async (_description, scenario: BudgetScenario, maximumHourlyRequests) => {
  const { hourlyRequests, problems } = await runBudgetScenario(scenario);
  expect(problems).toEqual([]);
  expect(hourlyRequests).toBeLessThanOrEqual(maximumHourlyRequests);
  expect(API_REQUESTS_PER_HOUR - hourlyRequests).toBeGreaterThanOrEqual(
    MINIMUM_REQUEST_HEADROOM,
  );
});
