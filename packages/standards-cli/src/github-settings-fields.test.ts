import { describe, expect, it } from 'bun:test';
import { loadGithubSettings } from './github-settings';

const sources = [
  ['canonical', '.github/settings.json'],
  ['local', '.github/settings.local.json'],
] as const;

const fieldCases = [
  ['repository', 'omitted', undefined, null],
  ['repository', 'null', null, 'object'],
  ['repository', 'scalar', 'invalid', 'object'],
  ['repository', 'object', {}, null],
  ['repository', 'array', [], 'object'],
  ['rulesets', 'omitted', undefined, null],
  ['rulesets', 'null', null, 'array'],
  ['rulesets', 'scalar', 'invalid', 'array'],
  ['rulesets', 'object', {}, 'array'],
  ['rulesets', 'array', [], null],
] as const;

for (const [source, fileLabel] of sources) {
  describe(`${fileLabel} field shapes`, () => {
    it.each(
      fieldCases,
    )('%s handles the %s shape', (field, _shape, value, expectedType) => {
      const declaration =
        value === undefined ? {} : { [field]: value as unknown };
      const serialized = JSON.stringify(declaration);
      const loaded = loadGithubSettings(
        source === 'canonical' ? serialized : '{}',
        source === 'local' ? serialized : '{}',
      );

      const expectedProblems =
        expectedType === null
          ? []
          : [`${fileLabel} "${field}" must be an ${expectedType}`];
      expect(loaded.problems).toEqual(expectedProblems);
      expect(loaded.merged === null).toBe(expectedType !== null);
    });
  });
}
