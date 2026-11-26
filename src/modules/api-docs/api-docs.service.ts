import { Injectable, NotFoundException } from '@nestjs/common';
import { existsSync } from 'fs';
import { join } from 'path';
import type { ApiDoc, ApiDocSummary } from './api-docs.types';
import { ATTENDANCE_MACHINES_DOC } from './content/attendance-machines';
import { UBL_DOC } from './content/ubl';

/** Built PDFs live in the repo, which the image copies whole (Dockerfile `COPY . .`). */
export const API_DOCS_PDF_DIR = join(process.cwd(), 'docs', 'api-docs', 'pdf');

export const API_DOCS: readonly ApiDoc[] = [ATTENDANCE_MACHINES_DOC, UBL_DOC];

/**
 * TAFSD-614: the external APIs TAFS runs (attendance machines, UBL), served
 * only to holders of the API Docs tile. Content and PDFs come from the
 * backend rather than the webapp so none of it lands on the public CDN.
 */
@Injectable()
export class ApiDocsService {
  list(): ApiDocSummary[] {
    return API_DOCS.map(({ slug, title, subtitle, version, updated, summary, pdfFile }) => ({
      slug,
      title,
      subtitle,
      version,
      updated,
      summary,
      pdf_available: existsSync(join(API_DOCS_PDF_DIR, pdfFile)),
    }));
  }

  get(slug: string): ApiDoc {
    const doc = API_DOCS.find((d) => d.slug === slug);
    if (!doc) throw new NotFoundException('No such API document');
    return doc;
  }

  pdfPath(slug: string): { path: string; filename: string } {
    const doc = this.get(slug);
    const path = join(API_DOCS_PDF_DIR, doc.pdfFile);
    if (!existsSync(path)) throw new NotFoundException('The PDF for this document has not been built');
    return { path, filename: doc.downloadName };
  }
}
