/**
 * Which campus (and, for segment-locked devices, which academic segments) a
 * STUDENT pin may be mapped to on a given device. Derived from actual scan
 * history per device, not its on-box label — devices named "Campus 3 ..." are
 * physically at the Johar (GEJ) campus, so the label alone can't be trusted.
 * Devices not listed here (test rigs, staff-only units) get no such check.
 *
 * TAFSD-582: segments are matched by id, not code. Codes can be edited in
 * Setup > Segments and have been (PRE_PRIMARY became EARLY_YEARS,
 * OLEVELS_CAMBRIDGE / ALEVELS_CAMBRIDGE became OLEVELS / ALEVELS), which left
 * every Early Years and O/A-Level student unmappable on their own device.
 * Ids are fixed by the seed migration (20260722140000_add_segments).
 */
export const SEGMENT_IDS = {
  EARLY_YEARS: 1, // was Pre-Primary: EY-I / II / III
  JUNIOR_CAMBRIDGE: 2,
  SENIOR_CAMBRIDGE: 3,
  OLEVELS: 4,
  ALEVELS: 5,
  SECONDARY: 6,
} as const;

export const DEVICE_SEGMENT_RULES: Record<string, { campusCode: string; segmentIds: number[] }> = {
  NYU7261205128: { campusCode: 'GEJ', segmentIds: [SEGMENT_IDS.EARLY_YEARS] }, // Campus 3 Device 2 Pre-Primary
  NYU7261205142: { campusCode: 'GEJ', segmentIds: [SEGMENT_IDS.JUNIOR_CAMBRIDGE] }, // Campus 3 Device 1 Junior Cambridge
  NYU7261205221: { campusCode: 'GEJ', segmentIds: [SEGMENT_IDS.SECONDARY] }, // Campus 2 Device 1 Secondary
  NYU7261205141: { campusCode: 'GEJ', segmentIds: [SEGMENT_IDS.SENIOR_CAMBRIDGE] }, // Campus 2 Device 2 Senior Cambridge
  NYU7261205172: { campusCode: 'GEJ', segmentIds: [SEGMENT_IDS.OLEVELS, SEGMENT_IDS.ALEVELS] }, // TAFSAL
};

/** Faculty devices: any segment, as long as the student belongs to this campus. */
export const DEVICE_CAMPUS_ONLY_RULES: Record<string, string> = {
  NYU7251000240: 'GEJ', // Johar Faculty
  NYU7261205040: 'KNF', // GKF Faculty
  NYU7261000023: 'NNZ', // NNN Faculty
};
