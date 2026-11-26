import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { TILES_MANIFEST } from '../access/tiles.manifest';
import { UBL_RESPONSE } from '../ubl/ubl.service';
import { UBL_PAYMENT_METHODS } from '../ubl/dto/ubl-bill.dto';
import { UBL_1BILL_CHARGE_SLABS } from '../../utils/ubl.util';
import { ZK_DEVICES } from '../attendance/zk-device-health.util';
import { API_DOCS_TILE_ID, API_DOCS_VIEW_ACTION } from './api-docs.constants';
import { API_DOCS, API_DOCS_PDF_DIR, ApiDocsService } from './api-docs.service';
import type { ApiDocBlock, ApiDocSection } from './api-docs.types';

/**
 * TAFSD-614. The page reads its tables from the code; the LaTeX sources cannot,
 * so these checks fail when the code moves and the .tex is not updated with it.
 */
const TEX_DIR = join(process.cwd(), 'docs', 'api-docs');
const tex = (slug: string) => readFileSync(join(TEX_DIR, `${slug}.tex`), 'utf8');
const texEscaped = (s: string) => s.replace(/_/g, '\\_');

function allText(sections: ApiDocSection[]): string {
  const block = (b: ApiDocBlock): string => {
    switch (b.type) {
      case 'p':
      case 'note':
        return b.text;
      case 'list':
        return b.items.join('\n');
      case 'table':
        return [...b.head, ...b.rows.flat()].join('\n');
      case 'code':
        return `${b.title ?? ''}\n${b.code}`;
    }
  };
  return sections
    .map((s) => [s.title, ...s.blocks.map(block), allText(s.subsections ?? [])].join('\n'))
    .join('\n');
}

describe('API docs (TAFSD-614)', () => {
  it('registers a default-deny web tile whose view action guards the routes', () => {
    const tile = TILES_MANIFEST.find((t) => t.id === API_DOCS_TILE_ID);
    expect(tile).toBeDefined();
    expect(tile!.surface ?? 'web').toBe('web');
    expect(tile!.legacyFullAccessCapabilities).toBeUndefined();
    expect(tile!.actions?.find((a) => a.default)?.id).toBe(API_DOCS_VIEW_ACTION.split('#')[1]);
  });

  it('has unique slugs and section ids', () => {
    expect(new Set(API_DOCS.map((d) => d.slug)).size).toBe(API_DOCS.length);
    for (const doc of API_DOCS) {
      const ids: string[] = [];
      const walk = (ss: ApiDocSection[]) => ss.forEach((s) => (ids.push(s.id), walk(s.subsections ?? [])));
      walk(doc.sections);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('ships a built PDF and a LaTeX source for every document', () => {
    for (const doc of API_DOCS) {
      expect(existsSync(join(API_DOCS_PDF_DIR, doc.pdfFile))).toBe(true);
      expect(existsSync(join(TEX_DIR, `${doc.slug}.tex`))).toBe(true);
    }
    expect(new ApiDocsService().list().every((d) => d.pdf_available)).toBe(true);
  });

  it('never carries a credential', () => {
    for (const doc of API_DOCS) {
      const text = allText(doc.sections) + tex(doc.slug);
      for (const name of ['UBL_SERVICE_USER_ID', 'UBL_SERVICE_PASSWORD']) {
        const value = process.env[name];
        if (value) expect(text).not.toContain(value);
      }
      expect(text).not.toMatch(/X-UBL-Password:\s*(?!<)[^\s\\]+/);
    }
  });

  describe('the UBL LaTeX matches the code', () => {
    const src = tex('ubl');

    it('lists every response code with its description', () => {
      for (const [code, desc] of Object.values(UBL_RESPONSE)) {
        expect(src).toContain(`\\texttt{${code}} & ${desc}`);
      }
    });

    it('lists every payment method', () => {
      for (const m of UBL_PAYMENT_METHODS) expect(src).toContain(`\\texttt{${texEscaped(m)}}`);
    });

    it('has the 1Bill charge of every slab', () => {
      for (const s of UBL_1BILL_CHARGE_SLABS) expect(src).toContain(`\\textbf{${s.charge}}`);
    });
  });

  it('the attendance LaTeX lists every known device', () => {
    const src = tex('attendance-machines');
    for (const sn of Object.keys(ZK_DEVICES)) expect(src).toContain(sn);
  });
});
