"""
ID card blanks (TAFSD-518).

Turns the school's own CorelDRAW-exported ID card sheets into one clean, card-sized
blank per format (page 1 = front, page 2 = back) plus a layout file that says where
every value goes. The generator (scripts/id-cards/id-cards.cjs) stamps student,
parent or staff details onto these blanks, the same way the leaving certificate is
stamped onto slc-formats/*.pdf.

What it does to each face, starting from the first card on the school's sheet:
  1. Removes everything outside the card, so no other student's details, photo or
     text travel inside the blank.
  2. Removes the sample person's details (name, class, G.R., phones, dates...) and
     records each one's position, size and colour: those positions are the layout.
  3. Removes the coloured house frame round the photo (the generator draws it in the
     right house colour) and any sample photo.
  4. Removes text the designer left hidden under the artwork.
  5. Crops the face to the card outline, keeping the artwork as vectors.

Two formats exist only as CorelDRAW files, with no PDF export. They are composed from
the PDFs of their sister formats, with the headings drawn in the school's own Cooper
glyphs (taken from the PDFs' embedded font outlines):
  - Pre-Primary, Campus III (Gulistan-e-Jauhar): the GKF card with "CAMPUS - III".
  - O Level: the NNN card with "O - LEVEL SECTION" over "TAFSAL", as the .cdr reads.

Usage:
  python3 scripts/id-cards/build-blanks.py <dir with the school PDFs> [<out dir>]
Needs PyMuPDF and fontTools (pip install pymupdf fonttools). The school PDFs are
expected under their own names (SENIOR_CARD.pdf, PARENTS_CARD.pdf, ...).
Writes <out>/<format>.pdf, <out>/layout.json and <out>/preview/<format>.png.
"""
import json
import os
import sys

import pymupdf
from fontTools.cffLib import CFFFontSet
from fontTools.misc.psCharStrings import T2WidthExtractor
from fontTools.pens.basePen import BasePen

SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.getcwd(), "id-card-formats")
os.makedirs(os.path.join(OUT, "preview"), exist_ok=True)

# ---------------------------------------------------------------- formats

# Card faces on the school's sheets: approximate top-left corners; the exact outline
# is found from the sheet's own card border.
FORMATS = {
    # --- Students: landscape cards in the four house colours.
    "pre-primary-nnn": dict(category="students", src="PRIMARY_NNN_CARD", front=(50, 90), back=(307, 90),
                            front_fields=["name", "classLine", "gr"]),
    "pre-primary-gkf": dict(category="students", src="PRIMARY_GKF_CARD", front=(50, 83), back=(307, 83),
                            front_fields=["name", "classLine", "gr"]),
    "pre-primary-jauhar": dict(category="students", src="PRIMARY_GKF_CARD", front=(50, 83),
                               back_src="ID_CARD_FORMAT", back=(311, 60),
                               front_fields=["name", "classLine", "gr"],
                               compose="campus-iii"),
    "junior-cambridge-jauhar": dict(category="students", src="ID_CARD_FORMAT", front=(54, 60), back=(311, 60),
                                    front_fields=["name", "classLine", "gr"]),
    "senior-cambridge-jauhar": dict(category="students", src="SENIOR_CARD", front=(44, 99), back=(301, 99),
                                    front_fields=["name", "classLine", "gr"]),
    "o-level-jauhar": dict(category="students", src="PRIMARY_NNN_CARD", front=(50, 90),
                           back_src="SENIOR_CARD", back=(301, 99),
                           front_fields=["name", "classLine", "gr"],
                           compose="o-level"),
    "secondary-jauhar": dict(category="students", src="SECONDARY_CARD", front=(49, 107), back=(306, 107),
                             front_fields=["name", "classLine", "gr"]),
    # --- Students: A Level, portrait, full-bleed artwork (the house frame is in the artwork).
    "a-level-jauhar": dict(category="students", src="TAFSAL_CARD_FORMAT_2026", front=(90, 18), back=(254, 18),
                           front_fields=["name", "levelLine", "gr"],
                           back_order=["father", "residence", "cellular", "contact", "nearest", "email",
                                       "house", "colour", "group", "issueDate", "validUpto"],
                           raster_frame=True),
    # --- Parents / guardians: one card per campus.
    "parent-kaneez-fatima": dict(category="parents", src="PARENTS_CARD", front=(48, 77), back=(311, 77)),
    "parent-north-nazimabad": dict(category="parents", src="PARENTS_CARD", front=(49, 358), back=(311, 358)),
    "parent-jauhar": dict(category="parents", src="PARENTS_CARD", front=(37, 594), back=(310, 594)),
    # --- Staff.
    "staff-administration": dict(category="staff", src="ID_CARD_ADMIN_FACULTY_FORMAT", front=(147, 15), back=(312, 15),
                                 front_fields=["name", "designation", "cnic", "employeeNo"],
                                 back_order_unlabelled=["addressLine2"], live_labels=["relation"]),
    "staff-faculty-jauhar": dict(category="staff", src="ID_CARD_ADMIN_FACULTY_FORMAT", front=(147, 274), back=(312, 274),
                                 front_fields=["name", "designation", "cnic", "employeeNo"],
                                 back_order_unlabelled=["addressLine2"], live_labels=["relation"]),
}

