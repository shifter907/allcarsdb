/**
 * Where the importers read and write.
 *
 * Resolved from this file's own location rather than the working directory, so
 * the scripts behave the same whether they are run from the repo root or from
 * tools/import.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** The contributor-facing CSVs. Everything here is committed. */
export const DATA = resolve(here, '../../data') + '/';

/**
 * Downloaded source data -- EPA's bulk CSV and the NHTSA pull results.
 *
 * Gitignored: it is tens of megabytes, it is not ours, and the pull scripts
 * regenerate it. The importers fail with a clear message when it is absent
 * rather than silently producing an empty result.
 */
export const CACHE = resolve(here, 'cache') + '/';
