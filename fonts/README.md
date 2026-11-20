# Fonts

`Stencil.ttf` (or `Stencil.otf`) goes here. TAFSD-528 sets the school name and the
title of admit cards and statements of entry in Stencil; `ExamDocumentPDF.tsx`
registers the file when it is present and falls back to Times Bold when it is not.

Stencil is a commercial font (Microsoft Office / Adobe) and is not on npm, so the
school's licensed copy is committed here. The Dockerfile's `COPY . .` ships it.
