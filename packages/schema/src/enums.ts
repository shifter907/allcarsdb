/**
 * Controlled vocabularies for AllCarsDB.
 *
 * Every enum member has a STABLE numeric code. The codes are written into the
 * `variant_search` index so that filtering compares integers instead of strings
 * -- this keeps the hot table narrow and makes full scans cheap when a query
 * filters on dimensions that no single index covers.
 *
 * RULES FOR EDITING THIS FILE:
 *   1. Never change or reuse an existing code. Ever.
 *   2. New members get the next free code in their block.
 *   3. Deprecating a member: mark it `deprecated: true`, keep the code.
 *
 * Codes are blocked by 100s per enum purely as a debugging convenience -- when
 * you see 402 in a raw index row you know it is an aspiration.
 */

export interface EnumMember {
  readonly code: number;
  readonly slug: string;
  readonly label: string;
  /**
   * Compact form used when the label is composed into a longer string.
   * "Naturally Aspirated Flat / Boxer-6" is unreadable; "NA flat-6" is not.
   */
  readonly short?: string;
  /** Alternate spellings accepted by the data loader and the search API. */
  readonly aliases?: readonly string[];
  readonly deprecated?: boolean;
  /** Longer explanation surfaced in the UI's filter help text. */
  readonly note?: string;
}

function defineEnum<const T extends readonly EnumMember[]>(name: string, members: T) {
  const bySlug = new Map<string, EnumMember>();
  const byCode = new Map<number, EnumMember>();

  for (const m of members) {
    if (bySlug.has(m.slug)) throw new Error(`${name}: duplicate slug ${m.slug}`);
    if (byCode.has(m.code)) throw new Error(`${name}: duplicate code ${m.code}`);
    bySlug.set(m.slug, m);
    byCode.set(m.code, m);
    for (const alias of m.aliases ?? []) {
      if (bySlug.has(alias)) throw new Error(`${name}: alias ${alias} collides`);
      bySlug.set(alias, m);
    }
  }

  return {
    name,
    // Widened deliberately. `const T` infers each member as a literal type
    // carrying only the keys that member actually declares, so iterating
    // `members` would lose `short`, `note` and `deprecated` on any entry that
    // omits them. `slugs` below keeps the narrow inference, which is where it
    // is actually useful.
    members: members as readonly EnumMember[],
    slugs: members.map((m) => m.slug) as { [K in keyof T]: T[K]['slug'] },
    /** Resolve a slug or alias to its numeric code. Returns null if unknown. */
    code(slug: string | null | undefined): number | null {
      if (slug == null) return null;
      return bySlug.get(slug.toLowerCase().replace(/[\s-]+/g, '_'))?.code ?? null;
    },
    /** Resolve a numeric code back to its canonical member. */
    fromCode(code: number | null | undefined): EnumMember | null {
      if (code == null) return null;
      return byCode.get(code) ?? null;
    },
    has(slug: string): boolean {
      return bySlug.has(slug.toLowerCase().replace(/[\s-]+/g, '_'));
    },
  };
}

// ---------------------------------------------------------------------------
// 100 block -- body
// ---------------------------------------------------------------------------

export const BodyCategory = defineEnum('body_category', [
  { code: 101, slug: 'sedan', label: 'Sedan' },
  { code: 102, slug: 'coupe', label: 'Coupe' },
  { code: 103, slug: 'hatchback', label: 'Hatchback' },
  { code: 104, slug: 'wagon', label: 'Wagon', aliases: ['estate', 'touring', 'avant'] },
  { code: 105, slug: 'convertible', label: 'Convertible', aliases: ['cabriolet', 'roadster', 'spider', 'spyder'] },
  { code: 106, slug: 'suv', label: 'SUV', aliases: ['sport_utility'] },
  { code: 107, slug: 'crossover', label: 'Crossover', note: 'Unibody, car-derived platform.' },
  { code: 108, slug: 'pickup', label: 'Pickup Truck', aliases: ['truck'] },
  { code: 109, slug: 'minivan', label: 'Minivan', aliases: ['mpv', 'people_mover'] },
  { code: 110, slug: 'van', label: 'Van', aliases: ['cargo_van', 'panel_van'] },
  { code: 111, slug: 'targa', label: 'Targa' },
  { code: 112, slug: 'liftback', label: 'Liftback', aliases: ['fastback'] },
  { code: 113, slug: 'chassis_cab', label: 'Chassis Cab' },
  { code: 114, slug: 'microcar', label: 'Microcar', aliases: ['kei'] },
  { code: 115, slug: 'shooting_brake', label: 'Shooting Brake' },
  { code: 116, slug: 'limousine', label: 'Limousine' },
]);

