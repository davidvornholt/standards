const applySegment = (
  segments: Array<string>,
  segment: string,
  absolute: boolean,
): void => {
  if (segment !== '' && segment !== '.') {
    if (segment !== '..') {
      segments.push(segment);
    } else if (segments.at(-1) !== undefined && segments.at(-1) !== '..') {
      segments.pop();
    } else if (!absolute) {
      segments.push(segment);
    }
  }
};

export const normalizeDependabotDirectory = (directory: string): string => {
  const absolute = directory.startsWith('/');
  const segments: Array<string> = [];
  for (const segment of directory.split('/')) {
    applySegment(segments, segment, absolute);
  }
  let normalized = segments.join('/');
  if (normalized === '') {
    normalized = absolute ? '/' : '.';
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
};

export const isDependabotGlob = (directory: string): boolean =>
  directory.includes('*') ||
  directory.includes('?') ||
  (directory.includes('[') && directory.includes(']'));
