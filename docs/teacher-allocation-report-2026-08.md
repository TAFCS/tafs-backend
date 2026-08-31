# Teacher Allocation Report — Aug 2026

## Executive summary

Teacher class/section mappings, job descriptions, and segment IDs were applied from the Aug 2026 allocation lists across **Johar (GEJ)**, **GKF**, and **North Nazimabad (NNN)**.

| Metric | Count |
|--------|------:|
| Employees updated | 61 |
| New employees created | 6 |
| Total teachers in allocation run | 68 |
| Skipped (by design) | 2 categories |

**Script:** [`scripts/apply-teacher-allocation-2026.ts`](../scripts/apply-teacher-allocation-2026.ts)  
**Overrides synced:** [`scripts/staff-class-section-overrides.ts`](../scripts/staff-class-section-overrides.ts)

---

## What was updated per employee

For each matched teacher:

- `job_title` — normalized role label
- `job_description` — verbatim from allocation lists
- `segment_id` — where a single clear segment applied
- `employee_class_section_assignments` — replaced entirely (delete + insert)

**Convention:** Subject teachers received all sections (A–D for Junior bands, A–C elsewhere) for each listed class. Home teachers received a single section (e.g. Jr I A → class JRI, section A).

### Class / section ID reference

| Class code | ID | Segment |
|------------|-----|---------|
| PN, NUR, KG | 1–3 | Pre-Primary |
| JRI – JRV | 4–8 | Junior Cambridge |
| SRI – SRIII | 9–11 | Senior Cambridge |
| OI – OII | 12–13 | O-Levels |
| VI – X | 15–19 | Secondary |

Sections: A=1, B=2, C=3, D=4

---

## New employees created

| Code | Name | Campus | Job description | Assignment pairs |
|------|------|--------|-----------------|-----------------:|
| GEJ-02-001514 | AMARA | Johar | Maths Jr III A–C & Jr IV C; Computer Jr V A–C | 7 |
| GEJ-02-001515 | MINAAHIL | Johar | Maths Jr IV A–B; Jr V A–C | 5 |
| GEJ-02-001516 | AKSA | Johar | English Literature Jr III–V; Islamiat Jr IV A–C | 12 |
| GEJ-02-001517 | ANNA MAKRAM | Johar | Sports Jr I–V | 20 |
| GEJ-02-001518 | SHARIQ | Johar | Robotics | 0 (JD only) |
| GKF-02-00021 | BARIRA | GKF | Pre-Nursery assistant | 3 |

---

## Johar — Secondary (VI–X)

| Teacher | Code | Assignment summary |
|---------|------|-------------------|
| Ms. Zahida | GEJ-02-00644 | Urdu VI–VII; Sindhi VI–VIII & X |
| Ms. Marukh | GEJ-02-001138 | Science VI–VIII; SST VII; PST VIII & X |
| Ms. Faiza | GEJ-02-001359 | Computer VI–X |
| Ms. Ghania | GEJ-02-001487 | Maths VI–X |
| Ms. Isbah | GEJ-02-001506 | English VI–X |
| Sir Abdullah | GEJ-02-001388 | Biology / Chemistry / Physics IX–X |
| Ms. Farheen | GEJ-02-001339 | Islamiat VI–IX |
| Zohair Inayat | GEJ-05-00031 | Gym & Band VIII–IX |
| Ms. Iqra Kashif | GEJ-02-001503 | Urdu Sr I + Secondary VII–VIII |

---

## Johar — Junior I & II (home + subject)

| Teacher | Code | Role |
|---------|------|------|
| Ms. Amna Shahzadi | GEJ-02-001405 | Home teacher Jr I **A** |
| Ms. Sidra Asif | GEJ-02-001491 | Home teacher Jr I **B** |
| Ms. Umama | GEJ-02-001439 | Home teacher Jr I **C** |
| Ms. Manahil Gul | GEJ-02-001497 | Home teacher Jr I **D** |
| Ms. Wajiha Zehra | GEJ-02-001496 | Home teacher Jr II **A** |
| Ms. Nadia Sulaiman | GEJ-02-001414 | Home teacher Jr II **B** |
| Ms. Kainat Wilson | GEJ-02-001406 | Home teacher Jr II **C** |
| Ms. Manahil Ali | GEJ-02-001512 | Home teacher Jr II **D** |
| Ms. Shabana | GEJ-02-001197 | Urdu Jr I (all sections) |
| Ms. Madiha | GEJ-02-001355 | Urdu Jr II (all sections) |
| Ms. Wajiha Fatima | GEJ-02-001486 | Computer Jr I & II |

---

## Johar — Junior III–V + PDF allocations

