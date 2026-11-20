import {
  MIN_DELETE_REASON,
  checkDeleteReason,
  currentVersion,
  isOnFile,
  liveVersions,
  nextVersionNo,
  type VersionState,
} from './vault-rules';

/** TAFSD-541: deleting a wrong version of a student document. */
const v = (version_no: number, deleted = false): VersionState => ({
  id: version_no * 100,
  version_no,
  deleted_at: deleted ? new Date('2026-11-19T10:00:00Z') : null,
});

describe('deleted document versions', () => {
  describe('currentVersion', () => {
    it('is the highest-numbered version when none is deleted', () => {
      expect(currentVersion([v(1), v(3), v(2)])?.version_no).toBe(3);
    });
    it('falls back to v2 when v3 of 3 is deleted', () => {
      expect(currentVersion([v(1), v(2), v(3, true)])?.version_no).toBe(2);
    });
    it('skips every deleted version, not just the newest', () => {
      expect(currentVersion([v(1), v(2, true), v(3, true)])?.version_no).toBe(1);
    });
    it('keeps the newest when an older one is deleted', () => {
      expect(currentVersion([v(1, true), v(2), v(3)])?.version_no).toBe(3);
    });
    it('is null when every version is deleted', () => {
      expect(currentVersion([v(1, true), v(2, true)])).toBeNull();
      expect(currentVersion([])).toBeNull();
    });
  });

  describe('liveVersions', () => {
    it('lists only versions on file, newest first', () => {
      expect(liveVersions([v(1), v(4, true), v(3), v(2, true)]).map((x) => x.version_no)).toEqual([3, 1]);
    });
  });

  describe('isOnFile', () => {
    it('is true while any version is left', () => {
      expect(isOnFile([v(1, true), v(2)])).toBe(true);
    });
    it('is false when the only version is deleted, so the slot reads missing again', () => {
      expect(isOnFile([v(1, true)])).toBe(false);
      expect(isOnFile([])).toBe(false);
    });
  });

  describe('nextVersionNo', () => {
    it('continues from the highest number', () => {
      expect(nextVersionNo([v(1), v(2)])).toBe(3);
    });
    it('never reuses a deleted number', () => {
      expect(nextVersionNo([v(1), v(2), v(3, true)])).toBe(4);
      expect(nextVersionNo([v(1, true)])).toBe(2);
    });
    it('starts at 1', () => {
      expect(nextVersionNo([])).toBe(1);
    });
  });

  describe('checkDeleteReason', () => {
    it('requires a reason of a few characters', () => {
      expect(checkDeleteReason(undefined)).toMatch(/reason/);
      expect(checkDeleteReason('   ')).toMatch(/reason/);
      expect(checkDeleteReason('x'.repeat(MIN_DELETE_REASON - 1))).toMatch(/reason/);
      expect(checkDeleteReason(`  ${'x'.repeat(MIN_DELETE_REASON - 1)}  `)).toMatch(/reason/);
    });
    it('accepts a real reason and refuses a very long one', () => {
      expect(checkDeleteReason('Wrong student')).toBeNull();
      expect(checkDeleteReason('x'.repeat(501))).toMatch(/500/);
    });
  });
});
