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
  quantity?: string;
  min?: number;
  max?: number;
  description?: string;
}

export interface Choice {
  value: string | number;
  n: number;
}

export interface SearchResult {
  index: number;
  vehicle: {
    index: number;
    make: string;
    model: string;
    year: number;
    generation: number | null;
    dev_chassis_code: string | null;
    platform_code: string | null;
    nickname: string | null;
    name: string;
  };
  // `null` means no engine has been recorded for this vehicle yet -- Search_View
  // is a LEFT JOIN specifically so an incomplete entry is still returned rather
  // than hidden. The UI is responsible for saying so rather than pretending the
  // car has no engine at all.
  engine: {
    index: number;
    manufacturer: string | null;
    code: string | null;
    named_variant: string | null;
    layout: string | null;
    cylinders: number | null;
    displacement_cc: number | null;
    aspiration: string | null;
    fuel_type: string | null;
    compression_ratio: string | null;
    fuel_delivery: string | null;
    horsepower: number | null;
    torque_lbft: number | null;
    summary: string | null;
  } | null;
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

/**
 * `facetFields` should be every field the filter panel renders, not a curated
 * subset. Facets are what drives the dropdowns themselves now: a facet's own
 * filter is excluded from its own count (the server already does this, for
 * the "narrow it down" panel this reused), so asking for a facet on every
 * field is what makes each dropdown reflect every *other* active filter --
 * Model narrows to Ford's models once Make=Ford is picked, rather than
 * offering Corvette next to Escape and letting the two combine into a car
 * that doesn't exist.
 */
export async function search(
  state: SearchState,
  facetFields: string[],
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const p = stateToParams(state);
  p.set('limit', '50');
  if (facetFields.length) p.set('facets', facetFields.join(','));

  const res = await fetch(`${BASE}/v1/search?${p}`, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Search failed (${res.status})`);
  }
  return res.json();
}

let metadataCache: Promise<{ fields: FieldDef[]; choices: Record<string, Choice[]> }> | null = null;

/**
 * `choices` here is the *unfiltered* set -- every value that exists anywhere
 * in the data, with no other selections narrowing it. It is only ever used to
 * paint the dropdowns before the first search response arrives; every search
 * after that carries its own facets (see `search()`), computed with whatever
 * else is currently selected, and those supersede this snapshot. Without this
 * initial fetch the dropdowns would sit empty for one round trip while the
 * first search is in flight.
 */
export function loadMetadata() {
  metadataCache ??= (async () => {
    // `no-cache` means revalidate, not "do not cache" -- the response is still
    // stored and a 304 still costs no bandwidth. It is worth the one round trip
    // because these two responses define the filter panel: a stale copy renders
    // controls for fields the data no longer has, and the page then contradicts
    // its own results with no way for the user to fix it but waiting out the
    // TTL. Search results are left on normal caching, where being a minute
    // behind is invisible rather than broken.
    const opts: RequestInit = { cache: 'no-cache' };
    const [fieldsRes, choicesRes] = await Promise.all([
      fetch(`${BASE}/v1/fields`, opts),
      fetch(`${BASE}/v1/choices`, opts),
    ]);
    if (!fieldsRes.ok) throw new Error('Could not load field definitions');
    const { fields } = (await fieldsRes.json()) as { fields: FieldDef[] };
    // Choices are a convenience, not a requirement -- a failure here should
    // degrade the dropdowns to empty rather than break the whole page; the
    // first search response fills them in regardless.
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
// Table browsing
// ---------------------------------------------------------------------------

export interface TableColumn {
  name: string;
  type: 'text' | 'integer';
  description: string;
  key?: 'pk' | 'fk';
  references?: string;
}

export interface TableSummary {
  name: string;
  label: string;
  group: 'source' | 'derived';
  role: string;
  description: string;
  csv?: string;
  column_count: number;
  row_count: number;
}

export interface TablePage {
  table: Omit<TableSummary, 'column_count' | 'row_count'> & { columns: TableColumn[] };
  total: number;
  limit: number;
  offset: number;
  rows: Record<string, unknown>[];
}

export async function loadTables(): Promise<TableSummary[]> {
  const res = await fetch(`${BASE}/v1/tables`);
  if (!res.ok) throw new Error('Could not load the table list');
  const body = (await res.json()) as { tables: TableSummary[] };
  return body.tables;
}

export async function loadTable(
  name: string,
  offset = 0,
  limit = 50,
): Promise<TablePage> {
  const res = await fetch(`${BASE}/v1/table/${encodeURIComponent(name)}?limit=${limit}&offset=${offset}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Could not load ${name}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export type UnitSystem = 'imperial' | 'metric';

/**
 * 2981 -> "3.0 L (2,981 cc)", or the reverse order in metric.
 *
 * Displacement filters are dropdowns of the exact cc values present in the
 * data (see FilterControl in App.tsx), not a free-typed number with a unit to
 * get wrong -- so there is no unit *input* to offer any more. The imperial/
 * metric toggle still does something, though: it decides which figure leads
 * in a label like this one.
 */
export function formatDisplacement(cc: number | null, system: UnitSystem = 'imperial'): string | null {
  if (cc === null || cc === undefined) return null;
  const l = `${(cc / 1000).toFixed(1)} L`;
  const raw = `${cc.toLocaleString()} cc`;
  return system === 'imperial' ? `${l} (${raw})` : `${raw} (${l})`;
}

/** 503 -> "503 hp (375 kW)", or the reverse order in metric. */
export function formatPower(hp: number | null, system: UnitSystem = 'imperial'): string | null {
  if (hp === null || hp === undefined) return null;
  const hpStr = `${hp.toLocaleString()} hp`;
  const kwStr = `${Math.round(hp * 0.745699872).toLocaleString()} kW`;
  return system === 'imperial' ? `${hpStr} (${kwStr})` : `${kwStr} (${hpStr})`;
}

/** 479 -> "479 lb-ft (649 Nm)", or the reverse order in metric. */
export function formatTorque(lbft: number | null, system: UnitSystem = 'imperial'): string | null {
  if (lbft === null || lbft === undefined) return null;
  const lbftStr = `${lbft.toLocaleString()} lb-ft`;
  const nmStr = `${Math.round(lbft * 1.35581795).toLocaleString()} Nm`;
  return system === 'imperial' ? `${lbftStr} (${nmStr})` : `${nmStr} (${lbftStr})`;
}

export const SORT_OPTIONS = [
  { value: '', label: 'Newest first' },
  { value: '-horsepower', label: 'Most powerful' },
  { value: '-displacement', label: 'Largest engine' },
  { value: 'displacement', label: 'Smallest engine' },
  { value: '-cylinders', label: 'Most cylinders' },
  { value: 'year', label: 'Oldest first' },
  { value: 'make', label: 'Make (A-Z)' },
];