/**
 * Roof construction. Deliberately separate from body category so that
 * "hard top convertible" is expressible without inventing a body category
 * for every combination.
 */
export const RoofType = defineEnum('roof_type', [
  { code: 201, slug: 'fixed', label: 'Fixed Roof' },
  { code: 202, slug: 'soft_top', label: 'Soft Top Convertible', aliases: ['fabric_top', 'cloth_top'] },
  { code: 203, slug: 'retractable_hardtop', label: 'Retractable Hardtop', aliases: ['hard_top_convertible', 'folding_hardtop', 'coupe_cabriolet'] },
  { code: 204, slug: 'removable_hardtop', label: 'Removable Hardtop', note: 'Manually detached and stored separately.' },
  { code: 205, slug: 'targa', label: 'Targa Top', note: 'Fixed rear glass/rollbar, removable centre panel.' },
  { code: 206, slug: 't_top', label: 'T-Top' },
  { code: 207, slug: 'removable_soft_top', label: 'Removable Soft Top', note: 'Jeep-style bikini/full soft top.' },
  { code: 208, slug: 'panoramic_fixed', label: 'Panoramic Fixed Glass' },
  { code: 209, slug: 'open', label: 'Open / No Roof', note: 'Barchetta, speedster, buggy.' },
]);

export const CabStyle = defineEnum('cab_style', [
  { code: 251, slug: 'regular_cab', label: 'Regular Cab' },
  { code: 252, slug: 'extended_cab', label: 'Extended Cab', aliases: ['access_cab', 'club_cab', 'supercab', 'king_cab', 'double_cab_small'] },
  { code: 253, slug: 'crew_cab', label: 'Crew Cab', aliases: ['supercrew', 'quad_cab', 'crewmax'] },
  { code: 254, slug: 'mega_cab', label: 'Mega Cab' },
]);

// ---------------------------------------------------------------------------
// 300 block -- engine architecture
// ---------------------------------------------------------------------------

export const EngineLayout = defineEnum('engine_layout', [
  { code: 301, slug: 'inline', label: 'Inline', short: 'inline', aliases: ['straight', 'i'] },
  { code: 302, slug: 'v', label: 'V', short: 'V' },
  { code: 303, slug: 'flat', label: 'Flat / Boxer', short: 'flat', aliases: ['boxer', 'horizontally_opposed', 'h'] },
  { code: 304, slug: 'w', label: 'W', short: 'W' },
  { code: 305, slug: 'rotary', label: 'Rotary / Wankel', short: 'rotary', aliases: ['wankel'] },
  { code: 306, slug: 'vr', label: 'VR', short: 'VR', note: 'Narrow-angle V sharing one head (VW VR6).' },
  { code: 307, slug: 'single', label: 'Single Cylinder', short: 'single' },
  { code: 308, slug: 'radial', label: 'Radial', short: 'radial' },
  { code: 309, slug: 'none', label: 'No Combustion Engine', note: 'Used by BEV powertrains.' },
]);

export const CamConfig = defineEnum('cam_config', [
  { code: 401, slug: 'ohv', label: 'OHV / Pushrod', aliases: ['pushrod', 'cam_in_block'] },
  { code: 402, slug: 'sohc', label: 'SOHC' },
  { code: 403, slug: 'dohc', label: 'DOHC' },
  { code: 404, slug: 'flathead', label: 'Flathead / Sidevalve', aliases: ['sidevalve', 'l_head'] },
  { code: 405, slug: 'camless', label: 'Camless / Electrohydraulic' },
  { code: 406, slug: 'rotary_ports', label: 'Rotary Porting', note: 'Wankel: side/peripheral ports, no valves.' },
  { code: 407, slug: 'none', label: 'Not Applicable' },
]);

