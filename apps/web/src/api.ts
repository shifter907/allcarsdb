/**
 * API client and search-state serialization.
 *
 * The search state lives in the URL query string, in the same format the Worker
 * accepts. One representation drives the request, is the shareable link, and is
 * the back-button history entry -- so there is no second copy of "what is the
 * user currently searching for" that can drift out of step with the first.
 */

const BASE =
  import.meta.env.VITE_API_BASE ??
  // In development Vite proxies /v1 to the local API, so a relative URL works
  // and no CORS negotiation happens at all. In production the API is a
  // different origin and has to be named.
  (import.meta.env.PROD ? 'https://api.allcarsdb.com' : '');

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface FieldDef {
  name: string;
  label: string;
  kind: 'number' | 'text';
  group: string;
  common: boolean;
  choices: boolean;
  quantity?: string;
  min?: number;
  max?: number;
  description?: string;
}

export interface Choice {
  value: string;
  n: number;
}

export interface SearchResult {
  index: number;
  vehicle: { index: number; make: string; model: string; year: number; name: string };
  engine: {
    index: number;
    layout: string | null;
    cylinders: number | null;
    displacement_cc: number | null;
    aspiration: string | null;
    fuel_type: string | null;
    compression_ratio: string | null;
    fuel_delivery: string | null;
    summary: string | null;
  };
}

export interface SearchResponse {
  total: number;
  limit: number;
  offset: number;
  results: SearchResult[];
  facets: { field: string; values: { value: string | number; n: number }[] }[];
}

/** One filter as the UI holds it: field, operator, raw value the user typed. */
export interface ActiveFilter {
  field: string;
  op: string;
  value: string;
  unit?: string;
}

export interface SearchState {
  filters: ActiveFilter[];
  q: string;
  sort: string;
  offset: number;
}

export const EMPTY_STATE: SearchState = { filters: [], q: '', sort: '', offset: 0 };

// ---------------------------------------------------------------------------
// URL <-> state
// ---------------------------------------------------------------------------

export function stateToParams(s: SearchState): URLSearchParams {
  const p = new URLSearchParams();
  for (const f of s.filters) {
    if (f.value === '' && f.op !== 'exists') continue;
    const val = f.op === 'exists' ? '' : `${f.value}${f.unit ?? ''}`;
    // `eq` is the default operator, so it is left off the URL to keep shared
    // links readable: `?make=Porsche` rather than `?make=eq:Porsche`.
    p.append(f.field, f.op === 'eq' ? val : `${f.op}:${val}`);
  }
  if (s.q) p.set('q', s.q);
  if (s.sort) p.set('sort', s.sort);
  if (s.offset) p.set('offset', String(s.offset));
  return p;
}

const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'between', 'exists', 'contains'];

export function paramsToState(p: URLSearchParams): SearchState {
  const s: SearchState = { ...EMPTY_STATE, filters: [] };
  for (const [key, raw] of p.entries()) {
    if (key === 'q') { s.q = raw; continue; }
    if (key === 'sort') { s.sort = raw; continue; }
    if (key === 'offset') { s.offset = Number(raw) || 0; continue; }
    if (key === 'limit' || key === 'facets') continue;

    const colon = raw.indexOf(':');
    const maybeOp = colon > 0 ? raw.slice(0, colon) : '';
    const op = OPS.includes(maybeOp) ? maybeOp : 'eq';
    const rest = OPS.includes(maybeOp) ? raw.slice(colon + 1) : raw;
    s.filters.push({ field: key, op, value: rest });
  }
  return s;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export async function search(state: SearchState, signal?: AbortSignal): Promise<SearchResponse> {
  const p = stateToParams(state);
  p.set('limit', '50');
  p.set('facets', 'make,layout,aspiration,fuel_type');

  const res = await fetch(`${BASE}/v1/search?${p}`, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Search failed (${res.status})`);
  }
  return res.json();
}

let metadataCache: Promise<{ fields: FieldDef[]; choices: Record<string, Choice[]> }> | null = null;

export function loadMetadata() {
  metadataCache ??= (async () => {
    const [fieldsRes, choicesRes] = await Promise.all([
      fetch(`${BASE}/v1/fields`),
      fetch(`${BASE}/v1/choices`),
    ]);
    if (!fieldsRes.ok) throw new Error('Could not load field definitions');
    const { fields } = (await fieldsRes.json()) as { fields: FieldDef[] };
    // Choices are a convenience, not a requirement -- a failure here should
    // degrade the dropdowns to free-text inputs, not break the whole page.
    const choices = choicesRes.ok
      ? ((await choicesRes.json()) as { choices: Record<string, Choice[]> }).choices
      : {};
    return { fields, choices };
  })();
  return metadataCache;
}

export async function loadStats(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/v1/stats`);
  if (!res.ok) throw new Error('Could not load stats');
  return res.json();
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export type UnitSystem = 'imperial' | 'metric';

/** Units offered for a quantity, most likely first. */
export function unitOptions(quantity: string | undefined, system: UnitSystem): string[] {
  if (quantity !== 'displacement') return [];
  return system === 'imperial' ? ['l', 'cc', 'cuin'] : ['l', 'cc'];
}

/** 2981 -> "3.0 L (2981 cc)". */
export function formatDisplacement(cc: number | null): string | null {
  if (cc === null || cc === undefined) return null;
  return `${(cc / 1000).toFixed(1)} L (${cc.toLocaleString()} cc)`;
}

export const SORT_OPTIONS = [
  { value: '', label: 'Newest first' },
  { value: '-displacement', label: 'Largest engine' },
  { value: 'displacement', label: 'Smallest engine' },
  { value: '-cylinders', label: 'Most cylinders' },
  { value: 'year', label: 'Oldest first' },
  { value: 'make', label: 'Make (A-Z)' },
];
