import { destinationFootprintsIntersect } from './creds-r2';

type FootprintedDestination = {
  readonly ref: { readonly target: string };
  readonly footprint: ReadonlyArray<string>;
};

const intersects = (
  left: FootprintedDestination,
  right: FootprintedDestination,
): boolean =>
  left.ref.target === right.ref.target &&
  destinationFootprintsIntersect(left.footprint, right.footprint);

export const groupByIntersectingFootprint = <
  Destination extends FootprintedDestination,
>(
  destinations: ReadonlyArray<Destination>,
): ReadonlyArray<ReadonlyArray<Destination>> =>
  destinations.reduce<Array<ReadonlyArray<Destination>>>(
    (groups, destination) => {
      const intersecting = groups.filter((group) =>
        group.some((candidate) => intersects(candidate, destination)),
      );
      const separate = groups.filter((group) => !intersecting.includes(group));
      return [...separate, [...intersecting.flat(), destination]];
    },
    [],
  );
