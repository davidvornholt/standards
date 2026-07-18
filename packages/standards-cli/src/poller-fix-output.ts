import { Buffer } from 'node:buffer';
import { isRecord } from './github-settings-parse';
import { FIX_OUTPUT_MARKER } from './poller-protocol';
import { runGit } from './poller-workspace';

export type SealedFixOutput = {
  readonly issueNumber: number;
  readonly approvalId: string;
  readonly title: string;
  readonly body: string;
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
      typeof raw.issueNumber !== 'number' ||
      typeof raw.approvalId !== 'string' ||
      typeof raw.title !== 'string' ||
      typeof raw.body !== 'string' ||
      typeof raw.generatedHead !== 'string'
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
    if (changed.length > 0) {
      return null;
    }
    return parseFixOutputMessage(
      runGit(['-C', cloneDir, 'log', '-1', '--format=%B', sealedHead], null),
      sealedHead,
    );
  } catch {
    return null;
  }
};
