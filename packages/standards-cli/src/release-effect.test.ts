import { describe, expect, it } from 'bun:test';
import {
  decodeUnknown,
  map,
  runSync,
  SchemaString,
  Struct,
  succeed,
} from './release-effect';

const INPUT_VALUE = 2;
const INCREMENT = 1;
const EXPECTED_VALUE = 3;

describe('release Effect adapter', () => {
  it('composes Effects and Schema decoding through the typed runtime', () => {
    expect(
      runSync(succeed(INPUT_VALUE).pipe(map((value) => value + INCREMENT))),
    ).toBe(EXPECTED_VALUE);
    expect(
      runSync(
        decodeUnknown(Struct({ value: SchemaString }))({ value: 'decoded' }),
      ),
    ).toEqual({ value: 'decoded' });
  });
});
