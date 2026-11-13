import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type student_status } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { ScopeService } from '../../common/scope/scope.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { codeFromLabel } from '../student-categories/student-categories.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import {
  ActivityQueryDto,
  CreateDocumentTypeDto,
  MissingQueryDto,
  UpdateDocumentTypeDto,
  UploadDocumentDto,
} from './dto/student-documents.dto';
import {
  checkUploadBatch,
  DEFAULT_MISSING_STATUSES,
  missingFor,
  prepareUpload,
  requiredSlotCount,
  slug,
  type GuardianLink,
  type HeldDoc,
  type RequiredType,
  type UploadFile,
} from './vault-rules';

const ENTITY = 'STUDENT_DOCUMENT';
const LINK_TTL_SECONDS = 300;

/** What the caller may do, resolved once by the controller from their actions. */
export type VaultPerms = {
  upload: boolean;
  replace: boolean;
  archive: boolean;
  viewRestricted: boolean;
};

const STUDENT_HEADER_SELECT = {
  cc: true,
  full_name: true,
  gr_number: true,
  photograph_url: true,
  status: true,
  campus_id: true,
  class_id: true,
  section_id: true,
  classes: { select: { description: true, segment_id: true } },
  sections: { select: { description: true } },
  campuses: { select: { campus_name: true } },
} satisfies Prisma.studentsSelect;

const VERSION_SELECT = {
  id: true,
  version_no: true,
  mime_type: true,
  size_bytes: true,
  original_filename: true,
  page_count: true,
  channel: true,
  note: true,
  uploaded_by: true,
  uploaded_at: true,
} satisfies Prisma.student_document_versionsSelect;

/**
 * Student document vault (Academics plan §5, TAFSD-498). Every document on a
 * student in one place. Files sit in private storage and are only reached
 * through a short-lived signed link minted here after a scope check. Versions
 * are append-only: a clearer copy is a new version, "make current" copies an
 * old one forward, archiving hides a document without deleting anything.
 */
