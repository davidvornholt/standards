import { expect, it } from 'bun:test';
import { descriptorRootForPlatform } from './sync-directory-handles';

it('selects descriptor-relative mutation support only on Linux', () => {
  expect(descriptorRootForPlatform('linux')).toBe('/proc/self/fd');
  expect(descriptorRootForPlatform('darwin')).toBeNull();
  expect(descriptorRootForPlatform('win32')).toBeNull();
});
