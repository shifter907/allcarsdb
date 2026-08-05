/**
 * The contribution file format.
 *
 * This schema is the contract with contributors, and it is the thing they will
 * judge the project by. Two decisions shape it:
 *
 * MEASUREMENTS CARRY THEIR UNITS INLINE. A contributor writes
 * `length: 177.9 in` or `length: 4519 mm` -- whichever their source printed --
 * and the loader converts. Forcing everyone to pre-convert to millimetres
 * guarantees conversion errors and makes every PR unreviewable against its
 * source, because the numbers in the diff no longer match the brochure.
 *
 * COMPONENTS MAY BE INLINE OR REFERENCED. Referencing a shared engine by slug
 * is better data, but demanding it as a first step is a wall a casual
 * contributor bounces off. Inline definitions are accepted and hoisted into
 * the shared catalog automatically, deduplicated by content hash.
 */

import { z } from 'zod';
import { ENUM_REGISTRY, type EnumName } from './enums.js';
import { toCanonical, type Quantity } from './units.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A slug. Numbers are coerced to strings first, because YAML reads `model: 911`
 * and `model: 500` as integers -- and a database of cars is going to meet the
 * 911, the 500, the Mazda 3 and the 240Z rather often.
 */
const slug = z.preprocess(
  (v) => (typeof v === 'number' ? String(v) : v),
  z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase-kebab-case (letters, digits, hyphens)'),
);

/** A value written as `4519 mm`, `177.9 in`, or a bare canonical number. */
function measure(quantity: Quantity) {
  return z
    .union([z.number(), z.string()])
    .transform((v, ctx) => {
      if (typeof v === 'number') return v;
      const m = /^\s*(-?[\d.]+)\s*([a-zA-Z/%0-9^]*)\s*$/.exec(v);
      if (!m) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Cannot parse measurement "${v}"` });
        return z.NEVER;
      }
      const n = Number(m[1]);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${m[1]}" is not a number` });
        return z.NEVER;
      }
      try {
        return toCanonical(quantity, n, m[2] || null);
      } catch (e) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
        return z.NEVER;
      }
    })
    .optional();
}

/** An enum slug, validated against its vocabulary and stored as a code. */
function enumRef(name: EnumName) {
  return z
    .string()
    .transform((v, ctx) => {
      const code = ENUM_REGISTRY[name].code(v);
      if (code === null) {
        const valid = ENUM_REGISTRY[name].members.map((m) => m.slug).join(', ');
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${v}" is not a valid ${name}. Valid values: ${valid}`,
        });
        return z.NEVER;
      }
      return code;
    })
    .optional();
}

const bool = z.boolean().optional();
const int = z.number().int().optional();
const num = z.number().optional();
const text = z.string().optional();

/** A citation. Either a slug pointing at data/sources/, or an inline URL. */
const sourceRef = z.union([
  slug,
  z.object({
    url: z.string().url().optional(),
    title: text,
    publisher: text,
    document_type: text,
    published_date: text,
    retrieved_date: text,
    page: text,
    confidence: enumRef('confidence'),
  }),
]);

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export const EngineSchema = z.object({
  slug: slug.optional(),
  code: text,
  name: text,
  family: text,
  manufacturer: slug.optional(),

  cylinders: int,
  layout: enumRef('engine_layout'),
  vee_angle_deg: num,
  displacement: measure('volume'),
  valves_per_cylinder: int,
  valves_total: int,
  cam_config: enumRef('cam_config'),
  cam_count: int,

  bore: measure('length'),
  stroke: measure('length'),
  compression_ratio: num,
  compression_ratio_max: num,

  aspiration: enumRef('aspiration'),
  forced_induction_count: int,
  intercooled: bool,
  charge_cooling: text,
  max_boost: measure('pressure'),

  fuel_type: enumRef('fuel_type'),
  fuel_delivery: enumRef('fuel_delivery'),
  min_octane_ron: int,

  block_material: text,
  head_material: text,
  liner_type: text,

  redline_rpm: int,
  fuel_cutoff_rpm: int,
  firing_order: text,
  dry_weight: measure('mass'),
  oil_capacity: measure('volume'),

  variable_valve_timing: bool,
  variable_valve_lift: bool,
  cylinder_deactivation: bool,
  dry_sump: bool,
  start_stop: bool,
  individual_throttle_bodies: bool,

  production_start_year: int,
  production_end_year: int,
  notes: text,
  sources: z.array(sourceRef).optional(),
});

