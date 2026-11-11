import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { toCategoryRef } from '../students/student-benefits';
import {
  CreateStudentCategoryDto,
  UpdateStudentCategoryDto,
} from './dto/student-category.dto';

/** "Staff Child (50%)" → STAFF_CHILD_50. */
export function codeFromLabel(label: string): string {
  const code = label
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 40)
    .replace(/_+$/g, '');
  return /^[A-Z]/.test(code) ? code : `CAT_${code}`.slice(0, 40);
}

/**
 * TAFSD-475: the special categories list in School Setup. A category's code is
 * fixed once created (reports, filters and the flat API keys use it); its name,
 * description, colour and order can change. A category anyone holds or held
 * can only be retired, not deleted.
 */
@Injectable()
export class StudentCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** Every category with how many students hold it now. */
  async findAll(includeRetired = true) {
    const rows = await this.prisma.student_categories.findMany({
      where: includeRetired ? {} : { is_active: true },
      orderBy: [{ display_order: 'asc' }, { label: 'asc' }],
      include: { _count: { select: { student_category_assignments: true } } },
    });
    return rows.map((r) => ({
      ...toCategoryRef(r),
      code: r.code,
      student_count: r._count.student_category_assignments,
    }));
  }

  async create(dto: CreateStudentCategoryDto, changedBy: string) {
    const label = dto.label.trim();
    const code = dto.code ?? codeFromLabel(label);
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code))
      throw new BadRequestException('Give the category a name with letters in it');
    const clash = await this.prisma.student_categories.findFirst({
      where: {
        OR: [{ code }, { label: { equals: label, mode: 'insensitive' } }],
      },
      select: { label: true, code: true },
    });
    if (clash)
      throw new ConflictException(
        clash.code === code
          ? `A category with the code ${code} already exists (${clash.label})`
          : `A category called "${clash.label}" already exists`,
      );
    const last = await this.prisma.student_categories.aggregate({
      _max: { display_order: true },
    });
    const record = await this.prisma.student_categories.create({
      data: {
        code,
        label,
        description: dto.description?.trim() || null,
        tone: dto.tone ?? 'slate',
        display_order: dto.display_order ?? (last._max.display_order ?? 0) + 10,
      },
    });
    void this.auditLogs.log({
      entity_type: 'STUDENT_CATEGORY',
      entity_id: String(record.id),
      action: 'CREATED',
      section: 'school-setup',
      new_value: `${record.label} (${record.code})`,
      changed_by: changedBy,
    });
    return toCategoryRef(record);
  }

  async update(id: number, dto: UpdateStudentCategoryDto, changedBy: string) {
    const before = await this.prisma.student_categories.findUnique({ where: { id } });
    if (!before) throw new NotFoundException(`Category #${id} not found`);
    const label = dto.label?.trim();
    if (label && label.toLowerCase() !== before.label.toLowerCase()) {
      const clash = await this.prisma.student_categories.findFirst({
        where: { id: { not: id }, label: { equals: label, mode: 'insensitive' } },
        select: { id: true },
      });
      if (clash) throw new ConflictException(`A category called "${label}" already exists`);
    }
    const data = {
      ...(label !== undefined ? { label } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description?.trim() || null }
        : {}),
      ...(dto.tone !== undefined ? { tone: dto.tone } : {}),
      ...(dto.display_order !== undefined ? { display_order: dto.display_order } : {}),
      ...(dto.is_active !== undefined ? { is_active: dto.is_active } : {}),
    };
    const record = await this.prisma.student_categories.update({ where: { id }, data });
    const changes = (Object.keys(data) as (keyof typeof data)[])
      .filter((k) => String(before[k] ?? '') !== String(record[k] ?? ''))
      .map((k) => ({
        entity_type: 'STUDENT_CATEGORY',
        entity_id: String(id),
        action: k === 'is_active' ? (record.is_active ? 'RESTORED' : 'RETIRED') : 'UPDATED',
        section: 'school-setup',
        field: `student_category.${k}`,
        old_value: before[k] == null ? null : String(before[k]),
        new_value: record[k] == null ? null : String(record[k]),
        changed_by: changedBy,
        note: before.label,
      }));
    if (changes.length) void this.auditLogs.logMany(changes);
    return toCategoryRef(record);
  }

  /** Only a category nobody holds. Otherwise retire it. */
  async remove(id: number, changedBy: string) {
    const cat = await this.prisma.student_categories.findUnique({
      where: { id },
      include: { _count: { select: { student_category_assignments: true } } },
    });
    if (!cat) throw new NotFoundException(`Category #${id} not found`);
    if (cat._count.student_category_assignments > 0)
      throw new ConflictException(
        `${cat._count.student_category_assignments} student(s) hold ${cat.label}. Retire it instead, or take it off those students first.`,
      );
    await this.prisma.student_categories.delete({ where: { id } });
    void this.auditLogs.log({
      entity_type: 'STUDENT_CATEGORY',
      entity_id: String(id),
      action: 'DELETED',
      section: 'school-setup',
      old_value: `${cat.label} (${cat.code})`,
      changed_by: changedBy,
    });
  }
}
