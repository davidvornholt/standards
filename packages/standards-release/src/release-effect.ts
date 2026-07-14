import type { Effect as EffectType } from 'effect/Effect';

// Dynamic module loading avoids a Biome 2.5.3 resolver panic on statically imported Effect combinator re-exports while retaining one typed Effect runtime.
const effect = await import('effect/Effect');
const cause = await import('effect/Cause');
const eitherModule = await import('effect/Either');
const schema = await import('effect/Schema');

export type Effect<A, E = never, R = never> = EffectType<A, E, R>;

export const {
  all,
  either,
  exit,
  fail,
  failCause,
  flatMap,
  flip,
  gen,
  map,
  mapError,
  never,
  runPromise,
  runPromiseExit,
  runSync,
  succeed,
  try: effectTry,
  tryPromise,
  uninterruptibleMask,
  void: effectVoid,
} = effect;

export const { failures: causeFailures, sequential: causeSequential } = cause;

export const { isLeft } = eitherModule;

export const {
  Array: SchemaArray,
  Boolean: SchemaBoolean,
  decodeUnknown,
  optional,
  Record: SchemaRecord,
  String: SchemaString,
  Struct,
  Unknown,
} = schema;
