/**
 * The two schema-browsing pages.
 *
 * These exist so the database is inspectable without cloning the repo or
 * knowing SQL. The search page answers "which cars match this"; these answer
 * "what is actually in here, and what does each column mean" -- which is the
 * question a prospective contributor has before they can add anything.
 */

import { useEffect, useState } from 'react';
import {
  loadTables,
  loadTable,
  type TableSummary,
  type TablePage,
  type TableColumn,
} from './api';
import { linkProps, navigate } from './router';

const PAGE_SIZE = 50;

/** Index page: every table, what it holds, and how much is in it. */
export function TablesIndex() {
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTables().then(setTables).catch((e) => setError(e.message));
  }, []);

  const source = tables?.filter((t) => t.group === 'source') ?? [];
  const derived = tables?.filter((t) => t.group === 'derived') ?? [];

  return (
    <div className="doc-page">
      <nav className="crumbs">
        <a {...linkProps('/')}>Search</a>
        <span aria-hidden="true">/</span>
        <span>Tables</span>
      </nav>

      <h1 className="doc-title">The data model</h1>
      <p className="doc-lede">
        Everything on this site comes from a handful of CSV files in the repository, loaded into
        SQLite on every build. This page lists each table, what one row of it represents, and what
        every column means — and each table links to its raw contents.
      </p>
      <p className="doc-note">
        A blank cell always means <em>unknown</em>, never zero and never “none”. A car with no
        recorded value for a spec is left out of filters on that spec rather than being guessed at,
        which is why gaps here are expected rather than embarrassing.
      </p>

      {error && <div className="error">{error}</div>}
      {!tables && !error && <p className="muted">Loading…</p>}

      {tables && (
        <>
          <h2 className="doc-h2">Source tables</h2>
          <p className="doc-sub">
            Authored by hand as CSV. These are what a contributor actually edits.
          </p>
          <div className="table-cards">
            {source.map((t) => <TableCard key={t.name} table={t} />)}
          </div>

          <h2 className="doc-h2">Derived</h2>
          <p className="doc-sub">
            Built automatically from the source tables on every rebuild. Never edited directly.
          </p>
          <div className="table-cards">
            {derived.map((t) => <TableCard key={t.name} table={t} />)}
          </div>
        </>
      )}
    </div>
  );
}

function TableCard({ table }: { table: TableSummary }) {
  return (
    <a className="table-card" {...linkProps(`/tables/${table.name}`)}>
      <div className="table-card-head">
        <h3>{table.label}</h3>
        <code className="table-card-name">{table.name}</code>
      </div>
      <p className="table-card-role">{table.role}</p>
      <p className="table-card-desc">{table.description}</p>
      <div className="table-card-stats">
        <span><strong>{table.row_count.toLocaleString()}</strong> rows</span>
        <span><strong>{table.column_count}</strong> columns</span>
        {table.csv && <code className="muted">{table.csv}</code>}
      </div>
    </a>
  );
}

/** Detail page: one table's column documentation, then its raw rows. */
export function TableDetail({ name }: { name: string }) {
  const [page, setPage] = useState<TablePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    loadTable(name, offset, PAGE_SIZE)
      .then((p) => { setPage(p); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [name, offset]);

  // A different table means starting from its first row, not from wherever the
  // previous table happened to be scrolled to.
  useEffect(() => { setOffset(0); }, [name]);

  if (error) {
    return (
      <div className="doc-page">
        <nav className="crumbs">
          <a {...linkProps('/')}>Search</a>
          <span aria-hidden="true">/</span>
          <a {...linkProps('/tables')}>Tables</a>
        </nav>
        <div className="error">{error}</div>
      </div>
    );
  }

  if (!page) return <div className="doc-page"><p className="muted">Loading…</p></div>;

  const { table, rows, total } = page;

  return (
    <div className="doc-page">
      <nav className="crumbs">
        <a {...linkProps('/')}>Search</a>
        <span aria-hidden="true">/</span>
        <a {...linkProps('/tables')}>Tables</a>
        <span aria-hidden="true">/</span>
        <span>{table.label}</span>
      </nav>

      <h1 className="doc-title">{table.label}</h1>
      <div className="doc-meta">
        <code>{table.name}</code>
        <span className={table.group === 'derived' ? 'tag tag-derived' : 'tag'}>
          {table.group === 'derived' ? 'derived' : 'source'}
        </span>
        <span className="muted">{total.toLocaleString()} rows</span>
        {table.csv && <code className="muted">{table.csv}</code>}
      </div>

      <p className="doc-lede">{table.role}</p>
      <p className="doc-note">{table.description}</p>

      <h2 className="doc-h2">Columns</h2>
      <div className="scroll-x">
        <table className="doc-table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Type</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((col) => (
              <tr key={col.name}>
                <td>
                  <code>{col.name}</code>
                  {col.key === 'pk' && <span className="tag tag-pk">key</span>}
                  {col.key === 'fk' && col.references && (
                    <a className="tag tag-fk" {...linkProps(`/tables/${col.references}`)}>
                      → {col.references}
                    </a>
                  )}
                </td>
                <td className="muted">{col.type}</td>
                <td>{col.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="doc-h2">
        Raw data {loading && <span className="spinner" aria-label="Loading" />}
      </h2>
      <div className="scroll-x">
        <table className="doc-table data-table">
          <thead>
            <tr>
              {table.columns.map((col) => <th key={col.name}>{col.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {table.columns.map((col) => (
                  <Cell key={col.name} value={row[col.name]} column={col} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div className="pager">
          <button
            className="ghost-btn"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          >
            Previous
          </button>
          <span className="muted">
            {(offset + 1).toLocaleString()}–{Math.min(offset + PAGE_SIZE, total).toLocaleString()} of{' '}
            {total.toLocaleString()}
          </span>
          <button
            className="ghost-btn"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            Next
          </button>
        </div>
      )}

      <p className="doc-note">
        Something wrong or missing?{' '}
        <a href="https://github.com/shifter907/allcarsdb">Fix it in the CSV</a> — every row here
        started as one line in a text file.
      </p>
    </div>
  );
}

/**
 * A blank cell is rendered as an explicit em-dash rather than as emptiness, so
 * "nobody has recorded this" reads as a deliberate state instead of looking
 * like the page failed to render something.
 *
 * Foreign-key values are deliberately *not* links. Making "10822" clickable
 * implies it jumps to that row, and it cannot -- these pages are paginated by
 * offset, not addressable by index, so the link would quietly dump you on page
 * one of the other table. The column documentation above says where the
 * reference points, which is the part that is actually true.
 */
function Cell({ value, column }: { value: unknown; column: TableColumn }) {
  if (value === null || value === undefined || value === '') {
    return <td className="cell-empty" title="No value recorded">—</td>;
  }
  const isNumeric = column.type === 'integer';
  return (
    <td
      className={isNumeric ? 'cell-num' : undefined}
      title={column.key === 'fk' && column.references ? `References ${column.references}` : undefined}
    >
      {String(value)}
    </td>
  );
}

export { navigate };
