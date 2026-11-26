import { UBL_RESPONSE } from '../../ubl/ubl.service';
import { UBL_PAYMENT_METHODS, UBL_ONEBILL_METHOD } from '../../ubl/dto/ubl-bill.dto';
import { DEFAULT_UBL_RATE_LIMIT_PER_MINUTE } from '../../ubl/ubl-access';
import { UBL_1BILL_CHARGE_SLABS, UBL_1BILL_PREFIX_PLACEHOLDER, ubl1BillCharge } from '../../../utils/ubl.util';
import type { ApiDoc } from '../api-docs.types';

/**
 * TAFSD-614: the UBL bill inquiry / payment API, checked against ubl.controller.ts,
 * ubl.service.ts, ubl-bill.dto.ts, ubl-access(.middleware).ts, ubl.util.ts and the
 * global pipeline (app.pipeline.ts, http-exception.filter.ts) on 27 Nov 2026.
 *
 * Starts from the specification sent to UBL (v1.3, 23 Nov 2026) and corrects
 * or adds what the code does that v1.3 does not say (section "Changes since
 * v1.3"). Response codes, payment methods and 1Bill slabs are read from the
 * code. Keep docs/api-docs/ubl.tex and its PDF in step.
 */

const pkr = (n: number) => n.toLocaleString('en-US');

const RESPONSE_USED_BY: Record<string, string> = {
  OK: 'Both',
  CONSUMER_NOT_FOUND: 'Both',
  NO_VOUCHER: 'Both',
  ALREADY_PAID: 'Both',
  EXPIRED: 'Both',
  NOT_PAYABLE: 'Both',
  AMOUNT_MISMATCH: 'Payment',
  VOUCHER_CHANGED: 'Payment',
  DUPLICATE: 'Payment (treat as success)',
  INVALID_REQUEST: 'Payment',
  UNAUTHORIZED: 'Both',
  GENERAL_ERROR: 'Both (resend with the same transaction_id)',
};

const responseRows = Object.entries(UBL_RESPONSE).map(([key, [code, desc]]) => [
  `\`${code}\``,
  desc,
  RESPONSE_USED_BY[key] ?? '',
]);

const slabRows = UBL_1BILL_CHARGE_SLABS.map((s, i) => {
  const from = i === 0 ? 0 : UBL_1BILL_CHARGE_SLABS[i - 1].upTo + 1;
  const range = Number.isFinite(s.upTo)
    ? i === 0 ? `Up to ${pkr(s.upTo)}` : `${pkr(from)} to ${pkr(s.upTo)}`
    : `Above ${pkr(UBL_1BILL_CHARGE_SLABS[i - 1].upTo)}`;
  return [range, `**${s.charge}**`];
});

const PAYMENT_METHOD_MEANING: Record<string, string> = {
  CASH: 'Cash at a branch counter',
  CHEQUE: 'Cheque (send `instrument_number`)',
  PAY_ORDER: 'Pay order or demand draft (send `instrument_number`)',
  ACCOUNT_TRANSFER: 'Debit from the payer\'s account (net banking, the UBL app, or a teller debit at the counter)',
  DEBIT_CARD: 'Debit card (UBL does not process these today)',
  CREDIT_CARD: 'Credit card (UBL does not process these today)',
  WALLET: 'Mobile wallet (UBL does not process these today)',
  OTHER: 'Any other method; tell TAFS which, so it can be added',
};

const methodRows = [
  ...UBL_PAYMENT_METHODS.map((m) => [`\`${m}\``, PAYMENT_METHOD_MEANING[m] ?? '']),
  [`\`${UBL_ONEBILL_METHOD}\``, '1Bill payments (15-digit consumer number). Empty or `null` on a 1Bill payment means the same. Refused for a CC.'],
];

const example = (bill: number) => [pkr(bill), String(ubl1BillCharge(bill)), pkr(bill + ubl1BillCharge(bill))];

