import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  search,
  loadMetadata,
  loadStats,
  paramsToState,
  stateToParams,
  formatDisplacement,
  unitOptions,
  SORT_OPTIONS,
  EMPTY_STATE,
  type ActiveFilter,
  type Choice,
  type FieldDef,
  type SearchResponse,
  type SearchState,
  type UnitSystem,
} from './api';

/**
 * Starting points, phrased as questions rather than filter syntax. A blank
 * search box on a database nobody has used before is a dead end -- these show
 * what the thing can answer.
 */
const EXAMPLES: { label: string; params: string }[] = [
  { label: 'Naturally aspirated flat-6', params: 'layout=Flat&cylinders=6&aspiration=contains:Naturally' },
  { label: 'Turbocharged four-cylinders', params: 'cylinders=4&aspiration=contains:Turbo' },
  { label: 'Under 2.0 litres', params: 'displacement=lt:2l' },
  { label: 'V8s, 5 litres and up', params: 'layout=V&cylinders=8&displacement=gte:5l' },
  { label: 'Diesels', params: 'fuel_type=contains:Diesel' },
];

export default function App() {
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [choices, setChoices] = useState<Record<string, Choice[]>>({});
  const [state, setState] = useState<SearchState>(() =>
    paramsToState(new URLSearchParams(window.location.search)),
  );
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [units, setUnits] = useState<UnitSystem>(
    () => (localStorage.getItem('units') as UnitSystem) ?? 'imperial',
  );
  const [showAll, setShowAll] = useState(false);

  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    loadMetadata()
      .then((m) => { setFields(m.fields); setChoices(m.choices); })
      .catch((e) => setError(e.message));
    loadStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => localStorage.setItem('units', units), [units]);

  // The URL is the state. Every change rewrites it, and the popstate handler
  // reads it back, so Back genuinely undoes a filter instead of leaving the
  // page while the address bar still shows it.
  useEffect(() => {
    const onPop = () => setState(paramsToState(new URLSearchParams(window.location.search)));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const knownFields = useMemo(() => new Set(fields.map((f) => f.name)), [fields]);

  useEffect(() => {
    const params = stateToParams(state);
    const url = params.toString() ? `?${params}` : window.location.pathname;
    window.history.replaceState(null, '', url);

    // Nothing can be searched until the field registry is known, because
    // without it there is no way to tell a real filter from a stray query
    // parameter.
    if (fields.length === 0) return;

    // Query parameters that are not fields are dropped rather than sent.
    // Every link shared anywhere picks up tracking parameters -- utm_source,
    // fbclid, gclid -- and passing those through as filters means the server
    // rejects the whole request and the visitor lands on an error instead of
    // the search someone meant to show them.
    const req = { ...state, filters: state.filters.filter((f) => knownFields.has(f.field)) };

    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;

    setLoading(true);
    setError(null);
    search(req, ctrl.signal)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setError(e.message);
        setLoading(false);
      });

    return () => ctrl.abort();
  }, [state, fields, knownFields]);

  const update = useCallback((next: Partial<SearchState>) => {
    // Any change to the query resets paging: staying on page 4 of a result set
    // that just changed shape shows the user an arbitrary slice of something
    // they did not ask for.
    setState((s) => ({ ...s, offset: 0, ...next }));
  }, []);

  const setFilter = useCallback((field: string, op: string, value: string, unit?: string) => {
    setState((s) => {
      const rest = s.filters.filter((f) => f.field !== field);
      const filters = value === '' ? rest : [...rest, { field, op, value, unit }];
      return { ...s, offset: 0, filters };
    });
  }, []);

  const filterFor = useCallback(
    (field: string): ActiveFilter | undefined => state.filters.find((f) => f.field === field),
    [state.filters],
  );

  const visibleFields = useMemo(
    () => fields.filter((f) => showAll || f.common),
    [fields, showAll],
  );

  const applyExample = (params: string) => setState(paramsToState(new URLSearchParams(params)));

  const activeCount = state.filters.length + (state.q ? 1 : 0);

  return (
    <>
      {/* Outside .layout so the sticky bar and its border span the full width
          rather than stopping at the content column. */}
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <strong>AllCarsDB</strong>{' '}
            <span className="muted">every car, every engine</span>
          </div>
          <div className="header-actions">
            <div className="unit-toggle">
              <button
                className={units === 'imperial' ? 'pill active' : 'pill'}
                onClick={() => setUnits('imperial')}
              >
                Imperial
              </button>
              <button
                className={units === 'metric' ? 'pill active' : 'pill'}
                onClick={() => setUnits('metric')}
              >
                Metric
              </button>
            </div>
            <a className="link-btn" href="https://github.com/shifter907/allcarsdb">
              Contribute
            </a>
          </div>
        </div>
      </header>

      <div className="layout">
      <main className="panel">
        <div className="text-search">
          <input
            type="search"
            placeholder="Search year, make or model — try “2023 porsche”"
            value={state.q}
            onChange={(e) => update({ q: e.target.value })}
          />
          {activeCount > 0 && (
            <button className="ghost-btn" onClick={() => setState(EMPTY_STATE)}>
              Clear all
            </button>
          )}
        </div>

        <div className="examples">
          <span className="examples-label">Try:</span>
          {EXAMPLES.map((ex) => (
            <button key={ex.label} className="chip" onClick={() => applyExample(ex.params)}>
              {ex.label}
            </button>
          ))}
        </div>

        <div className="filter-grid">
          {visibleFields.map((f) => (
            <FilterControl
              key={f.name}
              field={f}
              choices={choices[f.name] ?? []}
              active={filterFor(f.name)}
              units={units}
              onChange={setFilter}
            />
          ))}
        </div>

        {fields.length > 0 && (
          <button className="ghost-btn" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Fewer filters' : 'More filters'}
          </button>
        )}
      </main>

      <section className="results-head">
        <div>
          {loading && <span className="spinner" aria-label="Loading" />}
          <strong>{data ? data.total.toLocaleString() : '—'}</strong>{' '}
          {data?.total === 1 ? 'result' : 'results'}
        </div>
        <select value={state.sort} onChange={(e) => update({ sort: e.target.value })}>
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </section>

      {error && <div className="error">{error}</div>}

      {data && data.results.length === 0 && !error && (
        <div className="empty">
          <p>Nothing matches all of those filters.</p>
          <p className="muted">
            That may be a real answer — plenty of engine and vehicle combinations were never
            built. It may also mean the data is missing: this database is young, and a car with
            no recorded value for a spec is excluded from filters on it.
          </p>
          <p className="muted">
            If you know a car that should be here, adding it is a pull request against one
            CSV file.
          </p>
        </div>
      )}

      <div className="cards">
        {data?.results.map((r) => (
          <article className="card" key={r.index}>
            <div className="card-main">
              <h3>{r.vehicle.name}</h3>
              {r.engine.summary && <div className="muted">{r.engine.summary}</div>}
              <dl className="specs">
                <Spec label="Layout" value={r.engine.layout} />
                <Spec label="Cylinders" value={r.engine.cylinders} />
                <Spec label="Displacement" value={formatDisplacement(r.engine.displacement_cc)} />
                <Spec label="Aspiration" value={r.engine.aspiration} />
                <Spec label="Fuel" value={r.engine.fuel_type} />
                <Spec label="Compression" value={r.engine.compression_ratio} />
                <Spec label="Delivery" value={r.engine.fuel_delivery} />
              </dl>
            </div>
          </article>
        ))}
      </div>

      {data && data.facets.some((f) => f.values.length > 0) && (
        <section className="facets">
          <h4>Narrow it down</h4>
          <div className="facet-grid">
            {data.facets
              .filter((f) => f.values.length > 0)
              .map((f) => (
                <div className="facet" key={f.field}>
                  <h5>{fields.find((x) => x.name === f.field)?.label ?? f.field}</h5>
                  {f.values.slice(0, 8).map((v) => (
                    <button
                      key={String(v.value)}
                      className="row"
                      onClick={() => setFilter(f.field, 'eq', String(v.value))}
                    >
                      <span>{String(v.value)}</span>
                      <span className="muted">{v.n}</span>
                    </button>
                  ))}
                </div>
              ))}
          </div>
        </section>
      )}

      {data && data.total > data.limit && (
        <div className="pager">
          <button
            className="ghost-btn"
            disabled={state.offset === 0}
            onClick={() => setState((s) => ({ ...s, offset: Math.max(0, s.offset - 50) }))}
          >
            Previous
          </button>
          <span className="muted">
            {data.offset + 1}–{Math.min(data.offset + data.limit, data.total)} of{' '}
            {data.total.toLocaleString()}
          </span>
          <button
            className="ghost-btn"
            disabled={data.offset + data.limit >= data.total}
            onClick={() => setState((s) => ({ ...s, offset: s.offset + 50 }))}
          >
            Next
          </button>
        </div>
      )}

      <footer className="footer">
        {stats && (
          <span className="muted">
            {Number(stats.vehicle_years ?? 0).toLocaleString()} vehicle-years ·{' '}
            {Number(stats.engines ?? 0).toLocaleString()} engines ·{' '}
            {Number(stats.makes ?? 0).toLocaleString()} makes
          </span>
        )}
        <span className="muted">
          Open data, CC BY-SA 4.0 ·{' '}
          <a href="https://github.com/shifter907/allcarsdb">source &amp; contributing</a>
        </span>
      </footer>
      </div>
    </>
  );
}

