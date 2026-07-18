export const labelIdentity = (name: string): string => name.toLowerCase();

export const hasLabel = (
  labels: ReadonlyArray<string>,
  expected: string,
): boolean => {
  const identity = labelIdentity(expected);
  return labels.some((label) => labelIdentity(label) === identity);
};
