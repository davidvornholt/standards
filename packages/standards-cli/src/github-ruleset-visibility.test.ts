import { describe, expect, it } from 'bun:test';
import { BYPASS_ACTORS_KEY } from './github-ruleset-diff';
import {
  GRAPHQL_NOT_CONSULTED,
  isHiddenBypassActors,
  rulesetVisibilityProblems,
} from './github-ruleset-visibility';

const hiddenList = { key: BYPASS_ACTORS_KEY, name: 'Protect main' };
const hiddenEnforcement = { key: 'enforcement', name: 'Protect main' };

describe('isHiddenBypassActors', () => {
  it('separates the bypass-actor gap from any other invisible field', () => {
    expect(isHiddenBypassActors(hiddenList)).toBe(true);
    expect(isHiddenBypassActors(hiddenEnforcement)).toBe(false);
  });
});

describe('rulesetVisibilityProblems', () => {
  it('is silent when everything was verifiable', () => {
    expect(rulesetVisibilityProblems([], GRAPHQL_NOT_CONSULTED)).toEqual([]);
  });

  it('keeps the generic administration advice for other fields', () => {
    const [problem, ...rest] = rulesetVisibilityProblems(
      [hiddenEnforcement],
      GRAPHQL_NOT_CONSULTED,
    );
    expect(rest).toEqual([]);
    expect(problem).toContain('ruleset "Protect main": enforcement');
    expect(problem).toContain('read access to repository administration');
  });

  // A failed GraphQL call is a failed request, not a permission gap: telling
  // the operator to broaden a token would send them after the wrong thing.
  it('surfaces the GraphQL failure and asks for a re-run', () => {
    const [problem] = rulesetVisibilityProblems([hiddenList], {
      countedNames: new Set(),
      failure: 'HTTP 401 Bad credentials',
    });
    expect(problem).toContain('ruleset "Protect main": bypass_actors');
    expect(problem).toContain('HTTP 401 Bad credentials');
    expect(problem).toContain('re-run the check');
    expect(problem).not.toContain('installation token');
  });

  it('says the count matched when GraphQL answered one', () => {
    const [problem] = rulesetVisibilityProblems([hiddenList], {
      countedNames: new Set(['Protect main']),
      failure: null,
    });
    expect(problem).toContain('withholds their identities');
    expect(problem).toContain(
      'installation token cannot read bypass_actors over REST at any permission level',
    );
  });

  it('says nothing was answered when GraphQL counted no such ruleset', () => {
    const [problem] = rulesetVisibilityProblems([hiddenList], {
      countedNames: new Set(['Other ruleset']),
      failure: null,
    });
    expect(problem).toContain(
      'Neither REST nor the GraphQL bypass-actor count',
    );
    expect(problem).toContain(
      'installation token cannot read bypass_actors over REST at any permission level',
    );
  });

  // One ruleset being counted says nothing about another: reporting them
  // together would tell the reader the uncounted one is probably fine.
  it('splits counted rulesets from ones GraphQL never answered for', () => {
    const problems = rulesetVisibilityProblems(
      [
        { key: BYPASS_ACTORS_KEY, name: 'Protect main' },
        { key: BYPASS_ACTORS_KEY, name: 'Protect release' },
      ],
      { countedNames: new Set(['Protect main']), failure: null },
    );
    expect(problems).toHaveLength(2);
    const [counted, unanswered] = problems;
    expect(counted).toContain('ruleset "Protect main": bypass_actors');
    expect(counted).not.toContain('Protect release');
    expect(counted).toContain('withholds their identities');
    expect(unanswered).toContain('ruleset "Protect release": bypass_actors');
    expect(unanswered).not.toContain('Protect main');
    expect(unanswered).toContain('Neither REST nor the GraphQL bypass-actor');
    expect(unanswered).not.toContain('probably fine');
  });

  // The two gaps need different remedies, so they must not share one message.
  it('reports a hidden bypass list separately from other hidden fields', () => {
    const problems = rulesetVisibilityProblems(
      [hiddenEnforcement, hiddenList],
      { countedNames: new Set(['Protect main']), failure: null },
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('read access to repository administration');
    expect(problems[1]).toContain('withholds their identities');
  });
});
