import type { Effect as EffectType } from 'effect/Effect';

// Dynamic module loading avoids a Biome 2.5.3 resolver panic on statically imported Effect combinator re-exports while retaining one typed Effect runtime.
const effect = await import('effect/Effect');
const eitherModule = await import('effect/Either');
const schema = await import('effect/Schema');

export type Effect<A, E = never, R = never> = EffectType<A, E, R>;

export const {
  acquireUseRelease,
  all,
  either,
  fail,
  flatMap,
  flip,
  gen,
  map,
  mapError,
  orDie,
  runPromise,
  runPromiseExit,
  runSync,
  succeed,
  try: effectTry,
  tryPromise,
  void: effectVoid,
} = effect;

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