export const Aspiration = defineEnum('aspiration', [
  { code: 501, slug: 'naturally_aspirated', label: 'Naturally Aspirated', short: 'NA', aliases: ['na', 'nat_asp'] },
  { code: 502, slug: 'turbocharged', label: 'Turbocharged', short: 'turbo', aliases: ['turbo', 'single_turbo'] },
  { code: 503, slug: 'twin_turbocharged', label: 'Twin-Turbocharged', short: 'twin-turbo', aliases: ['twin_turbo', 'bi_turbo', 'biturbo'] },
  { code: 504, slug: 'quad_turbocharged', label: 'Quad-Turbocharged', short: 'quad-turbo', aliases: ['quad_turbo'] },
  { code: 505, slug: 'supercharged', label: 'Supercharged', short: 'supercharged', aliases: ['roots', 'centrifugal_supercharged'] },
  { code: 506, slug: 'twincharged', label: 'Twincharged', short: 'twincharged', note: 'Supercharger and turbocharger in series/parallel.' },
  { code: 507, slug: 'electric_supercharged', label: 'Electrically Supercharged', short: 'e-supercharged', aliases: ['e_supercharger'] },
  { code: 508, slug: 'triple_turbocharged', label: 'Triple-Turbocharged', short: 'triple-turbo', aliases: ['triple_turbo'] },
  { code: 509, slug: 'none', label: 'Not Applicable' },
]);

export const FuelType = defineEnum('fuel_type', [
  { code: 601, slug: 'gasoline', label: 'Gasoline', aliases: ['petrol', 'gas'] },
  { code: 602, slug: 'diesel', label: 'Diesel' },
  { code: 603, slug: 'e85', label: 'E85 / Flex Fuel', aliases: ['flex_fuel', 'ffv'] },
  { code: 604, slug: 'electric', label: 'Electric' },
  { code: 605, slug: 'hydrogen_fuel_cell', label: 'Hydrogen Fuel Cell', aliases: ['fcev'] },
  { code: 606, slug: 'hydrogen_combustion', label: 'Hydrogen Combustion' },
  { code: 607, slug: 'cng', label: 'Compressed Natural Gas', aliases: ['natural_gas'] },
  { code: 608, slug: 'lpg', label: 'LPG / Propane', aliases: ['propane', 'autogas'] },
  { code: 609, slug: 'ethanol', label: 'Ethanol (E100)' },
  { code: 610, slug: 'kerosene', label: 'Kerosene / Turbine' },
]);

export const FuelDelivery = defineEnum('fuel_delivery', [
  { code: 701, slug: 'carburetor', label: 'Carburetor', aliases: ['carb', 'carburettor'] },
  { code: 702, slug: 'throttle_body_injection', label: 'Throttle Body Injection', aliases: ['tbi', 'single_point'] },
  { code: 703, slug: 'port_injection', label: 'Port Injection', aliases: ['mpfi', 'multi_point', 'pfi', 'sequential'] },
  { code: 704, slug: 'direct_injection', label: 'Direct Injection', aliases: ['di', 'gdi', 'fsi', 'tsi_di'] },
  { code: 705, slug: 'dual_injection', label: 'Dual Injection (Port + Direct)', aliases: ['d4s', 'pdi'] },
  { code: 706, slug: 'mechanical_injection', label: 'Mechanical Injection', aliases: ['k_jetronic'] },
  { code: 707, slug: 'common_rail', label: 'Common Rail Diesel' },
  { code: 708, slug: 'unit_injector', label: 'Unit Injector', aliases: ['pumpe_duse'] },
  { code: 709, slug: 'none', label: 'Not Applicable' },
]);

// ---------------------------------------------------------------------------
// 800 block -- electrification
// ---------------------------------------------------------------------------

