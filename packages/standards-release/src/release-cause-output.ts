import {
  type Cause,
  defects,
  failures,
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
  const messages = [...failures(cause)].map((failure) => failure.message);
  const hasUntypedCause =
    [...defects(cause)].length > 0 || [...interruptors(cause)].length > 0;
  if (messages.length === 0 || hasUntypedCause) {
    messages.push(pretty(cause));
  }
  return messages
    .map((message) => `::error::${escapeGithubCommand(message)}\n`)
    .join('');
};
