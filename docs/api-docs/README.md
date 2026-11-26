# API docs (TAFSD-614)

Internal documentation of the external APIs TAFS runs, shown on the web
dashboard's **API Docs** tile (`system.api_docs`, granted per person in People &
Access) and downloadable there as A4 PDFs.

| Document | Page content | PDF source | Built PDF |
|---|---|---|---|
| Attendance machines (ZKTeco ADMS / iclock) | `src/modules/api-docs/content/attendance-machines.ts` | `attendance-machines.tex` | `pdf/attendance-machines.pdf` |
| UBL bill inquiry / payment | `src/modules/api-docs/content/ubl.ts` | `ubl.tex` | `pdf/ubl.pdf` |

The page and the PDF are written separately, so **change both together** and
rebuild with `make` (Tectonic). `npm test -- api-docs` fails when a UBL response
code, payment method or 1Bill slab, or a device in `ZK_DEVICES`, is missing from
the LaTeX. The page's own tables are read straight from those constants.

Never put credentials here. Show placeholders such as `<issued by TAFS>`. The
UBL documents sent to the bank live in `docs/ubl-api`; this set is the internal
reference and records where the code has moved on from them.
