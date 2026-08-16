/**
 * Canonical model names for series-numbered trucks, vans and SUVs.
 *
 * The catalogue inherited vPIC's model list, which spells the same real-world
 * distinction three different ways: Ford is fully series-numbered (F-150,
 * F-250, F-350), GM is not (one "Silverado" row covering 1500 through 3500,
 * plus a "Silverado HD" row merging 2500HD and 3500HD), and Dodge is both at
 * once ("Ram" and "Ram 1500"). A 2500HD and a 1500 are different trucks --
 * different GVWR class, frame, axles, brakes and engines -- and collapsing
 * them loses the distinction buyers actually search on.
 *
 * THE RULE: a word belongs in the model name if it names a different vehicle.
 * If it names a spec stored elsewhere -- drivetrain, cab, box, engine -- it
 * comes out. So "Silverado 2500HD Crew Cab L/Box 4x4" is the model "Silverado
 * 2500HD"; the cab, box and drive go to Body_Configs and Drivetrains.
 *
 * Drivetrain letters are stripped for the same reason. GM's C/K and Dodge's
 * D/W encode 2WD vs 4WD in the model name (C1500 = 2WD, K1500 = 4WD). That is
 * a drivetrain fact, so the model is "C/K 1500" -- GM's own line branding --
 * and the drive layout lives in Drivetrains where it can be filtered.
 *
 * Every name and year span is attested by NHTSA's spec records or EPA's
 * fuel-economy dataset. Nothing is filled in because the pattern looked tidy:
 * Silverado 3500 runs to 2014 and 3500HD begins in 2015 because that is what
 * the sources say, not because a renaming rule was applied.
 *
 * Rules are `requires`/`excludes` term lists rather than one combined pattern,
 * because the sources do not agree on word order. NHTSA writes both "EXPRESS
 * 2500" and "2500 EXPRESS LWB"; a single left-to-right regex matched the first
 * and missed the second, which would have silently dropped eight model years
 * of Express and Savana vans.
 */

/**
 * Ordered; first match wins, so the most specific entry comes first.
 * A rule matches when every `requires` term is present and no `excludes` term is.
 *
 * A rule names a `nameplate` and a `series` separately rather than one joined
 * string, because whether the series belongs in the model name depends on the
 * year. GM badged Suburban 1500 and Suburban 2500 while both existed, then
 * dropped the number in 2015 when only the light-duty one remained -- and the
 * same happened to Yukon XL. Keeping the two parts separate lets that fall out
 * of the data (see `collapseSingleSeries`) instead of being special-cased.
 */
const R = (make, nameplate, series, requires, excludes = []) =>
  ({ make, nameplate, series, requires, excludes });

/**
 * Digit boundaries, not word boundaries. The sources prefix the series with a
 * body or drivetrain letter -- "G1500 EXPRESS", "R1500 Suburban", "C15" -- and
 * `\b1500\b` does not match inside "G1500" because G and 1 are both word
 * characters. That sent every 1997-2010 Express van into the pre-1997 G-Series
 * rows, dating a van line to a decade after it ended.
 */
/**
 * Nameplates that make a bare series prefix mean something else entirely.
 *
 * GM prefixed every body style with the same chassis letter and series number:
 * "K15" is a pickup, but "K15 JIMMY" is an SUV and "K15 SUBURBAN" is a wagon.
 * Without this exclusion the bare-prefix rules claim all three as pickups.
 */
const NAMEPLATE = /\b(SUBURBAN|JIMMY|BLAZER|SIERRA|SILVERADO|EXPRESS|SAVANA|VANDURA|RALLY|SPORTVAN|RAMCHARGER|YUKON|TAHOE)\b/i;

const SERIES = {
  s1500:   /(?<!\d)1500(?!\d)|(?<![A-Z0-9])[CKRVGHB]15(?!\d)/i,
  s2500:   /(?<!\d)2500(?!\d)|(?<![A-Z0-9])[CKRVGHB]25(?!\d)/i,
  s3500:   /(?<!\d)3500(?!\d)|(?<![A-Z0-9])[CKRVGHB]35(?!\d)/i,
  classic: /\bCLASSIC\b/i,
};

