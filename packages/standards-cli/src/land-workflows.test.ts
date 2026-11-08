import { describe, expect, it } from 'bun:test';
import { workflowTriggersCi } from './land-workflows';

describe('workflowTriggersCi', () => {
  it.each([
    ['on: pull_request\n', true],
    ['on: pull_request_target\n', true],
    ['on: push\n', true],
    ['on: schedule\n', false],
    ['on: workflow_dispatch\n', false],
  ])('reads `on` as one event: %j', (text, expected) => {
    expect(workflowTriggersCi(text)).toBe(expected);
  });

  it.each([
    ['on: [workflow_dispatch, push]\n', true],
    ['on:\n  - schedule\n  - pull_request\n', true],
    ['on: [schedule, workflow_dispatch]\n', false],
  ])('reads `on` as a list of events: %j', (text, expected) => {
    expect(workflowTriggersCi(text)).toBe(expected);
  });

  it.each([
    ['on:\n  push:\n    branches: [main]\n', true],
    ['on:\n  pull_request:\n  workflow_dispatch:\n', true],
    [
      "on:\n  schedule:\n    - cron: '0 4 * * 1'\n  workflow_dispatch:\n",
      false,
    ],
    // A chained run reports on the default branch, not the pull request.
    ['on:\n  workflow_run:\n    workflows: [CI]\n', false],
  ])('reads `on` as a map of events: %j', (text, expected) => {
    expect(workflowTriggersCi(text)).toBe(expected);
  });

  it.each([
    ['an unparseable file', 'on: [push\n'],
    ['duplicate keys', 'on: schedule\non: schedule\n'],
    ['a file that is not a map', '- on: schedule\n'],
    ['a missing `on`', 'name: Nightly\n'],
    ['an `on` of another shape', 'on: 3\n'],
    ['an event that is not a name', 'on: [[schedule]]\n'],
    ['a file GitHub could not return in full', null],
  ])('counts %s as CI', (_case, text) => {
    expect(workflowTriggersCi(text)).toBe(true);
  });
});
