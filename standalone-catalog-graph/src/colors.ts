/** Fill colors encode health. */
const STATUS_COLOR: Record<string, string> = {
  Healthy: '#37c871',
  Warning: '#f5b715',
  Error: '#ff4d4f',
  Infra: '#7c8899',
  Context: '#4a5568',
};

export const HEALTH_LEGEND = ['Healthy', 'Warning', 'Error', 'Infra'].map((t) => ({ label: t, color: STATUS_COLOR[t] }));

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? STATUS_COLOR.Infra;
}

// Ring colors encode business domain. Domains come from tags, so colors are assigned to
// whatever domains are present rather than to a fixed list.
const DOMAIN_PALETTE = [
  '#4c9aff', '#c98bff', '#ff9f45', '#37d6b0', '#ff6b9a',
  '#ffd166', '#7bd88f', '#5ec8f2', '#b8a1ff', '#f4845f',
];
export const NO_DOMAIN_COLOR = '#5b6675';

/** Assigns a distinct color to each domain, in sorted order. */
export function domainPalette(domains: string[]): Map<string, string> {
  const sorted = [...new Set(domains.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return new Map(sorted.map((d, i) => [d, DOMAIN_PALETTE[i % DOMAIN_PALETTE.length]]));
}
