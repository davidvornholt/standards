import { expect, it } from 'bun:test';
import { hasClosingReferenceToIssue } from './poller-closing-reference';

const ISSUE_NUMBER = 7;

it.each([
  ['inline-code comment literal', 'Use `<!--` literally.\n\nFixes #7'],
  ['two-backtick comment literal', 'Use ``<!--`` literally.\n\nFixes #7'],
  ['escaped comment literal', 'Use \\<!-- literally.\n\nFixes #7'],
  ['indented-code comment literal', '    <!-- literal\n\nFixes #7'],
  ['tab-indented comment literal', '\t<!-- literal\n\nFixes #7'],
])('accepts a footer after an %s', (_name, body) => {
  expect(hasClosingReferenceToIssue(body, ISSUE_NUMBER)).toBe(true);
});

it.each([
  ['even escape', 'Use \\\\<!--\n\nFixes #7'],
  ['comment after inline code', '`literal` <!--\n\nFixes #7'],
  ['comment after an unmatched backtick', '` literal <!--\n\nFixes #7'],
  ['indented paragraph continuation', 'Paragraph\n    <!--\n\nFixes #7'],
])('rejects an active %s before the footer', (_name, body) => {
  expect(hasClosingReferenceToIssue(body, ISSUE_NUMBER)).toBe(false);
});