export const SERIES_RULES = [
  // --- Chevrolet full-size pickups -----------------------------------------
  R('Chevrolet', 'Silverado Classic', '1500HD', [/\bSILVERADO\b/i, SERIES.classic, /1500\s?HD/i]),
  R('Chevrolet', 'Silverado Classic', '2500HD', [/\bSILVERADO\b/i, SERIES.classic, /2500\s?HD/i]),
  R('Chevrolet', 'Silverado Classic', '3500',   [/\bSILVERADO\b/i, SERIES.classic, SERIES.s3500]),
  R('Chevrolet', 'Silverado Classic', '1500',   [/\bSILVERADO\b/i, SERIES.classic]),
  R('Chevrolet', 'Silverado', '1500 LD', [/\bSILVERADO\b/i, /\bLD\b/i]),
  R('Chevrolet', 'Silverado', '1500HD',  [/\bSILVERADO\b/i, /1500\s?HD/i]),
  R('Chevrolet', 'Silverado', '2500HD',  [/\bSILVERADO\b/i, /2500\s?HD/i]),
  R('Chevrolet', 'Silverado', '3500HD',  [/\bSILVERADO\b/i, /3500\s?HD/i]),
  R('Chevrolet', 'Silverado', '2500',    [/\bSILVERADO\b/i, SERIES.s2500]),
  R('Chevrolet', 'Silverado', '3500',    [/\bSILVERADO\b/i, SERIES.s3500]),
  // EPA's internal codes for the light-duty truck: C15/K15 (2007-18), C10/K10 (2019).
  R('Chevrolet', 'Silverado', '1500',    [/\bSILVERADO\b/i]),

  // --- Chevrolet vans -------------------------------------------------------
  // NHTSA writes 1997-2000 Express cargo vans as bare "G1500 CARGO" with no
  // nameplate at all, so the G-prefixed four-digit forms are Express too. The
  // G-Series rules below deliberately match only the two-digit form, or those
  // vans would be dated to a line that ended in 1996.
  R('Chevrolet', 'Express', '1500', [/\bEXPRESS\b/i, SERIES.s1500]),
  R('Chevrolet', 'Express', '2500', [/\bEXPRESS\b/i, SERIES.s2500]),
  R('Chevrolet', 'Express', '3500', [/\bEXPRESS\b/i, SERIES.s3500]),
  R('Chevrolet', 'Express', '1500', [/^G1500\b/i]),
  R('Chevrolet', 'Express', '2500', [/^G2500\b/i]),
  R('Chevrolet', 'Express', '3500', [/^G3500\b/i]),
  R('Chevrolet', 'G-Series', '10',  [/^G10\b/i]),
  R('Chevrolet', 'G-Series', '20',  [/^G20\b/i]),
  R('Chevrolet', 'G-Series', '30',  [/^G30\b/i]),

  // --- Chevrolet SUVs with a real series split ------------------------------
  // Ahead of the bare-prefix rules below: "R1500 SUBURBAN" must reach Suburban
  // rather than being claimed as a pickup by the ^[CKRV]1500 pattern.
  R('Chevrolet', 'Suburban', '2500', [/\bSUBURBAN\b/i, SERIES.s2500]),
  R('Chevrolet', 'Suburban', '1500', [/\bSUBURBAN\b/i, SERIES.s1500]),
  // Same as Yukon below: the Tahoe carried no series badge, but EPA files it
  // as "Tahoe 1500" / "Tahoe C1500".
  R('Chevrolet', 'Tahoe',    '1500', [/\bTAHOE\b/i, SERIES.s1500]),

  // --- Chevrolet pre-Silverado full-size ------------------------------------
  // GM's R/V series (1987-1991) is the carried-over square-body sold beside the
  // new GMT400 C/K, so the two are kept apart rather than merged by year.
  R('Chevrolet', 'R/V', '1500', [/^[RV]1500\b|^[RV]15\b/i], [NAMEPLATE]),
  R('Chevrolet', 'R/V', '2500', [/^[RV]2500\b|^[RV]25\b/i], [NAMEPLATE]),
  R('Chevrolet', 'R/V', '3500', [/^[RV]3500\b|^[RV]35\b/i], [NAMEPLATE]),
  R('Chevrolet', 'R/V', '10',   [/^[RV]10\b/i], [NAMEPLATE]),
  R('Chevrolet', 'R/V', '20',   [/^[RV]20\b/i], [NAMEPLATE]),
  R('Chevrolet', 'R/V', '30',   [/^[RV]30\b/i], [NAMEPLATE]),
  R('Chevrolet', 'C/K', '1500', [/^[CK]1500\b|^[CK]15\b/i], [NAMEPLATE]),
  R('Chevrolet', 'C/K', '2500', [/^[CK]2500\b|^[CK]25\b/i], [NAMEPLATE]),
  R('Chevrolet', 'C/K', '3500', [/^[CK]3500\b|^[CK]35\b/i], [NAMEPLATE]),
  R('Chevrolet', 'C/K', '10',   [/^[CK]10\b/i], [NAMEPLATE]),
  R('Chevrolet', 'C/K', '20',   [/^[CK]20\b/i], [NAMEPLATE]),
  R('Chevrolet', 'C/K', '30',   [/^[CK]30\b/i], [NAMEPLATE]),

  // --- GMC full-size pickups ------------------------------------------------
  R('GMC', 'Sierra Classic', '1500', [/\bSIERRA\b/i, SERIES.classic]),
  R('GMC', 'Sierra', '1500 Limited', [/\bSIERRA\b/i, /\bLTD\b|\bLIMITED\b/i]),
  R('GMC', 'Sierra', '1500HD',       [/\bSIERRA\b/i, /1500\s?HD/i]),
  R('GMC', 'Sierra', '2500HD',       [/\bSIERRA\b/i, /2500\s?HD/i]),
  R('GMC', 'Sierra', '3500HD',       [/\bSIERRA\b/i, /3500\s?HD/i]),
  R('GMC', 'Sierra', '2500',         [/\bSIERRA\b/i, SERIES.s2500]),
  R('GMC', 'Sierra', '3500',         [/\bSIERRA\b/i, SERIES.s3500]),
  R('GMC', 'Sierra', '1500',         [/\bSIERRA\b/i]),

  // --- GMC vans -------------------------------------------------------------
  R('GMC', 'Savana',  '1500', [/\bSAVANA\b/i, SERIES.s1500]),
  R('GMC', 'Savana',  '2500', [/\bSAVANA\b/i, SERIES.s2500]),
  R('GMC', 'Savana',  '3500', [/\bSAVANA\b/i, SERIES.s3500]),
  R('GMC', 'Vandura', '1500', [/\bVANDURA\b/i, SERIES.s1500]),
  R('GMC', 'Vandura', '2500', [/\bVANDURA\b/i, SERIES.s2500]),
  R('GMC', 'Vandura', '3500', [/\bVANDURA\b/i, SERIES.s3500]),
  R('GMC', 'Vandura', '10',   [/\bVANDURA\b/i, /^G10\b/i]),
  R('GMC', 'Vandura', '20',   [/\bVANDURA\b/i, /^G20\b/i]),
  R('GMC', 'Vandura', '30',   [/\bVANDURA\b/i, /^G30\b/i]),
  R('GMC', 'Rally',   '1500', [/\bRALLY\b/i, SERIES.s1500]),
  R('GMC', 'Rally',   '2500', [/\bRALLY\b/i, SERIES.s2500]),
  R('GMC', 'Rally',   '3500', [/\bRALLY\b/i, SERIES.s3500]),
  R('GMC', 'Rally',   '10',   [/\bRALLY\b/i, /^G10\b/i]),
  R('GMC', 'Rally',   '20',   [/\bRALLY\b/i, /^G20\b/i]),
  R('GMC', 'Rally',   '30',   [/\bRALLY\b/i, /^G30\b/i]),
  R('GMC', 'Savana',  '1500', [/^G1500\b/i]),
  R('GMC', 'Savana',  '2500', [/^G2500\b/i]),
  R('GMC', 'Savana',  '3500', [/^G3500\b/i]),

  // --- GMC SUVs -------------------------------------------------------------
  R('GMC', 'Yukon XL',  '2500', [/\bYUKON\b/i, /\bXL\b/i, SERIES.s2500]),
  R('GMC', 'Yukon XL',  '1500', [/\bYUKON\b/i, /\bXL\b/i, SERIES.s1500]),
  // The short-wheelbase Yukon was never badged with a series -- only the XL
  // was. EPA still files it as "Yukon 1500", so the rule exists purely to let
  // the single-series collapse resolve it back to the name GM actually used.
  R('GMC', 'Yukon',     '1500', [/\bYUKON\b/i, SERIES.s1500]),
  R('GMC', 'Suburban',  '2500', [/\bSUBURBAN\b/i, SERIES.s2500]),
  R('GMC', 'Suburban',  '1500', [/\bSUBURBAN\b/i, SERIES.s1500]),

  // --- GMC pre-Sierra full-size (after every nameplate rule above) ----------
  R('GMC', 'R/V', '1500', [/^[RV]1500\b|^[RV]15\b/i], [NAMEPLATE]),
  R('GMC', 'R/V', '2500', [/^[RV]2500\b|^[RV]25\b/i], [NAMEPLATE]),
  R('GMC', 'R/V', '3500', [/^[RV]3500\b|^[RV]35\b/i], [NAMEPLATE]),
  R('GMC', 'C/K', '1500', [/^[CK]1500\b|^[CK]15\b/i], [NAMEPLATE]),
  R('GMC', 'C/K', '2500', [/^[CK]2500\b|^[CK]25\b/i], [NAMEPLATE]),
  R('GMC', 'C/K', '3500', [/^[CK]3500\b|^[CK]35\b/i], [NAMEPLATE]),

  // --- Dodge / Ram pickups --------------------------------------------------
  // "Ram 50" is a rebadged Mitsubishi compact, unrelated to the 1500/2500/3500
  // line -- matched first, and carries no series, so it is never swept in.
  R('Dodge', 'Ram 50', null,   [/\bRAM\s?50\b/i]),
  R('Dodge', 'Ram', '1500',    [/\bRAM\b/i, SERIES.s1500]),
  R('Dodge', 'Ram', '2500',    [/\bRAM\b/i, SERIES.s2500]),
  R('Dodge', 'Ram', '3500',    [/\bRAM\b/i, SERIES.s3500]),
  // The A-prefixed forms are Ramcharger bodies ("AD150 Ramcharger"), excluded
  // by NAMEPLATE so an SUV is never filed as a pickup.
  R('Dodge', 'D/W', '150',     [/^[DW]100\b|^[DW]150\b|^A[DW]1(00|50)\b/i], [NAMEPLATE]),
  R('Dodge', 'D/W', '250',     [/^[DW]250\b|^A[DW]250\b/i], [NAMEPLATE]),
  R('Dodge', 'D/W', '350',     [/^[DW]350\b|^A[DW]350\b/i], [NAMEPLATE]),
  // Dodge renamed the van series for 1995: B150 became B1500. These are two
  // era names for one line, kept apart so a 1982 B150 is not filed under a
  // designation that did not exist for another thirteen years.
  R('Dodge', 'B-Series', '1500', [/^B-?1500\b/i], [NAMEPLATE]),
  R('Dodge', 'B-Series', '2500', [/^B-?2500\b/i], [NAMEPLATE]),
  R('Dodge', 'B-Series', '3500', [/^B-?3500\b/i], [NAMEPLATE]),
  R('Dodge', 'B-Series', '150',  [/^B-?150\b/i], [NAMEPLATE]),
  R('Dodge', 'B-Series', '250',  [/^B-?250\b/i], [NAMEPLATE]),
  R('Dodge', 'B-Series', '350',  [/^B-?350\b/i], [NAMEPLATE]),
  R('Ram',   'Ram', '1500',    [SERIES.s1500]),
  R('Ram',   'Ram', '2500',    [SERIES.s2500]),
  R('Ram',   'Ram', '3500',    [SERIES.s3500]),
];

