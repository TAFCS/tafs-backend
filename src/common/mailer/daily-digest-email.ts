/**
 * HTML for the admin daily digest (TAFSD-371), styled after the webapp:
 * primary #255A94, Geist, black-weight figures, 10px uppercase tracked labels,
 * rounded white cards on the slate background, zinc greys.
 *
 * Email clients ignore most of CSS, so everything that matters is inline and
 * laid out with tables. Gmail's mobile apps auto-invert light colours unless a
 * dark-mode override re-asserts them, hence the duplicated <style> block.
 */

export interface DigestMetric {
  /** Display value, already formatted. */
  value: string;
  /** Whole-percent change versus yesterday; null when yesterday was zero. */
  change: number | null;
  /** Whether a rise is good news (money in) or bad (a growing queue). */
  higherIsGood: boolean;
}

export interface DailyDigestEmailData {
  dateLabel: string;
  deposits: DigestMetric & { sub: string };
  attendance: (DigestMetric & { label: string })[];
  pending: (DigestMetric & { label: string })[];
}

const PRIMARY = '#255A94';
const PRIMARY_TINT = '#EAF1F8';
const PRIMARY_BORDER = '#C7D9EA';
const PAGE = '#F8FAFC';
const CARD = '#FFFFFF';
const BORDER = '#E4E4E7'; // zinc-200
const LABEL = '#A1A1AA'; // zinc-400
const MUTED = '#71717A'; // zinc-500
const FG = '#18181B'; // zinc-900
const GOOD_FG = '#047857';
const GOOD_BG = '#ECFDF5';
const BAD_FG = '#BE123C';
const BAD_BG = '#FFF1F2';
const FLAT_FG = '#71717A';
const FLAT_BG = '#F4F4F5';
const FONT = `'Geist', 'Inter', -apple-system, 'Segoe UI', Arial, Helvetica, sans-serif`;

const labelStyle = `font-size: 10px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase; color: ${LABEL};`;

/** "▲ 12% vs yesterday" pill, green or red depending on whether up is good. */
function changePill(m: DigestMetric): string {
  let text: string;
  let fg = FLAT_FG;
  let bg = FLAT_BG;
  if (m.change === null) {
    text = 'none yesterday';
  } else if (m.change === 0) {
    text = 'same as yesterday';
  } else {
    const up = m.change > 0;
    const good = up === m.higherIsGood;
    fg = good ? GOOD_FG : BAD_FG;
    bg = good ? GOOD_BG : BAD_BG;
    text = `${up ? '&#9650;' : '&#9660;'} ${Math.abs(m.change)}% vs yesterday`;
  }
  return `<span class="dd-pill" style="display: inline-block; font-size: 11px; font-weight: 700; color: ${fg}; background: ${bg}; padding: 3px 8px; border-radius: 999px; white-space: nowrap;">${text}</span>`;
}

function tile(m: DigestMetric & { label: string }): string {
  return `
            <td width="50%" valign="top" style="padding: 6px;">
              <div class="dd-card" style="background: ${CARD}; border: 1px solid ${BORDER}; border-radius: 16px; padding: 14px 16px;">
                <div class="dd-label" style="${labelStyle}">${m.label}</div>
                <div class="dd-fg" style="font-size: 26px; font-weight: 900; color: ${FG}; margin: 6px 0 8px; letter-spacing: -0.02em;">${m.value}</div>
                ${changePill(m)}
              </div>
            </td>`;
}

function pendingRow(m: DigestMetric & { label: string }, last: boolean): string {
  return `
            <tr>
              <td style="padding: 14px 18px;${last ? '' : ` border-bottom: 1px solid ${BORDER};`}">
                <div class="dd-fg" style="font-size: 14px; font-weight: 700; color: ${FG};">${m.label}</div>
                <div style="margin-top: 6px;">${changePill(m)}</div>
              </td>
              <td align="right" valign="middle" style="padding: 14px 18px;${last ? '' : ` border-bottom: 1px solid ${BORDER};`}">
                <span class="dd-fg" style="font-size: 26px; font-weight: 900; color: ${FG}; letter-spacing: -0.02em;">${m.value}</span>
              </td>
            </tr>`;
}

