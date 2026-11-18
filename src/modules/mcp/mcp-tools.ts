import { BadRequestException, Type, ValidationPipe } from '@nestjs/common';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { StudentsController } from '../students/students.controller';
import { SearchSimpleQueryDto } from '../students/dto/search-simple-query.dto';
import { PaymentHistoryQueryDto } from '../students/dto/payment-history-query.dto';
import { VouchersController } from '../vouchers/vouchers.controller';
import { FilterVouchersDto } from '../vouchers/dto/filter-vouchers.dto';
import { FinancialReportsController } from '../financial-reports/financial-reports.controller';
import { ListDefaultersQueryDto } from '../financial-reports/dto/financial-report-query.dto';
import { EmployeesController } from '../hr/employees/employees.controller';
import type { McpRoute } from './mcp-access';

/** JSON Schema for a tool's arguments (always an object). */
export type McpInputSchema = {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
};

export type McpToolDeps = {
  /** The live Nest instance of a controller, so its own scope checks run. */
  controller<T>(cls: Type<T>): T;
};

export type McpToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: McpInputSchema;
  /**
   * The HTTP route this tool stands in for. Its guards' metadata decides who
   * sees and may call the tool (McpRouteAccess). Only `whoami` has none: it
   * returns nothing beyond the caller's own session.
   */
  route: McpRoute | null;
  run(
    deps: McpToolDeps,
    args: Record<string, unknown>,
    user: IJwtStaffPayload,
  ): Promise<unknown>;
};

/** The same options the HTTP app uses (main.ts), so a tool accepts what the route accepts. */
const validation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

export async function asQuery<T>(
  dto: Type<T>,
  value: Record<string, unknown>,
): Promise<T> {
  return (await validation.transform(value, {
    type: 'query',
    metatype: dto,
  })) as T;
}

/** A required positive integer argument (a path parameter on the HTTP side). */
export function intArg(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new BadRequestException(`${key} must be a positive whole number`);
  }
  return n;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Everything in `args` except the named keys, for handing the rest to a DTO. */
function without(
  args: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  const rest = { ...args };
  for (const k of keys) delete rest[k];
  return rest;
}

/** Controllers wrap results as { data, status, message } or { success, data }; tools return the data. */
export function unwrap(result: unknown): unknown {
  if (result && typeof result === 'object' && 'data' in result)
    return (result as { data: unknown }).data;
  return result;
}

const intProp = (description: string) => ({
  type: 'integer',
  minimum: 1,
  description,
});
const intList = (description: string) => ({
  type: 'array',
  items: { type: 'integer' },
  description,
});
const pageProps = {
  page: { type: 'integer', minimum: 1, description: 'Page number, from 1.' },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    description: 'Rows per page (at most 100).',
  },
};

