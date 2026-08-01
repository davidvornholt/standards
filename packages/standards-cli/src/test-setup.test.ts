import { expect, it, spyOn } from 'bun:test';

it('leaves a called console spy unrestored', () => {
  const error = spyOn(console, 'error').mockImplementation(() => undefined);

  error('recorded before automatic cleanup');

  expect(error).toHaveBeenCalledTimes(1);
});

it('starts a re-spied console method with no inherited calls', () => {
  const error = spyOn(console, 'error').mockImplementation(() => undefined);

  expect(error).toHaveBeenCalledTimes(0);
});
