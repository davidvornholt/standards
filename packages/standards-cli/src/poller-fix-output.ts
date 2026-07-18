import { Buffer } from 'node:buffer';
import { isRecord } from './github-settings-parse';
import {
  assertCleanOutputWorktree,
  commitCountBetween,
  isAncestor,
  isGitObjectId,
  singleParentOf,
} from './poller-output-integrity';
import { FIX_OUTPUT_MARKER } from './poller-protocol';
import { runGit } from './poller-workspace';

export type SealedFixOutput = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly approvalId: string;
  readonly title: string;
  readonly body: string;
  readonly baseSha: string;
  readonly commits: number;
  readonly generatedHead: string;
  readonly sealedHead: string;
};

const fixOutputMessage = (
  output: Omit<SealedFixOutput, 'sealedHead'>,
): string =>
  `${FIX_OUTPUT_MARKER}\n${Buffer.from(JSON.stringify(output)).toString('base64url')}`;

const parseFixOutputMessage = (
  message: string,
  sealedHead: string,
): SealedFixOutput | null => {
  const [marker, encoded] = message.trim().split('\n');
  if (marker !== FIX_OUTPUT_MARKER || encoded === undefined) {
    return null;
  }
  try {
    const raw = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as unknown;
    if (
      !isRecord(raw) ||
      typeof raw.repo !== 'string' ||
      typeof raw.issueNumber !== 'number' ||
      typeof raw.approvalId !== 'string' ||
      typeof raw.title !== 'string' ||
      typeof raw.body !== 'string' ||
      typeof raw.baseSha !== 'string' ||
      typeof raw.commits !== 'number' ||
      !Number.isInteger(raw.commits) ||
      raw.commits < 1 ||
      typeof raw.generatedHead !== 'string' ||
      !isGitObjectId(raw.baseSha) ||
      !isGitObjectId(raw.generatedHead)
    ) {
      return null;
    }
    return { ...raw, sealedHead } as SealedFixOutput;
  } catch {
    return null;
  }
};

export const sealFixOutput = (
  workDir: string,
  output: Omit<SealedFixOutput, 'generatedHead' | 'sealedHead'>,
): SealedFixOutput => {
  assertCleanOutputWorktree(workDir);
  const generatedHead = runGit(
    ['-C', workDir, 'rev-parse', 'HEAD'],
    null,
  ).trim();
  runGit(
    [
      '-C',
      workDir,
      '-c',
      'user.name=standards-poller',
      '-c',
      'user.email=standards-poller@users.noreply.github.com',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '--only',
      '-m',
      fixOutputMessage({ ...output, generatedHead }),
    ],
    null,
  );
  const sealedHead = runGit(['-C', workDir, 'rev-parse', 'HEAD'], null).trim();
  return { ...output, generatedHead, sealedHead };
};

export const readSealedFixOutput = (
  cloneDir: string,
  branch: string,
): SealedFixOutput | null => {
  try {
    const sealedHead = runGit(
      ['-C', cloneDir, 'rev-parse', `refs/heads/${branch}`],
      null,
    ).trim();
    const changed = runGit(
      [
        '-C',
        cloneDir,
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        sealedHead,
      ],
      null,
    ).trim();
    const parsed = parseFixOutputMessage(
      runGit(['-C', cloneDir, 'log', '-1', '--format=%B', sealedHead], null),
      sealedHead,
    );
    if (
      changed.length > 0 ||
      parsed === null ||
      singleParentOf(cloneDir, sealedHead) !== parsed.generatedHead ||
      !isAncestor(cloneDir, parsed.baseSha, parsed.generatedHead) ||
      commitCountBetween(cloneDir, parsed.baseSha, parsed.generatedHead) !==
        parsed.commits
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};
