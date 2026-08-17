/**
 * Build the interactive review page from the template plus the unmatched data.
 *
 * Run `epa-candidates.mjs` first -- this reads its JSON output.
 *
 *   node tools/import/build-review.mjs
 *   -> tools/import/cache/epa-review.html
 *
 * The page is self-contained: the data is embedded, so it works offline and can
 * be published as-is. Decisions live in the browser's localStorage and are
 * exported as CSV, because nothing here can write back to the repo.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { CACHE } from './paths.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(here, 'review-template.html');

// --- compact the review data ------------------------------------------------
/**
 * Short keys and three candidates only. The full candidate dump is ~950 KB;
 * this is under 500 KB, which matters because it is inlined into the page.
 */
const source = JSON.parse(readFileSync(CACHE + 'epa-unmatched.json', 'utf8'));
const payload = source
  .map((o) => ({
    m: o.make,
    e: o.epaModel,
    r: o.rows,
    y: o.epaYears,
    c: (o.candidates ?? []).slice(0, 3)
      .map((c) => [c.model, Math.round(c.score * 100), c.yearOverlap, c.nameOverlap, c.ourYears]),
  }))
  // Ordered by how many dropped rows each decision unblocks, so reading down
  // the list is the same as working highest-impact-first.
  .sort((a, b) => b.r - a.r);

// --- inject -----------------------------------------------------------------
const template = readFileSync(TEMPLATE, 'utf8');

/**
 * Matched by regex rather than an exact string because the template's line
 * endings flip between LF and CRLF depending on what last touched it. A literal
 * "\n" marker silently failed to match once and produced a page with no data in
 * it at all -- which looked fine until it was opened.
 */
const MARKER = /<script>(\r?\n)\(\(\) => \{/;
if (!MARKER.test(template)) {
  throw new Error('template marker not found -- did review-template.html change?');
}

// A literal </script> inside the JSON would close the tag early. Model names
// carry no markup today; escaping costs nothing and removes the whole class.
const json = JSON.stringify(payload)
  .replace(/</g, '\\u003c')
  .replace(/[\u2028\u2029]/g, '');

const out = template.replace(
  MARKER,
  (m) => `<script type="application/json" id="payload">${json}</script>\n\n${m}`,
);

const dest = CACHE + 'epa-review.html';
writeFileSync(dest, out);

const totalRows = payload.reduce((s, o) => s + o.r, 0);
const band = (o) => (!o.c.length ? 'none' : o.c[0][1] >= 60 ? 'strong' : 'weak');
const tally = { strong: 0, weak: 0, none: 0 };
for (const o of payload) tally[band(o)]++;

console.log(`${payload.length} names / ${totalRows.toLocaleString()} dropped EPA rows`);
console.log(`  strong ${tally.strong} · weak ${tally.weak} · no candidate ${tally.none}`);
console.log(`wrote ${dest} (${(out.length / 1024 / 1024).toFixed(2)} MB)`);
