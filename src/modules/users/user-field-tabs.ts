/**
 * Every field of UpdateUserDto, mapped to the People & Access tab that owns
 * it. PUT /users/:id writes fields of both the Identity and Job tabs through
 * one route, so each field is authorised against `<tab>.edit`. A field missing
 * from this map is UNGUARDED -- user-field-tab-map.spec.ts asserts every DTO
 * key appears here, so a new field fails CI rather than shipping unguarded.
 *
 * Holding the tab's action is necessary, not sufficient: for a non-super-admin
 * UsersService.updateUser also refuses their own account and a SUPER_ADMIN's,
 * a role above their own access (`role`), and a new password on an account
 * that holds more than they do (`password`) -- TAFSD-365.
 */
export const USER_FIELD_TAB_MAP: Record<string, string> = {
  // ── Identity tab ──
  full_name: 'identity',
  password: 'identity',
  is_active: 'identity',
  role: 'identity',

  // ── Job tab ── (legacy fields — the webapp's Job tab writes campus/
  // department/pay through the Employee Directory's own endpoint instead.
  // These still exist on this DTO and must not go unguarded.)
  campus_id: 'job',
  allowed_class_ids: 'job',
};

export const PEOPLE_ACCESS_TILE_ID = 'system.people_access';