export const HybridType = defineEnum('hybrid_type', [
  { code: 801, slug: 'none', label: 'Combustion Only', aliases: ['ice', 'non_hybrid'] },
  { code: 802, slug: 'mhev_12v', label: 'Mild Hybrid (12V)' },
  { code: 803, slug: 'mhev_48v', label: 'Mild Hybrid (48V)', aliases: ['mhev', 'mild_hybrid'] },
  { code: 804, slug: 'hev', label: 'Full Hybrid', aliases: ['hybrid', 'full_hybrid', 'self_charging'] },
  { code: 805, slug: 'phev', label: 'Plug-in Hybrid', aliases: ['plug_in_hybrid'] },
  { code: 806, slug: 'erev', label: 'Extended-Range EV', aliases: ['rex', 'range_extender'] },
  { code: 807, slug: 'bev', label: 'Battery Electric', aliases: ['ev', 'electric'] },
  { code: 808, slug: 'fcev', label: 'Fuel Cell Electric' },
]);

export const MotorType = defineEnum('motor_type', [
  { code: 851, slug: 'pmsm', label: 'Permanent Magnet Synchronous', aliases: ['permanent_magnet', 'ipm'] },
  { code: 852, slug: 'induction', label: 'AC Induction', aliases: ['asynchronous', 'acim'] },
  { code: 853, slug: 'srm', label: 'Switched Reluctance' },
  { code: 854, slug: 'axial_flux', label: 'Axial Flux' },
  { code: 855, slug: 'wound_rotor', label: 'Externally Excited / Wound Rotor', aliases: ['eesm'] },
  { code: 856, slug: 'in_wheel', label: 'In-Wheel Hub Motor' },
]);

export const BatteryChemistry = defineEnum('battery_chemistry', [
  { code: 871, slug: 'nmc', label: 'Lithium NMC' },
  { code: 872, slug: 'lfp', label: 'Lithium Iron Phosphate (LFP)' },
  { code: 873, slug: 'nca', label: 'Lithium NCA' },
  { code: 874, slug: 'nimh', label: 'Nickel Metal Hydride' },
  { code: 875, slug: 'lead_acid', label: 'Lead Acid' },
  { code: 876, slug: 'lto', label: 'Lithium Titanate' },
  { code: 877, slug: 'solid_state', label: 'Solid State' },
  { code: 878, slug: 'sodium_ion', label: 'Sodium Ion' },
  { code: 879, slug: 'supercapacitor', label: 'Supercapacitor' },
]);

// ---------------------------------------------------------------------------
// 900 block -- transmission & driveline
// ---------------------------------------------------------------------------

export const TransmissionType = defineEnum('transmission_type', [
  { code: 901, slug: 'manual', label: 'Manual', aliases: ['mt', 'stick'] },
  { code: 902, slug: 'automatic', label: 'Torque Converter Automatic', aliases: ['at', 'auto', 'torque_converter'] },
  { code: 903, slug: 'dct', label: 'Dual-Clutch', aliases: ['dsg', 'pdk', 'dual_clutch', 's_tronic'] },
  { code: 904, slug: 'cvt', label: 'CVT', aliases: ['continuously_variable'] },
  { code: 905, slug: 'amt', label: 'Automated Manual', aliases: ['single_clutch_automated', 'smg', 'f1'] },
  { code: 906, slug: 'single_speed', label: 'Single-Speed Reduction', aliases: ['direct_drive', 'fixed_gear'] },
  { code: 907, slug: 'ecvt', label: 'Power-Split eCVT', aliases: ['planetary_hybrid', 'hsd'] },
  { code: 908, slug: 'two_speed', label: 'Two-Speed EV Gearbox' },
  { code: 909, slug: 'preselector', label: 'Preselector' },
]);

