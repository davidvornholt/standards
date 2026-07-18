import { describe, expect, it } from 'bun:test';
import { composeDependabot } from './dependabot-compose';

const { YAML: BunYaml } = await import('bun');

const BASE = [
  'version: 2',
  'updates:',
  '  - package-ecosystem: "bun"',
  '    directory: "/"',
  '    schedule:',
  '      interval: "weekly"',
  '    ignore:',
  '      - dependency-name: "@biomejs/biome"',
  '  - package-ecosystem: "github-actions"',
  '    directory: "/"',
  '    schedule:',
  '      interval: "weekly"',
  '',
].join('\n');

type Config = {
  updates: Array<{
    'package-ecosystem': string;
    ignore?: Array<Record<string, unknown>>;
  }>;
};

const parse = (composed: string): Config => BunYaml.parse(composed) as Config;

describe('composeDependabot', () => {
  it('emits the base with a generated header when there is no overlay', () => {
    const { composed, problems } = composeDependabot(BASE, null);
    expect(problems).toEqual([]);
    expect(composed).toStartWith('# GENERATED FILE - do not edit.');
    const config = parse(composed ?? '');
    expect(config.updates.map((u) => u['package-ecosystem'])).toEqual([
      'bun',
      'github-actions',
    ]);
  });

  it('treats an empty or comments-only overlay as no additions', () => {
    const bare = composeDependabot(BASE, null).composed;
    expect(composeDependabot(BASE, 'updates: []\n').composed).toBe(bare);
    expect(composeDependabot(BASE, '# nothing yet\n').composed).toBe(bare);
  });

  it('appends a new ecosystem block from the overlay', () => {
    const local = [
      'updates:',
      '  - package-ecosystem: "nix"',
      '    directory: "/"',
      '    schedule:',
      '      interval: "weekly"',
      '',
    ].join('\n');
    const { composed, problems } = composeDependabot(BASE, local);
    expect(problems).toEqual([]);
    const config = parse(composed ?? '');
    expect(config.updates.map((u) => u['package-ecosystem'])).toEqual([
      'bun',
      'github-actions',
      'nix',
    ]);
  });

  it('appends overlay ignore holds after the canonical ones', () => {
    const local = [
      'updates:',
      '  - package-ecosystem: "bun"',
      '    directory: "/"',
      '    ignore:',
      '      - dependency-name: "left-pad"',
      '        versions: [">1.0.0"]',
      '',
    ].join('\n');
    const { composed, problems } = composeDependabot(BASE, local);
    expect(problems).toEqual([]);
    const [bun] = parse(composed ?? '').updates;
    expect(bun?.ignore?.map((entry) => entry['dependency-name'])).toEqual([
      '@biomejs/biome',
      'left-pad',
    ]);
  });
});

describe('composeDependabot overlay validation', () => {
  it('rejects overriding keys on a canonical block', () => {
    const local = [
      'updates:',
      '  - package-ecosystem: "bun"',
      '    directory: "/"',
      '    schedule:',
      '      interval: "daily"',
      '',
    ].join('\n');
    const { composed, problems } = composeDependabot(BASE, local);
    expect(composed).toBeNull();
    expect(problems.join('\n')).toContain(
      'may only add ignore entries; remove: schedule',
    );
  });

  it('rejects a matching block without a non-empty ignore list', () => {
    const local = [
      'updates:',
      '  - package-ecosystem: "bun"',
      '    directory: "/"',
      '',
    ].join('\n');
    const { composed, problems } = composeDependabot(BASE, local);
    expect(composed).toBeNull();
    expect(problems.join('\n')).toContain('must add a non-empty ignore list');
  });

  it('rejects unknown top-level overlay keys', () => {
    const { composed, problems } = composeDependabot(BASE, 'version: 2\n');
    expect(composed).toBeNull();
    expect(problems.join('\n')).toContain('may only define "updates"');
  });

  it('rejects duplicate overlay blocks for one ecosystem and directory', () => {
    const local = [
      'updates:',
      '  - package-ecosystem: "nix"',
      '    directory: "/"',
      '    schedule:',
      '      interval: "weekly"',
      '  - package-ecosystem: "nix"',
      '    directory: "/"',
      '    schedule:',
      '      interval: "daily"',
      '',
    ].join('\n');
    const { composed, problems } = composeDependabot(BASE, local);
    expect(composed).toBeNull();
    expect(problems.join('\n')).toContain(
      'must be unique per ecosystem and directory',
    );
  });

  it('reports invalid YAML per file', () => {
    expect(
      composeDependabot('version: [\n', null).problems.join('\n'),
    ).toContain('.github/dependabot.base.yml must contain valid YAML');
    expect(
      composeDependabot(BASE, 'updates: [\n').problems.join('\n'),
    ).toContain('.github/dependabot.local.yml must contain valid YAML');
  });

  it('preserves other canonical top-level keys through composition', () => {
    const base = [
      'version: 2',
      'multi-ecosystem-groups:',
      '  infrastructure:',
      '    schedule:',
      '      interval: "weekly"',
      'updates:',
      '  - package-ecosystem: "bun"',
      '    directory: "/"',
      '    multi-ecosystem-group: "infrastructure"',
      '',
    ].join('\n');
    const { composed, problems } = composeDependabot(base, null);
    expect(problems).toEqual([]);
    const config = BunYaml.parse(composed ?? '') as Record<string, unknown>;
    expect(config['multi-ecosystem-groups']).toEqual({
      infrastructure: { schedule: { interval: 'weekly' } },
    });
  });
});
