import { parseDestination } from './creds-dest';
import type { DevEnvLayerKind } from './dev-env-document';

export const BROKERED_REFERENCES_KEY = 'brokeredReferences';

export type ParsedBrokeredAllowlist = {
  readonly entries: ReadonlySet<string>;
  readonly problems: ReadonlyArray<string>;
};

export const parseBrokeredAllowlist = (
  source: string,
  raw: unknown,
  layerKind: DevEnvLayerKind,
): ParsedBrokeredAllowlist => {
  if (layerKind === 'configuration') {
    return {
      entries: new Set(),
      problems: [
        `${source} reserved top-level key "${BROKERED_REFERENCES_KEY}" belongs only in the SOPS-encrypted secrets/dev.yaml layer`,
      ],
    };
  }
  if (!Array.isArray(raw)) {
    return {
      entries: new Set(),
      problems: [
        `${source} "${BROKERED_REFERENCES_KEY}" must list exact "<target>:<dotted.key>" entries`,
      ],
    };
  }
  const entries = new Set<string>();
  const problems: Array<string> = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'string' || parseDestination(entry) === null) {
      problems.push(
        `${source} "${BROKERED_REFERENCES_KEY}" entry ${index + 1} must be an exact "<target>:<dotted.key>" string`,
      );
    } else {
      entries.add(entry);
    }
  }
  return { entries, problems };
};
