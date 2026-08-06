/**
 * Unit handling.
 *
 * The database stores one canonical unit per physical quantity. Users think in
 * whatever their country taught them, and the same user will happily mix
 * systems in one query ("65 cu ft of cargo and 2.9 litres of engine"). So the
 * API accepts a unit alongside every numeric value and converts on the way in.
 *
 * Conversion factors are exact where an exact definition exists (the inch has
 * been exactly 25.4 mm since 1959; the pound exactly 0.45359237 kg). Using
 * rounded factors here would put a car measured at 28.0 in on the wrong side
 * of a `>= 711 mm` filter.
 */

export type Quantity =
  | 'length'
  | 'volume'
  | 'displacement'
  | 'mass'
  | 'speed'
  | 'power'
  | 'torque'
  | 'pressure'
  | 'time'
  | 'temperature'
  | 'economy'
  | 'energy'
  | 'angle'
  | 'count'
  | 'ratio'
  | 'currency';

interface UnitDef {
  canonical: string;
  /** Multiply an input value by this factor to reach the canonical unit. */
  factors: Record<string, number>;
}

export const QUANTITIES: Record<Quantity, UnitDef> = {
  length: {
    canonical: 'mm',
    factors: {
      mm: 1,
      cm: 10,
      m: 1000,
      km: 1_000_000,
      in: 25.4,
      ft: 304.8,
      yd: 914.4,
      mi: 1_609_344,
    },
  },
  volume: {
    canonical: 'l',
    factors: {
      l: 1,
      ml: 0.001,
      m3: 1000,
      cuft: 28.316846592,
      cuin: 0.016387064,
      galus: 3.785411784,
      galuk: 4.54609,
      cc: 0.001,
    },
  },
  // Engine displacement is its own quantity rather than a use of `volume`,
  // because it is stored in cubic centimetres while `volume` is canonically
  // litres. Sharing the one quantity would silently compare a "3.0 l" filter
  // against a column holding 2981 and match nothing -- the kind of wrong
  // answer that looks like missing data rather than a bug.
  displacement: {
    canonical: 'cc',
    factors: {
      cc: 1,
      ccm: 1,
      ml: 1,
      l: 1000,
      liter: 1000,
      litre: 1000,
      cuin: 16.387064,
      ci: 16.387064,
    },
  },
  mass: {
    canonical: 'kg',
    factors: {
      kg: 1,
      g: 0.001,
      t: 1000,
      lb: 0.45359237,
      lbs: 0.45359237,
      ton_us: 907.18474,
      ton_uk: 1016.0469088,
      st: 6.35029318,
    },
  },
  speed: {
    canonical: 'kph',
    factors: { kph: 1, 'km/h': 1, mph: 1.609344, ms: 3.6, 'm/s': 3.6, kn: 1.852 },
  },
  power: {
    // Stored as SAE net hp. PS/DIN and kW are converted; note that PS -> hp is
    // a real conversion, not a relabelling, and 1 PS = 0.98632 hp.
    canonical: 'hp',
    factors: { hp: 1, bhp: 1, kw: 1.34102209, ps: 0.98632006, cv: 0.98632006, ch: 0.98632006 },
  },
  torque: {
    canonical: 'lbft',
    factors: { lbft: 1, 'lb-ft': 1, nm: 0.73756215, kgm: 7.23301385 },
  },
  pressure: {
    canonical: 'psi',
    factors: { psi: 1, bar: 14.5037738, kpa: 0.145037738, atm: 14.6959488 },
  },
  time: { canonical: 's', factors: { s: 1, sec: 1, ms: 0.001, min: 60, h: 3600 } },
  temperature: { canonical: 'c', factors: { c: 1 } }, // offset units handled separately
  economy: {
    // US mpg is canonical because the EPA figures are the densest data we have.
    // l/100km is an INVERSE scale, so it cannot be a simple factor -- the
    // converter below special-cases it.
    canonical: 'mpg',
    factors: { mpg: 1, mpgus: 1, mpguk: 0.832674, mpge: 1 },
  },
  energy: { canonical: 'kwh', factors: { kwh: 1, wh: 0.001, mj: 0.277777778, j: 2.7777778e-7 } },
  angle: { canonical: 'deg', factors: { deg: 1, rad: 57.2957795 } },
  count: { canonical: 'count', factors: { count: 1 } },
  ratio: { canonical: 'ratio', factors: { ratio: 1, pct: 0.01, percent: 0.01 } },
  currency: { canonical: 'minor', factors: { minor: 1, major: 100 } },
};

export class UnitError extends Error {}

/**
 * Convert `value` expressed in `unit` into the canonical unit for `quantity`.
 * Passing no unit means the value is already canonical.
 */
export function toCanonical(quantity: Quantity, value: number, unit?: string | null): number {
  if (unit == null || unit === '') return value;

  const key = unit.toLowerCase().replace(/[\s^]/g, '');
  const def = QUANTITIES[quantity];

  // Inverse scales cannot be expressed as a multiplication.
  if (quantity === 'economy' && (key === 'l100km' || key === 'l/100km')) {
    if (value <= 0) throw new UnitError('l/100km must be positive');
    return 235.214583 / value;
  }
  if (quantity === 'economy' && (key === 'km/l' || key === 'kmpl')) {
    return value * 2.35214583; // km/l -> mpg(US)
  }
  if (quantity === 'temperature') {
    if (key === 'f') return ((value - 32) * 5) / 9;
    if (key === 'k') return value - 273.15;
    return value;
  }

  const factor = def.factors[key];
  if (factor === undefined) {
    throw new UnitError(
      `Unknown unit "${unit}" for ${quantity}. Accepted: ${Object.keys(def.factors).join(', ')}`,
    );
  }
  return value * factor;
}

/** Convert a canonical value back out to a display unit. */
export function fromCanonical(quantity: Quantity, value: number, unit?: string | null): number {
  if (unit == null || unit === '') return value;
  const key = unit.toLowerCase().replace(/[\s^]/g, '');

  if (quantity === 'economy' && (key === 'l100km' || key === 'l/100km')) {
    if (value <= 0) throw new UnitError('mpg must be positive');
    return 235.214583 / value;
  }
  if (quantity === 'temperature') {
    if (key === 'f') return (value * 9) / 5 + 32;
    if (key === 'k') return value + 273.15;
    return value;
  }

  const factor = QUANTITIES[quantity].factors[key];
  if (factor === undefined) throw new UnitError(`Unknown unit "${unit}" for ${quantity}`);
  return value / factor;
}

/** Units the UI should offer for a quantity, imperial-first or metric-first. */
export function unitsFor(quantity: Quantity, system: 'imperial' | 'metric'): string[] {
  const preferred: Partial<Record<Quantity, { imperial: string[]; metric: string[] }>> = {
    length: { imperial: ['in', 'ft'], metric: ['mm', 'cm', 'm'] },
    volume: { imperial: ['cuft', 'galus'], metric: ['l'] },
    mass: { imperial: ['lb'], metric: ['kg'] },
    speed: { imperial: ['mph'], metric: ['kph'] },
    power: { imperial: ['hp'], metric: ['kw', 'ps'] },
    torque: { imperial: ['lbft'], metric: ['nm'] },
    economy: { imperial: ['mpg'], metric: ['l/100km'] },
  };
  const p = preferred[quantity];
  if (!p) return [QUANTITIES[quantity].canonical];
  return system === 'imperial' ? p.imperial : p.metric;
}