LABEL_KEYS = {
    "FATHERSNAME": "father", "HUSBANDSNAME": "relation", "ADDRESS": "address", "RES.ADDRESS": "address",
    "RESIDENCE#": "residence", "CELLULAR#": "cellular", "CONTACT#": "contact", "NEAREST#": "nearest",
    "HOUSE": "house", "COLOUR": "colour", "DATEOFISSUE": "issueDate", "VALIDUPTO": "validUpto",
    "DATEOFJOINING": "joiningDate", "MOBILE#": "mobile", "EMAILADDRESS": "email", "GROUP": "group",
    "WE,PARENTS/GUARDIANOF": "childName", "STUDENTOFLEVEL": "level", "SECTION": "section",
    "BEARINGG.R.#": "gr",
}

# Dark text that is part of the design, not a value.
STATIC_DARK = {"ISSUING AUTHORITY", "HOLDER’S SIGNATURE", "HOLDER'S SIGNATURE"}

INK = 0x231F20  # the sample values' colour on student and staff cards
PARENT_RED = 0xED1C24


def norm_label(t):
    return t.upper().replace(" ", "").replace("’", "").replace("'", "").replace(":", "")


def hexcol(c):
    return "#%06x" % c


# ---------------------------------------------------------------- Cooper glyphs

class ShapePen(BasePen):
    """Draws CFF glyph outlines into a PyMuPDF Shape (glyph units -> page points)."""

    def __init__(self, shape, x, baseline, kx, ky):
        super().__init__(None)
        self.s, self.x, self.b, self.kx, self.ky = shape, x, baseline, kx, ky
        self.cur = None
        self.start = None

    def P(self, pt):
        return pymupdf.Point(self.x + pt[0] * self.kx, self.b - pt[1] * self.ky)

    def _moveTo(self, pt):
        self.cur = self.start = self.P(pt)

    def _lineTo(self, pt):
        p = self.P(pt)
        self.s.draw_line(self.cur, p)
        self.cur = p

    def _curveToOne(self, a, b, c):
        p = self.P(c)
        self.s.draw_bezier(self.cur, self.P(a), self.P(b), p)
        self.cur = p

    def _closePath(self):
        if self.cur != self.start:
            self.s.draw_line(self.cur, self.start)


