// ID cards (TAFSD-518): stamps student, parent and staff details onto the school's own
// card artwork, the way the leaving certificate is stamped onto slc-formats/*.pdf.
//
// The blanks in id-card-formats/ are the school's CorelDRAW cards with the sample
// person taken out (scripts/id-cards/build-blanks.py). layout.json says, for every
// face, where each value goes: its underline (or centre line), baseline, size and
// colour, all measured off the school's own files. Nothing here is placed by eye.
//
// Three categories, released separately:
//   students  pre-primary (NNN, GKF, Campus III), junior, senior, O level, secondary, A level
//   parents   parent / guardian card, one per campus
//   staff     administration, faculty
//
// Usage (from tafs-backend/):
//   node scripts/id-cards/id-cards.cjs <outDir>          sample releases from made-up people
// As a module:
//   const { renderCards } = require('./scripts/id-cards/id-cards.cjs')
//   await renderCards('senior-cambridge-jauhar', people, { layout: 'sheet' | 'cards' })
'use strict';

const fs = require('fs');
const path = require('path');
const {
  PDFDocument, StandardFonts, rgb,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, rectangle, clip, endPath,
} = require('pdf-lib');

const FORMATS_DIR = path.join(__dirname, '..', '..', 'id-card-formats');

/** House and frame colour, read off the school's four frames. */
const HOUSES = {
  'SIR SYED': { colour: 'YELLOW', frame: '#ffcb03' },
  JINNAH: { colour: 'BLUE', frame: '#2e3092' },
  LIAQUAT: { colour: 'GREEN', frame: '#00a650' },
  IQBAL: { colour: 'RED', frame: '#ed1c24' },
};

/** Which category each format belongs to, in release order. */
const CATEGORIES = {
  students: {
    title: 'Student cards',
    formats: ['pre-primary-nnn', 'pre-primary-gkf', 'pre-primary-jauhar', 'junior-cambridge-jauhar',
      'senior-cambridge-jauhar', 'o-level-jauhar', 'secondary-jauhar', 'a-level-jauhar'],
  },
  parents: { title: 'Parent cards', formats: ['parent-kaneez-fatima', 'parent-north-nazimabad', 'parent-jauhar'] },
  staff: { title: 'Staff cards', formats: ['staff-administration', 'staff-faculty-jauhar'] },
};

const FORMAT_TITLES = {
  'pre-primary-nnn': 'Pre-Primary, North Nazimabad (B.U.I)',
  'pre-primary-gkf': 'Pre-Primary, Gulshan-e-Kaneez Fatima (Campus VII)',
  'pre-primary-jauhar': 'Pre-Primary, Gulistan-e-Jauhar (Campus III)',
  'junior-cambridge-jauhar': 'Junior Cambridge, Campus III',
  'senior-cambridge-jauhar': 'Senior Cambridge, Campus II',
  'o-level-jauhar': 'O Level',
  'secondary-jauhar': 'Secondary (TAFSS), Campus II',
  'a-level-jauhar': 'A Level (TAFSAL)',
  'parent-kaneez-fatima': 'Parent / guardian, Kaneez Fatima',
  'parent-north-nazimabad': 'Parent / guardian, North Nazimabad',
  'parent-jauhar': 'Parent / guardian, Gulistan-e-Jauhar',
  'staff-administration': 'Staff, Administration',
  'staff-faculty-jauhar': 'Staff, Faculty (Campus III)',
};

const DASH = '-';

function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function loadLayout(dir = FORMATS_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8'));
}

// ---------------------------------------------------------------- values per format

