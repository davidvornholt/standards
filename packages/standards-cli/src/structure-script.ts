const UNSAFE_SCRIPT_SYNTAX = /[|;#"'`\r\n]/u;
const SCRIPT_WHITESPACE = /\s+/u;
const NON_EXECUTING_TURBO_OPTION = /^(?:-h|-v|--(?:dry|help|version))(?:=|$)/u;

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

export const isSafeFilteredTurboAlias = (script: string): boolean => {
  const commands = parseSafeCommands(script);
  if (commands?.length !== 1) {
    return false;
  }
  const [tokens] = commands;
  const filterAt = tokens.findIndex(
    (token) => token === '--filter' || token.startsWith('--filter='),
  );
  const filter = tokens[filterAt];
  const filterValue =
    filter === '--filter'
      ? tokens[filterAt + 1]
      : filter?.slice('--filter='.length);
  return tokens[0] !== 'turbo' || tokens[1] !== 'run'
    ? false
    : tokens[2]?.startsWith('-') === false &&
        !tokens.some((token) => NON_EXECUTING_TURBO_OPTION.test(token)) &&
        filterValue !== undefined &&
        filterValue !== '' &&
        !filterValue.startsWith('-');
};