/**
 * A string naming more than one series cannot be assigned to any of them.
 *
 * Both sources publish combined rows -- NHTSA's "G1500 G2500 G3500", EPA's
 * "Express 1500 2500" and "Savana 15 25 Conversion". Matching first-wins would
 * file all of them under 1500, inventing a light-duty van for years only the
 * heavier ones were sold. Refusing is the honest outcome; the cost is a little
 * under-coverage, which is the side to err on.
 */
function namesMultipleSeries(s) {
  let n = 0;
  for (const re of [SERIES.s1500, SERIES.s2500, SERIES.s3500]) if (re.test(s)) n++;
  return n > 1;
}

/**
 * Nameplates the rules recognise but the rename deliberately leaves alone.
 *
 * "Ram 50" is a rebadged Mitsubishi compact that the catalogue already holds
 * across two names ("D50" for 1981-86, "RAM 50" after). It is not a series
 * split, so introducing a third spelling would duplicate vehicles rather than
 * separate them. Kept here rather than in the migration so the review script
 * and the migration cannot disagree about what is in scope.
 */
export const SKIP_NAMEPLATES = new Set(['Ram 50']);

/**
 * Names the sources apply retroactively, which have to be rejected by year.
 *
 * NHTSA labels 1982 trucks with GM's *later* designations -- a 1982 C10 is
 * filed as "C1500 OR C10" and a 1982 G30 van as "G3500". Taken at face value
 * those put a 1500-series truck six years before GM used the name, and an
 * Express van fourteen years before it existed. The two dates below are plain
 * facts about GM's naming, not estimates: the 1500/2500/3500 designations
 * arrive with the GMT400 for MY1988, and Express and Savana launch for MY1996.
 *
 * The correctly-named records survive alongside -- the same source also files
 * a plain "C10" for 1982 -- so rejecting these loses almost no coverage.
 */
