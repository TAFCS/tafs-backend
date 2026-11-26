/**
 * TAFSD-614: shape of an API document served to the API Docs tile.
 *
 * Text fields support two inline marks, rendered by the webapp: `code` in
 * backticks and **bold** in double asterisks. Nothing else is interpreted, so
 * content can never inject markup into the page.
 */
export type ApiDocBlock =
  | { type: 'p'; text: string }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'code'; title?: string; code: string }
  | { type: 'note'; tone: 'info' | 'warn'; text: string };

export interface ApiDocSection {
  id: string;
  title: string;
  blocks: ApiDocBlock[];
  subsections?: ApiDocSection[];
}

export interface ApiDoc {
  slug: string;
  title: string;
  subtitle: string;
  version: string;
  /** YYYY-MM-DD the content was last checked against the code. */
  updated: string;
  summary: string;
  /** Built PDF: docs/api-docs/pdf/<slug>.pdf, from docs/api-docs/<slug>.tex. */
  pdfFile: string;
  /** File name the browser saves the PDF as. */
  downloadName: string;
  sections: ApiDocSection[];
}

export type ApiDocSummary = Pick<ApiDoc, 'slug' | 'title' | 'subtitle' | 'version' | 'updated' | 'summary'> & {
  pdf_available: boolean;
};
