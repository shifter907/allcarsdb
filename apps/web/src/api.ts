/**
 * API client and search-state serialisation.
 *
 * The search state lives in the URL query string, in the same format the API
 * accepts. One representation, three jobs: it drives the request, it is the
 * shareable link, and it is the back-button history entry. Keeping a separate
 * client-side state shape and mapping between them is where filter UIs
 * usually start to rot.
 */

/**
 * The API lives on its own subdomain (api.allcarsdb.com), not behind the same
 * origin as the UI -- so unlike the apex-path layout this started as, the
 * client needs to know where it is.
 *
 * In dev, BASE stays empty and Vite's proxy (vite.config.ts) forwards /v1 to
 * the local API on :8787, so nothing here needs to change to develop against
 * a local backend. VITE_API_BASE lets a preview deploy or a fork point at a
 * different API without a code change.
 */
const BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.PROD ? 'https://api.allcarsdb.com' : '');

export interface FieldDef {
  name: string;
  label: string;
  kind: 'number' | 'enum' | 'bool' | 'text';
  group: string;
  quantity: string | null;
  enum: string | null;
  common: boolean;
  min: number | null;
  max: number | null;
  description: string | null;
}

export interface EnumMember {
  slug: string;
  label: string;
  note: string | null;
}

export interface Feature {
  slug: string;
  name: string;
  category: string;
  value_type: string;
  is_common: number;
  usage_count: number;
}

export interface SearchResult {
  id: number;
  name: string;
  make: string;
  model: string;
  year: number;
  trim: string | null;
  variant: string | null;
  body: string | null;
  engine: string | null;
  drivetrain: string | null;
  url: string;
  specs: Record<string, number | string | null>;
  quality: { completeness: number; confidence: number | null };
}

export interface SearchResponse {
  total: number;
  limit: number;
  offset: number;
  results: SearchResult[];
  facets?: Record<string, { value: string | number; label: string | null; count: number }[]>;
  error?: string;
}

/** One row in the filter panel. */
export interface ActiveFilter {
  field: string;
  op: string;
  value: string;
  unit?: string;
}

export interface SearchState {
  filters: ActiveFilter[];
  features: string[];
  q: string;
  sort: string;
  offset: number;
}

export const EMPTY_STATE: SearchState = { filters: [], features: [], q: '', sort: '', offset: 0 };

// ---------------------------------------------------------------------------
// URL <-> state
// ---------------------------------------------------------------------------

export function stateToParams(s: SearchState): URLSearchParams {
  const p = new URLSearchParams();
  for (const f of s.filters) {
    if (f.value === '') continue;
    const value = f.unit ? `${f.value}${f.unit}` : f.value;
    p.append(f.field, f.op === 'eq' ? value : `${f.op}:${value}`);
  }
  if (s.features.length) p.set('has', s.features.join(','));
  if (s.q) p.set('q', s.q);
  if (s.sort) p.set('sort', s.sort);
  if (s.offset) p.set('offset', String(s.offset));
  return p;
}

export function paramsToState(p: URLSearchParams): SearchState {
  const state: SearchState = { ...EMPTY_STATE, filters: [], features: [] };
  for (const [key, raw] of p.entries()) {
    if (key === 'has') { state.features = raw.split(',').filter(Boolean); continue; }
    if (key === 'q') { state.q = raw; continue; }
    if (key === 'sort') { state.sort = raw; continue; }
    if (key === 'offset') { state.offset = Number(raw) || 0; continue; }
    if (key === 'limit' || key === 'facets') continue;

    const colon = raw.indexOf(':');
    const ops = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'between'];
    const maybeOp = colon > 0 ? raw.slice(0, colon) : '';
    const hasOp = ops.includes(maybeOp);
    const rest = hasOp ? raw.slice(colon + 1) : raw;
    const m = /^(-?\d+(?:\.\d+)?)([a-zA-Z/%0-9]+)$/.exec(rest);
    state.filters.push({
      field: key,
      op: hasOp ? maybeOp : 'eq',
      value: m ? m[1]! : rest,
      unit: m ? m[2]! : undefined,
    });
  }
  return state;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const FACETS = 'body_category,drivetrain,hybrid_type,transmission_type,aspiration,cylinders';