export function isAnachronistic(make, nameplate, series, year) {
  const gm = make === 'Chevrolet' || make === 'GMC';
  if (gm && /^(1500|2500|3500)/.test(series ?? '') && year < 1988) return true;
  if ((nameplate === 'Express' || nameplate === 'Savana') && year < 1996) return true;
  return false;
}

/** Canonicalise a source model string to `{ nameplate, series }`, or null. */
export function canonicalSeries(make, modelString) {
  const s = (modelString ?? '').trim();
  if (!s) return null;
  for (const rule of SERIES_RULES) {
    if (rule.make !== make) continue;
    if (!rule.requires.every((re) => re.test(s))) continue;
    if (rule.excludes.some((re) => re.test(s))) continue;
    if (rule.series && namesMultipleSeries(s)) return null;
    return { nameplate: rule.nameplate, series: rule.series };
  }
  return null;
}

/**
 * Resolve a source model string straight to a catalogue entry, or null.
 *
 * Checks the series name first and the bare nameplate second, which lets the
 * catalogue itself settle the question of whether a given year carries a series
 * number. No separate record of that decision is needed, so the importers
 * cannot fall out of step with the rename.
 */
export function resolveSeries(cat, make, modelString, year) {
  const c = canonicalSeries(make, modelString);
  if (!c) return null;
  const y = Number(year);
  if (isAnachronistic(make, c.nameplate, c.series, y)) return null;
  const models = cat.byMake.get(make.toLowerCase());
  if (!models) return null;
  for (const name of [c.series ? `${c.nameplate} ${c.series}` : null, c.nameplate]) {
    if (name && models.get(name)?.has(y)) return [make, name, String(y)];
  }
  return null;
}