export const TransmissionSchema = z.object({
  slug: slug.optional(),
  code: text,
  name: text,
  manufacturer: slug.optional(),
  type: enumRef('transmission_type'),
  forward_gears: int,
  clutch_type: text,
  paddle_shifters: bool,
  gear_ratios: z.array(z.number()).optional(),
  final_drive_ratio: num,
  max_torque: measure('torque'),
  weight: measure('mass'),
  notes: text,
});

export const DrivetrainSchema = z.object({
  slug: slug.optional(),
  name: text,
  type: enumRef('drivetrain_type'),
  marketing_name: text,
  transfer_case: text,
  has_low_range: bool,
  low_range_ratio: num,
  front_diff_type: text,
  center_diff_type: text,
  rear_diff_type: text,
  front_locker: bool,
  rear_locker: bool,
  default_front_torque_pct: num,
  max_front_torque_pct: num,
  max_rear_torque_pct: num,
  torque_vectoring: bool,
  disconnect_capable: bool,
  notes: text,
});

export const ElectricMotorSchema = z.object({
  slug: slug.optional(),
  code: text,
  name: text,
  type: enumRef('motor_type'),
  peak_power_kw: num,
  continuous_power_kw: num,
  peak_torque_nm: num,
  max_rpm: int,
  voltage_nominal: int,
  cooling: text,
  weight: measure('mass'),
});

export const BatterySchema = z.object({
  slug: slug.optional(),
  name: text,
  chemistry: enumRef('battery_chemistry'),
  cell_supplier: text,
  cell_format: text,
  capacity_gross_kwh: num,
  capacity_net_kwh: num,
  nominal_voltage: num,
  architecture_volts: int,
  module_count: int,
  cell_count: int,
  weight: measure('mass'),
  max_dc_charge_kw: num,
  max_ac_charge_kw: num,
  thermal_management: text,
  warranty_years: int,
  warranty_miles: int,
});

/** Either a slug reference to the shared catalog, or an inline definition. */
const ref = <T extends z.ZodTypeAny>(inline: T) => z.union([slug, inline]);

export const PowertrainSchema = z.object({
  slug: slug.optional(),
  name: text,
  engine: ref(EngineSchema).optional(),
  transmission: ref(TransmissionSchema).optional(),
  drivetrain: ref(DrivetrainSchema),
  placement: enumRef('engine_placement'),
  hybrid_type: enumRef('hybrid_type'),

  front_motor: ref(ElectricMotorSchema).optional(),
  front_motor_count: int,
  rear_motor: ref(ElectricMotorSchema).optional(),
  rear_motor_count: int,
  battery: ref(BatterySchema).optional(),

  horsepower: measure('power'),
  torque: measure('torque'),
  engine_horsepower: measure('power'),
  engine_torque: measure('torque'),
  electric_horsepower: measure('power'),
  electric_torque: measure('torque'),

  power_peak_rpm: int,
  power_peak_rpm_high: int,
  torque_peak_rpm: int,
  torque_peak_rpm_high: int,
  power_standard: enumRef('power_standard'),
  notes: text,
  sources: z.array(sourceRef).optional(),
});

// ---------------------------------------------------------------------------
// Specification blocks
// ---------------------------------------------------------------------------

export const ExteriorSchema = z.object({
  length: measure('length'),
  width: measure('length'),
  width_mirrors: measure('length'),
  height: measure('length'),
  wheelbase: measure('length'),
  track_front: measure('length'),
  track_rear: measure('length'),
  ground_clearance: measure('length'),
  ground_clearance_min: measure('length'),
  ground_clearance_max: measure('length'),
  approach_angle: measure('angle'),
  departure_angle: measure('angle'),
  breakover_angle: measure('angle'),
  wading_depth: measure('length'),
  curb_weight: measure('mass'),
  curb_weight_min: measure('mass'),
  curb_weight_max: measure('mass'),
  gvwr: measure('mass'),
  weight_dist_front_pct: num,
  drag_coefficient: num,
  frontal_area_m2: num,
  cda_m2: num,
  downforce_at_speed: measure('mass'),
  downforce_speed: measure('speed'),
  turning_circle_curb: measure('length'),
  notes: text,
  sources: z.array(sourceRef).optional(),
});

