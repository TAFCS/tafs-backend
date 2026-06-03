/**
 * Official `classes.id` values (Cambridge + Secondary + A-Level).
 * Keep in sync with the classes table.
 */
export const CLASS_IDS = {
  PN: 1,
  NUR: 2,
  KG: 3,
  JR_I: 4,
  JR_II: 5,
  JR_III: 6,
  JR_IV: 7,
  JR_V: 8,
  SR_I: 9,
  SR_II: 10,
  SR_III: 11,
  O_I: 12,
  O_II: 13,
  O_III: 14,
  VI: 15,
  VII: 16,
  VIII: 17,
  IX: 18,
  X: 19,
  AS: 21,
  A2: 22,
} as const;

/** Principal class-band scopes (allowed_class_ids on users). */
export const CLASS_BAND_IDS = {
  /** Pre-Nursery, Nursery, K.G. */
  PN_KG: [CLASS_IDS.PN, CLASS_IDS.NUR, CLASS_IDS.KG],
  JR_12: [CLASS_IDS.JR_I, CLASS_IDS.JR_II],
  JR_35: [CLASS_IDS.JR_III, CLASS_IDS.JR_IV, CLASS_IDS.JR_V],
  SR_13: [CLASS_IDS.SR_I, CLASS_IDS.SR_II, CLASS_IDS.SR_III],
  /** Secondary system VI–X */
  VI_X: [CLASS_IDS.VI, CLASS_IDS.VII, CLASS_IDS.VIII, CLASS_IDS.IX, CLASS_IDS.X],
  /** Cambridge O-I–III + AS/A2 */
  OA: [CLASS_IDS.O_I, CLASS_IDS.O_II, CLASS_IDS.O_III, CLASS_IDS.AS, CLASS_IDS.A2],
};

export type ClassBandKey = keyof typeof CLASS_BAND_IDS;