/**
 * A series number only belongs in the model name when the nameplate actually
 * offered more than one series that year. GM sold Suburban 1500 alongside
 * Suburban 2500 through 2013 and badged both; from 2015 only the light-duty
 * one remained and the badge became plain "Suburban". Yukon XL did the same.
 *
 * Deriving that from the data rather than hardcoding it means the catalogue
 * follows the badge without anyone maintaining a list of exceptions.
 */
export function collapseSingleSeries(attested) {
  const perYear = new Map(); // "make|nameplate|year" -> Set(series)
  for (const { make, nameplate, series, year } of attested) {
    const k = `${make}|${nameplate}|${year}`;
    if (!perYear.has(k)) perYear.set(k, new Set());
    if (series) perYear.get(k).add(series);
  }
  return (make, nameplate, series, year) => {
    const seen = perYear.get(`${make}|${nameplate}|${year}`);
    if (!series || !seen || seen.size <= 1) return nameplate;
    return `${nameplate} ${series}`;
  };
}

/** The models this rename replaces -- used to know what to remove and migrate. */
export const REPLACED_MODELS = {
  Chevrolet: ['Silverado', 'Silverado HD', 'Silverado LD', 'Silverado LTD',
              'C/K Pickup', 'Express', 'Suburban', 'Suburban HD'],
  GMC: ['Sierra', 'Sierra HD', 'Sierra Limited', 'C/K Pickup', 'Savana',
        'Vandura', 'Rally', 'Suburban', 'Yukon XL'],
  Dodge: ['Ram', 'Ram 1500', 'Ram Van', 'Ram Wagon', 'RAM 50'],
  Ram: [],
};