export const DrivetrainType = defineEnum('drivetrain_type', [
  { code: 951, slug: 'fwd', label: 'Front-Wheel Drive', aliases: ['front_wheel_drive', '2wd_front'] },
  { code: 952, slug: 'rwd', label: 'Rear-Wheel Drive', aliases: ['rear_wheel_drive', '2wd_rear'] },
  { code: 953, slug: 'awd', label: 'All-Wheel Drive', aliases: ['all_wheel_drive', 'quattro', 'xdrive', '4matic'] },
  { code: 954, slug: '4wd_part_time', label: 'Part-Time 4WD', aliases: ['4x4_part_time', 'selectable_4wd'] },
  { code: 955, slug: '4wd_full_time', label: 'Full-Time 4WD', aliases: ['4x4_full_time'] },
  { code: 956, slug: '6wd', label: 'Six-Wheel Drive', aliases: ['6x6'] },
  { code: 957, slug: 'rwd_biased_awd', label: 'RWD-Biased AWD', note: 'Disconnects to pure RWD in normal driving.' },
  { code: 958, slug: 'fwd_biased_awd', label: 'FWD-Biased AWD' },
  { code: 959, slug: 'through_road_awd', label: 'Through-the-Road AWD', note: 'Engine drives one axle, e-motor the other; no propshaft.' },
]);

export const EnginePlacement = defineEnum('engine_placement', [
  { code: 981, slug: 'front_longitudinal', label: 'Front, Longitudinal' },
  { code: 982, slug: 'front_transverse', label: 'Front, Transverse' },
  { code: 983, slug: 'mid_longitudinal', label: 'Mid, Longitudinal' },
  { code: 984, slug: 'mid_transverse', label: 'Mid, Transverse' },
  { code: 985, slug: 'rear_longitudinal', label: 'Rear, Longitudinal' },
  { code: 986, slug: 'rear_transverse', label: 'Rear, Transverse' },
  { code: 987, slug: 'front_mid', label: 'Front-Mid', note: 'Behind front axle line.' },
  { code: 988, slug: 'under_floor', label: 'Under Floor' },
  { code: 989, slug: 'none', label: 'Not Applicable' },
]);

// ---------------------------------------------------------------------------
// 1000 block -- chassis
// ---------------------------------------------------------------------------

export const SuspensionType = defineEnum('suspension_type', [
  { code: 1001, slug: 'macpherson_strut', label: 'MacPherson Strut', aliases: ['strut'] },
  { code: 1002, slug: 'double_wishbone', label: 'Double Wishbone', aliases: ['double_a_arm', 'sla'] },
  { code: 1003, slug: 'multilink', label: 'Multi-Link', aliases: ['multi_link'] },
  { code: 1004, slug: 'torsion_beam', label: 'Torsion Beam', aliases: ['twist_beam'] },
  { code: 1005, slug: 'live_axle', label: 'Live / Solid Axle', aliases: ['solid_axle', 'beam_axle', 'rigid_axle'] },
  { code: 1006, slug: 'de_dion', label: 'De Dion Tube' },
  { code: 1007, slug: 'swing_axle', label: 'Swing Axle' },
  { code: 1008, slug: 'trailing_arm', label: 'Trailing Arm' },
  { code: 1009, slug: 'semi_trailing_arm', label: 'Semi-Trailing Arm' },
  { code: 1010, slug: 'leaf_spring_live_axle', label: 'Leaf-Sprung Live Axle' },
  { code: 1011, slug: 'pushrod', label: 'Pushrod / Inboard' },
  { code: 1012, slug: 'air_suspension', label: 'Air Suspension', note: 'Spring medium; combine with a geometry value where known.' },
]);

export const SteeringType = defineEnum('steering_type', [
  { code: 1051, slug: 'rack_pinion_hydraulic', label: 'Hydraulic Rack & Pinion', aliases: ['hydraulic'] },
  { code: 1052, slug: 'rack_pinion_electric', label: 'Electric Rack & Pinion', aliases: ['eps', 'electric'] },
  { code: 1053, slug: 'rack_pinion_electrohydraulic', label: 'Electrohydraulic Rack & Pinion', aliases: ['ehps'] },
  { code: 1054, slug: 'recirculating_ball', label: 'Recirculating Ball' },
  { code: 1055, slug: 'worm_sector', label: 'Worm & Sector' },
  { code: 1056, slug: 'steer_by_wire', label: 'Steer-by-Wire' },
  { code: 1057, slug: 'unassisted_rack', label: 'Unassisted Rack & Pinion', aliases: ['manual_steering'] },
]);