export const InteriorSchema = z.object({
  seating_capacity: int,
  seating_capacity_max: int,
  seat_rows: int,
  seating_config: text,

  headroom_front: measure('length'),
  headroom_front_sunroof: measure('length'),
  headroom_second: measure('length'),
  headroom_third: measure('length'),
  legroom_front: measure('length'),
  legroom_second: measure('length'),
  legroom_third: measure('length'),
  shoulder_room_front: measure('length'),
  shoulder_room_second: measure('length'),
  hip_room_front: measure('length'),
  hip_room_second: measure('length'),

  seat_height_front: measure('length'),
  seat_height_second: measure('length'),
  seat_height_adjust_range: measure('length'),
  step_in_height: measure('length'),

  passenger_volume: measure('volume'),
  cargo_behind_first: measure('volume'),
  cargo_behind_second: measure('volume'),
  cargo_behind_third: measure('volume'),
  cargo_frunk: measure('volume'),
  cargo_max: measure('volume'),
  cargo_load_length: measure('length'),
  cargo_width_between_arches: measure('length'),
  liftover_height: measure('length'),

  bed_length: measure('length'),
  bed_width: measure('length'),
  bed_depth: measure('length'),
  bed_volume: measure('volume'),
  notes: text,
  sources: z.array(sourceRef).optional(),
});

export const PerformanceSchema = z.object({
  zero_to_60_mph: measure('time'),
  zero_to_100_kph: measure('time'),
  zero_to_100_mph: measure('time'),
  zero_to_60_rollout: measure('time'),
  quarter_mile: measure('time'),
  quarter_mile_trap: measure('speed'),
  top_speed: measure('speed'),
  top_speed_limited: bool,
  braking_60_0: measure('length'),
  braking_70_0: measure('length'),
  lateral_g: num,
  slalom_mph: num,
  figure_eight: measure('time'),
  nurburgring: text,
  nurburgring_date: text,
  measured: bool,
  measured_by: text,
  notes: text,
  sources: z.array(sourceRef).optional(),
});

export const EfficiencySchema = z.object({
  cycle: enumRef('test_cycle'),
  mpg_city: num,
  mpg_highway: num,
  mpg_combined: num,
  l_per_100km_combined: num,
  mpge_city: num,
  mpge_highway: num,
  mpge_combined: num,
  kwh_per_100mi: num,
  electric_range: measure('length'),
  total_range: measure('length'),
  fuel_tank: measure('volume'),
  co2_g_per_km: num,
  emissions_standard: text,
  dc_charge_10_80_min: num,
  dc_peak_kw: num,
  ac_charge_0_100_h: num,
  ac_onboard_kw: num,
  charge_port: text,
  v2l_kw: num,
  sources: z.array(sourceRef).optional(),
});

export const CapacitySchema = z.object({
  payload: measure('mass'),
  towing_braked: measure('mass'),
  towing_unbraked: measure('mass'),
  towing_max: measure('mass'),
  tongue_weight: measure('mass'),
  gcwr: measure('mass'),
  roof_load: measure('mass'),
  hitch_receiver_in: num,
  fifth_wheel_capable: bool,
  sources: z.array(sourceRef).optional(),
});

export const ChassisSchema = z.object({
  suspension_front: enumRef('suspension_type'),
  suspension_rear: enumRef('suspension_type'),
  spring_type_front: text,
  spring_type_rear: text,
  adaptive_dampers: bool,
  damper_brand: text,
  active_anti_roll: bool,
  ride_height_adjustable: bool,
  steering_type: enumRef('steering_type'),
  steering_ratio: num,
  turns_lock_to_lock: num,
  rear_wheel_steering: bool,
  brake_front: enumRef('brake_type'),
  brake_rear: enumRef('brake_type'),
  brake_front_dia: measure('length'),
  brake_rear_dia: measure('length'),
  brake_front_pistons: int,
  brake_rear_pistons: int,
  brake_caliper_brand: text,
  wheel_front_dia_in: num,
  wheel_front_width_in: num,
  wheel_rear_dia_in: num,
  wheel_rear_width_in: num,
  wheel_material: text,
  tire_front: text,
  tire_rear: text,
  tire_brand_oem: text,
  spare_type: text,
  chassis_construction: text,
  body_material: text,
  sources: z.array(sourceRef).optional(),
});

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/**
 * Accepted forms, in ascending order of detail:
 *
 *   features:
 *     heated-seats-front: standard
 *     massage-seats-front:
 *       availability: package
 *       package: executive-package
 *       price: 3200
 *     infotainment-screen-size:
 *       availability: standard
 *       value: 12.3
 */
const FeatureValueSchema = z.union([
  z.string(),
  z.object({
    availability: z.string(),
    value: z.union([z.number(), z.string()]).optional(),
    package: slug.optional(),
    price: z.number().optional(),
    currency: text,
    confidence: enumRef('confidence'),
    notes: text,
  }),
]);

