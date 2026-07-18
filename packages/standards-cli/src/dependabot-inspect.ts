// Semantic validation for the composed .github/dependabot.yml: structural
// shape, schedules, multi-ecosystem groups, and the baseline ecosystems every
// consumer must watch. Like cli.ts, this module is zero-dependency so `bunx`
// can execute the published package.

import { DEPENDABOT_FILE } from './dependabot-compose';
import { isNonEmptyString, isRecord } from './github-settings-parse';

const { YAML: BunYaml } = await import('bun');

const DEPENDABOT_BASELINE_ECOSYSTEMS = ['bun', 'github-actions'] as const;
const DEPENDABOT_SCHEDULE_INTERVALS = new Set([
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'semiannually',
  'yearly',
  'cron',
]);

type DependabotUpdateInspection = {
  readonly problems: ReadonlyArray<string>;
  readonly rootEcosystem: string | null;
};

const inspectDependabotSchedule = (
  schedule: unknown,
  label: string,
): ReadonlyArray<string> => {
  if (!(isRecord(schedule) && isNonEmptyString(schedule.interval))) {
    return [`${label} must define schedule.interval`];
  }
  if (!DEPENDABOT_SCHEDULE_INTERVALS.has(schedule.interval)) {
    return [`${label} has an unsupported schedule.interval`];
  }
  if (schedule.interval === 'cron' && !isNonEmptyString(schedule.cronjob)) {
    return [`${label} must define schedule.cronjob for a cron interval`];
  }
  return [];
};

type DependabotGroupInspection = {
  readonly problems: ReadonlyArray<string>;
  readonly scheduledGroups: ReadonlySet<string>;
};

const inspectDependabotGroups = (
  groups: unknown,
): DependabotGroupInspection => {
  if (groups === undefined) {
    return { problems: [], scheduledGroups: new Set() };
  }
  if (!isRecord(groups)) {
    return {
      problems: [`${DEPENDABOT_FILE} multi-ecosystem-groups must be a mapping`],
      scheduledGroups: new Set(),
    };
  }

  const problems: Array<string> = [];
  const scheduledGroups = new Set<string>();
  for (const [name, group] of Object.entries(groups)) {
    const label = `${DEPENDABOT_FILE} multi-ecosystem-groups.${name}`;
    const groupProblems = isRecord(group)
      ? inspectDependabotSchedule(group.schedule, label)
      : [`${label} must be a mapping`];
    problems.push(...groupProblems);
    if (groupProblems.length === 0) {
      scheduledGroups.add(name);
    }
  }
  return { problems, scheduledGroups };
};

const inspectDependabotUpdate = (
  update: unknown,
  index: number,
  scheduledGroups: ReadonlySet<string>,
): DependabotUpdateInspection => {
  const label = `${DEPENDABOT_FILE} updates[${index}]`;
  if (!isRecord(update)) {
    return { problems: [`${label} must be a mapping`], rootEcosystem: null };
  }

  const {
    directory,
    directories,
    schedule,
    'multi-ecosystem-group': multiEcosystemGroup,
    'package-ecosystem': ecosystem,
  } = update;
  const problems: Array<string> = [];
  if (!isNonEmptyString(ecosystem)) {
    problems.push(`${label} must define package-ecosystem`);
  }

  const hasDirectory = isNonEmptyString(directory);
  const hasDirectories =
    Array.isArray(directories) &&
    directories.length > 0 &&
    directories.every(isNonEmptyString);
  if (hasDirectory === hasDirectories) {
    problems.push(
      `${label} must define exactly one of directory or directories`,
    );
  }

  if (schedule === undefined && isNonEmptyString(multiEcosystemGroup)) {
    if (!scheduledGroups.has(multiEcosystemGroup)) {
      problems.push(
        `${label} must reference a scheduled multi-ecosystem group`,
      );
    }
  } else {
    problems.push(...inspectDependabotSchedule(schedule, label));
  }

  const targetsRoot =
    directory === '/' ||
    (Array.isArray(directories) && directories.includes('/'));
  return {
    problems,
    rootEcosystem:
      isNonEmptyString(ecosystem) && targetsRoot ? ecosystem : null,
  };
};

export const inspectDependabot = (raw: string): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  let config: unknown;
  try {
    config = BunYaml.parse(raw);
  } catch {
    return [`${DEPENDABOT_FILE} must contain valid YAML`];
  }

  if (!isRecord(config)) {
    return [`${DEPENDABOT_FILE} must contain a YAML mapping`];
  }
  if (config.version !== 2) {
    problems.push(`${DEPENDABOT_FILE} must use version: 2`);
  }

  const { updates, 'multi-ecosystem-groups': multiEcosystemGroups } = config;
  if (!Array.isArray(updates)) {
    problems.push(`${DEPENDABOT_FILE} must define an updates list`);
    return problems;
  }

  const groupInspection = inspectDependabotGroups(multiEcosystemGroups);
  problems.push(...groupInspection.problems);
  const rootEcosystems = new Set<string>();
  for (const [index, update] of updates.entries()) {
    const inspection = inspectDependabotUpdate(
      update,
      index,
      groupInspection.scheduledGroups,
    );
    problems.push(...inspection.problems);
    if (inspection.rootEcosystem !== null) {
      rootEcosystems.add(inspection.rootEcosystem);
    }
  }

  for (const ecosystem of DEPENDABOT_BASELINE_ECOSYSTEMS) {
    if (!rootEcosystems.has(ecosystem)) {
      problems.push(
        `${DEPENDABOT_FILE} must include a root-directory ${ecosystem} ecosystem`,
      );
    }
  }
  return problems;
};
