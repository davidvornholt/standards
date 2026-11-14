import { describe, expect, it } from 'bun:test';
import { workflowTriggersCi } from './land-workflows';

// A pull request from feature/topic into trunk that changes one file.
const target = (changed: ReadonlyArray<string> | null = ['src/app.ts']) => ({
  base: 'trunk',
  head: 'feature/topic',
  changedFiles: () => changed,
});

const triggers = (text: string, changed?: ReadonlyArray<string> | null) =>
  workflowTriggersCi(text, target(changed));

describe('workflowTriggersCi with activity types', () => {
  it.each([
    ['on:\n  pull_request:\n    types: [closed]\n', false],
    ['on:\n  pull_request_target:\n    types: closed\n', false],
    ['on:\n  pull_request:\n    types: [opened]\n', true],
    ['on:\n  pull_request:\n    types: [closed, synchronize]\n', true],
    // A label can trigger a run just before land merges.
    ['on:\n  pull_request:\n    types: [labeled]\n', true],
    ['on:\n  pull_request:\n    types: {closed: true}\n', true],
  ])('reads %j', (text, expected) => {
    expect(triggers(text)).toBe(expected);
  });
});

describe('workflowTriggersCi with branch and tag filters', () => {
  it.each([
    // Pull request filters match the base branch.
    ['on:\n  pull_request:\n    branches: [main]\n', false],
    ['on:\n  pull_request:\n    branches: [trunk]\n', true],
    ['on:\n  pull_request:\n    branches: trunk\n', true],
    ["on:\n  pull_request:\n    branches: ['tr*']\n", true],
    ["on:\n  pull_request:\n    branches: ['release/**']\n", false],
    ['on:\n  pull_request:\n    branches-ignore: [trunk]\n', false],
    ['on:\n  pull_request:\n    branches-ignore: [main]\n', true],
    // The last pattern that matches decides.
    ["on:\n  pull_request:\n    branches: ['**', '!trunk']\n", false],
    ["on:\n  pull_request:\n    branches: ['**', '!trunk', 'trunk']\n", true],
    // Push filters match the pushed branch, the pull request's head.
    ['on:\n  push:\n    branches: [main]\n', false],
    ["on:\n  push:\n    branches: ['feature/*']\n", true],
    ["on:\n  push:\n    branches: ['*']\n", false],
    ["on:\n  push:\n    branches: ['**']\n", true],
    ["on:\n  push:\n    branches-ignore: ['feature/**']\n", false],
    ["on:\n  push:\n    tags: ['v*']\n", false],
    ["on:\n  push:\n    tags-ignore: ['v*']\n", false],
    ["on:\n  push:\n    tags: ['v*']\n    branches: ['feature/**']\n", true],
    ["on:\n  push:\n    tags: ['v*']\n  pull_request:\n", true],
    // GitHub's other pattern characters.
    ["on:\n  push:\n    branches: ['feature/top?ic']\n", true],
    ["on:\n  push:\n    branches: ['feature/to+pic']\n", true],
    ["on:\n  push:\n    branches: ['[a-f]eature/topic']\n", true],
    ["on:\n  push:\n    branches: ['[g-z]eature/topic']\n", false],
    ["on:\n  push:\n    branches: ['feature\\/topic.x']\n", false],
  ])('reads %j', (text, expected) => {
    expect(triggers(text)).toBe(expected);
  });
});

describe('workflowTriggersCi with path filters', () => {
  it.each([
    ["on:\n  pull_request:\n    paths: ['src/**']\n", true],
    ["on:\n  pull_request:\n    paths: ['docs/**']\n", false],
    ["on:\n  pull_request:\n    paths: ['*.ts']\n", false],
    ["on:\n  pull_request:\n    paths: ['**.ts']\n", true],
    ["on:\n  pull_request:\n    paths: ['src/**', '!src/app.ts']\n", false],
    ["on:\n  pull_request:\n    paths-ignore: ['src/**']\n", false],
    ["on:\n  pull_request:\n    paths-ignore: ['docs/**']\n", true],
    ["on:\n  push:\n    branches: ['**']\n    paths: ['docs/**']\n", false],
  ])('reads %j', (text, expected) => {
    expect(triggers(text)).toBe(expected);
  });

  it('runs when any changed file matches', () => {
    const text = "on:\n  pull_request:\n    paths-ignore: ['**.md']\n";
    expect(triggers(text, ['README.md', 'docs/guide.md'])).toBe(false);
    expect(triggers(text, ['README.md', 'src/app.ts'])).toBe(true);
  });

  it("doesn't list the changed files for a workflow without path filters", () => {
    const text = "on:\n  pull_request:\n    branches: ['**']\n";
    const changedFiles = (): never => {
      throw new Error('listed the changed files');
    };
    expect(workflowTriggersCi(text, { ...target(), changedFiles })).toBeTrue();
  });
});

describe('workflowTriggersCi with filters it cannot read', () => {
  it.each([
    [
      'branches and branches-ignore together',
      'on:\n  pull_request:\n    branches: [main]\n    branches-ignore: [dev]\n',
    ],
    [
      'paths and paths-ignore together',
      'on:\n  pull_request:\n    paths: [docs]\n    paths-ignore: [src]\n',
    ],
    ['a filter of another shape', 'on:\n  push:\n    branches: {main: 1}\n'],
    ['an empty filter', 'on:\n  push:\n    branches: []\n'],
    ['a pattern that is not a name', 'on:\n  push:\n    branches: [[main]]\n'],
    ['an invalid pattern', "on:\n  push:\n    branches: ['+main']\n"],
    ['an event of another shape', 'on:\n  pull_request: 3\n'],
  ])('counts %s as CI', (_case, text) => {
    expect(triggers(text)).toBeTrue();
  });

  it('counts a path filter as CI when GitHub lists too many files', () => {
    expect(
      triggers("on:\n  pull_request:\n    paths: ['docs/**']\n", null),
    ).toBe(true);
  });
});