def cooper_glyphs():
    """char -> (charstring, advance in glyph units), merged from every PDF that embeds Cooper."""
    out = {}
    for name in ["PRIMARY_NNN_CARD", "PRIMARY_GKF_CARD", "TAFSAL_CARD_FORMAT_2026"]:
        d = pymupdf.open(os.path.join(SRC, name + ".pdf"))
        page = d[0]
        gid_of = {}
        for t in page.get_texttrace():
            if "Cooper" in t["font"]:
                for c in t["chars"]:
                    gid_of[chr(c[0])] = c[1]
        xref = next(x[0] for x in page.get_fonts() if "Cooper" in x[3])
        buf = d.extract_font(xref)[3]
        import io
        cff = CFFFontSet()
        cff.decompile(io.BytesIO(buf), None)
        font = cff[cff.fontNames[0]]
        cs_all = font.CharStrings
        for ch, gid in gid_of.items():
            if ch in out:
                continue
            # CID-keyed subset: glyphs are named by CID, which is the PDF's glyph id.
            gname = "cid%05d" % gid
            if gname not in cs_all:
                continue
            cs, fd = cs_all.getItemAndSelector(gname)
            priv = font.FDArray[fd].Private if hasattr(font, "FDArray") else font.Private
            ext = T2WidthExtractor(cs.private.Subrs if hasattr(cs.private, "Subrs") else [], cs.globalSubrs,
                                   priv.nominalWidthX, priv.defaultWidthX)
            ext.execute(cs)
            out[ch] = (cs, ext.width)
    return out


COOPER = None


def draw_cooper(page, text, size, baseline, center_x, color):
    global COOPER
    if COOPER is None:
        COOPER = cooper_glyphs()
    # The headings are set with a text matrix that is not square: matched against
    # the originals' ink ("CAMPUS VII", "PRE-PRIMARY SECTION"), the glyphs run at
    # 0.974 x the span size across and 1.12 x up, filled and outlined at 0.5pt.
    kx = size * 0.974 / 1000.0
    ky = size * 1.12 / 1000.0
    missing = [c for c in text if c not in COOPER]
    if missing:
        raise SystemExit(f"Cooper glyphs missing for {missing!r} in {text!r}")
    width = sum(COOPER[c][1] for c in text) * kx
    x = center_x - width / 2
    shape = page.new_shape()
    for c in text:
        cs, adv = COOPER[c]
        if c != " ":
            cs.draw(ShapePen(shape, x, baseline, kx, ky))
        x += adv * kx
    rgb = tuple(((color >> s) & 255) / 255 for s in (16, 8, 0))
    shape.finish(fill=rgb, color=rgb, width=0.5, even_odd=False, closePath=True)
    shape.commit()


# ---------------------------------------------------------------- measuring

def card_rect(page, corner):
    """The card border nearest the given top-left corner."""
    best = None
    for dr in page.get_drawings():
        r = dr["rect"]
        if 120 < r.width < 300 and 120 < r.height < 300 and abs(r.width - r.height) > 20:
            d = abs(r.x0 - corner[0]) + abs(r.y0 - corner[1])
            if d < 6 and (best is None or d < best[0]):
                best = (d, r)
    if not best:
        raise SystemExit(f"no card outline near {corner}")
    return pymupdf.Rect(best[1])


