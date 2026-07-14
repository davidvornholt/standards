import {
  type Cause,
  defects,
  die,
  failures,
  interrupt,
  interruptors,
  pretty,
} from 'effect/Cause';

type MessageFailure = {
  readonly message: string;
};

const escapeGithubCommand = (message: string): string =>
  message
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');

export const renderReleaseCause = <E extends MessageFailure>(
  cause: Cause<E>,
): string => {
  const messages = [
    ...[...failures(cause)].map((failure) => failure.message),
    ...[...defects(cause)].map((defect) => pretty(die(defect))),
    ...[...interruptors(cause)].map((fiberId) => pretty(interrupt(fiberId))),
  ];
  if (messages.length === 0) {
    messages.push(pretty(cause));
  }
  return messages
    .map((message) => `::error::${escapeGithubCommand(message)}\n`)
    .join('');
};
