/**
 * Every field of UpdateUserDto, mapped to the tab that owns it.
 *
 * PUT /users/:id writes fields belonging to both the Identity and Job tabs
 * of the People & Access panel through one route, so tab-level permissions
 * only mean something if every field is mapped. A field missing from this
 * map is UNGUARDED -- user-field-tab-map.spec.ts asserts every DTO key
 * appears here (in this map or in USER_SUPER_ADMIN_ONLY_FIELDS), so a new
 * field fails CI rather than shipping an unguarded write.
 */
export const USER_FIELD_TAB_MAP: Record<string, string> = {
  // ── Identity tab ──
  full_name: 'identity',
  password: 'identity',
  is_active: 'identity',

  // ── Job tab ── (legacy fields — the webapp's Job tab currently writes
  // campus/department/pay through the Employee Directory's own endpoint
  // instead, per its own field-partitioning. These still exist on this DTO
  // and must not go unguarded if ever exercised directly through this route.)
  campus_id: 'job',
  allowed_class_ids: 'job',
};

/**
 * `role` cannot be authorised the normal way: holding `job.edit` (or any
 * action at all) must never be enough to change someone's role, because
 * role is how SUPER_ADMIN itself is granted — and the generic CASL mapper
 * (casl-ability.factory.ts) turns almost any non-'.view' permission key into
 * full Manage on whatever subject it names, so "holds job.edit" says nothing
 * about how trusted the holder actually is. Only an acting SUPER_ADMIN may
 * change this field — checked directly against the actor's role in
 * UsersService.updateUser, not through the tab-action map. Listed here only
 * so the completeness spec knows the field is accounted for.
 */
export const USER_SUPER_ADMIN_ONLY_FIELDS = ['role'];

export const PEOPLE_ACCESS_TILE_ID = 'system.people_access';
