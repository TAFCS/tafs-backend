import 'reflect-metadata';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { REQUIRE_ACTION_KEY } from '../../decorators/require-action.decorator';
import { TILES_MANIFEST } from '../access/tiles.manifest';
import { GuideController } from './guide.controller';
import { GuideService } from './guide.service';
import type { GuideManifest } from './guide.types';

const file = (name: string, pages: number) => ({ file: name, bytes: 1000, pages });

const MANIFEST: GuideManifest = {
  schema: 1,
  title: 'TAFSync Software Manual',
  built_at: '2026-11-27T00:00:00+00:00',
  commit: 'abc',
  manual: file('TAFSync-Manual.pdf', 9),
  areas: [
    {
      id: 'students',
      title: 'Students',
      pdf: file('area-students.pdf', 5),
      modules: [
        { id: 'students/quick-registration', title: 'Quick Registration', where: 'Student & Profiling → Quick Registration', summary: null, pdf: file('module-students-quick-registration.pdf', 4), bare: file('bare-students-quick-registration.pdf', 2) },
      ],
    },
    {
      id: 'finance',
      title: 'Finance',
      pdf: file('area-finance.pdf', 6),
      modules: [
        { id: 'finance/defaulters-report', title: 'Defaulters Report', where: 'Finance → Defaulters', summary: 'x', pdf: file('module-finance-defaulters-report.pdf', 5), bare: file('bare-finance-defaulters-report.pdf', 3) },
      ],
    },
  ],
};

async function pdfOf(pages: number, label: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89]).drawText(`${label} ${i + 1}`, { x: 72, y: 700, font, size: 12 });
  return Buffer.from(await doc.save());
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Guide (TAFSD-616)', () => {
  describe('access', () => {
    const tile = TILES_MANIFEST.find((t) => t.id === 'system.user_guide')!;

    it('is a web tile in System with one default view action and no legacy bridge', () => {
      expect(tile).toMatchObject({ module: 'system', href: '/system/guide', capabilities: ['system.guide.view'] });
      expect(tile.surface).toBeUndefined();
      expect(tile.legacyFullAccessCapabilities).toBeUndefined();
      expect(tile.actions).toEqual([expect.objectContaining({ id: 'view', default: true })]);
    });

    it('gates every route on system.user_guide#view', () => {
      expect(Reflect.getMetadata('__guards__', GuideController)).toContain(TileActionGuard);
      expect(Reflect.getMetadata(REQUIRE_ACTION_KEY, GuideController)).toEqual({ mode: 'all', actionKeys: ['system.user_guide#view'] });
      const proto = GuideController.prototype as any;
      const routes = Object.getOwnPropertyNames(proto).filter((n) => Reflect.getMetadata('method', proto[n]) !== undefined);
      expect(routes.sort()).toEqual(['combine', 'contents', 'file']);
      for (const r of routes) expect(Reflect.getMetadata(REQUIRE_ACTION_KEY, proto[r])).toBeUndefined(); // class-level gate applies
    });
  });

  describe('service', () => {
    let fetchSpy: jest.SpyInstance;
    let assets: Record<string, Buffer>;
    const ids: Record<string, number> = {};
    const service = (token = 'test-token') =>
      new GuideService({ get: (k: string) => (k === 'MANUAL_GITHUB_TOKEN' ? token : undefined) } as any);

    beforeEach(async () => {
      assets = {
        'manifest.json': Buffer.from(JSON.stringify(MANIFEST)),
        'TAFSync-Manual.pdf': await pdfOf(9, 'manual'),
        'bare-students-quick-registration.pdf': await pdfOf(2, 'QR'),
        'bare-finance-defaulters-report.pdf': await pdfOf(3, 'DR'),
        'not-in-manifest.pdf': await pdfOf(1, 'secret'),
      };
      Object.keys(assets).forEach((name, i) => (ids[name] = i + 1));
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: any) => {
        const url = String(input);
        if (url.endsWith('/releases/latest')) {
          expect(init.headers.Authorization).toBe('Bearer test-token');
          return json({ tag_name: 'manual-1', published_at: null, assets: Object.keys(assets).map((name) => ({ name, id: ids[name] })) });
        }
        const m = url.match(/\/releases\/assets\/(\d+)$/);
        if (m) {
          // GitHub redirects asset downloads to signed storage.
          return new Response(null, { status: 302, headers: { location: `https://storage.example/${m[1]}` } });
        }
        const s = url.match(/^https:\/\/storage\.example\/(\d+)$/);
        if (s) {
          expect(init?.headers?.Authorization).toBeUndefined(); // the token stays on api.github.com
          const name = Object.keys(ids).find((n) => ids[n] === Number(s[1]))!;
          return new Response(assets[name], { status: 200 });
        }
        return new Response('nope', { status: 404 });
      });
    });

    afterEach(() => fetchSpy.mockRestore());

    it('refuses plainly when the server has no token', async () => {
      await expect(service('').contents()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('returns the sections in reading order from the latest release', async () => {
      const c = await service().contents();
      expect(c.tag).toBe('manual-1');
      expect(c.areas.map((a) => a.id)).toEqual(['students', 'finance']);
    });

    it('serves only files the manifest lists', async () => {
      const s = service();
      expect((await PDFDocument.load(await s.file('TAFSync-Manual.pdf'))).getPageCount()).toBe(9);
      await expect(s.file('not-in-manifest.pdf')).rejects.toBeInstanceOf(NotFoundException);
      await expect(s.file('../manifest.json')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('caches the release and files', async () => {
      const s = service();
      await s.file('TAFSync-Manual.pdf');
      const calls = fetchSpy.mock.calls.length;
      await s.contents();
      await s.file('TAFSync-Manual.pdf');
      expect(fetchSpy.mock.calls.length).toBe(calls);
    });

    it('joins modules in reading order whatever order they were ticked, under a cover and contents, with bookmarks', async () => {
      const { bytes, pages } = await service().combine(['finance/defaulters-report', 'students/quick-registration']);
      expect(pages).toBe(1 + 1 + 2 + 3);
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(7);
      expect(doc.catalog.get(PDFName.of('Outlines'))).toBeDefined();
      expect(doc.getTitle()).toBe('TAFSync Software Manual: 2 selected sections');
    });

    it('rejects a module that is not in the guide', async () => {
      await expect(service().combine(['finance/nope'])).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
