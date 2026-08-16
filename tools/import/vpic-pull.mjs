// Second pass: 1981-2010, filling in the era before the first pull (which
// covered 2011-2025 and is why "most of what's there is 2011 or newer").
// 1981 is the boundary because that's the first US model year under the
// standardized 17-character VIN -- vPIC's data gets meaningfully thinner and
// less consistent before it, which is a real accuracy concern, not just an
// arbitrary cutoff.
//
// Pull Make/Model/Year from NHTSA vPIC. One HTTP call per (make, year, vehicle
// type) -- comma-batching is not supported by GetModelsForMakeYear, confirmed
// against the live API before writing this.
//
// Rewritten after the first attempt (concurrency 12, no pacing) got the
// requesting IP blocked by vPIC's WAF partway through -- and the block did
// NOT show up as an HTTP error. It returned 200 OK with an "Access Denied"
// HTML page, which silently parsed as "zero models for this make" instead of
// a failure, so ~75 of 83 makes came back looking clean but were actually
// just never answered. Two independent fixes for that, not one:
//
//   1. A response is only accepted if it is real JSON with a Results array.
//      Anything else (including a 200 that isn't JSON) is a hard failure,
//      not a quiet empty result.
//   2. A circuit breaker: five failures of that kind *in a row*, anywhere in
//      the run, aborts the whole script immediately. Grinding through the
//      remaining thousands of calls against a wall that is already blocking
//      you wastes time and very plausibly extends the block.
//
// Pacing is deliberately slow -- concurrency 2, a delay after every request.
//
// Resume support: the first two runs got 8, then 38, of 83 makes done before
// stopping (a WAF block, then a cluster of transient "fetch failed" network
// errors after 80 minutes of sustained requests). Redoing completed makes
// from scratch each time wastes the time already spent and adds more load
// right when the API has just shown it can be fragile. RESUME_FROM_INDEX
// skips straight to the first make not fully attempted last run; the
// existing checkpoint file is loaded and merged into, never overwritten.

import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const RESUME_FROM_INDEX = Number(process.argv[2] ?? 0);

const MAKES = [
  'Acura', 'Alfa Romeo', 'AMC', 'Aston Martin', 'Audi', 'Bentley', 'BMW',
  'Bugatti', 'Buick', 'Cadillac', 'Chevrolet', 'Chrysler', 'Dodge', 'Eagle',
  'Ferrari', 'Fiat', 'Fisker', 'Ford', 'Genesis', 'GMC', 'Honda', 'Hummer',
  'Hyundai', 'Infiniti', 'Isuzu', 'Jaguar', 'Jeep', 'Karma', 'Kia',
  'Lamborghini', 'Land Rover', 'Lexus', 'Lincoln', 'Lotus', 'Lucid',
  'Maserati', 'Maybach', 'Mazda', 'McLaren', 'Mercedes-Benz', 'Mercury',
  'Mini', 'Mitsubishi', 'Nissan', 'Oldsmobile', 'Plymouth', 'Polestar',
  'Pontiac', 'Porsche', 'Ram', 'Rivian', 'Rolls-Royce', 'Saab', 'Saturn',
  'Scion', 'Smart', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'VinFast',
  'Volkswagen', 'Volvo', 'Daewoo', 'Geo',
  'Panoz', 'Saleen', 'Shelby', 'Spyker', 'Wiesmann', 'Koenigsegg', 'Pagani',
  'Rimac', 'Morgan', 'Caterham', 'Alpina', 'Datsun', 'Yugo',
  'Callaway', 'Roush', 'Hennessey', 'DeLorean', 'Qvale',
  // Real 1980s/90s US-market makes that had no presence in the 2011-2025
  // window and so were never in the first pull's make list.
  'Sterling', 'Merkur', 'Daihatsu', 'Renault', 'Peugeot', 'Passport',
];

const YEARS = Array.from({ length: 2010 - 1981 + 1 }, (_, i) => 1981 + i);
const TYPES = ['car', 'truck', 'multipurpose passenger vehicle (mpv)'];

const CONCURRENCY = 2;
const DELAY_MS = 600;
const MAX_CONSECUTIVE_FAILURES = 5;
const CHECKPOINT_EVERY = 50;

class BlockedError extends Error {}

async function fetchOne(make, year, type) {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}/vehicletype/${encodeURIComponent(type)}?format=json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AllCarsDB-data-import/1.0' },
  });
  const contentType = res.headers.get('content-type') ?? '';
  const body = await res.text();

  if (!res.ok || !contentType.includes('json') || body.trim().startsWith('<')) {
    throw new BlockedError(`HTTP ${res.status}, content-type "${contentType}", body starts "${body.slice(0, 60)}"`);
  }

  const json = JSON.parse(body);
  return (json.Results ?? []).map((r) => r.Model_Name);
}

async function main() {
  const resumeMakes = MAKES.slice(RESUME_FROM_INDEX);
  const jobs = [];
  for (const make of resumeMakes) for (const year of YEARS) for (const type of TYPES) {
    jobs.push({ make, year, type });
  }
  console.error(`resuming from make #${RESUME_FROM_INDEX} (${resumeMakes[0]})`);
  console.error(`${jobs.length} API calls across ${resumeMakes.length} makes x ${YEARS.length} years x ${TYPES.length} types`);
  console.error(`concurrency ${CONCURRENCY}, ${DELAY_MS}ms delay per request -- expect this to take a while, on purpose`);

  const rows = new Map();
  const addResults = (make, year, models) => {
    for (const model of models) {
      const key = `${make.toLowerCase()} ${model.toLowerCase()} ${year}`;
      if (!rows.has(key)) rows.set(key, { make, model, year });
    }
  };

  // Seed with whatever the prior run already collected -- this run only adds
  // to it, never starts over.
  if (existsSync('vpic-pull-raw.json')) {
    const prior = JSON.parse(readFileSync('vpic-pull-raw.json', 'utf8'));
    for (const r of prior) addResults(r.make, r.year, [r.model]);
    console.error(`loaded ${rows.size} rows from the previous checkpoint`);
  }

  let consecutiveFailures = 0;
  let completed = 0;
  let aborted = false;

  const checkpoint = () => {
    writeFileSync('vpic-pull-raw.json', JSON.stringify([...rows.values()]));
  };

  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !aborted) {
      const job = jobs[next++];
      try {
        const models = await fetchOne(job.make, job.year, job.type);
        addResults(job.make, job.year, models);
        consecutiveFailures = 0;
      } catch (e) {
        consecutiveFailures++;
        console.error(`FAILED ${job.make} ${job.year} ${job.type}: ${e.message}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`\n${MAX_CONSECUTIVE_FAILURES} failures in a row -- stopping now rather than grinding` +
            ` against what looks like another block. ${rows.size} rows collected before this point are saved.`);
          aborted = true;
        }
      }
      completed++;
      if (completed % CHECKPOINT_EVERY === 0) {
        checkpoint();
        console.error(`  ${completed}/${jobs.length} (${rows.size} rows so far)`);
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  checkpoint();

  console.error(`\n${aborted ? 'ABORTED' : 'done'} after ${((Date.now() - started) / 1000).toFixed(0)}s, ` +
    `${completed}/${jobs.length} jobs attempted this run, ${rows.size} distinct (make, model, year) rows total`);
  console.error('wrote vpic-pull-raw.json');
  if (aborted) process.exitCode = 1;
}

main();