/** The text that goes in each field, from one person's details. Empty values print "-", as the school's cards do. */
function fieldValues(format, p) {
  const up = (v) => (v == null || String(v).trim() === '' ? DASH : String(v).trim().toUpperCase());
  const keep = (v) => (v == null || String(v).trim() === '' ? DASH : String(v).trim());
  const house = p.house ? String(p.house).toUpperCase() : null;
  const common = {
    father: up(p.fatherName),
    address: up(p.address),
    residence: up(p.residencePhone),
    cellular: up(p.cellPhone),
    contact: up(p.contactPhone),
    nearest: up(p.nearestPhone),
    house: up(house),
    colour: house && HOUSES[house] ? HOUSES[house].colour : DASH,
    issueDate: up(p.issueDate),
    validUpto: up(p.validUpto),
  };
  if (format.startsWith('parent-')) {
    return {
      childName: up(p.studentName), level: up(p.level), section: up(p.section), gr: up(p.gr),
      issueDate: common.issueDate, validUpto: common.validUpto,
    };
  }
  if (format.startsWith('staff-')) {
    return {
      name: up(p.name), designation: up(p.designation),
      cnic: `CNIC # ${keep(p.cnic)}`, employeeNo: `EMPLOYEE # ${keep(p.employeeNo)}`,
      relationLabel: p.relation === 'husband' ? 'HUSBAND’S NAME :' : 'FATHER’S NAME :',
      relation: up(p.relationName), joiningDate: up(p.joiningDate),
      address: up(p.addressLine1), addressLine2: p.addressLine2 ? up(p.addressLine2) : '',
      residence: common.residence, mobile: up(p.mobilePhone), nearest: common.nearest,
      issueDate: common.issueDate, validUpto: common.validUpto,
    };
  }
  if (format === 'a-level-jauhar') {
    return {
      ...common,
      name: up(p.name), levelLine: `LEVEL : ${up(p.level)} SECTION : ${up(p.section)}`, gr: `G.R. # ${keep(p.gr)}`,
      email: p.email ? String(p.email).trim().toLowerCase() : DASH, group: up(p.group),
    };
  }
  return { ...common, name: up(p.name), classLine: up(p.classLine), gr: `GR. # ${keep(p.gr)}` };
}

// ---------------------------------------------------------------- drawing

/**
 * Writes `text` centred in the field's box on its measured baseline, in the measured
 * size and colour, shrinking (then narrowing) only as much as a long value needs.
 * The school's names and class lines are Calibri Bold and everything else Arial Bold;
 * Helvetica Bold is Arial's metric twin, and narrowed to 90% it stands in for Calibri.
 */
function drawField(page, font, field, text, ox, oy, faceH) {
  if (!text) return;
  const boxW = field.x1 - field.x0;
  const squeezeBase = field.font === 'calibri' ? 0.9 : 1;
  let size = field.size;
  let squeeze = squeezeBase;
  const widthAt = (s, q) => font.widthOfTextAtSize(text, s) * q;
  while (widthAt(size, squeeze) > boxW && size > field.size * 0.72) size -= 0.1;
  while (widthAt(size, squeeze) > boxW && squeeze > squeezeBase * 0.72) squeeze -= 0.01;
  const w = widthAt(size, squeeze);
  // Centred on the measured centre (the underline's middle, or under the photo),
  // moved only as far as needed to stay inside the box.
  const cx = field.cx != null ? field.cx : (field.x0 + field.x1) / 2;
  const x = ox + Math.min(Math.max(cx - w / 2, field.x0), field.x1 - w);
  const y = oy + faceH - field.base;
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(squeeze, 0, 0, 1, x, y));
  page.drawText(text, { x: 0, y: 0, size, font, color: hex(field.color) });
  page.pushOperators(popGraphicsState());
}

function drawLabel(page, font, field, text, ox, oy, faceH) {
  page.drawText(text, { x: ox + field.x, y: oy + faceH - field.base, size: field.size, font, color: hex(field.color) });
}

