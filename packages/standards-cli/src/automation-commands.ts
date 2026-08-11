import { resolve } from 'node:path';
import process from 'node:process';
import {
  type DeliveryRuns,
  verifyAutomationEnvironments,
  writeAutomationProof,
} from './automation-verify';
import { request, resolveToken } from './github-api';

const usage = `Usage: standards automation verify [--dir <path>] [--delivery <plane>=<run-id>]

Admin-verifies private-plan capability, exact-main GitHub environments, and secret scope, then records the proof for canonical workflows.`;
const DELIVERY_ARGUMENT =
  /^(?<plane>automation|notifications)=(?<runId>[1-9][0-9]*)$/u;

type AutomationArguments = {
  readonly consumer: string;
  readonly deliveryRuns: DeliveryRuns;
};

const parseArguments = (
  args: ReadonlyArray<string>,
): AutomationArguments | { readonly problem: string } => {
  let consumer = process.cwd();
  const deliveryRuns: Record<string, number> = {};
  let index = 1;
  while (index < args.length) {
    const option = args[index];
    const value = args[index + 1];
    if (option === '--dir' && value !== undefined) {
      consumer = value;
    } else if (option === '--delivery' && value !== undefined) {
      const groups = DELIVERY_ARGUMENT.exec(value)?.groups;
      const plane = groups?.plane;
      const runId = groups?.runId;
      if (
        plane === undefined ||
        runId === undefined ||
        deliveryRuns[plane] !== undefined
      ) {
        return {
          problem:
            '--delivery must be one unique automation|notifications=<run-id> value',
        };
      }
      deliveryRuns[plane] = Number(runId);
    } else {
      return { problem: `unknown or incomplete option ${String(option)}` };
    }
    index += 2;
  }
  return { consumer, deliveryRuns: deliveryRuns as DeliveryRuns };
};

export const runAutomationCommand = async (
  args: ReadonlyArray<string>,
): Promise<boolean> => {
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${usage}\n`);
    return true;
  }
  if (args[0] !== 'verify') {
    process.stderr.write(`${usage}\n`);
    return false;
  }
  const parsed = parseArguments(args);
  if ('problem' in parsed) {
    process.stderr.write(`standards automation: ${parsed.problem}\n`);
    return false;
  }
  try {
    const token = resolveToken();
    if (token === null) {
      throw new Error(
        'automation verification needs an admin token; authenticate gh or set GH_TOKEN',
      );
    }
    const proof = await verifyAutomationEnvironments({
      consumer: resolve(parsed.consumer),
      token,
      api: request,
      now: Date.now(),
      deliveryRuns: parsed.deliveryRuns,
    });
    await writeAutomationProof(resolve(parsed.consumer), proof);
    process.stdout.write(
      `standards automation: verified and recorded ${Object.keys(proof.planes).join(' and ')} environment isolation\n`,
    );
    return true;
  } catch (error) {
    process.stderr.write(
      `standards automation: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
};
