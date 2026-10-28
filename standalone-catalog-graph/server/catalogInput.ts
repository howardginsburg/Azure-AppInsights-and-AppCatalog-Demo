import type { CatalogInput } from '../common/shared.js';

const MAX_LENGTH: Record<Exclude<keyof CatalogInput, 'isActive'>, number> = {
  workload: 100,
  displayName: 200,
  businessOwner: 200,
  description: 1000,
  appUrl: 500,
  docsUrl: 500,
  runbookUrl: 500,
  repoUrl: 500,
  slo: 10,
  onCall: 200,
};

const URL_FIELDS = ['appUrl', 'docsUrl', 'runbookUrl', 'repoUrl'] as const;

/** Validates an untrusted request body as a catalog row. */
export function parseCatalogInput(body: unknown): CatalogInput | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Expected a JSON object.' };
  }
  const b = body as Record<string, unknown>;
  const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

  const input: CatalogInput = {
    workload: s(b.workload),
    displayName: s(b.displayName),
    businessOwner: s(b.businessOwner),
    description: s(b.description),
    appUrl: s(b.appUrl),
    docsUrl: s(b.docsUrl),
    runbookUrl: s(b.runbookUrl),
    repoUrl: s(b.repoUrl),
    slo: s(b.slo),
    onCall: s(b.onCall),
    isActive: b.isActive === undefined ? true : Boolean(b.isActive),
  };

  if (!input.workload) return { error: 'Field "workload" is required.' };
  if (!input.displayName) return { error: 'Field "displayName" is required.' };
  for (const [field, max] of Object.entries(MAX_LENGTH)) {
    const value = input[field as keyof typeof MAX_LENGTH];
    if (value.length > max) return { error: `Field "${field}" exceeds ${max} characters.` };
  }
  // Links render as anchors, and edits are anonymous, so only plain web links are accepted.
  for (const field of URL_FIELDS) {
    if (input[field] && !/^https?:\/\//i.test(input[field])) {
      return { error: `Field "${field}" must start with http:// or https://.` };
    }
  }
  return input;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: string): boolean {
  return GUID.test(value);
}
