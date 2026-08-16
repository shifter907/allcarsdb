import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  search,
  loadMetadata,
  loadStats,
  paramsToState,
  stateToParams,
  formatDisplacement,
  formatPower,
  formatTorque,
  SORT_OPTIONS,
  EMPTY_STATE,
  type ActiveFilter,
  type Choice,
  type FieldDef,
  type SearchResponse,
  type SearchResult,
  type SearchState,
  type UnitSystem,
} from './api';
import { useRoute, linkProps } from './router';
import { TablesIndex, TableDetail } from './Tables';

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

/**
 * Display names for the filter sections. Falls back to the raw group key, so a
 * group added to the field registry shows up with a usable heading before
 * anyone gets around to naming it here.
 */
const GROUP_LABELS: Record<string, string> = {
  vehicle: 'Vehicle',
  powertrain: 'Powertrain & Electric',
  engine: 'Engine',
  drivetrain: 'Transmission & Drivetrain',
  body: 'Body & Dimensions',
  interior: 'Interior',
  capability: 'Towing, Weight & Performance',
  trim: 'Trim',
};

const groupLabel = (key: string) =>
  GROUP_LABELS[key] ?? key.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export default function App() {
  const route = useRoute();
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [units, setUnits] = useState<UnitSystem>(
    () => (localStorage.getItem('units') as UnitSystem) ?? 'imperial',
  );

  useEffect(() => { loadStats().then(setStats).catch(() => {}); }, []);
  useEffect(() => localStorage.setItem('units', units), [units]);

  return (
    <>
      {/* Outside .layout so the sticky bar and its border span the full width
          rather than stopping at the content column. */}
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <a className="brand-link" {...linkProps('/')}>
              <strong>AllCarsDB</strong>
            </a>{' '}
            <span className="muted">The most comprehensive vehicle spec database ever created. Free Forever.</span>
          </div>
          <div className="header-actions">
            <a className="link-btn" {...linkProps('/tables')}>Data model</a>
            {route.name === 'search' && (
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
            )}
            <a className="link-btn" href="https://github.com/shifter907/allcarsdb">
              Contribute
            </a>
          </div>
        </div>
      </header>

      <div className="layout">
        {route.name === 'search' && <SearchPage units={units} />}
        {route.name === 'tables' && <TablesIndex />}
        {route.name === 'table' && <TableDetail name={route.table} />}

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
            <a {...linkProps('/tables')}>data model</a> ·{' '}
            <a href="https://github.com/shifter907/allcarsdb">source &amp; contributing</a>
          </span>
        </footer>
      </div>
    </>
  );
}

