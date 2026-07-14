import { describe, expect, it } from 'bun:test';
import { fail as causeFail, die, parallel } from 'effect/Cause';
import { renderReleaseCause } from './release-cause-output';
import { ReleasePackageError } from './release-package-error';

describe('release cause output', () => {
  it('reports every typed failure in a parallel cause', () => {
    const first = new ReleasePackageError({
      message: 'first failure',
    });
    const second = new ReleasePackageError({
      message: 'second failure',
    });
    expect(
      renderReleaseCause(parallel(causeFail(first), causeFail(second))),
    ).toBe('::error::first failure\n::error::second failure\n');
  });

  it('retains a safe pretty fallback when a compound cause contains a defect', () => {
    const failure = new ReleasePackageError({
      message: 'typed failure',
    });
    const output = renderReleaseCause(
      parallel(causeFail(failure), die('defect%\ncontinued')),
    );
    expect(output).toStartWith('::error::typed failure\n::error::');
    expect(output).toContain('defect%25%0Acontinued');
    expect(output).not.toContain('defect%\ncontinued');
  });
});
