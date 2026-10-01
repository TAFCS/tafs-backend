import { CLASS_BAND_IDS } from './class-band-ids';
import {
  closedTicketVisibilityWhere,
  matchRoutingOverrides,
  parseRoutingOverrides,
  pickPrincipal,
  principalLookupWhere,
} from './support-ticket-routing';

describe('support-ticket-routing', () => {
  describe('principalLookupWhere', () => {
    it('matches campus-wide and class-band principals', () => {
      const where = principalLookupWhere(1, 15);
      expect(where.role).toBe('PRINCIPAL');
      expect(where.OR).toHaveLength(2);
    });
  });

  describe('pickPrincipal', () => {
    it('prefers campus-wide principal over class-band', () => {
      const campusWide = {
        id: 'a',
        allowed_class_ids: [] as number[],
      };
      const classBand = {
        id: 'b',
        allowed_class_ids: CLASS_BAND_IDS.VI_X,
      };
      expect(pickPrincipal([classBand, campusWide])?.id).toBe('a');
    });

    it('returns undefined when no candidates', () => {
      expect(pickPrincipal([])).toBeUndefined();
    });
  });

  describe('closedTicketVisibilityWhere', () => {
    it('campus admin sees all closed tickets', () => {
      expect(closedTicketVisibilityWhere({ role: 'CAMPUS_ADMIN' })).toEqual({
        status: 'CLOSED',
      });
    });

    it('principal sees closed tickets routed to principals', () => {
      expect(closedTicketVisibilityWhere({ role: 'PRINCIPAL' })).toEqual({
        status: 'CLOSED',
        routed_role: 'PRINCIPAL',
      });
    });

    it('teacher has no closed ticket access', () => {
      expect(closedTicketVisibilityWhere({ role: 'TEACHER' })).toEqual({
        status: 'CLOSED',
        id: '__none__',
      });
    });
  });

  describe('routing overrides', () => {
    it('ignores malformed config', () => {
      expect(parseRoutingOverrides(null)).toEqual([]);
      expect(parseRoutingOverrides('not json')).toEqual([]);
      expect(parseRoutingOverrides('{"campus_id":2}')).toEqual([]);
      expect(
        parseRoutingOverrides('[{"campus_id":"2","user_id":"u"},{"campus_id":2,"user_id":"ok"}]'),
      ).toEqual([{ campus_id: 2, user_id: 'ok' }]);
    });

    it('matches campus-wide and class-specific overrides, specific first', () => {
      const overrides = parseRoutingOverrides(
        JSON.stringify([
          { campus_id: 2, user_id: 'campus-wide' },
          { campus_id: 2, class_ids: [5], user_id: 'class-5' },
          { campus_id: 1, user_id: 'other-campus' },
        ]),
      );
      expect(matchRoutingOverrides(overrides, 2, 5).map((o) => o.user_id)).toEqual([
        'class-5',
        'campus-wide',
      ]);
      expect(matchRoutingOverrides(overrides, 2, 3).map((o) => o.user_id)).toEqual([
        'campus-wide',
      ]);
      expect(matchRoutingOverrides(overrides, 3, 3)).toEqual([]);
    });
  });
});