export const BrakeType = defineEnum('brake_type', [
  { code: 1071, slug: 'disc_vented', label: 'Vented Disc', aliases: ['ventilated_disc'] },
  { code: 1072, slug: 'disc_solid', label: 'Solid Disc' },
  { code: 1073, slug: 'disc_drilled', label: 'Drilled Disc' },
  { code: 1074, slug: 'disc_slotted', label: 'Slotted Disc' },
  { code: 1075, slug: 'carbon_ceramic', label: 'Carbon Ceramic', aliases: ['pccb', 'ccm', 'ccb'] },
  { code: 1076, slug: 'carbon_carbon', label: 'Carbon-Carbon' },
  { code: 1077, slug: 'drum', label: 'Drum' },
  { code: 1078, slug: 'inboard_disc', label: 'Inboard Disc' },
]);

// ---------------------------------------------------------------------------
// 1100 block -- data quality & provenance
// ---------------------------------------------------------------------------

/**
 * How much a given fact should be trusted. Surfaced in the UI so users can
 * decide, and usable as a search filter ("only show verified data").
 */
export const Confidence = defineEnum('confidence', [
  { code: 1101, slug: 'manufacturer', label: 'Manufacturer Source', note: 'From an OEM press kit, brochure, or spec sheet.' },
  { code: 1102, slug: 'regulatory', label: 'Regulatory Filing', note: 'EPA, NHTSA, EU type approval, homologation docs.' },
  { code: 1103, slug: 'measured', label: 'Independently Measured', note: 'Instrumented test by a reputable outlet.' },
  { code: 1104, slug: 'reputable_secondary', label: 'Reputable Secondary Source' },
  { code: 1105, slug: 'community', label: 'Community Reported', note: 'Contributed without a citation. Treat with caution.' },
  { code: 1106, slug: 'inferred', label: 'Inferred', note: 'Derived from a sibling variant or a shared component.' },
  { code: 1107, slug: 'unverified', label: 'Unverified / Placeholder' },
  { code: 1108, slug: 'disputed', label: 'Disputed', note: 'Sources conflict; see notes.' },
]);

/** Availability of a feature on a specific variant. */
export const Availability = defineEnum('availability', [
  { code: 1121, slug: 'standard', label: 'Standard' },
  { code: 1122, slug: 'optional', label: 'Standalone Option' },
  { code: 1123, slug: 'package', label: 'In Option Package' },
  { code: 1124, slug: 'dealer_installed', label: 'Dealer Installed' },
  { code: 1125, slug: 'late_availability', label: 'Late Availability' },
  { code: 1126, slug: 'unavailable', label: 'Not Available' },
]);

/**
 * Which measurement regime a fuel-economy or range figure came from.
 * Mixing EPA and WLTP numbers in one column would silently corrupt every
 * efficiency comparison, so the regime is stored alongside the value.
 */
export const TestCycle = defineEnum('test_cycle', [
  { code: 1141, slug: 'epa', label: 'EPA (US)' },
  { code: 1142, slug: 'wltp', label: 'WLTP' },
  { code: 1143, slug: 'nedc', label: 'NEDC' },
  { code: 1144, slug: 'jc08', label: 'JC08' },
  { code: 1145, slug: 'wltc_japan', label: 'WLTC (Japan)' },
  { code: 1146, slug: 'cltc', label: 'CLTC (China)' },
  { code: 1147, slug: 'nrcan', label: 'NRCan (Canada)' },
  { code: 1148, slug: 'adr', label: 'ADR (Australia)' },
  { code: 1149, slug: 'manufacturer_claim', label: 'Manufacturer Claim' },
]);