export async function search(state: SearchState, signal?: AbortSignal): Promise<SearchResponse> {
  const p = stateToParams(state);
  p.set('facets', FACETS);
  p.set('limit', '50');
  const res = await fetch(`${BASE}/v1/search?${p}`, { signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as SearchResponse;
}

let metaCache: Promise<{
  fields: FieldDef[];
  enums: Record<string, EnumMember[]>;
  features: Feature[];
}> | null = null;

/** Field definitions, vocabularies and the feature catalog, fetched once. */
export function loadMetadata() {
  if (!metaCache) {
    metaCache = (async () => {
      const [f, e, ft] = await Promise.all([
        fetch(`${BASE}/v1/fields`).then((r) => r.json()),
        fetch(`${BASE}/v1/enums`).then((r) => r.json()),
        fetch(`${BASE}/v1/features`).then((r) => r.json()),
      ]);
      return {
        fields: f.fields as FieldDef[],
        enums: e as Record<string, EnumMember[]>,
        features: ft.features as Feature[],
      };
    })();
  }
  return metaCache;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export type UnitSystem = 'imperial' | 'metric';

/** Units offered for a quantity, in the user's preferred system first. */
export function unitOptions(quantity: string | null, system: UnitSystem): string[] {
  if (!quantity) return [];
  const table: Record<string, { imperial: string[]; metric: string[] }> = {
    length: { imperial: ['in', 'ft'], metric: ['mm', 'cm', 'm'] },
    volume: { imperial: ['cuft', 'galus'], metric: ['l', 'cc'] },
    mass: { imperial: ['lb'], metric: ['kg'] },
    speed: { imperial: ['mph'], metric: ['kph'] },
    power: { imperial: ['hp'], metric: ['kw', 'ps'] },
    torque: { imperial: ['lbft'], metric: ['nm'] },
    economy: { imperial: ['mpg'], metric: ['l/100km'] },
    energy: { imperial: ['kwh'], metric: ['kwh'] },
    time: { imperial: ['s'], metric: ['s'] },
    angle: { imperial: ['deg'], metric: ['deg'] },
    currency: { imperial: ['major'], metric: ['major'] },
  };
  const t = table[quantity];
  if (!t) return [];
  return system === 'imperial' ? [...t.imperial, ...t.metric] : [...t.metric, ...t.imperial];
}

export function formatSpec(
  key: string,
  value: number | string | null,
  system: UnitSystem,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);

  const imperial = system === 'imperial';
  switch (key) {
    case 'horsepower': return `${Math.round(n)} hp`;
    case 'torque_lbft':
      return imperial ? `${Math.round(n)} lb-ft` : `${Math.round(n / 0.73756215)} Nm`;
    case 'curb_weight_kg':
      return imperial ? `${Math.round(n / 0.45359237).toLocaleString()} lb` : `${Math.round(n).toLocaleString()} kg`;
    case 'zero_to_60_s': return `${n.toFixed(1)}s 0-60`;
    case 'cargo_behind_second_l':
      return imperial ? `${(n / 28.316846592).toFixed(1)} cu ft cargo` : `${Math.round(n)} L cargo`;
    case 'seat_height_mm':
      return imperial ? `${(n / 25.4).toFixed(1)} in seat height` : `${Math.round(n)} mm seat height`;
    case 'mpg_combined':
      return imperial ? `${Math.round(n)} mpg` : `${(235.214583 / n).toFixed(1)} L/100km`;
    case 'mpge_combined': return `${Math.round(n)} MPGe`;
    case 'electric_range_mi':
      return imperial ? `${Math.round(n)} mi EV` : `${Math.round(n * 1.609344)} km EV`;
    case 'towing_max_kg':
      return imperial ? `${Math.round(n / 0.45359237).toLocaleString()} lb towing` : `${Math.round(n).toLocaleString()} kg towing`;
    case 'msrp': return `$${Math.round(n).toLocaleString()}`;
    default: return null;
  }
}

export const SPEC_ORDER = [
  'horsepower', 'torque_lbft', 'zero_to_60_s', 'curb_weight_kg',
  'cargo_behind_second_l', 'seat_height_mm', 'mpg_combined', 'mpge_combined',
  'electric_range_mi', 'towing_max_kg', 'msrp',
];