export const OptionPackageSchema = z.object({
  slug: slug,
  code: text,
  name: z.string(),
  price: num,
  currency: text,
  description: text,
  requires: slug.optional(),
  features: z.array(slug).optional(),
});

// ---------------------------------------------------------------------------
// Variant / trim / file
// ---------------------------------------------------------------------------

export const VariantSchema = z.object({
  slug: slug,
  name: text,
  body: slug, // reference into data/body-styles.yaml
  powertrain: ref(PowertrainSchema),

  msrp: num,
  currency: text,
  destination: num,
  price_as_of: text,
  production_count: int,

  exterior: ExteriorSchema.optional(),
  interior: InteriorSchema.optional(),
  performance: PerformanceSchema.optional(),
  efficiency: z.array(EfficiencySchema).optional(),
  capacity: CapacitySchema.optional(),
  chassis: ChassisSchema.optional(),

  features: z.record(slug, FeatureValueSchema).optional(),
  confidence: enumRef('confidence'),
  notes: text,
  sources: z.array(sourceRef).optional(),
});

export const TrimSchema = z.object({
  slug: slug,
  name: z.string(),
  ordinal: int,
  oem_code: text,
  is_special_edition: bool,
  production_count: int,
  packages: z.array(OptionPackageSchema).optional(),

  /**
   * Specs declared here apply to every variant in the trim unless the variant
   * overrides them. This is what keeps a 12-variant trim from being twelve
   * copies of the same interior dimensions -- and, more importantly, keeps
   * them from drifting apart when someone corrects only one.
   */
  defaults: z
    .object({
      exterior: ExteriorSchema.optional(),
      interior: InteriorSchema.optional(),
      chassis: ChassisSchema.optional(),
      capacity: CapacitySchema.optional(),
      features: z.record(slug, FeatureValueSchema).optional(),
    })
    .optional(),

  variants: z.array(VariantSchema).min(1),
  notes: text,
});

export const VehicleFileSchema = z.object({
  /** Schema version, so the loader can migrate old files. */
  version: z.literal(1).default(1),

  make: slug,
  model: slug,
  model_name: text,
  generation: z.object({
    slug: slug,
    code: text,
    name: text,
    ordinal: int,
    start_year: z.number().int(),
    end_year: int,
    facelift_of: slug.optional(),
    platform: text,
    designer: text,
  }),
  year: z.number().int().min(1885).max(2100),
  market: z.string(),
  release_date: text,

  trims: z.array(TrimSchema).min(1),
  sources: z.array(sourceRef).optional(),
  notes: text,
});

export type VehicleFile = z.infer<typeof VehicleFileSchema>;
export type Trim = z.infer<typeof TrimSchema>;
export type Variant = z.infer<typeof VariantSchema>;
export type Powertrain = z.infer<typeof PowertrainSchema>;
export type Engine = z.infer<typeof EngineSchema>;
export type Transmission = z.infer<typeof TransmissionSchema>;
export type Drivetrain = z.infer<typeof DrivetrainSchema>;
export type ElectricMotor = z.infer<typeof ElectricMotorSchema>;
export type Battery = z.infer<typeof BatterySchema>;

// ---------------------------------------------------------------------------
// Catalog files
// ---------------------------------------------------------------------------

export const MakeFileSchema = z.object({
  slug: slug,
  name: z.string(),
  manufacturer: slug.optional(),
  country_code: text,
  founded_year: int,
  defunct_year: int,
  wikidata_id: text,
  notes: text,
});

export const BodyStyleFileSchema = z.object({
  body_styles: z.array(
    z.object({
      slug: slug,
      name: z.string(),
      category: z.string(),
      roof: z.string(),
      doors: int,
      cab: text,
      bed_length_in: num,
      seat_rows: int,
      notes: text,
    }),
  ),
});

export const FeatureCatalogSchema = z.object({
  features: z.array(
    z.object({
      slug: slug,
      name: z.string(),
      category: z.string(),
      description: text,
      value_type: z.enum(['bool', 'number', 'text', 'enum']).default('bool'),
      value_unit: text,
      value_options: z.array(z.string()).optional(),
      parent: slug.optional(),
      aliases: z.array(z.string()).optional(),
      is_common: bool,
      /**
       * Reserved bit 0-127 in the search index bitmask. Assigning one makes
       * this feature filterable without a join. Bits are scarce -- reserve
       * them for features people actually filter on, and never reuse a number.
       */
      search_bit: z.number().int().min(0).max(127).optional(),
      first_seen_year: int,
    }),
  ),
});