/** Where a power/torque figure was measured. Crank vs wheel matters a lot. */
export const PowerStandard = defineEnum('power_standard', [
  { code: 1161, slug: 'sae_net', label: 'SAE Net (hp)' },
  { code: 1162, slug: 'sae_gross', label: 'SAE Gross (hp)', note: 'Pre-1972 US figures. Not comparable to net.' },
  { code: 1163, slug: 'sae_certified', label: 'SAE Certified J1349' },
  { code: 1164, slug: 'din', label: 'DIN (PS)' },
  { code: 1165, slug: 'ece', label: 'ECE R85' },
  { code: 1166, slug: 'jis', label: 'JIS' },
  { code: 1167, slug: 'wheel', label: 'Measured at Wheels' },
  { code: 1168, slug: 'iso_1585', label: 'ISO 1585' },
]);

export const Market = defineEnum('market', [
  { code: 1201, slug: 'us', label: 'United States' },
  { code: 1202, slug: 'ca', label: 'Canada' },
  { code: 1203, slug: 'mx', label: 'Mexico' },
  { code: 1204, slug: 'eu', label: 'European Union' },
  { code: 1205, slug: 'uk', label: 'United Kingdom' },
  { code: 1206, slug: 'jp', label: 'Japan' },
  { code: 1207, slug: 'au', label: 'Australia' },
  { code: 1208, slug: 'cn', label: 'China' },
  { code: 1209, slug: 'kr', label: 'South Korea' },
  { code: 1210, slug: 'in', label: 'India' },
  { code: 1211, slug: 'br', label: 'Brazil' },
  { code: 1212, slug: 'za', label: 'South Africa' },
  { code: 1213, slug: 'me', label: 'Middle East' },
  { code: 1214, slug: 'row', label: 'Rest of World' },
]);

/** Broad grouping used to organise the feature catalog in the UI. */
export const FeatureCategory = defineEnum('feature_category', [
  { code: 1301, slug: 'seating_comfort', label: 'Seating & Comfort' },
  { code: 1302, slug: 'climate', label: 'Climate Control' },
  { code: 1303, slug: 'infotainment', label: 'Infotainment' },
  { code: 1304, slug: 'audio', label: 'Audio' },
  { code: 1305, slug: 'driver_assistance', label: 'Driver Assistance' },
  { code: 1306, slug: 'safety_passive', label: 'Passive Safety' },
  { code: 1307, slug: 'lighting', label: 'Lighting' },
  { code: 1308, slug: 'exterior_convenience', label: 'Exterior & Convenience' },
  { code: 1309, slug: 'performance_hardware', label: 'Performance Hardware' },
  { code: 1310, slug: 'offroad_hardware', label: 'Off-Road Hardware' },
  { code: 1311, slug: 'towing', label: 'Towing' },
  { code: 1312, slug: 'connectivity', label: 'Connectivity' },
  { code: 1313, slug: 'instrumentation', label: 'Instrumentation' },
  { code: 1314, slug: 'cargo_utility', label: 'Cargo & Utility' },
  { code: 1315, slug: 'charging', label: 'EV Charging' },
  { code: 1316, slug: 'security', label: 'Security' },
]);

/** Registry so the ETL and API can iterate every vocabulary generically. */
export const ENUM_REGISTRY = {
  body_category: BodyCategory,
  roof_type: RoofType,
  cab_style: CabStyle,
  engine_layout: EngineLayout,
  cam_config: CamConfig,
  aspiration: Aspiration,
  fuel_type: FuelType,
  fuel_delivery: FuelDelivery,
  hybrid_type: HybridType,
  motor_type: MotorType,
  battery_chemistry: BatteryChemistry,
  transmission_type: TransmissionType,
  drivetrain_type: DrivetrainType,
  engine_placement: EnginePlacement,
  suspension_type: SuspensionType,
  steering_type: SteeringType,
  brake_type: BrakeType,
  confidence: Confidence,
  availability: Availability,
  test_cycle: TestCycle,
  power_standard: PowerStandard,
  market: Market,
  feature_category: FeatureCategory,
} as const;

export type EnumName = keyof typeof ENUM_REGISTRY;