/** A neutral head-and-shoulders placeholder where no photo is supplied. */
function drawPhotoPlaceholder(page, r, ox, oy, faceH) {
  const x = ox + r.x0;
  const y = oy + faceH - r.y1;
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  page.drawRectangle({ x, y, width: w, height: h, color: rgb(0.93, 0.94, 0.95) });
  const cx = x + w / 2;
  const tone = rgb(0.76, 0.78, 0.82);
  page.drawCircle({ x: cx, y: y + h * 0.6, size: Math.min(w, h) * 0.19, color: tone });
  // Shoulders: the top of an ellipse sitting on the bottom edge, clipped to the box.
  page.pushOperators(pushGraphicsState(), rectangle(x, y, w, h), clip(), endPath());
  page.drawEllipse({ x: cx, y, xScale: w * 0.4, yScale: h * 0.34, color: tone });
  page.pushOperators(popGraphicsState());
}

async function drawPhoto(doc, page, r, photoPath, ox, oy, faceH) {
  const bytes = fs.readFileSync(photoPath);
  const img = /\.png$/i.test(photoPath) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const x = ox + r.x0;
  const y = oy + faceH - r.y1;
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const scale = Math.max(w / img.width, h / img.height);
  const iw = img.width * scale;
  const ih = img.height * scale;
  page.pushOperators(pushGraphicsState(), rectangle(x, y, w, h), clip(), endPath());
  page.drawImage(img, { x: x + (w - iw) / 2, y: y + (h - ih) / 2, width: iw, height: ih });
  page.pushOperators(popGraphicsState());
}

/** Draws one face (front or back) of one card with its lower-left corner at (ox, oy). */
async function drawFace(doc, page, ctx, format, side, person, ox, oy) {
  const face = ctx.layout[format][side];
  const embedded = ctx.blanks[format][side === 'front' ? 0 : 1];
  page.drawPage(embedded, { x: ox, y: oy, width: face.width, height: face.height });
  const values = fieldValues(format, person);
  const H = face.height;

  if (side === 'front' && face.photo) {
    if (person.photo) await drawPhoto(doc, page, face.photo, person.photo, ox, oy, H);
    else drawPhotoPlaceholder(page, face.photo, ox, oy, H);
  }
  if (side === 'front' && face.frame) {
    const house = person.house && HOUSES[String(person.house).toUpperCase()];
    const f = face.frame;
    // Over the A Level artwork the old frame is painted in; cover it fully.
    const width = f.over_artwork ? f.width + 0.9 : f.width;
    page.drawRectangle({
      x: ox + f.x0, y: oy + H - f.y1, width: f.x1 - f.x0, height: f.y1 - f.y0,
      borderColor: hex(house ? house.frame : '#221e1f'), borderWidth: width,
    });
  }
  for (const [key, field] of Object.entries(face.fields)) {
    if (key.endsWith('Label')) {
      const text = values[key];
      if (text) drawLabel(page, ctx.font, field, text, ox, oy, H);
      continue;
    }
    drawField(page, ctx.font, field, values[key], ox, oy, H);
  }
}

async function context(doc, formats, dir) {
  const layout = loadLayout(dir);
  const blanks = {};
  for (const f of formats) {
    if (!layout[f]) throw new Error(`Unknown ID card format: ${f}`);
    const bytes = fs.readFileSync(path.join(dir, `${f}.pdf`));
    blanks[f] = await doc.embedPdf(bytes, [0, 1]);
  }
  return { layout, blanks, font: await doc.embedFont(StandardFonts.HelveticaBold) };
}

// ---------------------------------------------------------------- page layouts

const A4 = { w: 595.28, h: 841.89 };

/**
 * A4 proof sheets laid out like the school's own: each card's front beside its back.
 * Landscape cards: 4 per portrait sheet. Portrait cards: 2 per landscape sheet row, 4 per sheet.
 */