| Teacher | Code | Role |
|---------|------|------|
| Ms. Avesha | GEJ-02-001424 | English Jr III |
| Ms. Nabiha | GEJ-02-001352 | English Jr IV; Islamiat Jr V B |
| Ms. Naila | GEJ-02-001420 | English Jr V |
| Ms. Sadia Sami | GEJ-02-001248 | Science Jr III–V |
| Ms. Lubna | GEJ-02-001219 | Urdu Jr III |
| Ms. Sahar | GEJ-02-001383 | Urdu Jr IV |
| Ms. Shaista | GEJ-02-001407 | Urdu Jr V |
| Ms. Asma Naz | GEJ-02-001365 | Arts Jr I–V |
| Ms. Ammara Hassan | GEJ-02-001337 | Computer Jr I–IV |
| Ms. Amara | GEJ-02-001514 | Maths Jr III/IV; Computer Jr V *(new)* |
| Ms. Minaahil | GEJ-02-001515 | Maths Jr IV & V *(new)* |
| Ms. Aksa | GEJ-02-001516 | English Lit Jr III–V *(new)* |
| Ms. Anmol | GEJ-02-001500 | SST Jr III–V |
| Anna Makram | GEJ-02-001517 | Sports Jr I–V *(new)* |
| Sir Shariq | GEJ-02-001518 | Robotics — no class-section *(new)* |
| Sir Zafar Baloch | GEJ-02-001507 | Taekwondo Jr I–V |
| Mr. Habib-uddin | GEJ-02-001375 | Scouts Jr I–V |
| Ms. Ghazala | GEJ-02-001376 | Scouts Jr I–V |

---

## Johar — Seniors (Sr I – O-II)

| Teacher | Code | Role |
|---------|------|------|
| Ms. Hina | GEJ-02-001505 | English Sr I–II |
| Ms. Sabika | GEJ-02-001338 | English Sr III – O-II |
| Ms. Iqra Kashif | GEJ-02-001503 | Urdu Sr I + Secondary VII–VIII |
| Ms. Anjum | GEJ-02-0593 | Urdu Sr II A,C + Sr III *(O-block deferred)* |
| Ms. Saba | GEJ-02-001427 | Maths Sr I & II |
| Ms. Sarah Kausar | GEJ-02-0635 | Maths Sr III – O-II |
| Ms. Bushra | GEJ-02-001348 | Biology Sr I–III + O-I/O-II |
| Ms. Uzma | GEJ-02-001502 | Chemistry Sr I–III |
| Ms. Reena | GEJ-02-001475 | Physics Sr I–III |
| Ms. Fatima | GEJ-02-001271 | History / Geo / Islamiat Sr I–III |
| Ms. Sheeren | GEJ-02-001435 | History / Geo Sr I & III |
| Mr. Moin | GEJ-02-001494 | Computer Sr I – O-II |

---

## GKF (Kaneez Fatima)

| Teacher | Code | Role |
|---------|------|------|
| Ms. Rubab | GKF-02-00019 | Pre-Nursery lead |
| Ms. Barira | GKF-02-00021 | Pre-Nursery assistant *(new)* |
| Ms. Asbha | GKF-02-00020 | Nursery A |
| Ms. Maham | GKF-02-00025 | Nursery B lead |
| Ms. Alishba | GKF-02-00010 | Nursery B assistant |
| Ms. Ambreen | GKF-02-00011 | KG |
| Ms. Saira | GKF-02-00023 | Junior I |
| Ms. Maharuk | GKF-02-00027 | Junior II |
| Ms. Atiqa | GKF-02-00018 | Jr III + English III & IV |
| Ms. Sana | GKF-02-00015 | Jr IV + SST / Science / Computer III & IV |
| Ms. Nadia Jarrar | GKF-02-00028 | Urdu Jr I–IV |

---

## North Nazimabad (NNN)

| Teacher | Code | Role |
|---------|------|------|
| Ms. Aiman | NNN-02-0067 | Pre-Nur & Nursery |
| Ms. Samreen | NNN-02-0071 | KG |
| Ms. Mehak | NNN-02-0066 | Junior I |
| Ms. Fozia | NNN-02-0055 | Junior II |
| Ms. Javeria | NNN-02-0070 | Maths / Urdu / SST Jr III–V |
| Ms. Maryam | NNN-02-0072 | English Jr III–V |
| Ms. Muqaddas | NNN-02-0053 | Science / Urdu / Islamiat Jr III–V |
| Computer Teacher | — | **Skipped** — “To be hired” |

---

## Intentionally skipped / deferred

| Item | Reason |
|------|--------|
| NNN Computer Teacher | Vacant role — no employee to map |
| Ms. Anjum — O-I/O-II one block | Block-level timetable detail; class-section only has Sr II A,C + Sr III |
| Ms. Anjum — O-I/O-II one block | Block-level timetable detail; class-section only has Sr II A,C + Sr III |
| Duplicate “Manahil Jr II D” | Resolved: **Manahil Gul** (001497) = Jr I D; **Manahil Ali** (001512) = Jr II D |

### Bushra / Uzma — Islamiat Sr I section split (**applied** in teaching groups)

**Allocation rule**

