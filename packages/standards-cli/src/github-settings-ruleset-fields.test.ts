import { describe, expect, it } from 'bun:test';
import { loadGithubSettings } from './github-settings';
import {
  BYPASS_ACTORS_KEY,
  rulesetComparedKeys,
} from './github-settings-parse';

const branch = JSON.parse(
  '{"name":"Protect release","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["refs/heads/release/*"],"exclude":[]}},"bypass_actors":[],"rules":[{"type":"deletion"}]}',
) as Readonly<Record<string, unknown>>;
const push = JSON.parse(
  '{"name":"Limit file sizes","target":"push","enforcement":"active","bypass_actors":[],"rules":[{"type":"max_file_size","parameters":{"max_file_size":10}}]}',
) as Readonly<Record<string, unknown>>;
const empty = JSON.stringify({ repository: {}, rulesets: [] });
const declaration = (ruleset: Readonly<Record<string, unknown>>) =>
  JSON.stringify({ repository: {}, rulesets: [ruleset] });

describe('explicit ruleset declarations', () => {
  it.each(
    ['target', 'enforcement', 'conditions', 'bypass_actors'].flatMap((key) => [
      ['canonical', key],
      ['local', key],
    ]),
  )('rejects an omitted %s field: %s', (location, key) => {
    const incomplete = Object.fromEntries(
      Object.entries(branch).filter(([name]) => name !== key),
    );
    const loaded =
      location === 'canonical'
        ? loadGithubSettings(declaration(incomplete), empty)
        : loadGithubSettings(empty, declaration(incomplete));
    const filename =
      location === 'canonical' ? 'settings.json' : 'settings.local.json';
    const advice =
      key === BYPASS_ACTORS_KEY ? '; use [] if nobody may bypass' : '';
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      `.github/${filename} ruleset "Protect release" must declare "${key}"${advice}`,
    ]);
  });

  it.each([
    ['target', null, '"target" must be'],
    ['enforcement', null, '"enforcement" must be'],
    [BYPASS_ACTORS_KEY, null, 'must be an array'],
    ['conditions', null, 'must declare "ref_name.include"'],
    ['conditions', {}, 'must declare "ref_name.include"'],
    [
      'conditions',
      JSON.parse('{"ref_name":{"include":["~ALL"]}}'),
      'must declare "ref_name.include"',
    ],
  ])('rejects an invalid explicit %s field (%j)', (key, value, message) => {
    const loaded = loadGithubSettings(
      empty,
      declaration({ ...branch, [String(key)]: value }),
    );
    expect(loaded.merged).toBeNull();
    expect(loaded.problems.join('\n')).toContain(String(message));
  });

  it.each(['branch', 'tag'])(
    'preserves a complete %s declaration',
    (target) => {
      const ruleset = { ...branch, target };
      const loaded = loadGithubSettings(empty, declaration(ruleset));
      expect(loaded.problems).toEqual([]);
      expect(loaded.merged?.rulesets).toEqual([ruleset]);
    },
  );

  it('accepts push rules without inapplicable branch conditions', () => {
    const loaded = loadGithubSettings(empty, declaration(push));
    expect(loaded.problems).toEqual([]);
    expect(loaded.merged?.rulesets).toEqual([push]);
    expect(rulesetComparedKeys('push')).toEqual([
      'target',
      'enforcement',
      'bypass_actors',
    ]);
  });

  it.each([null, {}])(
    'rejects conditions on a push ruleset (%j)',
    (conditions) => {
      const loaded = loadGithubSettings(
        empty,
        declaration({ ...push, conditions }),
      );
      expect(loaded.merged).toBeNull();
      expect(loaded.problems.join('\n')).toContain(
        'must omit "conditions" for target "push"',
      );
    },
  );
});
