// Terminal prompts for login flows. Hidden input never echoes: pasted
// bootstrap tokens must not land in terminal scrollback or transcripts.

import process from 'node:process';
import { createInterface } from 'node:readline/promises';

const END_OF_TRANSMISSION = '\u0004';
const INTERRUPT = '\u0003';
const DELETE = '\u007f';

export const promptLine = async (question: string): Promise<string> => {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
};

const isSubmit = (char: string): boolean =>
  char === '\r' || char === '\n' || char === END_OF_TRANSMISSION;

const applyChar = (value: string, char: string): string =>
  char === DELETE || char === '\b' ? value.slice(0, -1) : value + char;

export const promptHidden = (question: string): Promise<string> => {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    return promptLine(question);
  }
  stdout.write(question);
  return new Promise((resolvePromise) => {
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const finish = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (isSubmit(char)) {
          finish();
          resolvePromise(value.trim());
          return;
        }
        if (char === INTERRUPT) {
          finish();
          process.kill(process.pid, 'SIGINT');
          return;
        }
        value = applyChar(value, char);
      }
    };
    stdin.on('data', onData);
  });
};
