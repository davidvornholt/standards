#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const POLICY_FILE = 'sync-standards.local.json';
const DEFAULT_SCHEDULED_SYNC = true;

const loadScheduledSync = () => {
  if (!existsSync(POLICY_FILE)) {
    return DEFAULT_SCHEDULED_SYNC;
  }

  const policy = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
  if (
    typeof policy !== 'object' ||
    policy === null ||
    Array.isArray(policy)
  ) {
    throw new Error(`${POLICY_FILE} must be a JSON object`);
  }
  if (typeof policy.scheduledSync !== 'boolean') {
    throw new Error(`${POLICY_FILE} requires boolean "scheduledSync"`);
  }
  return policy.scheduledSync;
};

const eventName = process.env.GITHUB_EVENT_NAME;
if (eventName !== 'schedule' && eventName !== 'workflow_dispatch') {
  throw new Error(`Unsupported Standards sync event: ${eventName ?? 'unset'}`);
}

const scheduledSync = loadScheduledSync();
const runSync = eventName === 'workflow_dispatch' || scheduledSync;
const outputFile = process.env.GITHUB_OUTPUT;
if (outputFile === undefined || outputFile.length === 0) {
  throw new Error('GITHUB_OUTPUT is required');
}

appendFileSync(outputFile, `run_sync=${runSync}\n`);
console.log(
  runSync
    ? 'standards: sync preflight enabled this run'
    : `standards: scheduled sync disabled by ${POLICY_FILE}`,
);