function SearchPage({ units }: { units: UnitSystem }) {
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [choices, setChoices] = useState<Record<string, Choice[]>>({});
  const [state, setState] = useState<SearchState>(() =>
    paramsToState(new URLSearchParams(window.location.search)),
  );
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string> | null>(null);

  const inFlight = useRef<AbortController | null>(null);
  // The first search (right after metadata loads) fires immediately -- there
  // is nothing to coalesce it with, so delaying it would only make the
  // landing page feel slower for no benefit. Every search after that is a
  // real edit to a real state, and those get debounced.
  const firstSearch = useRef(true);

  useEffect(() => {
    loadMetadata()
      .then((m) => { setFields(m.fields); setChoices(m.choices); })
      .catch((e) => setError(e.message));
  }, []);

  // The URL is the state. Every change rewrites it, and the popstate handler
  // reads it back, so Back genuinely undoes a filter instead of leaving the
  // page while the address bar still shows it.
  useEffect(() => {
    const onPop = () => setState(paramsToState(new URLSearchParams(window.location.search)));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const knownFields = useMemo(() => new Set(fields.map((f) => f.name)), [fields]);

  /**
   * Which fields to ask for facets on.
   *
   * This used to be "every field", which is what made the dropdowns narrow
   * each other. At ~60 fields that becomes ~60 GROUP BY statements per
   * debounced keystroke, several of them over semi-joins -- and the compiler
   * rejects the request outright past its facet cap. So it is now the fields
   * that actually need fresh options: the ones with an active filter, the
   * sections the user has open, and the common fields that make up the default
   * panel. Everything else keeps whatever options it already had, which is
   * correct because a collapsed dropdown nobody is looking at does not need to
   * re-narrow.
   */
  const facetFields = useMemo(() => {
    const wanted = new Set<string>();
    for (const f of fields) {
      if (f.common) wanted.add(f.name);
      if (openGroups?.has(f.group)) wanted.add(f.name);
    }
    for (const f of state.filters) if (knownFields.has(f.field)) wanted.add(f.field);
    // Bounded well below the compiler's cap, so a user opening every section
    // at once still produces a request the server will accept.
    return [...wanted].slice(0, 36);
  }, [fields, openGroups, state.filters, knownFields]);

  // How long to wait after the *last* filter change before actually asking
  // the server. Picking Make, then Model, then Cylinders in quick succession
  // used to be three requests; debounced, it is one, fired after things settle.
  const SEARCH_DEBOUNCE_MS = 400;

  useEffect(() => {
    // The URL update is not debounced -- it costs nothing (no network) and
    // "the address bar always matches what's on screen" is worth keeping true
    // on every keystroke, independent of when the search itself actually fires.
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

    const runSearch = () => {
      inFlight.current?.abort();
      const ctrl = new AbortController();
      inFlight.current = ctrl;

      setLoading(true);
      setError(null);
      search(req, facetFields, ctrl.signal)
        .then((d) => {
          setData(d);
          setLoading(false);

          // Merged, not replaced. Facets are requested lazily now, so a
          // response only carries the fields that were asked for -- replacing
          // wholesale would blank out every dropdown the user had not just
          // interacted with.
          const fresh: Record<string, Choice[]> = {};
          for (const f of d.facets) fresh[f.field] = f.values;
          setChoices((prev) => ({ ...prev, ...fresh }));

          // A filter can be invalidated by a *different* filter changing --
          // picking Make=Ford after Model=Corvette was already selected leaves
          // a combination that does not exist. Rather than let it sit selected
          // and silently return zero results, drop whatever is no longer among
          // its field's current choices. Each pass can only remove filters, so
          // this always terminates rather than looping.
          //
          // Only fields whose facets came back in THIS response can be judged.
          // A field that was not requested has no fresh evidence against it, and
          // treating stale or absent options as proof of invalidity would drop
          // filters the user set deliberately.
          const stillValid = (f: ActiveFilter) => {
            const opts = fresh[f.field];
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
    };

    if (firstSearch.current) {
      firstSearch.current = false;
      runSearch();
      return () => inFlight.current?.abort();
    }

    // Mark loading immediately so the UI acknowledges the change right away,
    // even though the request itself waits out the debounce window -- a
    // spinner that only appears once the network call starts would leave a
    // dead-looking gap between "I clicked something" and "it's doing anything".
    setLoading(true);
    const timeoutId = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [state, fields, knownFields, facetFields]);

  const update = useCallback((next: Partial<SearchState>) => {
    // Any change to the query resets paging: staying on page 4 of a result set
    // that just changed shape shows the user an arbitrary slice of something
    // they did not ask for.
    setState((s) => ({ ...s, offset: 0, ...next }));
  }, []);

  const setFilter = useCallback((field: string, op: string, value: string) => {
    setState((s) => {
      let rest = s.filters.filter((f) => f.field !== field);
      // Engine Variant only means anything relative to a chosen Engine Code --
      // clearing Code should clear whatever variant was picked under it too,
      // rather than leaving an invisible filter still narrowing the results
      // once its control has disappeared from the panel.
      if (field === 'code' && value === '') {
        rest = rest.filter((f) => f.field !== 'named_variant');
      }
      const filters = value === '' ? rest : [...rest, { field, op, value }];
      return { ...s, offset: 0, filters };
    });
  }, []);

  const filterFor = useCallback(
    (field: string): ActiveFilter | undefined => state.filters.find((f) => f.field === field),
    [state.filters],
  );

  // Engine Variant ("B30", "Alpina") only means something once an Engine Code
  // is chosen -- a raw list of every variant name across every engine family
  // is not a useful thing to filter on by itself. Hiding the control until
  // Code is active also means there is never an empty dropdown sitting in the
  // panel with nothing to offer.
  const codeActive = state.filters.some((f) => f.field === 'code' && f.value !== '');
  const visibleFields = useMemo(
    () => fields.filter((f) => f.name !== 'named_variant' || codeActive),
    [fields, codeActive],
  );

  /**
   * Filters are grouped into collapsible sections rather than one flat grid.
   * With seventeen fields a grid was merely busy; the data model this is
   * heading toward has well over a hundred, at which point a single wall of
   * dropdowns stops being usable at all. Grouping is the thing that scales.
   */
  const groups = useMemo(() => {
    const byGroup = new Map<string, FieldDef[]>();
    for (const f of visibleFields) {
      const list = byGroup.get(f.group);
      if (list) list.push(f);
      else byGroup.set(f.group, [f]);
    }
    return [...byGroup.entries()].map(([key, groupFields]) => ({
      key,
      label: groupLabel(key),
      fields: groupFields,
      // Whether this section contains any filter that describes a specific
      // configuration rather than the car -- which is what makes the
      // same-configuration question meaningful here.
      hasBuildFields: groupFields.some((f) => f.grain === 'build'),
      // A section where nothing has any values yet renders as a column of
      // dropdowns that all say "Any", which reads as broken rather than as
      // empty. Knowing the difference lets it say so instead.
      hasAnyChoices: groupFields.some((f) => (choices[f.name]?.length ?? 0) > 0),
      // A section holding at least one "common" field is one most people want
      // open on arrival. As the registry grows, the specialised sections
      // (interior dimensions, drivetrain internals) have no common fields and
      // so stay collapsed until someone goes looking for them.
      defaultOpen: groupFields.some((f) => f.common),
    }));
  }, [visibleFields, choices]);

  // Null until the field registry arrives, then seeded once from the defaults.
  // After that it is whatever the user has opened or closed.
  useEffect(() => {
    if (openGroups === null && groups.length > 0) {
      setOpenGroups(new Set(groups.filter((g) => g.defaultOpen).map((g) => g.key)));
    }
  }, [groups, openGroups]);

  const toggleGroup = useCallback((key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const applyExample = (params: string) => setState(paramsToState(new URLSearchParams(params)));

  const activeCount = state.filters.length + (state.q ? 1 : 0);

  return (
    <>
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

        <div className="filter-sections">
          {groups.map((group) => {
            const open = openGroups?.has(group.key) ?? group.defaultOpen;
            const activeInGroup = group.fields.filter((f) => filterFor(f.name)).length;
            return (
              <section className="filter-section" key={group.key}>
                <button
                  type="button"
                  className="filter-section-head"
                  aria-expanded={open}
                  onClick={() => toggleGroup(group.key)}
                >
                  <span className={open ? 'caret open' : 'caret'} aria-hidden="true">▸</span>
                  <span className="filter-section-title">{group.label}</span>
                  {/* Shown even when collapsed, so a section can never hide an
                      active filter that is silently narrowing the results. */}
                  {activeInGroup > 0 && <span className="badge">{activeInGroup}</span>}
                  <span className="filter-section-count muted">{group.fields.length}</span>
                </button>

                {open && !group.hasAnyChoices && (
                  <p className="section-empty">
                    Nothing recorded here yet — these filters come alive as
                    contributors add the data.{' '}
                    <a {...linkProps('/tables')}>See what they hold</a>.
                  </p>
                )}

                {open && (
                  <div className="filter-grid">
                    {group.fields.map((f) => (
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
                )}

                {/* Configuration-level filters can be read two ways, and the
                    difference is not obvious from the controls alone, so the
                    choice is offered where those filters actually are. */}
                {open && group.hasBuildFields && (
                  <label className="same-build">
                    <input
                      type="checkbox"
                      checked={state.sameBuild}
                      onChange={(e) =>
                        setState((s) => ({ ...s, offset: 0, sameBuild: e.target.checked }))
                      }
                    />
                    <span>
                      Require one configuration to meet all of these
                      <span className="muted">
                        {' '}— otherwise a vehicle qualifies if different configurations
                        satisfy them separately.
                      </span>
                    </span>
                  </label>
                )}
              </section>
            );
          })}
        </div>
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
        {data?.results.map((r) => {
          const tag = vehicleTag(r.vehicle);
          return (
          <article className="card" key={r.index}>
            <div className="card-main">
              <h3>
                {r.vehicle.name}
                {tag && <span className="muted"> ({tag})</span>}
              </h3>
              {r.engine ? (
                <>
                  {(r.engine.summary || engineTag(r.engine)) && (
                    <div className="muted">
                      {r.engine.summary}
                      {r.engine.summary && engineTag(r.engine) && ' — '}
                      {engineTag(r.engine)}
                      {r.powertrain?.type && r.powertrain.type !== 'ICE' && (
                        <span className="pt-badge">{r.powertrain.type}</span>
                      )}
                    </div>
                  )}
                  <dl className="specs">
                    <Spec label="Layout" value={r.engine.layout} />
                    <Spec label="Cylinders" value={r.engine.cylinders} />
                    <Spec label="Displacement" value={formatDisplacement(r.engine.displacement_cc, units)} />
                    <Spec label="Horsepower" value={formatPower(r.engine.horsepower, units)} />
                    <Spec label="Torque" value={formatTorque(r.engine.torque_lbft, units)} />
                    <Spec label="Aspiration" value={r.engine.aspiration} />
                    <Spec label="Fuel" value={r.engine.fuel_type} />
                    <Spec label="Compression" value={r.engine.compression_ratio} />
                    <Spec label="Delivery" value={r.engine.fuel_delivery} />
                    <Spec label="Valvetrain" value={r.engine.valvetrain} />
                    <Spec label="Redline" value={r.engine.redline_rpm ? `${r.engine.redline_rpm.toLocaleString()} rpm` : null} />
                  </dl>
                </>
              ) : r.powertrain && !r.powertrain.engine_expected ? (
                // A battery-electric or fuel-cell car genuinely has no engine.
                // Saying "no engine data recorded yet" here would report a
                // complete record as an incomplete one.
                <>
                  <div className="muted">
                    {electricSummary(r.powertrain, units)}
                    <span className="pt-badge">{r.powertrain.type}</span>
                  </div>
                  <dl className="specs">
                    <Spec label="Power" value={formatPower(r.powertrain.combined_horsepower, units)} />
                    <Spec label="Torque" value={formatTorque(r.powertrain.combined_torque_lbft, units)} />
                    <Spec label="Range" value={r.powertrain.electric_range_mi ? `${r.powertrain.electric_range_mi} mi` : null} />
                    <Spec label="Battery" value={r.powertrain.battery?.usable_kwh ? `${r.powertrain.battery.usable_kwh} kWh usable` : null} />
                    <Spec label="Chemistry" value={r.powertrain.battery?.chemistry ?? null} />
                    <Spec label="DC Charge" value={r.powertrain.dc_charge_kw ? `${r.powertrain.dc_charge_kw} kW` : null} />
                    <Spec label="Port" value={r.powertrain.charge_port} />
                  </dl>
                </>
              ) : (
                // A vehicle can exist with no powertrain recorded yet -- the
                // join is a LEFT JOIN specifically so this car is still shown
                // rather than disappearing from every search until someone
                // fills that in. Saying so plainly beats pretending the gap
                // isn't there.
                <div className="incomplete">No engine data recorded yet.</div>
              )}

              {r.capability && (
                <dl className="specs capability">
                  <Spec label="Max towing" value={r.capability.max_towing_lb ? `${r.capability.max_towing_lb.toLocaleString()} lb` : null} />
                  <Spec label="Max payload" value={r.capability.max_payload_lb ? `${r.capability.max_payload_lb.toLocaleString()} lb` : null} />
                  <Spec label="Curb weight" value={r.capability.min_curb_weight_lb ? `from ${r.capability.min_curb_weight_lb.toLocaleString()} lb` : null} />
                  <Spec label="Best MPG" value={r.capability.best_epa_combined_mpg} />
                  <Spec label="0–60" value={r.capability.quickest_zero_to_sixty_s ? `${r.capability.quickest_zero_to_sixty_s}s` : null} />
                  <Spec label="Trims" value={r.capability.trims} />
                </dl>
              )}
            </div>
          </article>
          );
        })}
      </div>

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
    </>
  );
}

/**
 * "E46 · Gen 4 · MQB · "OBS"" from whichever of the four vehicle-identity
 * fields are actually present. Chassis code leads because it's what an
 * enthusiast recognises fastest; the nickname trails in quotes since it's
 * the least formal of the four and reads oddly leading a title.
 */
function vehicleTag(v: SearchResult['vehicle']): string {
  const parts: string[] = [];
  if (v.dev_chassis_code) parts.push(v.dev_chassis_code);
  if (v.generation) parts.push(`Gen ${v.generation}`);
  if (v.platform_code) parts.push(v.platform_code);
  if (v.nickname) parts.push(`"${v.nickname}"`);
  return parts.join(' · ');
}

/**
 * "BMW S58" or "BMW S58 B30" from whichever of the engine-identity fields are
 * present. Silent_Variant never reaches the client at all -- it exists purely
 * to let two otherwise-identical rows coexist in the database -- so there is
 * nothing to filter out here; Named_Variant is the only differentiator meant
 * to ever be seen.
 */
/**
 * "272 mi · 57.5 kWh" for a car with no engine to summarise. Built from
 * whichever parts are present, the same way engineSummary is on the server.
 */
function electricSummary(
  p: NonNullable<SearchResult['powertrain']>,
  units: UnitSystem,
): string {
  const parts: string[] = [];
  const power = formatPower(p.combined_horsepower, units);
  if (power) parts.push(power);
  if (p.electric_range_mi) parts.push(`${p.electric_range_mi} mi range`);
  if (p.battery?.usable_kwh) parts.push(`${p.battery.usable_kwh} kWh`);
  return parts.join(' · ');
}

function engineTag(e: NonNullable<SearchResult['engine']>): string {
  const parts: string[] = [];
  if (e.manufacturer) parts.push(e.manufacturer);
  if (e.code) parts.push(e.code);
  if (e.named_variant) parts.push(e.named_variant);
  return parts.join(' ');
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

  const label = (v: string | number) => {
    if (field.name === 'displacement') return formatDisplacement(Number(v), units) ?? String(v);
    if (field.name === 'horsepower') return formatPower(Number(v), units) ?? String(v);
    if (field.name === 'torque') return formatTorque(Number(v), units) ?? String(v);
    return String(v);
  };

  // Choices carry a count from the server, but it is deliberately not rendered.
  // "Ford (1,898)" invites the number to be read as a fact about Ford when it
  // is really a fact about how much data has been entered so far -- and it
  // makes every option in a long dropdown harder to scan.
  const options = (
    <>
      <option value="">Any</option>
      {unlisted && <option value={value}>{value} (no longer in the data)</option>}
      {choices.map((c) => (
        <option key={String(c.value)} value={String(c.value)}>
          {label(c.value)}
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