function Spec({ label, value }: { label: string; value: string | number | null }) {
  if (value === null || value === undefined || value === '') return null;
  // The pair is wrapped in a div -- valid inside a <dl> in HTML5 -- so that
  // each label sits above its own value. Left as bare dt/dd siblings they
  // become independent grid items and flow across the columns, pairing every
  // label with the wrong number.
  return (
    <div className="spec">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * One filter control, shaped by the field's declared kind.
 *
 * Text fields with known values get a dropdown built from what is actually in
 * the database; text fields without get a contains-search; numbers get a
 * comparison plus a value, and a unit selector when the quantity has units.
 */
function FilterControl({
  field,
  choices,
  active,
  units,
  onChange,
}: {
  field: FieldDef;
  choices: Choice[];
  active?: ActiveFilter;
  units: UnitSystem;
  onChange: (field: string, op: string, value: string, unit?: string) => void;
}) {
  const unitChoices = unitOptions(field.quantity, units);
  const [op, setOp] = useState(active?.op ?? (field.kind === 'number' ? 'eq' : 'eq'));
  const [unit, setUnit] = useState(active?.unit ?? unitChoices[0]);

  useEffect(() => { if (active?.op) setOp(active.op); }, [active?.op]);

  const value = active?.value ?? '';

  if (field.kind === 'text' && choices.length > 0) {
    // A filter can be active with a value that is not one of the choices --
    // a `contains:` filter from a shared link, or a value that has since left
    // the data. Without an option to select, the control falls back to "Any"
    // while the results stay filtered, and the page contradicts itself.
    const unlisted = value !== '' && !choices.some((c) => c.value === value);

    return (
      <label className="filter">
        <span>{field.label}</span>
        <select
          value={value}
          onChange={(e) => onChange(field.name, 'eq', e.target.value)}
          title={field.description}
        >
          <option value="">Any</option>
          {unlisted && (
            <option value={value}>
              {active?.op === 'contains' ? `contains “${value}”` : value}
            </option>
          )}
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.value} ({c.n})
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.kind === 'text') {
    return (
      <label className="filter">
        <span>{field.label}</span>
        <input
          type="text"
          placeholder="contains…"
          value={value}
          onChange={(e) => onChange(field.name, 'contains', e.target.value)}
          title={field.description}
        />
      </label>
    );
  }

  return (
    <label className="filter">
      <span>{field.label}</span>
      <div className="row">
        <select value={op} onChange={(e) => { setOp(e.target.value); onChange(field.name, e.target.value, value, unit); }}>
          <option value="eq">is</option>
          <option value="gte">at least</option>
          <option value="lte">at most</option>
          <option value="gt">more than</option>
          <option value="lt">less than</option>
        </select>
        <input
          type="number"
          inputMode="decimal"
          value={value}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(field.name, op, e.target.value, unit)}
          title={field.description}
        />
        {unitChoices.length > 0 && (
          <select
            value={unit}
            onChange={(e) => { setUnit(e.target.value); onChange(field.name, op, value, e.target.value); }}
          >
            {unitChoices.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        )}
      </div>
    </label>
  );
}