| Teacher | Primary subject (Class & Sections — full bands) | Islamiat (teaching group — section roster) |
|---------|---------------------------------------------------|---------------------------------------------|
| Ms. Uzma (`GEJ-02-001502`) | Chemistry Sr I–III, all sections A–C | Islamiat **Sr I A only** |
| Ms. Bushra (`GEJ-02-001348`) | Biology Sr I–III + O-I/O-II, all sections A–C | Islamiat **Sr I B & C only** |

**Applied 31 Aug 2026** via [`scripts/seed-sr-islamiat-split-2026.ts`](../scripts/seed-sr-islamiat-split-2026.ts):

| Teaching group | ID | Label | Enrolled students |
|----------------|---:|-------|------------------:|
| Uzma / ISLAMIYAT / SRI | 90 | Sr I A — Islamiat | 33 (section A) |
| Bushra / ISLAMIYAT / SRI | 91 | Sr I B & C — Islamiat | 65 (sections B + C) |

Each group has a group-scoped timetable shell for `2026-2027` (slots still to be filled in Timetables UI).

**Why Class & Sections was left as full bands**

HR Class & Sections has no subject column — it correctly shows Bio/Chem coverage across all sections. The Islamiat split lives in **`teaching_groups` + `student_subject_enrollments`**, which is what drives subject-specific rosters and parent schedules.

**Still pending:** Islamiat **timetable slots** (day/block) on groups #90 and #91 once the weekly schedule is confirmed.

**Related (not yet done):** Ms. Fatima and Ms. Sheeren have similar section-specific History splits (Sr I A vs B/C) — same pattern, needs teaching groups once HISTORY/GEOGRAPHY Cambridge subjects exist in the DB.
---

## Not changed / left alone

These employees exist in HR but were **not** remapped (different roles or not on the confirmed list):

- SUNDUS FATIMA (GEJ-02-001490)
- SIDRA FAROOQ (GEJ-02-001492)
- AYESHA KHAN (GEJ-02-001493)
- MUSKAN ZEESHAN (GEJ-02-001501)
- FARIDA SALEEM (GEJ-02-001488)
- MUHAMMAD RASHID QURESHI (GEJ-02-00983) — existing Taekwondo coach alongside Zafar Baloch

---

## DB name ↔ code corrections

Many teachers were already in HR under codes 001486–001519. The script matched live DB records rather than assuming blank codes:

| Allocation list name | Matched DB record | Code |
|---------------------|-------------------|------|
| Ms. Ghania | GHANIA KHALID | GEJ-02-001487 |
| Ms. Isbah | ISBAH SYED | GEJ-02-001506 |
| Ms. Iqra Kashif | IQRA KASHIF | GEJ-02-001503 |
| Ms. Sidra Asif | SIDRA ASIF | GEJ-02-001491 |
| Ms. Manahil (Jr I D) | MANAHIL GUL | GEJ-02-001497 |
| Ms. Manahil (Jr II D) | MANAHIL ALI | GEJ-02-001512 |
| Ms. Wajiha Zehra | SYEDA WAJIHA ZEHRA | GEJ-02-001496 |
| Ms. Wajiha Fatima | SYEDA WAJIHA FATIMA HAIDER | GEJ-02-001486 |
| Ms. Hina | HINA MURTAZA | GEJ-02-001505 |
| Ms. Uzma | UZMA MATEEN | GEJ-02-001502 |
| Mr. Moin | MOIN ASIM | GEJ-02-001494 |
| Sir Zafar | ZAFAR BALOCH | GEJ-02-001507 |
| GKF Maham | MAHAM ASLAM SIDDIQUI | GKF-02-00025 |
| GKF Maharuk | MAHRUKH SHAFI | GKF-02-00027 |
| GKF Nadia Jarrar | NADIA JARRAR | GKF-02-00028 |

---

## Technical notes

1. **Re-import safety:** Overrides in `staff-class-section-overrides.ts` preserve assignments if HR CSV is re-imported.
2. **Out of scope (initial run):** `teaching_groups` / `timetable_slots` for most teachers — except Islamiat Sr I split (groups #90–#91, see seed script).
3. **Portal accounts:** The allocation script does not create login credentials for new employees.

### Re-run commands

```bash
# Preview changes (default)
npx ts-node scripts/apply-teacher-allocation-2026.ts

# Apply to database
DRY_RUN=false npx ts-node scripts/apply-teacher-allocation-2026.ts

# Islamiat Sr I section split (teaching groups)
DRY_RUN=false npx ts-node scripts/seed-sr-islamiat-split-2026.ts
```

---

## Recommended follow-ups

1. Spot-check teachers in **HR → Employee Directory → Class & Sections** (especially home teachers with single-section assignments).
2. Create portal accounts for the **7 new employees** if needed.
3. Add **timetable slots** for Islamiat groups #90–#91 (Uzma/Bushra) and Anjum’s O-level block when schedule is confirmed.
4. Hire and map **NNN Computer Teacher** when confirmed.

---

*Generated: 31 Aug 2026*
