import { parseDocument } from 'yaml';

export const parseYaml = (
  raw: string,
  label: string,
): { readonly value: unknown; readonly problem: string | null } => {
  try {
    const unmergedDocument = parseDocument(raw, {
      merge: false,
      uniqueKeys: true,
    });
    if (unmergedDocument.errors.length === 0) {
      const document = parseDocument(raw, { merge: true, uniqueKeys: true });
      if (document.errors.length === 0) {
        return { value: document.toJS() as unknown, problem: null };
      }
    }
  } catch {
    // The caller reports one stable configuration error for parser failures.
  }
  return {
    value: null,
    problem: `${label} must contain valid YAML with unique mapping keys`,
  };
};