def spans_in(page, R):
    out = []
    for b in page.get_text("dict", clip=R)["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                if not s["text"].strip():
                    continue
                bb = pymupdf.Rect(s["bbox"])
                if not R.contains(pymupdf.Point((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2)):
                    continue
                out.append(dict(text=s["text"].strip(), bbox=bb, base=s["origin"][1], size=s["size"],
                                color=s["color"], font=s["font"].split("+")[-1]))
    return out


def hlines_in(page, R):
    out = []
    for dr in page.get_drawings():
        rr = dr["rect"]
        if rr.x1 < R.x0 or rr.x0 > R.x1 or rr.y1 < R.y0 or rr.y0 > R.y1:
            continue
        for it in dr["items"]:
            if it[0] == "l":
                a, b = it[1], it[2]
                if abs(a.y - b.y) < 0.6 and abs(a.x - b.x) > 12 and R.contains(a):
                    out.append(dict(y=(a.y + b.y) / 2, x0=min(a.x, b.x), x1=max(a.x, b.x)))
    return out


def raster_hlines(page, R, min_len_pt=14):
    """Underlines baked into artwork images: long horizontal runs of dark, neutral-to-
    blue pixels (the A Level card's rules print as thin grey-blue lines over the
    gradient; red and the warm background never qualify)."""
    dpi = 600
    pix = page.get_pixmap(dpi=dpi, clip=R)
    k = 72 / dpi
    w, h, n = pix.width, pix.height, pix.n
    sam = pix.samples
    rows = []
    for y in range(h):
        run = 0
        start = 0
        base = y * w * n
        for x in range(w + 1):
            ok = False
            if x < w:
                i = base + x * n
                r_, g_, b_ = sam[i], sam[i + 1], sam[i + 2]
                ok = (r_ + g_ + b_) < 3 * 175 and b_ >= r_ - 15
            if ok:
                if run == 0:
                    start = x
                run += 1
            else:
                if run * k >= min_len_pt:
                    rows.append((y, start, start + run))
                run = 0
    # merge rows that belong to one stroke
    lines = []
    for y, a, b in rows:
        for L in lines:
            if abs(L["yp"] - y) <= 3 and min(b, L["b"]) - max(a, L["a"]) > 0.6 * (b - a):
                L["ys"].append(y)
                L["yp"] = y
                L["a"], L["b"] = min(L["a"], a), max(L["b"], b)
                break
        else:
            lines.append(dict(yp=y, ys=[y], a=a, b=b))
    segs = sorted((dict(y=R.y0 + (sum(L["ys"]) / len(L["ys"])) * k, x0=R.x0 + L["a"] * k, x1=R.x0 + L["b"] * k)
                   for L in lines), key=lambda L: (round(L["y"]), L["x0"]))
    # The watermark crosses some rules and breaks them into pieces; join pieces of one
    # rule (gaps under 25pt). HOUSE and COLOUR share a row 34pt apart and stay two.
    out = []
    for L in segs:
        prev = next((P for P in reversed(out) if abs(P["y"] - L["y"]) < 1.0), None)
        if prev and L["x0"] - prev["x1"] < 25:
            prev["x1"] = max(prev["x1"], L["x1"])
        else:
            out.append(dict(L))
    # Watermark letters over the right-hand ends hide the last stretch of some rules.
    # On this artwork every rule runs to one right edge, so a rule with nothing else to
    # its right on its row is taken to that edge.
    long_rules = [L for L in out if L["x1"] - L["x0"] > 60]
    if long_rules:
        edge = sorted(L["x1"] for L in long_rules)[len(long_rules) // 2]
        for L in out:
            right_of = [P for P in out if P is not L and abs(P["y"] - L["y"]) < 1.0 and P["x0"] > L["x1"]]
            if not right_of and L["x1"] < edge:
                L["x1"] = edge
    return out


def tight(span):
    """A redaction band through the middle of a span's letters. Redaction drops every
    character whose box it touches, and font boxes are tall, so a full-height band
    would also take the line above (it took TAFSAL off the O Level card)."""
    b, z = span["base"], span["size"]
    return pymupdf.Rect(span["bbox"].x0 - 0.1, b - 0.5 * z, span["bbox"].x1 + 0.1, b - 0.15 * z)


def raster_frame(page, R, box):
    """Centre-line rectangle and stroke width of the blue frame painted round the photo."""
    dpi = 600
    k = 72 / dpi
    clip = box + (-12, -12, 12, 12)
    pix = page.get_pixmap(dpi=dpi, clip=clip)
    w, h, n, sam = pix.width, pix.height, pix.n, pix.samples

    def blue(x, y):
        i = (y * w + x) * n
        return sam[i + 2] > 120 and sam[i] < 110 and sam[i + 1] < 120

    def runs(v):
        out, st, pr = [], v[0], v[0]
        for a in v[1:]:
            if a != pr + 1:
                out.append((st, pr + 1))
                st = a
            pr = a
        out.append((st, pr + 1))
        return out

    row = runs([x for x in range(w) if blue(x, h // 2)])
    col = runs([y for y in range(h) if blue(w // 2, y)])
    (l0, l1), (r0, r1) = row[0], row[-1]
    (t0, t1), (b0, b1) = col[0], col[-1]
    rect = pymupdf.Rect(clip.x0 + (l0 + l1) / 2 * k, clip.y0 + (t0 + t1) / 2 * k,
                        clip.x0 + (r0 + r1) / 2 * k, clip.y0 + (b0 + b1) / 2 * k)
    rect.width_pt = max(l1 - l0, r1 - r0, t1 - t0, b1 - b0) * k
    return rect


def render(page, R, dpi=110):
    return page.get_pixmap(dpi=dpi, clip=R).samples


def is_hidden(doc, R, span):
    """True when removing the span changes nothing visible (the designer left it under artwork)."""
    probe = pymupdf.open("pdf", doc.tobytes())
    p = probe[0]
    before = p.get_pixmap(dpi=110, clip=span["bbox"]).samples
    p.add_redact_annot(tight(span))
    p.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                       text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    after = p.get_pixmap(dpi=110, clip=span["bbox"]).samples
    return before == after


# ---------------------------------------------------------------- one face

def blank_face(fmt_key, cfg, side, out_doc):
    src_name = cfg.get("back_src", cfg["src"]) if side == "back" else cfg["src"]
    doc = pymupdf.open(os.path.join(SRC, src_name + ".pdf"))
    page = doc[0]
    R = card_rect(page, cfg[side])
    O = (R.x0, R.y0)

    # 1. Everything outside the card goes. Rects stop 1.5pt short of the card so
    #    artwork that bleeds a hair past the border is kept.
    big = page.rect + (-5, -5, 5, 5)
    m = 1.5
    for rr in [pymupdf.Rect(big.x0, big.y0, big.x1, R.y0 - m), pymupdf.Rect(big.x0, R.y1 + m, big.x1, big.y1),
               pymupdf.Rect(big.x0, R.y0 - m, R.x0 - m, R.y1 + m), pymupdf.Rect(R.x1 + m, R.y0 - m, big.x1, R.y1 + m)]:
        page.add_redact_annot(rr)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_REMOVE,
                          graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
                          text=pymupdf.PDF_REDACT_TEXT_REMOVE)

    spans = spans_in(page, R)
    lines = hlines_in(page, R)
    labels = [s for s in spans if s["color"] == 0x2E3092 and s["font"].startswith("Arial")]

    # 2. Which spans are sample values.
    parents = cfg["category"] == "parents"

    def is_value(s):
        if parents:
            return s["color"] == PARENT_RED and s["font"] == "Arial-BoldMT"
        return s["color"] == INK and s["text"] not in STATIC_DARK and s["font"] in ("Arial-BoldMT", "Calibri-Bold")

    values = [s for s in spans if is_value(s)]
    removed = list(values)

    # Labels written live (staff "HUSBAND'S NAME :" also has to read "FATHER'S NAME :").
    live = {}
    for s in labels:
        key = LABEL_KEYS.get(norm_label(s["text"]))
        if key in cfg.get("live_labels", []):
            live[key] = s
            removed.append(s)

    # Composed headings replace these spans.
    compose = cfg.get("compose") if side == "front" else None
    heading_spans = {}
    if compose:
        for s in spans:
            if s["font"].startswith("Cooper"):
                heading_spans[s["text"]] = s
                if compose == "o-level" or s["text"] == "CAMPUS VII":
                    removed.append(s)

    # 4. Hidden leftovers. On the A Level card everything visible is in the artwork
    #    image, so every text run goes; sample values hidden under it (a stray "-"
    #    from an older layout) are not fields.
    if cfg.get("raster_frame"):
        values = [v for v in values if not is_hidden(doc, R, v)]
        for s in spans:
            if s not in removed:
                removed.append(s)
        labels = []
    for s in spans:
        if s in removed:
            continue
        if is_hidden(doc, R, s):
            removed.append(s)
            if s in labels:
                labels.remove(s)

    # 3. House frame (landscape students) and sample photos.
    frame = None
    photo = None
    for dr in page.get_drawings():
        r = dr["rect"]
        if not R.contains(r) or not dr.get("color") or dr.get("fill"):
            continue
        if 50 < r.width < 70 and 55 < r.height < 80 and cfg["category"] == "students":
            col = tuple(int(v * 255) for v in dr["color"])
            if col != (0x22, 0x1E, 0x1F):
                frame = dict(rect=r, width=dr["width"], color=col)
        if 50 < r.width < 70 and 60 < r.height < 80 and dr["color"] and \
                tuple(int(v * 255) for v in dr["color"]) == (0x22, 0x1E, 0x1F):
            photo = dict(rect=r, width=dr["width"], border=True)
    photos = [pymupdf.Rect(im["bbox"]) for im in page.get_image_info()
              if R.contains(pymupdf.Rect(im["bbox"]).tl) and 40 < pymupdf.Rect(im["bbox"]).width < 70
              and 55 < pymupdf.Rect(im["bbox"]).height < 80]
    if photos and not photo:
        photo = dict(rect=photos[0], width=0, border=False)
    if frame and not photo:
        fr = frame["rect"]
        photo = dict(rect=fr, width=frame["width"], border=False)

    # Apply text removals (values, live labels, composed headings, hidden leftovers).
    for s in removed:
        # Raster card: nothing visible is text, so whole boxes can go.
        page.add_redact_annot(s["bbox"] + (-0.3, -0.3, 0.3, 0.3) if cfg.get("raster_frame") else tight(s))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                          text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    if frame:
        page.add_redact_annot(frame["rect"] + (-2.5, -2.5, 2.5, 2.5))
        page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                              graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
                              text=pymupdf.PDF_REDACT_TEXT_NONE)
    for pr in photos:
        page.add_redact_annot(pr)
    if photos:
        page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_REMOVE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                              text=pymupdf.PDF_REDACT_TEXT_NONE)

    # Composed headings, in Cooper outlines.
    if compose == "campus-iii":
        s = heading_spans["CAMPUS VII"]
        draw_cooper(page, "CAMPUS - III", s["size"], s["base"], (s["bbox"].x0 + s["bbox"].x1) / 2, s["color"])
    elif compose == "o-level":
        a = heading_spans["PRE-PRIMARY SECTION"]
        b = heading_spans["B.U.I (NNN)"]
        draw_cooper(page, "O - LEVEL SECTION", a["size"], a["base"], (a["bbox"].x0 + a["bbox"].x1) / 2, a["color"])
        draw_cooper(page, "TAFSAL", b["size"], b["base"], (b["bbox"].x0 + b["bbox"].x1) / 2, b["color"])

    # 5. Crop to the card.
    out_page = out_doc.new_page(width=R.width, height=R.height)
    out_page.show_pdf_page(out_page.rect, doc, 0, clip=R)

    # ---- layout for this face (all numbers relative to the card's top-left, y down)
    def rel(x, y):
        return round(x - O[0], 2), round(y - O[1], 2)

    if cfg.get("raster_frame") and side == "back":
        # The vector rules in this file belong to an older layout hidden under the
        # artwork; the visible ones are in the image.
        lines = raster_hlines(page, R)

    fields = {}
    unlabelled = []
    for s in sorted(values, key=lambda s: (round(s["base"]), s["bbox"].x0)):
        row_labels = [L for L in labels if abs(L["base"] - s["base"]) < 4 and L["bbox"].x1 <= s["bbox"].x0 + 3]
        key = None
        if row_labels and not cfg.get("back_order"):
            lab = max(row_labels, key=lambda L: L["bbox"].x1)
            key = LABEL_KEYS.get(norm_label(lab["text"]))
        if key is None:
            unlabelled.append(s)
            continue
        fields[key] = s
    if side == "front" and cfg.get("front_fields"):
        for key, s in zip(cfg["front_fields"], unlabelled):
            fields[key] = s
    elif side == "back":
        order = cfg.get("back_order") or cfg.get("back_order_unlabelled") or []
        for key, s in zip(order, unlabelled):
            fields[key] = s

    out_fields = {}
    for key, s in fields.items():
        bb = s["bbox"]
        # The underline this value sits on: just below the baseline, overlapping it.
        cand = [L for L in lines if -0.5 <= L["y"] - s["base"] <= 4.5 and min(L["x1"], bb.x1) - max(L["x0"], bb.x0) > 1]
        if cand:
            L = min(cand, key=lambda L: L["y"] - s["base"])
            x0, x1 = L["x0"] + 2.5, L["x1"] - 2.5
            rule = round(L["y"] - O[1], 2)
        else:
            cx = (bb.x0 + bb.x1) / 2
            half = (R.width / 2 - 6) if cfg["category"] != "students" or R.width < R.height else 80
            if key in ("classLine", "gr", "levelLine"):
                half = min(half, 60)
            x0, x1 = max(R.x0 + 5, cx - half), min(R.x1 - 5, cx + half)
            if key == "name" and cfg["category"] == "students" and R.width > R.height:
                # Landscape student cards: the name is centred under the photo but must
                # stay clear of the Directress's signature on the right (it starts at
                # about 170pt), so a long name may move left rather than run into it.
                x0, x1 = R.x0 + 8, R.x0 + 168
            rule = None
        center = (x0 + x1) / 2 if rule is not None else (bb.x0 + bb.x1) / 2
        out_fields[key] = dict(x0=rel(x0, 0)[0], x1=rel(x1, 0)[0], cx=rel(center, 0)[0], base=rel(0, s["base"])[1],
                               size=round(s["size"], 2), color=hexcol(s["color"]),
                               font="calibri" if s["font"].startswith("Calibri") else "arial",
                               rule=rule, sample=s["text"])
    for key, s in live.items():
        out_fields[key + "Label"] = dict(x=rel(s["bbox"].x0, 0)[0], base=rel(0, s["base"])[1], size=round(s["size"], 2),
                                         color=hexcol(s["color"]), sample=s["text"])

    face = dict(width=round(R.width, 2), height=round(R.height, 2), fields=out_fields)
    if cfg.get("raster_frame") and side == "front":
        # The house frame is painted into the artwork (this sheet's first card is
        # Jinnah, blue). Find its bars across the middle of the photo box; the
        # generator paints over it in the card's own house colour.
        frame = None
        fr = raster_frame(page, R, photo["rect"])
        face["frame"] = dict(x0=rel(fr.x0, 0)[0], y0=rel(0, fr.y0)[1], x1=rel(fr.x1, 0)[0], y1=rel(0, fr.y1)[1],
                             width=round(fr.width_pt, 2), over_artwork=True)
        photo = dict(rect=pymupdf.Rect(fr.x0, fr.y0, fr.x1, fr.y1), width=fr.width_pt, border=False)
    if frame:
        fr = frame["rect"]
        face["frame"] = dict(x0=rel(fr.x0, 0)[0], y0=rel(0, fr.y0)[1], x1=rel(fr.x1, 0)[0], y1=rel(0, fr.y1)[1],
                             width=round(frame["width"], 2))
    if photo:
        pr = photo["rect"]
        inset = photo["width"] / 2 if photo["width"] else 0
        face["photo"] = dict(x0=rel(pr.x0 + inset, 0)[0], y0=rel(0, pr.y0 + inset)[1],
                             x1=rel(pr.x1 - inset, 0)[0], y1=rel(0, pr.y1 - inset)[1])
    face["_removed"] = [s["text"] for s in removed]
    return face


# ---------------------------------------------------------------- main

layout = {}
for key, cfg in FORMATS.items():
    out_doc = pymupdf.open()
    faces = {}
    for side in ("front", "back"):
        faces[side] = blank_face(key, cfg, side, out_doc)
    path = os.path.join(OUT, key + ".pdf")
    out_doc.save(path, garbage=4, deflate=True, clean=True)
    # Preview both faces side by side.
    chk = pymupdf.open(path)
    for i, side in enumerate(("front", "back")):
        chk[i].get_pixmap(dpi=200).save(os.path.join(OUT, "preview", f"{key}-{side}.png"))
    # What text is left in the blank, for review.
    left = [[s.strip() for s in p.get_text().split("\n") if s.strip()] for p in chk]
    imgs = [len(p.get_images()) for p in chk]
    layout[key] = dict(category=cfg["category"], source=cfg["src"], **faces)
    print(f"{key}: front {faces['front']['width']}x{faces['front']['height']}  fields "
          f"F{sorted(faces['front']['fields'])} B{sorted(faces['back']['fields'])}  images {imgs}")
    print(f"   removed F: {faces['front']['_removed']}")
    print(f"   removed B: {faces['back']['_removed']}")
    print(f"   text left F: {left[0]}")
    print(f"   text left B: {left[1]}")
    for side in ("front", "back"):
        faces[side].pop("_removed")

with open(os.path.join(OUT, "layout.json"), "w") as f:
    json.dump(layout, f, indent=1)
print("wrote", OUT)
