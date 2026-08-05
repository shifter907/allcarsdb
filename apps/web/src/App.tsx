/**
 * The search interface.
 *
 * The filter panel is generated from GET /v1/fields and GET /v1/enums rather
 * than hard-coded. Adding a searchable column to the schema therefore makes it
 * appear in the UI with no front-end change at all -- which matters for a
 * project where the schema is expected to keep growing and the person adding
 * a column is often not a front-end developer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  search, loadMetadata, paramsToState, stateToParams, unitOptions,
  formatSpec, SPEC_ORDER, EMPTY_STATE,
  type SearchState, type SearchResponse, type FieldDef, type EnumMember,
  type Feature, type ActiveFilter, type UnitSystem,
} from './api.js';

const GROUP_LABELS: Record<string, string> = {
  identity: 'Year & Make',
  body: 'Body',
  engine: 'Engine',
  powertrain: 'Powertrain',
  performance: 'Performance',
  exterior: 'Exterior Dimensions',
  interior: 'Interior Dimensions',
  efficiency: 'Efficiency & Range',
  capacity: 'Towing & Payload',
  commercial: 'Price',
  quality: 'Data Quality',
};

const GROUP_ORDER = [
  'identity', 'body', 'engine', 'powertrain', 'performance',
  'exterior', 'interior', 'efficiency', 'capacity', 'commercial', 'quality',
];

const NUMERIC_OPS = [
  { op: 'gte', label: 'at least' },
  { op: 'lte', label: 'at most' },
  { op: 'eq', label: 'about' },
  { op: 'between', label: 'between' },
  { op: 'exists', label: 'is recorded' },
];

/** Preloaded searches. The fastest way to explain what this thing does. */
const EXAMPLES: { label: string; query: string }[] = [
  {
    label: 'Naturally aspirated flat-6, 24v+',
    query: 'engine_layout=flat&cylinders=6&aspiration=naturally_aspirated&valves_total=gte:24',
  },
  {
    label: 'Hybrid AWD with massage seats',
    query: 'hybrid_type=hev,phev,mhev_48v&drivetrain=awd,through_road_awd,fwd_biased_awd&has=massage-seats-front',
  },
  {
    label: 'Folding hardtop convertibles',
    query: 'roof_type=retractable_hardtop',
  },
  {
    label: 'Manual, under 3000 lb',
    query: 'transmission_type=manual&curb_weight=lte:3000lb',
  },
  {
    label: '3 rows + 60 cu ft cargo',
    query: 'seat_rows=3&cargo_behind_first=gte:60cuft',
  },
];