export const UBL_DOC: ApiDoc = {
  slug: 'ubl',
  title: 'UBL Bill Payment API',
  subtitle: 'Bill inquiry and bill payment for United Bank Limited (OTC, net banking, app and 1Bill)',
  version: '1.4 (internal)',
  updated: '2026-11-27',
  summary:
    'The two endpoints UBL calls to look up a student\'s fee voucher and post a payment against it, with the consumer number rules, amounts, 1Bill charge, response codes and how testing works. Corrects the v1.3 specification where the code has moved on.',
  pdfFile: 'ubl.pdf',
  downloadName: 'TAFS_API_UBL.pdf',
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [
        {
          type: 'p',
          text: 'UBL\'s systems call TAFS to collect school fees. There are two calls, both JSON over HTTPS, both authenticated with a service user and password in headers:',
        },
        {
          type: 'list',
          items: [
            '**Bill inquiry** (`GET`) returns the student\'s current voucher and the exact amount to collect today.',
            '**Bill payment** (`POST`) posts a collected payment. TAFS records it as a deposit on the voucher, exactly as if staff had received it.',
          ],
        },
        {
          type: 'p',
          text: 'One API serves both UBL products: **TAFSCLCC** (over the counter, net banking, UBL app; the payer gives the 5-digit CC) and **TAFSCLBILL** (1Bill; a 15-digit consumer number, any bank or wallet). The consumer number alone decides which amount is quoted.',
        },
        {
          type: 'note',
          tone: 'info',
          text: 'Status on 27 Nov 2026: 1Bill tested end to end on 18 Nov. Waiting on UBL for the production 1Bill prefix, its egress IP addresses (for the allow-list) and OTC / net banking testing. Collections and UBL settlement statements are reconciled under Financial Reports → UBL Collections.',
        },
      ],
    },
    {
      id: 'consumer-number',
      title: 'Consumer number',
      blocks: [
        {
          type: 'table',
          head: ['Sent as', 'Format', 'Amount quoted'],
          rows: [
            ['Up to 5 digits', 'The student\'s CC, leading zeros optional (`8088` = `08088`)', 'The voucher amount'],
            ['15 digits', '10-digit TAFS 1Bill prefix + CC zero-padded to 5 (`100000000008088`)', 'The voucher amount + the 1Bill charge'],
          ],
        },
        {
          type: 'list',
          items: [
            `Until \`UBL_1BILL_PREFIX\` is set to the prefix UBL issues, the prefix is the placeholder \`${UBL_1BILL_PREFIX_PLACEHOLDER}\`. Changing it changes every student\'s 1Bill number.`,
            'Any other length, a 15-digit number with another prefix, or CC 0 returns code `01`.',
            'More than 20 digits, or anything that is not digits, is a malformed request (HTTP 400).',
          ],
        },
      ],
    },
    {
      id: 'amounts',
      title: 'Amounts',
      blocks: [
        {
          type: 'table',
          head: ['Payment date (Pakistan time)', 'Amount'],
          rows: [
            ['On or before the due date', '`amount_within_due_date`: unpaid fees (net of discounts) + unpaid arrear surcharges'],
            ['After the due date, up to the validity date', '`amount_after_due_date`: the above + the unpaid late fee'],
            ['After the validity date', 'Not payable: code `04`'],
          ],
        },
        {
          type: 'p',
          text: 'For an inquiry "today" is the Pakistan date when the call arrives. For a payment it is the Pakistan date of `transaction_datetime`, so a payment taken on the due date and posted the next morning still pays the within-due amount.',
        },
        {
          type: 'p',
          text: 'Amounts are whole rupees. `amount` may carry up to two decimals (`90053` = `90053.00`); a fractional value never matches and gets `06`; three or more decimals is HTTP 400. The payment must equal `amount_payable` exactly: partial and over-payments are refused, so UBL never creates family credit.',
        },
      ],
      subsections: [
        {
          id: 'onebill-charge',
          title: '1Bill charge',
          blocks: [
            {
              type: 'p',
              text: 'Borne by the payer and never booked as fees: the 1LINK same-day settlement fee plus the biller charge for the slab, rounded up to whole rupees. The slab is that of the **transaction** (bill + charge), so a charge that tips the total over a boundary takes the next slab\'s charge.',
            },
            { type: 'table', head: ['Transaction (PKR)', '1Bill charge'], rows: slabRows },
            {
              type: 'table',
              head: ['Voucher amount', '1Bill charge', 'Amount quoted'],
              rows: [example(90_000), example(91_000), example(99_980), example(4_990)],
            },
          ],
        },
      ],
    },
    {
      id: 'voucher-resolution',
      title: 'Which voucher is collected',
      blocks: [
        {
          type: 'list',
          items: [
            'Only vouchers released to the parent, and not VOID (replaced by a newer one), are considered.',
            'The newest one that is UNPAID, OVERDUE or PARTIALLY_PAID is collected.',
            'If none is payable, the newest one\'s state is returned instead: PAID `03`, WAIVED `05`, EXPIRED or past its validity date `04`. No voucher at all is `02`.',
            'A new voucher carries every older unpaid voucher\'s outstanding fees onto itself and voids the older one, so normally there is exactly one payable voucher holding all arrears. A fee item can be on only one payable voucher at a time, so the same fees are never collected twice.',
            'UBL vouchers print the plain voucher serial as the voucher number (e.g. `12461`).',
          ],
        },
      ],
    },
    {
      id: 'authentication',
      title: 'Connectivity and authentication',
      blocks: [
        { type: 'code', title: 'Base URL (production; there is no other)', code: 'https://api.tafs.cloud/api/v1/ubl' },
        {
          type: 'table',
          head: ['Header', 'Value'],
          rows: [
            ['`X-UBL-User`', 'Service user ID issued to UBL'],
            ['`X-UBL-Password`', 'Its password'],
            ['`Content-Type`', '`application/json` on payments'],
          ],
        },
        {
          type: 'list',
          items: [
            'Credentials are compared in constant time against `UBL_SERVICE_USER_ID` and `UBL_SERVICE_PASSWORD` on the backend. They are issued separately and never go in a URL, a document or a ticket.',
            'Missing or wrong credentials: HTTP 200 with code `10`.',
            'HTTPS only (TLS 1.2 and 1.3), behind Cloudflare.',
            '`UBL_ALLOWED_IPS` (comma-separated IPs or CIDRs) restricts callers; unset means no restriction. An invalid entry refuses **every** UBL request with 503 rather than opening the API.',
            `Rate limit per caller IP: \`UBL_RATE_LIMIT_PER_MINUTE\`, default ${DEFAULT_UBL_RATE_LIMIT_PER_MINUTE} a minute; 0 turns it off.`,
            'The caller IP is Cloudflare\'s `cf-connecting-ip`, believed only when the connection came from a Cloudflare range (`UBL_TRUSTED_PROXY_RANGES` overrides the list). `X-Forwarded-For` is ignored.',
            'Maintenance mode does not block these routes.',
          ],
        },
      ],
      subsections: [
        {
          id: 'http-status',
          title: 'HTTP status',
          blocks: [
            { type: 'p', text: 'Every business outcome, including code `10`, is HTTP 200 with the outcome in `response_code`. The exceptions:' },
            {
              type: 'table',
              head: ['HTTP', 'Code', 'When', 'Body'],
              rows: [
                ['400', '–', 'Malformed: missing or invalid field, non-digit consumer number, **any field the API does not define**', '`{"status":400,"message":["…"],"data":null}`'],
                ['403', '`10`', 'Caller IP not on the allow-list', '`response_code`, `response_desc`, `client_ip`'],
                ['429', '`99`', 'Rate limit exceeded; `Retry-After: 60`', 'same'],
                ['503', '`99`', 'UBL network settings invalid on the backend', 'same'],
              ],
            },
            { type: 'p', text: '403, 429 and 503 are answered before any student or payment data is read. Nothing is booked.' },
          ],
        },
      ],
    },
    {
      id: 'inquiry',
      title: 'Bill inquiry',
      blocks: [
        { type: 'code', code: 'GET /api/v1/ubl/bill-inquiry?consumer_number={consumer_number}' },
        {
          type: 'p',
          text: 'One query parameter, `consumer_number`. An optional `channel` is still accepted from older callers and ignored. Any other parameter is HTTP 400.',
        },
        {
          type: 'table',
          head: ['Field', 'Type', 'Meaning'],
          rows: [
            ['`response_code` / `response_desc`', 'string', '`"00"` / `"Success"`'],
            ['`consumer_number`', 'string', 'As sent'],
            ['`onebill_consumer_number`', 'string', 'The student\'s 15-digit 1Bill number'],
            ['`cc`', 'string', 'CC, 5 digits zero-padded'],
            ['`student_name`, `gr_number`, `campus`, `class`', 'string', 'The student (`gr_number`, `campus`, `class` may be null)'],
            ['`voucher_number`', 'string', 'Voucher being collected'],
            ['`billing_month`', 'string', 'Months billed, e.g. `"OCT 26"`'],
            ['`voucher_status`', 'string', '`UNPAID`, `OVERDUE` or `PARTIALLY_PAID`'],
            ['`issue_date`, `due_date`, `validity_date`', 'string', '`YYYYMMDD`'],
            ['`currency`', 'string', '`"PKR"`'],
            ['`amount_within_due_date`', 'number', 'Includes the 1Bill charge for a 1Bill number'],
            ['`amount_after_due_date`', 'number', 'Includes the late fee, and the 1Bill charge for a 1Bill number'],
            ['`late_fee`', 'number', 'Unpaid late fee that applies after the due date'],
            ['`channel_fee`', 'number', '1Bill charge inside `amount_payable`; 0 for a CC'],
            ['`amount_payable`', 'number', '**The exact amount to collect today**'],
          ],
        },
        {
          type: 'code',
          title: 'CC, after the due date',
          code: 'GET /api/v1/ubl/bill-inquiry?consumer_number=08088\nX-UBL-User: <issued by TAFS>\nX-UBL-Password: <issued by TAFS>\n\n{\n  "response_code": "00",\n  "response_desc": "Success",\n  "consumer_number": "08088",\n  "onebill_consumer_number": "100000000008088",\n  "cc": "08088",\n  "student_name": "<student name>",\n  "gr_number": "7001",\n  "campus": "Gulistan-e-Jauhar Campus",\n  "class": "AS",\n  "voucher_number": "12461",\n  "billing_month": "OCT 26",\n  "voucher_status": "OVERDUE",\n  "issue_date": "20261001",\n  "due_date": "20261010",\n  "validity_date": "20261020",\n  "currency": "PKR",\n  "amount_within_due_date": 90000,\n  "amount_after_due_date": 91000,\n  "late_fee": 1000,\n  "channel_fee": 0,\n  "amount_payable": 91000\n}',
        },
        {
          type: 'code',
          title: '1Bill number, before the due date (fields as above, amounts differ)',
          code: '{\n  "response_code": "00",\n  "consumer_number": "100000000008088",\n  "voucher_status": "UNPAID",\n  "amount_within_due_date": 90053,\n  "amount_after_due_date": 91053,\n  "late_fee": 1000,\n  "channel_fee": 53,\n  "amount_payable": 90053,\n  …\n}',
        },
        {
          type: 'code',
          title: 'Failure',
          code: '{ "response_code": "03", "response_desc": "Voucher is already paid", "voucher_number": "12461" }',
        },
      ],
    },
    {
      id: 'payment',
      title: 'Bill payment',
      blocks: [
        { type: 'code', code: 'POST /api/v1/ubl/bill-payment\nContent-Type: application/json' },
        {
          type: 'table',
          head: ['Field', 'Required', 'Meaning'],
          rows: [
            ['`consumer_number`', 'Yes', 'Same value as the inquiry'],
            ['`amount`', 'Yes', 'Amount collected; must equal `amount_payable`'],
            ['`channel`', 'CC: yes', 'CC: `OTC`, `APP` or `INTERNET_BANKING`. 1Bill: omit or `ONEBILL`'],
            ['`payment_method`', 'CC: yes', 'How the payer paid (table below). 1Bill: `ONEBILL` or empty'],
            ['`transaction_id`', 'Yes', 'UBL\'s unique reference, up to 100 characters'],
            ['`transaction_datetime`', 'Yes', 'ISO 8601 with offset (`2026-10-05T11:00:00+05:00`), or `YYYYMMDD` / `YYYYMMDDHHmm` / `YYYYMMDDHHmmss` in Pakistan time'],
            ['`voucher_number`', 'Advised', 'From the inquiry. If sent and a newer voucher exists, code `07`'],
            ['`branch_code`', 'OTC', 'UBL branch'],
            ['`payer_bank_code`, `payer_bank_name`', '1Bill', 'Bank or wallet the payer paid from'],
            ['`instrument_number`', 'Cheque / PO', 'Required for `CHEQUE` and `PAY_ORDER`'],
          ],
        },
        { type: 'p', text: 'Optional fields sent as `"{}"`, `""` or `null` are treated as not sent.' },
        { type: 'table', head: ['payment_method', 'Meaning'], rows: methodRows },
        {
          type: 'table',
          head: ['Response field', 'Meaning'],
          rows: [
            ['`transaction_id`', 'As sent'],
            ['`tafs_receipt_id`', 'TAFS deposit number'],
            ['`voucher_number`', 'Voucher the payment went to'],
            ['`amount_booked`', 'Credited to the student (excludes the 1Bill charge)'],
            ['`channel_fee`', '1Bill charge inside the amount collected; 0 for a CC'],
          ],
        },
        {
          type: 'code',
          title: '1Bill payment',
          code: 'POST /api/v1/ubl/bill-payment\n{\n  "consumer_number": "100000000008088",\n  "amount": 90053,\n  "payment_method": "ONEBILL",\n  "transaction_id": "UBL20261005110000123",\n  "transaction_datetime": "2026-10-05T11:00:00+05:00",\n  "voucher_number": "12461",\n  "payer_bank_code": "HBL",\n  "payer_bank_name": "Habib Bank Limited"\n}\n\n{\n  "response_code": "00",\n  "response_desc": "Success",\n  "transaction_id": "UBL20261005110000123",\n  "tafs_receipt_id": "48215",\n  "voucher_number": "12461",\n  "amount_booked": 90000,\n  "channel_fee": 53\n}',
        },
        {
          type: 'code',
          title: 'Net banking, account transfer',
          code: '{\n  "consumer_number": "08088",\n  "channel": "INTERNET_BANKING",\n  "payment_method": "ACCOUNT_TRANSFER",\n  "amount": 90000,\n  "transaction_id": "UBLIB20261125101500001",\n  "transaction_datetime": "2026-11-25T10:15:00+05:00",\n  "voucher_number": "12461"\n}',
        },
        {
          type: 'code',
          title: 'Failures',
          code: '{ "response_code": "06", "response_desc": "Amount does not match the payable amount", "amount_payable": 90053 }\n{ "response_code": "08", "response_desc": "Duplicate transaction; already posted",\n  "transaction_id": "UBL20261005110000123", "tafs_receipt_id": "48215" }\n{ "response_code": "09", "response_desc": "instrument_number is required for CHEQUE and PAY_ORDER" }',
        },
      ],
      subsections: [
        {
          id: 'retries',
          title: 'Duplicates, retries and timeouts',
          blocks: [
            {
              type: 'list',
              items: [
                'Posting is idempotent on `transaction_id`, checked before anything else. On a timeout or `99`, resend the same request with the same id: a payment that did go through comes back `08` with its receipt and is never booked twice.',
                'An id stays used even after the school reverses that deposit (it is kept in `ubl_transactions`). The resend still gets `08`, with the number of the deposit that was reversed.',
                'Code `09` carries the specific reason in `response_desc`.',
              ],
            },
          ],
        },
        {
          id: 'what-tafs-records',
          title: 'What TAFS records',
          blocks: [
            {
              type: 'list',
              items: [
                'A deposit on the voucher with `payment_method = ubl`, `reference_number` = the transaction id, `deposit_date` = `transaction_datetime`, and remarks such as `UBL OTC · CHEQUE · instrument 00412387 · branch 0457`.',
                'The payment clears the late fee (if overdue) and the arrear surcharges in full, and the rest goes to the fee heads in the voucher\'s order. The voucher becomes PAID and its paid receipt is generated as for any deposit.',
                'A row in `ubl_transactions` (amount received, amount booked, 1Bill charge, channel, method), which the UBL Collections reconciliation matches to UBL\'s settlement statement.',
                'An audit log entry by actor `ubl-bank`.',
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'errors',
      title: 'Response codes',
      blocks: [{ type: 'table', head: ['Code', 'Meaning', 'Used by'], rows: responseRows }],
    },
    {
      id: 'testing',
      title: 'Testing',
      blocks: [
        {
          type: 'p',
          text: 'There is **no UAT**. UBL tests against production, on test students in the Kaneez Fatima class IX test class. Their payments post real deposits, so they must land only on these students.',
        },
        {
          type: 'table',
          head: ['CC', 'Set up for'],
          rows: [
            ['44', 'Unpaid voucher (1Bill tested on it 18 Nov 2026, receipt 7074)'],
            ['1', 'Unpaid voucher, for 1Bill'],
            ['2', 'Overdue voucher (late fee applies)'],
            ['3', 'Part-paid voucher'],
            ['4', 'Latest voucher expired: code `04`'],
          ],
        },
        {
          type: 'list',
          items: [
            `1Bill test numbers are \`${UBL_1BILL_PREFIX_PLACEHOLDER}\` + the CC padded to 5 (\`${UBL_1BILL_PREFIX_PLACEHOLDER}00044\`).`,
            'CC 5 is TAFS\'s own reconciliation test payment, not one of UBL\'s cases.',
            'States change as UBL pays. TAFS reverses `payment_method = ubl` deposits on these students on request and at the end of testing, latest first. That removes them from TAFS only; it does not return the money at the bank.',
            'The test credentials and full scenarios are in the separate test data document sent to UBL. They are not reproduced here.',
          ],
        },
      ],
    },
    {
      id: 'changes',
      title: 'Changes since v1.3',
      blocks: [
        { type: 'p', text: 'The API has not changed since v1.3 (23 Nov 2026). Checking that document against the code found these gaps, now covered above:' },
        {
          type: 'list',
          items: [
            'Any request field or query parameter the API does not define is refused with HTTP 400 (also told to UBL on 25 Nov).',
            'The HTTP 400 body is `{"status":400,"message":[…],"data":null}`, not UBL\'s `response_code` format; a 403 body also carries `client_ip`.',
            'A payment\'s due-date and validity checks use `transaction_datetime`, not the time it reaches TAFS.',
            `The default rate limit is ${DEFAULT_UBL_RATE_LIMIT_PER_MINUTE} requests a minute per caller IP, and a bad allow-list fails closed with 503.`,
            'A transaction id stays a duplicate after its deposit is reversed; the `08` reply then names a deposit that no longer exists.',
            '`transaction_datetime` also accepts `YYYYMMDDHHmm` (no seconds).',
            'The inquiry still accepts, and ignores, an optional `channel` parameter.',
            `Until \`UBL_1BILL_PREFIX\` is set, 1Bill numbers use the placeholder prefix \`${UBL_1BILL_PREFIX_PLACEHOLDER}\`. UBL had not issued the production prefix as of 23 Nov 2026.`,
          ],
        },
      ],
    },
  ],
};
