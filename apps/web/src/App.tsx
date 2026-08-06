import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  search,
  loadMetadata,
  loadStats,
  paramsToState,
  stateToParams,
  formatDisplacement,
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
 *
 * Every value here has to be one that could plausibly appear as-is in a
 * dropdown -- there is no free-text entry any more, so an example pointing at
 * a value the data does not have would just look broken when clicked.
 */
const EXAMPLES: { label: string; params: string }[] = [
  { label: 'Flat-6s', params: 'layout=Flat&cylinders=6' },
  { label: 'Turbocharged fours', params: 'cylinders=4&aspiration=Turbocharged' },
  { label: 'V8s', params: 'layout=V&cylinders=8' },
  { label: 'Diesels', params: 'fuel_type=Diesel' },
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
  // Every field is requested as a facet, not a curated subset -- this is what
  // makes each dropdown reflect every *other* active filter. See search() in
  // api.ts for why that specific combination narrows the options.
  const facetFields = useMemo(() => fields.map((f) => f.name), [fields]);

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
    search(req, facetFields, ctrl.signal)
      .then((d) => {
        setData(d);
        setLoading(false);

        const newChoices: Record<string, Choice[]> = {};
        for (const f of d.facets) newChoices[f.field] = f.values;
        setChoices(newChoices);

        // A filter can be invalidated by a *different* filter changing --
        // picking Make=Ford after Model=Corvette was already selected leaves
        // a combination that does not exist. Rather than let it sit selected
        // and silently return zero results, drop whatever is no longer among
        // its field's current choices. Each pass can only remove filters, so
        // this always terminates rather than looping.
        const stillValid = (f: ActiveFilter) => {
          const opts = newChoices[f.field];
          return !opts || opts.some((c) => String(c.value) === f.value);
        };
        const survivors = req.filters.filter(stillValid);
        if (survivors.length !== req.filters.length) {
          setState((s) => ({ ...s, offset: 0, filters: survivors }));
        }
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setError(e.message);
        setLoading(false);
      });

    return () => ctrl.abort();
  }, [state, fields, knownFields, facetFields]);

  const update = useCallback((next: Partial<SearchState>) => {
    // Any change to the query resets paging: staying on page 4 of a result set
    // that just changed shape shows the user an arbitrary slice of something
    // they did not ask for.
    setState((s) => ({ ...s, offset: 0, ...next }));
  }, []);

  const setFilter = useCallback((field: string, op: string, value: string) => {
    setState((s) => {
      const rest = s.filters.filter((f) => f.field !== field);
      const filters = value === '' ? rest : [...rest, { field, op, value }];
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
              {r.engine ? (
                <>
                  {r.engine.summary && <div className="muted">{r.engine.summary}</div>}
                  <dl className="specs">
                    <Spec label="Layout" value={r.engine.layout} />
                    <Spec label="Cylinders" value={r.engine.cylinders} />
                    <Spec label="Displacement" value={formatDisplacement(r.engine.displacement_cc, units)} />
                    <Spec label="Aspiration" value={r.engine.aspiration} />
                    <Spec label="Fuel" value={r.engine.fuel_type} />
                    <Spec label="Compression" value={r.engine.compression_ratio} />
                    <Spec label="Delivery" value={r.engine.fuel_delivery} />
                  </dl>
                </>
              ) : (
                // A vehicle can exist with no engine recorded yet -- the join
                // is a LEFT JOIN specifically so this car is still shown rather
                // than disappearing from every search until someone fills that
                // in. Saying so plainly beats pretending the gap isn't there.
                <div className="incomplete">No engine data recorded yet.</div>
              )}
            </div>
          </article>
        ))}
      </div>

      {/* There used to be a "narrow it down" panel here, listing the top
          values of a curated few fields as clickable buttons. It is gone now
          because every dropdown above does the same job for every field, not
          a curated four -- and does it better: it stays in sync with what is
          still actually choosable given the rest of the filters, instead of
          offering a value that would zero out the results. */}

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
 * One filter control. Every field is a dropdown of values actually present in
 * the data -- there is no free-text entry anywhere in the filter panel, so
 * there is no way to type a value the database will silently fail to match
 * because of a typo or a unit the field wasn't expecting.
 *
 * Numeric fields additionally get an operator dropdown ("is" / "at least" /
 * "at most"), because a comparison is still useful and the value being chosen
 * from a real list is what makes it safe to offer -- "at least 6" cylinders
 * means something precise when 6 is a value that exists.
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
  onChange: (field: string, op: string, value: string) => void;
}) {
  const value = active?.value ?? '';

  // A filter can be active with a value that is no longer among the choices --
  // most often because the last row carrying it was edited or removed since
  // the page loaded. Without an option to select, the control would silently
  // fall back to "Any" while the results stayed filtered, contradicting itself.
  const unlisted = value !== '' && !choices.some((c) => String(c.value) === value);

  const label = (v: string | number) =>
    field.name === 'displacement' ? (formatDisplacement(Number(v), units) ?? String(v)) : String(v);

  const options = (
    <>
      <option value="">Any</option>
      {unlisted && <option value={value}>{value} (no longer in the data)</option>}
      {choices.map((c) => (
        <option key={String(c.value)} value={String(c.value)}>
          {label(c.value)} ({c.n})
        </option>
      ))}
    </>
  );

  if (field.kind === 'text') {
    return (
      <label className="filter">
        <span>{field.label}</span>
        <select
          value={value}
          onChange={(e) => onChange(field.name, 'eq', e.target.value)}
          title={field.description}
        >
          {options}
        </select>
      </label>
    );
  }

  const op = active?.op ?? 'eq';

  return (
    <label className="filter">
      <span>{field.label}</span>
      <div className="row">
        <select
          value={op}
          onChange={(e) => onChange(field.name, e.target.value, value)}
        >
          <option value="eq">is</option>
          <option value="gte">at least</option>
          <option value="lte">at most</option>
          <option value="gt">more than</option>
          <option value="lt">less than</option>
        </select>
        <select
          value={value}
          onChange={(e) => onChange(field.name, op, e.target.value)}
          title={field.description}
        >
          {options}
        </select>
      </div>
    </label>
  );
}
