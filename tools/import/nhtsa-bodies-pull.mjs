/**
 * NHTSA vPIC GetCanadianVehicleSpecifications -> raw JSON checkpoint.
 *
 * This is the one NHTSA source that carries real vehicle dimensions. It is
 * queried by make and model year; the response's own MYR field says which spec
 * revision applies, and NHTSA returns the applicable revision for the year
 * asked about. That contract is what makes it safe to attach a result to the
 * year it was requested for.
 *
 * Spot-checked before trusting: the 2019+ Silverado records come back at
 * wheelbase 147.2 / 156.7 / 139.4 / 126.4 in against GM's published 147.4 /
 * 157.0 / 139.5 / 126.5 -- agreement to within the rounding introduced by the
 * source storing centimetres.
 *
 * Same pacing discipline as the earlier vPIC pulls: a WAF block returns HTTP
 * 200 with an HTML body rather than an error status, so a response is only
 * accepted if it really is JSON, and five consecutive failures abort the run
 * instead of grinding against a wall.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { DATA, CACHE } from './paths.mjs';

const RESUME_FROM = Number(process.argv[2] ?? 0);
const OUT = CACHE + 'nhtsa-bodies-raw.json';

// Makes we actually have vehicles for, so nothing is fetched that could not be
// attached to anything.
const MAKES = readFileSync(
  DATA + 'year_make_model.csv', 'utf8',
).split(/\r?\n/).filter(Boolean).slice(1)
  .map((l) => {
    const m = l.match(/^(?:"([^"]*)"|([^,]*)),/);
    return m ? (m[1] ?? m[2]).trim() : null;
  })
  .filter(Boolean);
const UNIQUE_MAKES = [...new Set(MAKES)].sort();

// The dataset begins in the early 1970s; our own data thins out well before
// that, and every call that returns nothing is still a call.
const YEARS = Array.from({ length: 2025 - 1981 + 1 }, (_, i) => 1981 + i);

const CONCURRENCY = 2;
const DELAY_MS = 500;
const MAX_CONSECUTIVE_FAILURES = 5;
const CHECKPOINT_EVERY = 100;

class BlockedError extends Error {}

async function fetchOne(make, year) {
  const url =
    'https://vpic.nhtsa.dot.gov/api/vehicles/GetCanadianVehicleSpecifications/' +
    `?year=${year}&make=${encodeURIComponent(make)}&units=US&format=json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AllCarsDB-data-import/1.0' },
  });
  const ct = res.headers.get('content-type') ?? '';
  const body = await res.text();
  if (!res.ok || !ct.includes('json') || body.trim().startsWith('<')) {
    throw new BlockedError(`HTTP ${res.status}, content-type "${ct}", body starts "${body.slice(0, 60)}"`);
  }
  const json = JSON.parse(body);
  return (json.Results ?? []).map((r) => {
    const s = {};
    for (const spec of r.Specs ?? []) s[spec.Name] = spec.Value;
    return s;
  });
}

async function main() {
  const makes = UNIQUE_MAKES.slice(RESUME_FROM);
  const jobs = [];
  for (const make of makes) for (const year of YEARS) jobs.push({ make, year });

  console.error(`${UNIQUE_MAKES.length} makes total, resuming from #${RESUME_FROM} (${makes[0]})`);
  console.error(`${jobs.length} calls across ${makes.length} makes x ${YEARS.length} years`);

  // Keyed on everything that identifies a distinct spec record, so the same
  // record returned for several years is stored once with all its years.
  const records = new Map();
  if (existsSync(OUT)) {
    for (const r of JSON.parse(readFileSync(OUT, 'utf8'))) {
      records.set(r.key, { ...r, years: new Set(r.years) });
    }
    console.error(`loaded ${records.size} records from checkpoint`);
  }

  let consecutive = 0, completed = 0, aborted = false;
  const checkpoint = () => {
    writeFileSync(OUT, JSON.stringify(
      [...records.values()].map((r) => ({ ...r, years: [...r.years].sort() })),
    ));
  };

  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !aborted) {
      const job = jobs[next++];
      try {
        for (const spec of await fetchOne(job.make, job.year)) {
          if (!spec.Model) continue;
          const key = `${job.make}|${spec.Model}|${spec.MYR ?? ''}`;
          const existing = records.get(key);
          if (existing) existing.years.add(job.year);
          else records.set(key, { key, make: job.make, spec, years: new Set([job.year]) });
        }
        consecutive = 0;
      } catch (e) {
        consecutive++;
        console.error(`FAILED ${job.make} ${job.year}: ${e.message}`);
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`\n${MAX_CONSECUTIVE_FAILURES} failures in a row -- stopping. ` +
            `${records.size} records saved.`);
          aborted = true;
        }
      }
      completed++;
      if (completed % CHECKPOINT_EVERY === 0) {
        checkpoint();
        console.error(`  ${completed}/${jobs.length} (${records.size} records)`);
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  checkpoint();

  console.error(`\n${aborted ? 'ABORTED' : 'done'} after ${((Date.now() - started) / 1000).toFixed(0)}s, ` +
    `${completed}/${jobs.length} calls, ${records.size} distinct spec records`);
  if (aborted) process.exitCode = 1;
}

main();
