// Jest stub for @react-pdf/renderer. The real module is ESM-only and can't be
// loaded by ts-jest without extra transforms. Specs that transitively import
// payslip-pdf.service don't exercise rendering — this stub just satisfies the
// import graph.
export const renderToBuffer = async () => Buffer.alloc(0);
export const Document: any = () => null;
export const Page: any = () => null;
export const Text: any = () => null;
export const View: any = () => null;
export const StyleSheet = { create: (s: any) => s };
export const Font = { register: () => undefined };