async function addSheets(doc, ctx, format, people, heading) {
  const face = ctx.layout[format].front;
  const portrait = face.height > face.width;
  const pageW = portrait ? A4.h : A4.w;
  const pageH = portrait ? A4.w : A4.h;
  const gap = 10;
  const perRow = portrait ? 2 : 1;
  const rows = portrait ? 2 : 4;
  const pairW = face.width * 2 + gap;
  const gridW = perRow * pairW + (perRow - 1) * gap * 3;
  const gridH = rows * face.height + (rows - 1) * gap * 1.6;
  const left = (pageW - gridW) / 2;
  const top = (pageH - gridH) / 2 + 8;
  for (let i = 0; i < people.length; i += perRow * rows) {
    const page = doc.addPage([pageW, pageH]);
    if (heading) {
      page.drawText(heading, { x: left, y: pageH - 26, size: 9, font: ctx.font, color: rgb(0.35, 0.35, 0.35) });
    }
    const chunk = people.slice(i, i + perRow * rows);
    for (let j = 0; j < chunk.length; j++) {
      const row = Math.floor(j / perRow);
      const col = j % perRow;
      const x = left + col * (pairW + gap * 3);
      const y = pageH - top - (row + 1) * face.height - row * gap * 1.6;
      await drawFace(doc, page, ctx, format, 'front', chunk[j], x, y);
      await drawFace(doc, page, ctx, format, 'back', chunk[j], x + face.width + gap, y);
      for (const dx of [0, face.width + gap]) {
        page.drawRectangle({
          x: x + dx, y, width: face.width, height: face.height,
          borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.3,
        });
      }
    }
  }
}

/** Card-sized pages, front then back, for a duplex card printer. */
async function addCardPages(doc, ctx, format, people) {
  const face = ctx.layout[format].front;
  for (const p of people) {
    for (const side of ['front', 'back']) {
      const page = doc.addPage([face.width, face.height]);
      await drawFace(doc, page, ctx, format, side, p, 0, 0);
    }
  }
}

/**
 * Renders cards for one or more formats.
 * @param jobs   [{ format, people: [...] }]
 * @param opts   { layout: 'sheet' | 'cards', dir, headings: boolean }
 */
async function renderJobs(jobs, opts = {}) {
  const doc = await PDFDocument.create();
  const ctx = await context(doc, [...new Set(jobs.map((j) => j.format))], opts.dir || FORMATS_DIR);
  for (const job of jobs) {
    if (opts.layout === 'cards') await addCardPages(doc, ctx, job.format, job.people);
    else await addSheets(doc, ctx, job.format, job.people, opts.headings === false ? null : job.heading);
  }
  doc.setTitle(opts.title || 'ID cards');
  doc.setCreator('TAFS');
  return doc.save();
}

async function renderCards(format, people, opts = {}) {
  return renderJobs([{ format, people }], opts);
}

module.exports = { renderCards, renderJobs, fieldValues, HOUSES, CATEGORIES, FORMAT_TITLES, loadLayout };

// ---------------------------------------------------------------- samples

if (require.main === module) {
  (async () => {
    const out = process.argv[2] || path.join(process.cwd(), 'id-card-samples');
    const samples = require('./sample-people.cjs');
    let n = 1;
    for (const [cat, def] of Object.entries(CATEGORIES)) {
      const dir = path.join(out, `${n++} - ${def.title}`);
      fs.mkdirSync(dir, { recursive: true });
      const jobs = def.formats.map((f) => ({ format: f, people: samples[f], heading: `${FORMAT_TITLES[f]} — sample` }));
      fs.writeFileSync(path.join(dir, `${def.title} - samples (A4 sheets).pdf`),
        await renderJobs(jobs, { layout: 'sheet', title: `${def.title} — samples` }));
      fs.writeFileSync(path.join(dir, `${def.title} - print file (card size, front then back).pdf`),
        await renderJobs(jobs, { layout: 'cards', title: `${def.title} — print file` }));
      for (const f of def.formats) {
        fs.writeFileSync(path.join(dir, `${FORMAT_TITLES[f].replace(/[\/:]/g, '-')}.pdf`),
          await renderJobs([{ format: f, people: samples[f], heading: `${FORMAT_TITLES[f]} — sample` }],
            { layout: 'sheet', title: FORMAT_TITLES[f] }));
      }
      console.log(`${def.title}: ${def.formats.length} formats -> ${dir}`);
    }
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