export function App() {
  const [state, setState] = useState<SearchState>(() =>
    paramsToState(new URLSearchParams(location.search)),
  );
  const [meta, setMeta] = useState<{
    fields: FieldDef[];
    enums: Record<string, EnumMember[]>;
    features: Feature[];
  } | null>(null);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [units, setUnits] = useState<UnitSystem>(
    () => (localStorage.getItem('units') as UnitSystem) ?? 'imperial',
  );
  const [showAll, setShowAll] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { loadMetadata().then(setMeta).catch((e) => setError(e.message)); }, []);
  useEffect(() => { localStorage.setItem('units', units); }, [units]);

  // Keep the URL in step with the search, so every result set is linkable.
  useEffect(() => {
    const params = stateToParams(state);
    const next = params.toString() ? `?${params}` : location.pathname;
    if (next !== location.search && next !== location.pathname + location.search) {
      history.replaceState(null, '', next);
    }
  }, [state]);

  useEffect(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);

    const timer = setTimeout(() => {
      search(state, ctrl.signal)
        .then((r) => { setData(r); setError(null); })
        .catch((e) => { if (e.name !== 'AbortError') setError(e.message); })
        .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    }, 180); // debounce: the panel emits a lot of intermediate states

    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [state]);

  // ---- Mutations ----------------------------------------------------------

  const setFilter = useCallback((field: string, patch: Partial<ActiveFilter> | null) => {
    setState((s) => {
      const filters = s.filters.filter((f) => f.field !== field);
      if (patch === null) return { ...s, filters, offset: 0 };
      const existing = s.filters.find((f) => f.field === field);
      return {
        ...s,
        offset: 0,
        filters: [...filters, { field, op: 'eq', value: '', ...existing, ...patch }],
      };
    });
  }, []);

  const toggleFeature = useCallback((slug: string) => {
    setState((s) => ({
      ...s,
      offset: 0,
      features: s.features.includes(slug)
        ? s.features.filter((f) => f !== slug)
        : [...s.features, slug],
    }));
  }, []);

  const applyExample = useCallback((query: string) => {
    setState(paramsToState(new URLSearchParams(query)));
    setShowAll(true);
  }, []);

  const filterOf = useCallback(
    (field: string) => state.filters.find((f) => f.field === field),
    [state.filters],
  );

  // ---- Derived ------------------------------------------------------------

  const grouped = useMemo(() => {
    if (!meta) return [];
    const visible = meta.fields.filter((f) => showAll || f.common);
    const byGroup = new Map<string, FieldDef[]>();
    for (const f of visible) {
      const list = byGroup.get(f.group) ?? [];
      list.push(f);
      byGroup.set(f.group, list);
    }
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({
      group: g,
      label: GROUP_LABELS[g] ?? g,
      fields: byGroup.get(g)!,
    }));
  }, [meta, showAll]);

  const commonFeatures = useMemo(
    () => (meta?.features ?? []).filter((f) => f.is_common || state.features.includes(f.slug)),
    [meta, state.features],
  );

  const activeCount = state.filters.filter((f) => f.value !== '' || f.op === 'exists').length
    + state.features.length + (state.q ? 1 : 0);

  // ---- Render -------------------------------------------------------------

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <h1>AllCarsDB</h1>
            <p>Every variant. Every spec. Open data.</p>
          </div>
          <div className="header-actions">
            <div className="unit-toggle" role="group" aria-label="Unit system">
              <button
                className={units === 'imperial' ? 'on' : ''}
                onClick={() => setUnits('imperial')}
              >
                Imperial
              </button>
              <button
                className={units === 'metric' ? 'on' : ''}
                onClick={() => setUnits('metric')}
              >
                Metric
              </button>
            </div>
            <a className="ghost-btn" href="https://github.com/allcarsdb/allcarsdb" target="_blank" rel="noreferrer">
              Contribute
            </a>
          </div>
        </div>
      </header>

      <div className="examples">
        <span className="examples-label">Try:</span>
        {EXAMPLES.map((ex) => (
          <button key={ex.label} className="chip" onClick={() => applyExample(ex.query)}>
            {ex.label}
          </button>
        ))}
      </div>

      <div className="layout">
        <aside className="panel">
          <div className="panel-head">
            <input
              className="text-search"
              type="search"
              placeholder="Search by name…"
              value={state.q}
              onChange={(e) => setState((s) => ({ ...s, q: e.target.value, offset: 0 }))}
            />
            {activeCount > 0 && (
              <button className="link-btn" onClick={() => setState(EMPTY_STATE)}>
                Clear all ({activeCount})
              </button>
            )}
          </div>

          {!meta && <p className="muted">Loading filters…</p>}

          {grouped.map(({ group, label, fields }) => (
            <section key={group} className="group">
              <h2>{label}</h2>
              {fields.map((f) => (
                <FilterRow
                  key={f.name}
                  field={f}
                  value={filterOf(f.name)}
                  enums={f.enum ? meta!.enums[f.enum] ?? [] : []}
                  units={units}
                  onChange={(patch) => setFilter(f.name, patch)}
                />
              ))}
            </section>
          ))}

          {meta && (
            <section className="group">
              <h2>Equipment</h2>
              <p className="hint">
                Matches cars where the feature is standard, optional, or in a package.
              </p>
              {commonFeatures.map((ft) => (
                <label key={ft.slug} className="check">
                  <input
                    type="checkbox"
                    checked={state.features.includes(ft.slug)}
                    onChange={() => toggleFeature(ft.slug)}
                  />
                  <span>{ft.name}</span>
                  <span className="count">{ft.usage_count}</span>
                </label>
              ))}
            </section>
          )}

          {meta && (
            <button className="link-btn wide" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer filters' : `Show all ${meta.fields.length} filters`}
            </button>
          )}
        </aside>

        <main className="results">
          <div className="results-head">
            <div>
              {error ? (
                <span className="error">{error}</span>
              ) : (
                <strong>
                  {data ? `${data.total.toLocaleString()} ${data.total === 1 ? 'result' : 'results'}` : '…'}
                </strong>
              )}
              {loading && <span className="spinner" aria-label="Loading" />}
            </div>
            <select
              value={state.sort}
              onChange={(e) => setState((s) => ({ ...s, sort: e.target.value, offset: 0 }))}
            >
              <option value="">Newest first</option>
              <option value="-horsepower">Most power</option>
              <option value="zero_to_60">Quickest 0-60</option>
              <option value="curb_weight">Lightest</option>
              <option value="-cargo_behind_second">Most cargo</option>
              <option value="price">Cheapest</option>
              <option value="-price">Most expensive</option>
              <option value="-total_range">Longest range</option>
              <option value="-completeness">Most complete data</option>
            </select>
          </div>

          {data?.results.length === 0 && !error && (
            <div className="empty">
              <h3>Nothing matches all of those filters.</h3>
              <p>
                That may be a real answer — plenty of specification combinations have
                never been built. It may also mean the data is missing: this database
                is young, and a car with no recorded value for a spec is excluded from
                filters on it.
              </p>
              <p className="muted">
                If you know a car that should be here, adding it is a pull request
                against one YAML file.
              </p>
            </div>
          )}

          <ul className="cards">
            {data?.results.map((r) => (
              <li key={r.id} className="card">
                <div className="card-main">
                  <h3>{r.name}</h3>
                  <p className="sub">
                    {[r.body, r.engine, r.drivetrain].filter(Boolean).join(' · ')}
                  </p>
                  <ul className="specs">
                    {SPEC_ORDER.map((key) => {
                      const text = formatSpec(key, r.specs[key] ?? null, units);
                      return text ? <li key={key}>{text}</li> : null;
                    })}
                  </ul>
                </div>
                <div className="card-side">
                  <Completeness value={r.quality.completeness} />
                </div>
              </li>
            ))}
          </ul>

          {data && data.total > data.results.length && (
            <div className="pager">
              <button
                disabled={state.offset === 0}
                onClick={() => setState((s) => ({ ...s, offset: Math.max(0, s.offset - 50) }))}
              >
                Previous
              </button>
              <span>
                {state.offset + 1}–{Math.min(state.offset + 50, data.total)} of{' '}
                {data.total.toLocaleString()}
              </span>
              <button
                disabled={state.offset + 50 >= data.total}
                onClick={() => setState((s) => ({ ...s, offset: s.offset + 50 }))}
              >
                Next
              </button>
            </div>
          )}

          {data?.facets && <Facets facets={data.facets} onPick={setFilter} />}
        </main>
      </div>

      <footer className="footer">
        <p>
          Open data under CC BY-SA 4.0. Specifications are contributed and may contain
          errors — check anything that matters against the manufacturer.
        </p>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------

