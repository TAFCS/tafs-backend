import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { NoticeBoardService } from './notice-board.service';
import { TILES_MANIFEST } from '../access/tiles.manifest';

// TAFSD-553: every notice names its statuses and years; each status is its own grant.

const T = 'communication.notice_board';
const poster = (...targets: string[]) =>
  ({ sub: 'u1', role: 'CAMPUS_ADMIN', actions: [`${T}#view`, `${T}#create`, ...targets.map((t) => `${T}#target.${t}`)] }) as any;
const superAdmin = { sub: 'sa', role: 'SUPER_ADMIN', actions: [] } as any;

function build(students: Array<{ cc: number; status: string | null }> = []) {
  const svc = Object.create(NoticeBoardService.prototype) as any;
  svc.prisma = { students: { findMany: jest.fn(async () => students) } };
  return svc as NoticeBoardService;
}

describe('notice audience permissions', () => {
  it('requires at least one status, even for a superadmin', async () => {
    await expect(
      build().assertAudienceAllowed(superAdmin, { student_statuses: [], academic_years: ['2026-27'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires at least one academic year, even for a superadmin', async () => {
    await expect(
      build().assertAudienceAllowed(superAdmin, { student_statuses: ['ENROLLED'], academic_years: [' '] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a superadmin pick every status', async () => {
    await expect(
      build().assertAudienceAllowed(superAdmin, {
        student_statuses: ['ENROLLED', 'GRADUATED', 'LEFT'],
        academic_years: ['2025-26', '2026-27'],
      }),
    ).resolves.toBeUndefined();
  });

  it('allows the statuses the poster holds and refuses the rest', async () => {
    const svc = build();
    await expect(
      svc.assertAudienceAllowed(poster('enrolled', 'quick_admission'), {
        student_statuses: ['ENROLLED', 'QUICK_ADMISSION'],
        academic_years: ['2026-27'],
      }),
    ).resolves.toBeUndefined();
    await expect(
      svc.assertAudienceAllowed(poster('enrolled'), {
        student_statuses: ['ENROLLED', 'GRADUATED'],
        academic_years: ['2026-27'],
      }),
    ).rejects.toThrow(/Graduated/);
  });

  it('honours a whole-tile wildcard grant', async () => {
    const u = { sub: 'u2', role: 'CAMPUS_ADMIN', actions: [`${T}#*`] } as any;
    await expect(
      build().assertAudienceAllowed(u, { student_statuses: ['EXPELLED'], academic_years: ['2026-27'] }),
    ).resolves.toBeUndefined();
  });

  it("checks named students against each one's status, without needing a status or year", async () => {
    const svc = build([
      { cc: 101, status: 'ENROLLED' },
      { cc: 102, status: 'LEFT' },
    ]);
    await expect(svc.assertAudienceAllowed(poster('enrolled'), { student_ccs: [101, 102] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.assertAudienceAllowed(poster('enrolled', 'left'), { student_ccs: [101, 102] })).resolves.toBeUndefined();
  });

  it('ticks Enrolled by default when the tile is granted, and nothing else', () => {
    const tile = TILES_MANIFEST.find((t) => t.id === T)!;
    const defaults = tile.actions!.filter((a) => a.default).map((a) => a.id);
    expect(defaults).toEqual(expect.arrayContaining(['view', 'target.enrolled']));
    for (const id of ['target.quick_admission', 'target.soft_admission', 'target.left', 'target.expelled', 'target.graduated']) {
      expect(tile.actions!.some((a) => a.id === id && !a.default)).toBe(true);
    }
  });
});