@Injectable()
export class StudentDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly scope: ScopeService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ─── Types ──────────────────────────────────────────────────────────────

  async listTypes(includeInactive = true) {
    const rows = await this.prisma.student_document_types.findMany({
      where: includeInactive ? {} : { is_active: true },
      orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { student_documents: { where: { archived_at: null } } } },
      },
    });
    return rows.map(({ _count, ...t }) => ({ ...t, document_count: _count.student_documents }));
  }

  async createType(dto: CreateDocumentTypeDto, by: string) {
    const name = dto.name.trim();
    const code = dto.code ?? codeFromLabel(name);
    const clash = await this.prisma.student_document_types.findFirst({
      where: { OR: [{ code }, { name: { equals: name, mode: 'insensitive' }, owner: dto.owner ?? 'STUDENT' }] },
      select: { id: true },
    });
    if (clash) throw new ConflictException(`A document type called ${name} already exists`);
    const max = await this.prisma.student_document_types.aggregate({ _max: { display_order: true } });
    const row = await this.prisma.student_document_types.create({
      data: {
        code,
        name,
        description: dto.description?.trim() || null,
        owner: dto.owner ?? 'STUDENT',
        origin: 'PROVIDED',
        allow_multiple: dto.allow_multiple ?? false,
        required_at_admission: dto.required_at_admission ?? false,
        restricted: dto.restricted ?? false,
        display_order: dto.display_order ?? (max._max.display_order ?? 0) + 10,
      },
    });
    await this.auditLogs.log({
      entity_type: ENTITY,
      entity_id: `type:${row.id}`,
      action: 'CREATED',
      changed_by: by,
      note: `Added document type ${row.name} (${row.owner === 'GUARDIAN' ? 'parent' : 'student'} document).`,
    });
    return row;
  }

  async updateType(id: number, dto: UpdateDocumentTypeDto, by: string) {
    const type = await this.prisma.student_document_types.findUnique({ where: { id } });
    if (!type) throw new NotFoundException('Document type not found');
    if (type.origin === 'GENERATED' && dto.required_at_admission) {
      throw new BadRequestException('Documents the school issues cannot be required at admission');
    }
    if (dto.allow_multiple === false && type.allow_multiple) {
      const dup = await this.prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM (
          SELECT 1 FROM student_documents
          WHERE type_id = ${id} AND archived_at IS NULL
          GROUP BY COALESCE(student_id, 0), COALESCE(guardian_id, 0)
          HAVING COUNT(*) > 1
        ) x`;
      if ((dup[0]?.n ?? 0) > 0) {
        throw new ConflictException(
          `${dup[0].n} student(s) hold more than one ${type.name}. Archive the extras before allowing only one.`,
        );
      }
    }
    const row = await this.prisma.student_document_types.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        description: dto.description === undefined ? undefined : dto.description?.trim() || null,
        allow_multiple: type.origin === 'GENERATED' ? undefined : dto.allow_multiple,
        required_at_admission: dto.required_at_admission,
        restricted: dto.restricted,
        is_active: dto.is_active,
        display_order: dto.display_order,
      },
    });
    const changed = Object.entries(dto)
      .filter(([k, v]) => v !== undefined && (type as Record<string, unknown>)[k] !== v)
      .map(([k]) => k.replace(/_/g, ' '));
    if (changed.length) {
      await this.auditLogs.log({
        entity_type: ENTITY,
        entity_id: `type:${id}`,
        action: 'UPDATED',
        changed_by: by,
        note: `Changed document type ${row.name}: ${changed.join(', ')}.`,
      });
    }
    return row;
  }

  // ─── Reading a student's vault ──────────────────────────────────────────

  /** The student, if the caller's scope reaches them. Missing and out of reach both 404. */
  private async scopedStudent(cc: number, user: IJwtStaffPayload) {
    const student = await this.prisma.students.findFirst({
      where: { cc, deleted_at: null, ...this.scope.whereForStudents(user) },
      select: STUDENT_HEADER_SELECT,
    });
    if (!student) throw new NotFoundException(`Student #${cc} not found`);
    return student;
  }

  private async guardianLinks(cc: number) {
    const rows = await this.prisma.student_guardians.findMany({
      where: { student_id: cc },
      select: {
        guardian_id: true,
        relationship: true,
        is_primary_contact: true,
        guardians: { select: { full_name: true } },
      },
    });
    const order = (r: string) => {
      const u = r.trim().toUpperCase();
      return u === 'FATHER' ? 0 : u === 'MOTHER' ? 1 : 2;
    };
    return rows.sort((a, b) => order(a.relationship) - order(b.relationship));
  }

  private async requiredTypes(): Promise<RequiredType[]> {
    return this.prisma.student_document_types.findMany({
      where: { is_active: true, required_at_admission: true },
      orderBy: [{ display_order: 'asc' }],
      select: { id: true, code: true, name: true, owner: true },
    });
  }

  async getVault(cc: number, user: IJwtStaffPayload, perms: VaultPerms) {
    const student = await this.scopedStudent(cc, user);
    const links = await this.guardianLinks(cc);
    const guardianIds = links.map((l) => l.guardian_id);

    const [types, docs, required] = await Promise.all([
      this.prisma.student_document_types.findMany({ orderBy: [{ display_order: 'asc' }, { name: 'asc' }] }),
      this.prisma.student_documents.findMany({
        where: {
          OR: [{ student_id: cc }, ...(guardianIds.length ? [{ guardian_id: { in: guardianIds } }] : [])],
        },
        orderBy: [{ created_at: 'desc' }],
        include: { versions: { orderBy: { version_no: 'desc' }, select: VERSION_SELECT } },
      }),
      this.requiredTypes(),
    ]);

    const restrictedTypeIds = new Set(types.filter((t) => t.restricted).map((t) => t.id));
    const visibleDocs = docs.filter((d) => perms.viewRestricted || !restrictedTypeIds.has(d.type_id));
    const hiddenRestricted = docs.length - visibleDocs.length;

    const held: HeldDoc[] = docs.filter((d) => !d.archived_at);
    const guardianLinks: GuardianLink[] = links.map((l) => ({ ...l, full_name: l.guardians?.full_name }));
    const missing = missingFor(cc, required, guardianLinks, held);
    const requiredCount = requiredSlotCount(required, guardianLinks);

    return {
      student: {
        cc: student.cc,
        full_name: student.full_name,
        gr_number: student.gr_number,
        photograph_url: student.photograph_url,
        status: student.status,
        class_name: student.classes?.description ?? null,
        section_name: student.sections?.description ?? null,
        campus_name: student.campuses?.campus_name ?? null,
      },
      guardians: links.map((l) => ({
        id: l.guardian_id,
        full_name: l.guardians?.full_name ?? null,
        relationship: l.relationship,
        is_primary_contact: !!l.is_primary_contact,
      })),
      // Inactive types only matter where something is already filed under them.
      types: types
        .filter((t) => t.is_active || docs.some((d) => d.type_id === t.id))
        .map((t) => ({ ...t, locked: t.restricted && !perms.viewRestricted })),
      documents: visibleDocs.map((d) => ({
        id: d.id,
        type_id: d.type_id,
        student_id: d.student_id,
        guardian_id: d.guardian_id,
        title: d.title,
        academic_year: d.academic_year,
        source_ref: d.source_ref,
        archived_at: d.archived_at,
        archived_by: d.archived_by,
        archive_reason: d.archive_reason,
        created_by: d.created_by,
        created_at: d.created_at,
        current: d.versions[0] ?? null,
        versions: d.versions,
      })),
      hidden_restricted_count: hiddenRestricted,
      missing,
      completeness: { required: requiredCount, on_file: requiredCount - missing.length },
      permissions: perms,
    };
  }

  /** Required-document completeness for a handful of students (search results). */
  async summary(ccs: number[], user: IJwtStaffPayload) {
    const ids = [...new Set(ccs)].slice(0, 100);
    if (!ids.length) return [];
    const students = await this.prisma.students.findMany({
      where: { cc: { in: ids }, deleted_at: null, ...this.scope.whereForStudents(user) },
      select: { cc: true },
    });
    const visible = students.map((s) => s.cc);
    const { required, linksByCc, heldByCc } = await this.loadCompleteness(visible);
    return visible.map((cc) => {
      const links = linksByCc.get(cc) ?? [];
      const missing = missingFor(cc, required, links, heldByCc.get(cc) ?? []);
      const req = requiredSlotCount(required, links);
      return { cc, required: req, on_file: req - missing.length, missing: missing.map((m) => m.label) };
    });
  }

  private async loadCompleteness(ccs: number[]) {
    const required = await this.requiredTypes();
    const linkRows = ccs.length
      ? await this.prisma.student_guardians.findMany({
          where: { student_id: { in: ccs } },
          select: { student_id: true, guardian_id: true, relationship: true, is_primary_contact: true },
        })
      : [];
    const guardianIds = [...new Set(linkRows.map((l) => l.guardian_id))];
    const requiredIds = required.map((t) => t.id);
    const docRows = ccs.length && requiredIds.length
      ? await this.prisma.student_documents.findMany({
          where: {
            archived_at: null,
            type_id: { in: requiredIds },
            OR: [
              { student_id: { in: ccs } },
              ...(guardianIds.length ? [{ guardian_id: { in: guardianIds } }] : []),
            ],
          },
          select: { type_id: true, student_id: true, guardian_id: true },
        })
      : [];

    const linksByCc = new Map<number, GuardianLink[]>();
    for (const l of linkRows) {
      const list = linksByCc.get(l.student_id) ?? [];
      list.push(l);
      linksByCc.set(l.student_id, list);
    }
    const byGuardian = new Map<number, HeldDoc[]>();
    const heldByCc = new Map<number, HeldDoc[]>();
    for (const d of docRows) {
      if (d.student_id != null) {
        const list = heldByCc.get(d.student_id) ?? [];
        list.push(d);
        heldByCc.set(d.student_id, list);
      } else if (d.guardian_id != null) {
        const list = byGuardian.get(d.guardian_id) ?? [];
        list.push(d);
        byGuardian.set(d.guardian_id, list);
      }
    }
    for (const cc of ccs) {
      const own = heldByCc.get(cc) ?? [];
      const theirs = (linksByCc.get(cc) ?? []).flatMap((l) => byGuardian.get(l.guardian_id) ?? []);
      heldByCc.set(cc, [...own, ...theirs]);
    }
    return { required, linksByCc, heldByCc };
  }

  // ─── Missing documents report ───────────────────────────────────────────

  async missingReport(query: MissingQueryDto, user: IJwtStaffPayload) {
    const statuses = (query.statuses?.length ? query.statuses : [...DEFAULT_MISSING_STATUSES]) as student_status[];
    const where: Prisma.studentsWhereInput = {
      deleted_at: null,
      status: { in: statuses },
      ...(query.campus_ids?.length ? { campus_id: { in: query.campus_ids } } : {}),
      ...(query.class_ids?.length ? { class_id: { in: query.class_ids } } : {}),
      ...(query.section_ids?.length ? { section_id: { in: query.section_ids } } : {}),
    };
    const q = query.q?.trim();
    if (q) {
      const or: Prisma.studentsWhereInput[] = [
        { full_name: { contains: q, mode: 'insensitive' } },
        { gr_number: { contains: q, mode: 'insensitive' } },
      ];
      if (/^\d+$/.test(q) && Number(q) <= 2147483647) or.push({ cc: Number(q) });
      where.OR = or;
    }

    const students = await this.prisma.students.findMany({
      where: { AND: [where, this.scope.whereForStudents(user)] },
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
        status: true,
        photograph_url: true,
        classes: { select: { id: true, description: true } },
        sections: { select: { id: true, description: true } },
        campuses: { select: { campus_name: true } },
      },
      orderBy: [{ class_id: 'asc' }, { section_id: 'asc' }, { full_name: 'asc' }],
    });

    const { required, linksByCc, heldByCc } = await this.loadCompleteness(students.map((s) => s.cc));
    const focus = query.type_ids?.length ? new Set(query.type_ids) : null;

    const typeTotals = new Map<number, number>(required.map((t) => [t.id, 0]));
    const rows: Array<Record<string, unknown>> = [];
    let complete = 0;
    for (const s of students) {
      const links = linksByCc.get(s.cc) ?? [];
      const missing = missingFor(s.cc, required, links, heldByCc.get(s.cc) ?? []);
      if (!missing.length) {
        complete += 1;
        continue;
      }
      for (const typeId of new Set(missing.map((m) => m.type_id))) {
        typeTotals.set(typeId, (typeTotals.get(typeId) ?? 0) + 1);
      }
      if (focus && !missing.some((m) => focus.has(m.type_id))) continue;
      const req = requiredSlotCount(required, links);
      rows.push({
        cc: s.cc,
        full_name: s.full_name,
        gr_number: s.gr_number,
        status: s.status,
        photograph_url: s.photograph_url,
        campus_name: s.campuses?.campus_name ?? null,
        class_name: s.classes?.description ?? null,
        section_name: s.sections?.description ?? null,
        required: req,
        on_file: req - missing.length,
        missing,
      });
    }

    const limit = Math.min(query.limit ?? 50, 200);
    const page = query.page ?? 1;
    const items = query.all ? rows : rows.slice((page - 1) * limit, page * limit);
    return {
      items,
      meta: {
        total: rows.length,
        page: query.all ? 1 : page,
        limit: query.all ? rows.length : limit,
        students_checked: students.length,
        students_complete: complete,
      },
      by_type: required.map((t) => ({
        type_id: t.id,
        type_code: t.code,
        name: t.name,
        owner: t.owner,
        students_missing: typeTotals.get(t.id) ?? 0,
      })),
    };
  }

  // ─── Recent activity ────────────────────────────────────────────────────

  async activity(query: ActivityQueryDto, user: IJwtStaffPayload) {
    const limit = Math.min(query.limit ?? 50, 100);
    const scopeWhere = this.scope.whereForStudents(user);
    const rows = await this.prisma.audit_logs.findMany({
      where: {
        entity_type: ENTITY,
        action: { in: ['UPLOADED', 'REPLACED', 'ARCHIVED', 'RESTORED', 'MADE_CURRENT'] },
        student_id: { not: null },
        ...(Object.keys(scopeWhere).length ? { students: scopeWhere } : {}),
        ...(query.before ? { id: { lt: query.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
      select: {
        id: true,
        action: true,
        note: true,
        changed_by: true,
        changed_at: true,
        student_id: true,
        students: {
          select: {
            full_name: true,
            gr_number: true,
            classes: { select: { description: true } },
            sections: { select: { description: true } },
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      note: r.note,
      changed_by: r.changed_by,
      changed_at: r.changed_at,
      cc: r.student_id,
      full_name: r.students?.full_name ?? null,
      gr_number: r.students?.gr_number ?? null,
      class_name: r.students?.classes?.description ?? null,
      section_name: r.students?.sections?.description ?? null,
    }));
  }

  // ─── Writing ────────────────────────────────────────────────────────────

  async upload(cc: number, dto: UploadDocumentDto, files: UploadFile[], user: IJwtStaffPayload, perms: VaultPerms) {
    const by = user.username || user.sub;
    const student = await this.scopedStudent(cc, user);

    const problem = checkUploadBatch(files);
    if (problem) throw new BadRequestException(problem);

    const type = await this.prisma.student_document_types.findUnique({ where: { id: dto.type_id } });
    if (!type || !type.is_active) throw new BadRequestException('Choose a document type');
    if (type.origin === 'GENERATED') {
      throw new BadRequestException(`${type.name} is issued by the system and filed automatically`);
    }
    if (type.restricted && !perms.viewRestricted) {
      throw new ForbiddenException(`You can't file ${type.name} documents`);
    }

    // Who the document belongs to.
    let guardianId: number | null = null;
    let ownerLabel = student.full_name;
    if (type.owner === 'GUARDIAN') {
      if (!dto.guardian_id) throw new BadRequestException(`Choose whose ${type.name} this is`);
      const link = await this.prisma.student_guardians.findUnique({
        where: { student_id_guardian_id: { student_id: cc, guardian_id: dto.guardian_id } },
        select: { relationship: true, guardians: { select: { full_name: true } } },
      });
      if (!link) throw new BadRequestException('That guardian is not linked to this student');
      guardianId = dto.guardian_id;
      ownerLabel = `${link.guardians?.full_name ?? 'Guardian'} (${link.relationship})`;
    } else if (dto.guardian_id) {
      throw new BadRequestException(`${type.name} belongs to the student, not a guardian`);
    }

    const ownerWhere = guardianId ? { guardian_id: guardianId } : { student_id: cc };

    let prepared;
    try {
      prepared = await prepareUpload(files, slug(`${type.name}-${guardianId ? ownerLabel : student.full_name}`));
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    const folder = guardianId ? `vault/guardians/${guardianId}` : `vault/students/${cc}`;
    const key = `${folder}/${slug(type.code)}/${Date.now()}-${prepared.sha256.slice(0, 16)}.${prepared.extension}`;

    const result = await this.prisma.$transaction(async (tx) => {
      // One writer per (type, owner) at a time, so two desks can't both create
      // the "only" B-Form for the same student.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sdv:${type.id}:${guardianId ? `g${guardianId}` : `s${cc}`}`}))`;

      let doc = dto.document_id
        ? await tx.student_documents.findFirst({ where: { id: dto.document_id, type_id: type.id, ...ownerWhere } })
        : null;
      if (dto.document_id && !doc) throw new NotFoundException('That document is not on this student');
      if (doc?.archived_at) throw new BadRequestException('Restore the document before adding a version');
      if (!doc && !type.allow_multiple) {
        doc = await tx.student_documents.findFirst({ where: { type_id: type.id, archived_at: null, ...ownerWhere } });
      }

      const isReplace = !!doc;
      if (isReplace && !perms.replace) throw new ForbiddenException('You can add documents but not replace them');
      if (!isReplace && !perms.upload) throw new ForbiddenException('You can replace documents but not add new ones');

      if (doc) {
        const current = await tx.student_document_versions.findFirst({
          where: { document_id: doc.id },
          orderBy: { version_no: 'desc' },
          select: { sha256: true, version_no: true },
        });
        if (current?.sha256 === prepared.sha256) {
          throw new ConflictException('This exact file is already the current version');
        }
      } else {
        doc = await tx.student_documents.create({
          data: {
            type_id: type.id,
            ...ownerWhere,
            title: dto.title?.trim() || null,
            academic_year: dto.academic_year?.trim() || null,
            created_by: by,
          },
        });
      }

      const last = await tx.student_document_versions.aggregate({
        where: { document_id: doc.id },
        _max: { version_no: true },
      });
      const versionNo = (last._max.version_no ?? 0) + 1;
      // Upload inside the lock, after every check has passed, so a refused
      // upload leaves nothing in storage.
      await this.storage.uploadPrivate(key, prepared.buffer, prepared.mime);
      const version = await tx.student_document_versions.create({
        data: {
          document_id: doc.id,
          version_no: versionNo,
          storage_key: key,
          mime_type: prepared.mime,
          size_bytes: prepared.buffer.length,
          sha256: prepared.sha256,
          original_filename: files.length === 1 ? files[0].originalname?.slice(0, 255) : prepared.filename,
          page_count: prepared.pageCount,
          channel: 'DESK_UPLOAD',
          note: dto.note?.trim() || null,
          uploaded_by: by,
        },
        select: VERSION_SELECT,
      });
      if (isReplace && (dto.title !== undefined || dto.academic_year !== undefined)) {
        await tx.student_documents.update({
          where: { id: doc.id },
          data: {
            ...(dto.title !== undefined ? { title: dto.title.trim() || null } : {}),
            ...(dto.academic_year !== undefined ? { academic_year: dto.academic_year.trim() || null } : {}),
          },
        });
      }
      return { documentId: doc.id, version, isReplace };
    }, { timeout: 30000 });

    const merged = files.length > 1 ? ` (${files.length} files combined into one PDF)` : '';
    await this.auditLogs.log({
      entity_type: ENTITY,
      entity_id: String(result.documentId),
      action: result.isReplace ? 'REPLACED' : 'UPLOADED',
      field: type.code,
      changed_by: by,
      student_id: cc,
      note: result.isReplace
        ? `New version ${result.version.version_no} of ${type.name} for ${ownerLabel}${merged}.${dto.note ? ` Note: ${dto.note.trim()}` : ''}`
        : `Filed ${type.name}${dto.title ? ` "${dto.title.trim()}"` : ''} for ${ownerLabel}${merged}.`,
    });

    return { document_id: result.documentId, version: result.version, replaced: result.isReplace };
  }

  /** The document, if the caller's scope reaches any student it belongs to. Returns that student's cc. */
  private async scopedDocument(documentId: number, user: IJwtStaffPayload) {
    const doc = await this.prisma.student_documents.findUnique({
      where: { id: documentId },
      include: { type: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    const scopeWhere = this.scope.whereForStudents(user);
    let cc: number | null = null;
    let ownerLabel = '';
    if (doc.student_id != null) {
      const s = await this.prisma.students.findFirst({
        where: { cc: doc.student_id, deleted_at: null, ...scopeWhere },
        select: { cc: true, full_name: true },
      });
      cc = s?.cc ?? null;
      ownerLabel = s?.full_name ?? '';
    } else if (doc.guardian_id != null) {
      const link = await this.prisma.student_guardians.findFirst({
        where: { guardian_id: doc.guardian_id, students: { deleted_at: null, ...scopeWhere } },
        select: { student_id: true, relationship: true, guardians: { select: { full_name: true } } },
      });
      cc = link?.student_id ?? null;
      ownerLabel = link ? `${link.guardians?.full_name ?? 'Guardian'} (${link.relationship})` : '';
    }
    if (cc == null) throw new NotFoundException('Document not found');
    return { doc, cc, ownerLabel };
  }

  async link(versionId: number, disposition: 'inline' | 'attachment', user: IJwtStaffPayload, perms: VaultPerms) {
    const version = await this.prisma.student_document_versions.findUnique({ where: { id: versionId } });
    if (!version) throw new NotFoundException('Document not found');
    const { doc, cc, ownerLabel } = await this.scopedDocument(version.document_id, user);
    if (doc.type.restricted && !perms.viewRestricted) throw new NotFoundException('Document not found');

    const ext = version.mime_type === 'application/pdf' ? 'pdf' : version.mime_type === 'image/png' ? 'png' : 'jpg';
    const filename = `${slug(`${ownerLabel}-${doc.type.name}${doc.title ? `-${doc.title}` : ''}`)}-v${version.version_no}.${ext}`;
    const url = await this.storage.getSignedUrl(version.storage_key, LINK_TTL_SECONDS, {
      disposition,
      filename,
      contentType: version.mime_type,
    });
    await this.auditLogs.log({
      entity_type: ENTITY,
      entity_id: String(doc.id),
      action: disposition === 'attachment' ? 'DOWNLOADED' : 'VIEWED',
      field: doc.type.code,
      changed_by: user.username || user.sub,
      student_id: cc,
      note: `${disposition === 'attachment' ? 'Downloaded' : 'Viewed'} ${doc.type.name} version ${version.version_no} of ${ownerLabel}.`,
    });
    return { url, filename, mime_type: version.mime_type, expires_in: LINK_TTL_SECONDS };
  }

  /** Copies an older version forward as the newest one. Nothing is overwritten. */
  async makeCurrent(documentId: number, versionId: number, user: IJwtStaffPayload, perms: VaultPerms) {
    const { doc, cc, ownerLabel } = await this.scopedDocument(documentId, user);
    if (doc.type.restricted && !perms.viewRestricted) throw new NotFoundException('Document not found');
    if (doc.archived_at) throw new BadRequestException('Restore the document first');
    const by = user.username || user.sub;
    const created = await this.prisma.$transaction(async (tx) => {
      const versions = await tx.student_document_versions.findMany({
        where: { document_id: documentId },
        orderBy: { version_no: 'desc' },
      });
      const source = versions.find((v) => v.id === versionId);
      if (!source) throw new NotFoundException('That version is not on this document');
      if (versions[0].id === versionId) throw new BadRequestException('That version is already current');
      return tx.student_document_versions.create({
        data: {
          document_id: documentId,
          version_no: versions[0].version_no + 1,
          storage_key: source.storage_key,
          mime_type: source.mime_type,
          size_bytes: source.size_bytes,
          sha256: source.sha256,
          original_filename: source.original_filename,
          page_count: source.page_count,
          channel: source.channel,
          note: `Version ${source.version_no} made current again`,
          uploaded_by: by,
        },
        select: VERSION_SELECT,
      });
    });
    await this.auditLogs.log({
      entity_type: ENTITY,
      entity_id: String(documentId),
      action: 'MADE_CURRENT',
      field: doc.type.code,
      changed_by: by,
      student_id: cc,
      note: `Made an older version of ${doc.type.name} current again for ${ownerLabel} (now version ${created.version_no}).`,
    });
    return created;
  }

  async archive(documentId: number, reason: string, user: IJwtStaffPayload, perms: VaultPerms) {
    const { doc, cc, ownerLabel } = await this.scopedDocument(documentId, user);
    if (doc.type.restricted && !perms.viewRestricted) throw new NotFoundException('Document not found');
    if (doc.archived_at) throw new BadRequestException('Already archived');
    if (doc.type.origin === 'GENERATED') {
      throw new BadRequestException(`${doc.type.name} is a record of what the school issued and can't be archived`);
    }
    const by = user.username || user.sub;
    await this.prisma.student_documents.update({
      where: { id: documentId },
      data: { archived_at: new Date(), archived_by: by, archive_reason: reason.trim() },
    });
    await this.auditLogs.log({
      entity_type: ENTITY,
      entity_id: String(documentId),
      action: 'ARCHIVED',
      field: doc.type.code,
      changed_by: by,
      student_id: cc,
      note: `Archived ${doc.type.name}${doc.title ? ` "${doc.title}"` : ''} of ${ownerLabel}. Reason: ${reason.trim()}`,
    });
    return { ok: true };
  }

  async restore(documentId: number, user: IJwtStaffPayload, perms: VaultPerms) {
    const { doc, cc, ownerLabel } = await this.scopedDocument(documentId, user);
    if (doc.type.restricted && !perms.viewRestricted) throw new NotFoundException('Document not found');
    if (!doc.archived_at) throw new BadRequestException('Not archived');
    if (!doc.type.allow_multiple) {
      const other = await this.prisma.student_documents.findFirst({
        where: {
          type_id: doc.type_id,
          archived_at: null,
          ...(doc.guardian_id ? { guardian_id: doc.guardian_id } : { student_id: doc.student_id }),
        },
        select: { id: true },
      });
      if (other) {
        throw new ConflictException(`There is already a ${doc.type.name} on file. Archive it first, or upload this file as a new version of it.`);
      }
    }
    const by = user.username || user.sub;
    await this.prisma.student_documents.update({
      where: { id: documentId },
      data: { archived_at: null, archived_by: null, archive_reason: null },
    });
    await this.auditLogs.log({
      entity_type: ENTITY,
      entity_id: String(documentId),
      action: 'RESTORED',
      field: doc.type.code,
      changed_by: by,
      student_id: cc,
      note: `Restored ${doc.type.name} of ${ownerLabel}.`,
    });
    return { ok: true };
  }
}
