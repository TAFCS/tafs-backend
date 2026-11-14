# ID card formats (TAFSD-518)

The school's own ID card artwork, one blank per format. Each PDF has two card-sized pages,
front then back, with the sample person taken out. `scripts/id-cards/id-cards.cjs` stamps
real details onto them, the way the leaving certificate is stamped onto `slc-formats/`.

| Format | Category | Source sheet |
|---|---|---|
| `pre-primary-nnn` | students | PRIMARY NNN CARD 2026 - 2027 |
| `pre-primary-gkf` | students | PRIMARY GKF CARD 2026 - 2027 |
| `pre-primary-jauhar` | students | PRIMARY CARD 2026 - 2027 (.cdr only): GKF artwork with "CAMPUS - III" in Cooper, Jauhar back |
| `junior-cambridge-jauhar` | students | ID CARD FORMAT |
| `senior-cambridge-jauhar` | students | SENIOR CARD 2026 - 2027 |
| `o-level-jauhar` | students | O LEVEL CARD 2026 - 2027 (.cdr only): NNN artwork with "O - LEVEL SECTION" / "TAFSAL" in Cooper, Senior back |
| `secondary-jauhar` | students | SECONDARY CARD 2026 - 2027 |
| `a-level-jauhar` | students | TAFSAL CARD FORMAT 2026 |
| `parent-kaneez-fatima`, `parent-north-nazimabad`, `parent-jauhar` | parents | PARENTS CARD |
| `staff-administration`, `staff-faculty-jauhar` | staff | ID CARD ADMIN FACULTY FORMAT |

`layout.json` gives each field's box (its underline, or the centre line under the photo),
baseline, size and colour, measured off the school's files, plus the photo box and house
frame. Coordinates are points from the card's top-left corner, y down.

## Rebuilding

When the school sends new artwork, rebuild rather than nudging numbers:

```
pip install pymupdf fonttools
python3 scripts/id-cards/build-blanks.py <folder with the school's PDFs> id-card-formats
```

The script removes everything outside the card and every sample value, photo and hidden
leftover, so no real person's details travel inside a blank. Check its "text left" output:
only the card's own printed wording should remain.

## Samples

```
node scripts/id-cards/id-cards.cjs <outDir>
```

Writes one folder per category (students, parents, staff) with an A4 proof sheet, a
card-size print file (front then back, for a duplex card printer) and one PDF per format,
all from the made-up people in `scripts/id-cards/sample-people.cjs`.
