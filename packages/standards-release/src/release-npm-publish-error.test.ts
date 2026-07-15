import { describe, expect, it } from 'bun:test';
import { file, Glob } from 'bun';
import { stagedArtifactFailure } from './release-npm-publish-error';

const CAUSE = 17;
const MESSAGE_PREFIX = 'Preparing package artifact failed while';
const OWNER = 'release-npm-publish-error.ts';
const CONSUMERS = [
  'release-npm-publish-artifact.ts',
  'release-npm-publish-read.ts',
] as const;

describe('staged artifact failure owner', () => {
  it('preserves the tagged error and actionable message', () => {
    const failure = stagedArtifactFailure('reading the staged artifact', CAUSE);

    expect(failure).toMatchObject({
      _tag: 'ArtifactIdentityError',
      message:
        'Preparing package artifact failed while reading the staged artifact: 17',
    });
  });

  it('keeps the message template in its single production owner', async () => {
    const sources = await Promise.all(
      [...new Glob('*.ts').scanSync({ cwd: import.meta.dir })]
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map(async (name) => ({
          name,
          source: await file(`${import.meta.dir}/${name}`).text(),
        })),
    );

    expect(
      sources
        .filter(({ source }) => source.includes(MESSAGE_PREFIX))
        .map(({ name }) => name),
    ).toEqual([OWNER]);
    for (const consumer of CONSUMERS) {
      const source = sources.find(({ name }) => name === consumer)?.source;
      expect(source).toContain("from './release-npm-publish-error'");
      expect(source).not.toContain('new ArtifactIdentityError');
    }
  });
});
