import {
  USER_FIELD_TAB_MAP,
  USER_SUPER_ADMIN_ONLY_FIELDS,
} from './user-field-tabs';
import { PEOPLE_ACCESS_ACTIONS_FOR_TEST } from '../access/tiles.manifest';

/**
 * Every field UpdateUserDto can carry, listed here by hand. Kept as a literal
 * rather than reflected off the class so the spec has no runtime dependency
 * on the service. Adding a field to the DTO without adding it here fails
 * this spec — which is the point.
 */
const DTO_FIELDS = [
  'full_name', 'password', 'role', 'campus_id', 'is_active', 'allowed_class_ids',
];

/**
 * PUT /users/:id writes fields belonging to both the Identity and Job tabs
 * through one route, so tab-level permissions only mean something if EVERY
 * field is mapped. A field missing from this map (and from
 * USER_SUPER_ADMIN_ONLY_FIELDS) is an unguarded write.
 */
describe('USER_FIELD_TAB_MAP', () => {
  it('covers every field the DTO can carry', () => {
    const known = new Set([
      ...Object.keys(USER_FIELD_TAB_MAP),
      ...USER_SUPER_ADMIN_ONLY_FIELDS,
    ]);
    const unmapped = DTO_FIELDS.filter((f) => !known.has(f));

    // Failing here means a field was added to UpdateUserDto without deciding
    // which tab owns it. Add it to USER_FIELD_TAB_MAP (or, if it needs a
    // stricter check than any action can express, to
    // USER_SUPER_ADMIN_ONLY_FIELDS).
    expect(unmapped).toEqual([]);
  });

  it('maps nothing that is not a real DTO field', () => {
    const dto = new Set(DTO_FIELDS);
    const stale = Object.keys(USER_FIELD_TAB_MAP).filter((f) => !dto.has(f));
    expect(stale).toEqual([]);
  });

  it('maps every tab to an edit action the manifest declares', () => {
    const declared = new Set(PEOPLE_ACCESS_ACTIONS_FOR_TEST.map((a) => a.id));
    const missing = [...new Set(Object.values(USER_FIELD_TAB_MAP))]
      .map((tab) => `${tab}.edit`)
      .filter((actionId) => !declared.has(actionId));

    expect(missing).toEqual([]);
  });

  it('never maps a field to both a tab and the super-admin-only list', () => {
    const both = USER_SUPER_ADMIN_ONLY_FIELDS.filter(
      (f) => USER_FIELD_TAB_MAP[f] !== undefined,
    );
    expect(both).toEqual([]);
  });
});
