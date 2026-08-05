const UNSAFE_SCRIPT_SYNTAX = /[|;#"'`\r\n]/u;
const SCRIPT_WHITESPACE = /\s+/u;
const NON_EXECUTING_TURBO_OPTION = /^(?:-h|-v|--(?:dry|help|version))(?:=|$)/u;

type FilteredTurboAliasViolation =
  | 'empty'
  | 'filter-empty'
  | 'filter-missing'
  | 'filter-option'
  | 'multiple-commands'
  | 'non-executing-option'
  | 'not-run'
  | 'not-turbo'
  | 'syntax'
  | 'task';

export const parseSafeCommands = (
  script: string | null,
): ReadonlyArray<ReadonlyArray<string>> | null => {
  if (
    script === null ||
    script.trim() === '' ||
    UNSAFE_SCRIPT_SYNTAX.test(script) ||
    script.includes('$(')
  ) {
    return null;
  }
  const commands = script.split('&&').map((command) => command.trim());
  return commands.some((command) => command === '' || command.includes('&'))
    ? null
    : commands.map((command) => command.split(SCRIPT_WHITESPACE));
};

export const hasSafeCommands = (
  script: string | null,
  expected: ReadonlyArray<string>,
  exact: boolean,
): boolean => {
  const commands = parseSafeCommands(script)?.map((tokens) => tokens.join(' '));
  if (commands === undefined) {
    return false;
  }
  return exact
    ? commands.length === expected.length &&
        commands.every((command, index) => command === expected[index])
    : expected.every((command) => commands.includes(command));
};

export const hasSafeCommand = (
  script: string | null,
  expected: string,
): boolean => hasSafeCommands(script, [expected], false);

const filteredTurboAliasViolation = (
  script: string,
): FilteredTurboAliasViolation | null => {
  if (script.trim() === '') {
    return 'empty';
  }
  const commands = parseSafeCommands(script);
  if (commands === null) {
    return 'syntax';
  }
  if (commands.length !== 1) {
    return 'multiple-commands';
  }
  const [tokens] = commands;
  if (tokens[0] !== 'turbo') {
    return 'not-turbo';
  }
  if (tokens[1] !== 'run') {
    return 'not-run';
  }
  if (tokens.some((token) => NON_EXECUTING_TURBO_OPTION.test(token))) {
    return 'non-executing-option';
  }
  if (tokens[2]?.startsWith('-') !== false) {
    return 'task';
  }
  const filterAt = tokens.findIndex(
    (token) => token === '--filter' || token.startsWith('--filter='),
  );
  const filter = tokens[filterAt];
  const filterValue =
    filter === '--filter'
      ? tokens[filterAt + 1]
      : filter?.slice('--filter='.length);
  if (filter === undefined) {
    return 'filter-missing';
  }
  if (filterValue === undefined || filterValue === '') {
    return 'filter-empty';
  }
  return filterValue.startsWith('-') ? 'filter-option' : null;
};

export const filteredTurboAliasProblem = (
  name: string,
  script: string,
): string | null => {
  const violation = filteredTurboAliasViolation(script);
  if (violation === null) {
    return null;
  }
  const details: Record<FilteredTurboAliasViolation, string> = {
    empty: 'must be a non-empty single filtered Turbo command',
    'filter-empty': 'must pass a non-empty value to --filter',
    'filter-missing': 'must pass an explicit --filter',
    'filter-option': 'must pass a --filter value that is not another option',
    'multiple-commands':
      'must contain exactly one command; && command chains are not supported',
    'non-executing-option':
      'must execute a task; Turbo help, version, and dry-run options are not allowed',
    'not-run': 'must invoke Turbo through "turbo run"',
    'not-turbo': 'must invoke Turbo directly with "turbo"',
    syntax:
      'contains shell syntax the structure gate does not parse (quotes, |, ;, #, backticks, $(, CR/LF line breaks, or malformed ampersand separators); write one command with plain arguments, using --filter=./apps/* for a glob',
    task: 'must put a task name immediately after "turbo run"',
  };
  return `package.json: root script "${name}" ${details[violation]}`;
};

export const isSafeFilteredTurboAlias = (script: string): boolean =>
  filteredTurboAliasViolation(script) === null;