function FilterRow({
  field, value, enums, units, onChange,
}: {
  field: FieldDef;
  value: ActiveFilter | undefined;
  enums: EnumMember[];
  units: UnitSystem;
  onChange: (patch: Partial<ActiveFilter> | null) => void;
}) {
  const opts = unitOptions(field.quantity, units);

  if (field.kind === 'enum') {
    const selected = value?.value ? value.value.split(',') : [];
    return (
      <div className="filter">
        <label>{field.label}</label>
        <div className="pills">
          {enums.map((m) => {
            const on = selected.includes(m.slug);
            return (
              <button
                key={m.slug}
                className={`pill ${on ? 'on' : ''}`}
                title={m.note ?? undefined}
                onClick={() => {
                  const next = on ? selected.filter((s) => s !== m.slug) : [...selected, m.slug];
                  onChange(next.length ? { op: 'in', value: next.join(',') } : null);
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (field.kind === 'bool') {
    return (
      <label className="check">
        <input
          type="checkbox"
          checked={value?.value === 'true'}
          onChange={(e) => onChange(e.target.checked ? { op: 'eq', value: 'true' } : null)}
        />
        <span>{field.label}</span>
      </label>
    );
  }

  const op = value?.op ?? 'gte';
  const isBetween = op === 'between';
  const [lo = '', hi = ''] = isBetween ? (value?.value ?? '').split('..') : [];

  return (
    <div className="filter">
      <label title={field.description ?? undefined}>
        {field.label}
        {field.description && <span className="info">?</span>}
      </label>
      <div className="row">
        <select
          value={op}
          onChange={(e) => {
            const nextOp = e.target.value;
            if (nextOp === 'exists') onChange({ op: 'exists', value: 'exists' });
            else onChange({ op: nextOp, value: value?.value ?? '' });
          }}
        >
          {NUMERIC_OPS.map((o) => (
            <option key={o.op} value={o.op}>{o.label}</option>
          ))}
        </select>

        {op !== 'exists' && (
          isBetween ? (
            <>
              <input
                type="number" placeholder="min" value={lo}
                onChange={(e) => onChange({ op, value: `${e.target.value}..${hi}` })}
              />
              <input
                type="number" placeholder="max" value={hi}
                onChange={(e) => onChange({ op, value: `${lo}..${e.target.value}` })}
              />
            </>
          ) : (
            <input
              type="number"
              placeholder={field.min !== null ? String(field.min) : ''}
              value={value?.value ?? ''}
              onChange={(e) =>
                e.target.value === '' ? onChange(null) : onChange({ op, value: e.target.value })
              }
            />
          )
        )}

        {opts.length > 0 && op !== 'exists' && (
          <select
            value={value?.unit ?? opts[0]}
            onChange={(e) => onChange({ op, value: value?.value ?? '', unit: e.target.value })}
          >
            {opts.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        )}

        {value && (
          <button className="x" onClick={() => onChange(null)} aria-label={`Clear ${field.label}`}>
            ×
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Facet counts. Each facet's own filter is excluded from its counts server
 * side, so these answer "what else could I have picked" rather than collapsing
 * to the single value already selected.
 */
function Facets({
  facets, onPick,
}: {
  facets: NonNullable<SearchResponse['facets']>;
  onPick: (field: string, patch: Partial<ActiveFilter> | null) => void;
}) {
  const entries = Object.entries(facets).filter(([, v]) => v.length > 1);
  if (!entries.length) return null;

  return (
    <section className="facets">
      <h2>Narrow further</h2>
      <div className="facet-grid">
        {entries.map(([name, values]) => (
          <div key={name} className="facet">
            <h3>{GROUP_LABELS[name] ?? name.replace(/_/g, ' ')}</h3>
            <ul>
              {values.slice(0, 8).map((v) => (
                <li key={String(v.value)}>
                  <button onClick={() => onPick(name, { op: 'in', value: String(v.value) })}>
                    <span>{v.label ?? String(v.value)}</span>
                    <span className="count">{v.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * How much of the schema this entry actually fills in. Shown because a spec
 * database that hides its own gaps trains people to distrust all of it -- and
 * because a visible gap is an invitation to fill it.
 */
function Completeness({ value }: { value: number }) {
  const tone = value >= 80 ? 'good' : value >= 50 ? 'ok' : 'low';
  return (
    <div className={`completeness ${tone}`} title={`${value}% of tracked specs recorded`}>
      <svg viewBox="0 0 36 36" width="34" height="34" aria-hidden="true">
        <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3" className="track" />
        <circle
          cx="18" cy="18" r="15.5" fill="none" strokeWidth="3" className="bar"
          strokeDasharray={`${(value / 100) * 97.4} 97.4`}
          strokeLinecap="round" transform="rotate(-90 18 18)"
        />
      </svg>
      <span>{value}%</span>
    </div>
  );
}