function sectionTitle(text: string): string {
  return `<div class="dd-label" style="${labelStyle} margin: 24px 6px 8px;">${text}</div>`;
}

export function renderDailyDigestHtml(subject: string, data: DailyDigestEmailData): string {
  const lightRules = `
      body, .dd-body { background: ${PAGE} !important; }
      .dd-badge { background: ${PRIMARY} !important; color: #ffffff !important; }
      .dd-fg { color: ${FG} !important; }
      .dd-muted { color: ${MUTED} !important; }
      .dd-label { color: ${LABEL} !important; }
      .dd-card { background: ${CARD} !important; border-color: ${BORDER} !important; }
      .dd-hero { background: ${PRIMARY_TINT} !important; border-color: ${PRIMARY_BORDER} !important; }
      .dd-hero-label { color: ${PRIMARY} !important; }`;

  const attendanceRows: string[] = [];
  for (let i = 0; i < data.attendance.length; i += 2) {
    attendanceRows.push(`
          <tr>${data.attendance.slice(i, i + 2).map(tile).join('')}
          </tr>`);
  }

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${subject}</title>
    <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;700;900&display=swap" rel="stylesheet" />
    <style>
      :root { color-scheme: light; supported-color-schemes: light; }${lightRules}
      @media (prefers-color-scheme: dark) {${lightRules}
      }
    </style>
  </head>
  <body class="dd-body" style="margin: 0; padding: 0; background: ${PAGE};">
    <div class="dd-body" style="background: ${PAGE}; padding: 32px 16px; font-family: ${FONT};">
      <div style="max-width: 520px; margin: 0 auto;">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td valign="middle" style="padding: 0 6px;">
              <span class="dd-badge" style="display: inline-block; background: ${PRIMARY}; color: #ffffff; font-size: 11px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase; padding: 5px 10px; border-radius: 10px;">TAFSync</span>
            </td>
            <td align="right" valign="middle" class="dd-label" style="${labelStyle} padding: 0 6px;">Daily digest</td>
          </tr>
        </table>
        <h1 class="dd-fg" style="margin: 16px 6px 2px; font-size: 22px; font-weight: 900; color: ${FG}; letter-spacing: -0.02em;">${data.dateLabel}</h1>
        <p class="dd-muted" style="margin: 0 6px 16px; font-size: 13px; color: ${MUTED};">Today at a glance, compared with yesterday.</p>

        <div style="padding: 0 6px;">
          <div class="dd-hero" style="background: ${PRIMARY_TINT}; border: 1px solid ${PRIMARY_BORDER}; border-radius: 24px; padding: 20px 22px;">
            <div class="dd-hero-label" style="font-size: 10px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase; color: ${PRIMARY};">Money deposited today</div>
            <div class="dd-fg" style="font-size: 32px; font-weight: 900; color: ${FG}; margin: 6px 0 4px; letter-spacing: -0.02em;">${data.deposits.value}</div>
            <div class="dd-muted" style="font-size: 13px; color: ${MUTED}; margin-bottom: 10px;">${data.deposits.sub}</div>
            ${changePill(data.deposits)}
          </div>
        </div>

        ${sectionTitle('Attendance today')}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: separate;">${attendanceRows.join('')}
        </table>

        ${sectionTitle('Waiting on staff')}
        <div style="padding: 0 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="dd-card" style="background: ${CARD}; border: 1px solid ${BORDER}; border-radius: 24px; border-collapse: separate;">${data.pending.map((m, i) => pendingRow(m, i === data.pending.length - 1)).join('')}
          </table>
        </div>

        <p class="dd-label" style="margin: 24px 6px 0; font-size: 11px; color: ${LABEL}; text-align: center;">Sent automatically at 11 PM PKT by TAFSync. Queue figures are compared with the same time yesterday.</p>
      </div>
    </div>
  </body>
</html>`;
}
