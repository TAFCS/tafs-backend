import { auditActorLabel } from './audit-actor.util';

describe('auditActorLabel', () => {
  it('prefers full name over username', () => {
    expect(
      auditActorLabel({ sub: 'uuid-1', username: 'jdoe', fullName: 'Jane Doe' }),
    ).toBe('Jane Doe');
  });

  it('falls back to username when full name is missing', () => {
    expect(auditActorLabel({ sub: 'uuid-1', username: 'jdoe' })).toBe('jdoe');
  });

  it('falls back to sub when only id is available', () => {
    expect(auditActorLabel({ sub: 'a05df842-daa3-4a3e-ab4f-e848b543bed6' })).toBe(
      'a05df842-daa3-4a3e-ab4f-e848b543bed6',
    );
  });

  it('labels known system actors', () => {
    expect(auditActorLabel('zk-device')).toBe('ZK Device');
    expect(auditActorLabel('system')).toBe('System');
  });

  it('returns system for empty input', () => {
    expect(auditActorLabel(null)).toBe('system');
    expect(auditActorLabel('')).toBe('system');
  });
});