const clampLimit = (args: Record<string, unknown>, fallback: number) => {
  const limit = typeof args.limit === 'number' ? args.limit : fallback;
  return { ...args, limit: Math.min(Math.max(1, Math.trunc(limit)), 100) };
};

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'whoami',
    title: 'Who am I',
    description:
      'Your TAFS identity as this assistant sees it: name, role, the campuses/classes/sections your data is limited to, and the tools you can use.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    route: null,
    // Answered by McpService, which knows the caller's tool list.
    run: async () => {
      throw new Error('whoami is answered by McpService');
    },
  },
  {
    name: 'search_students',
    title: 'Search students',
    description:
      'Find students by name, CC, GR number, father name or phone. Returns at most a short list; results are limited to the campuses and classes you can see. Use get_student for the full profile.',
    inputSchema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description: 'Name, CC, GR number, father name or phone.',
        },
        campus_id: intProp('Only this campus.'),
        class_id: intProp('Only this class.'),
        section_id: intProp('Only this section.'),
        segment_id: intProp('Only this segment.'),
      },
      additionalProperties: false,
    },
    route: { controller: StudentsController, method: 'searchSimple' },
    run: async (deps, args, user) =>
      deps
        .controller(StudentsController)
        .searchSimple(await asQuery(SearchSimpleQueryDto, args), user),
  },
  {
    name: 'get_student',
    title: 'Student profile',
    description:
      "A student's full profile by CC: class, section, campus, status, family, guardians, fee settings.",
    inputSchema: {
      type: 'object',
      properties: { cc: intProp("The student's CC number.") },
      required: ['cc'],
      additionalProperties: false,
    },
    route: { controller: StudentsController, method: 'findOne' },
    run: async (deps, args, user) =>
      deps.controller(StudentsController).findOne(intArg(args, 'cc'), user),
  },
  {
    name: 'get_student_payment_history',
    title: 'Student payment history',
    description:
      "A student's fee heads, vouchers and deposits for one academic year.",
    inputSchema: {
      type: 'object',
      properties: {
        cc: intProp("The student's CC number."),
        academic_year: {
          type: 'string',
          pattern: '^\\d{4}-\\d{4}$',
          description: 'e.g. 2026-2027',
        },
      },
      required: ['cc', 'academic_year'],
      additionalProperties: false,
    },
    route: { controller: StudentsController, method: 'getPaymentHistory' },
    run: async (deps, args, user) =>
      deps
        .controller(StudentsController)
        .getPaymentHistory(
          intArg(args, 'cc'),
          await asQuery(PaymentHistoryQueryDto, without(args, 'cc')),
          user,
        ),
  },
  {
    name: 'list_vouchers',
    title: 'List vouchers',
    description:
      'Issued fee vouchers (challans), newest first, filtered by student, status, campus, class or issue date.',
    inputSchema: {
      type: 'object',
      properties: {
        cc: intProp('Student CC.'),
        gr: { type: 'string', description: 'Student GR number.' },
        status: {
          type: 'string',
          description:
            'UNPAID, OVERDUE, EXPIRED, PARTIALLY_PAID, PAID, VOID or WAIVED; comma-separate several.',
        },
        campus_id: {
          type: 'string',
          description: 'Campus id; comma-separate several.',
        },
        class_id: {
          type: 'string',
          description: 'Class id; comma-separate several.',
        },
        section_id: {
          type: 'string',
          description: 'Section id; comma-separate several.',
        },
        date_from: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'Issued on or after (YYYY-MM-DD).',
        },
        date_to: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'Issued on or before (YYYY-MM-DD).',
        },
        ...pageProps,
      },
      additionalProperties: false,
    },
    route: { controller: VouchersController, method: 'findAll' },
    run: async (deps, args, user) =>
      deps
        .controller(VouchersController)
        .findAll(await asQuery(FilterVouchersDto, clampLimit(args, 20)), user),
  },
  {
    name: 'get_voucher',
    title: 'Voucher detail',
    description:
      'One voucher by its id: fee heads, amounts, due and validity dates, deposits and status.',
    inputSchema: {
      type: 'object',
      properties: { voucher_id: intProp('The voucher id.') },
      required: ['voucher_id'],
      additionalProperties: false,
    },
    route: { controller: VouchersController, method: 'findOne' },
    run: async (deps, args, user) =>
      deps
        .controller(VouchersController)
        .findOne(intArg(args, 'voucher_id'), user),
  },
  {
    name: 'get_student_arrears',
    title: 'Student arrears',
    description:
      "What a student owes from before a fee date, by the school's one arrears definition (the amount a new voucher dated fee_date would carry forward), with the late surcharge.",
    inputSchema: {
      type: 'object',
      properties: {
        cc: intProp("The student's CC number."),
        fee_date: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description:
            'Arrears are the unpaid heads dated before this day (YYYY-MM-DD). Defaults to today.',
        },
        waive_surcharge: {
          type: 'boolean',
          description: 'Leave the late surcharge out.',
        },
      },
      required: ['cc'],
      additionalProperties: false,
    },
    route: { controller: VouchersController, method: 'getArrears' },
    run: async (deps, args, user) => {
      const cc = intArg(args, 'cc');
      const unknown = Object.keys(
        without(args, 'cc', 'fee_date', 'waive_surcharge'),
      );
      if (unknown.length)
        throw new BadRequestException(
          `property ${unknown[0]} should not exist`,
        );
      const feeDate = args.fee_date ?? new Date().toISOString().slice(0, 10);
      if (
        typeof feeDate !== 'string' ||
        !DATE_ONLY.test(feeDate) ||
        Number.isNaN(Date.parse(feeDate))
      ) {
        throw new BadRequestException('fee_date must be YYYY-MM-DD');
      }
      if (
        args.waive_surcharge !== undefined &&
        typeof args.waive_surcharge !== 'boolean'
      ) {
        throw new BadRequestException('waive_surcharge must be true or false');
      }
      return deps
        .controller(VouchersController)
        .getArrears(
          String(cc),
          feeDate,
          user,
          args.waive_surcharge === true ? 'true' : 'false',
        );
    },
  },
  {
    name: 'list_defaulters',
    title: 'Defaulters',
    description:
      'The Financial Reports defaulters list as of a date: students with arrears, how many months behind, and how much. view=by_class / by_campus / aging gives roll-ups instead of students.',
    inputSchema: {
      type: 'object',
      properties: {
        as_of_date: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'YYYY-MM-DD; defaults to today.',
        },
        view: {
          type: 'string',
          enum: ['students', 'by_class', 'by_campus', 'aging'],
        },
        min_months_behind: { type: 'integer', minimum: 1, maximum: 60 },
        max_months_behind: { type: 'integer', minimum: 1, maximum: 60 },
        campus_id: intList('Only these campuses.'),
        class_id: intList('Only these classes.'),
        section_id: intList('Only these sections.'),
        cc: intProp('Only this student.'),
        sort_by: {
          type: 'string',
          enum: [
            'months_behind',
            'arrears_outstanding',
            'oldest_arrear',
            'arrear_head_count',
            'student_name',
          ],
        },
        sort_dir: { type: 'string', enum: ['asc', 'desc'] },
        ...pageProps,
      },
      additionalProperties: false,
    },
    route: { controller: FinancialReportsController, method: 'listDefaulters' },
    run: async (deps, args, user) =>
      deps
        .controller(FinancialReportsController)
        .listDefaulters(
          await asQuery(ListDefaultersQueryDto, clampLimit(args, 25)),
          user,
        ),
  },
  {
    name: 'search_employees',
    title: 'Search employees',
    description:
      'Find staff by name or employee code, within the campuses and departments you can see.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Name or employee code.' },
      },
      required: ['q'],
      additionalProperties: false,
    },
    route: { controller: EmployeesController, method: 'searchSimple' },
    run: async (deps, args, user) => {
      const unknown = Object.keys(without(args, 'q'));
      if (unknown.length)
        throw new BadRequestException(
          `property ${unknown[0]} should not exist`,
        );
      if (typeof args.q !== 'string')
        throw new BadRequestException('q must be text');
      return deps.controller(EmployeesController).searchSimple(args.q, user);
    },
  },
];

export const MCP_TOOLS_BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]));
