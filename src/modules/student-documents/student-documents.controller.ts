import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { isSuperAdmin } from '../../common/auth/super-admin';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { RequireAction, RequireAnyAction } from '../../decorators/require-action.decorator';
import { createApiResponse } from '../../utils/serializer.util';
import { actionsCover } from '../access/tiles.manifest';
import { Action } from '../auth/casl/actions';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import {
  ActivityQueryDto,
  ArchiveDocumentDto,
  CreateDocumentTypeDto,
  LinkQueryDto,
  MissingQueryDto,
  SummaryQueryDto,
  UpdateDocumentTypeDto,
  UploadDocumentDto,
} from './dto/student-documents.dto';
import { StudentDocumentsService, type VaultPerms } from './student-documents.service';
import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD, vaultAction } from './vault-rules';

const canRead = (ability: any) => ability.can(Action.Read, 'Student');

/**
 * Student document vault (TAFSD-498). Tile `student.documents`, used by the
 * Student Documents page and the Documents tab of the student panel. Every
 * route is held to the caller's student scope in the service.
 */
@ApiTags('Student Documents')
@Controller('student-documents')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class StudentDocumentsController {
  constructor(private readonly service: StudentDocumentsService) {}

  private perms(user: IJwtStaffPayload): VaultPerms {
    if (isSuperAdmin(user)) return { upload: true, replace: true, archive: true, viewRestricted: true };
    const held = new Set(user.actions ?? []);
    const has = (id: string) => actionsCover(held, vaultAction(id));
    return {
      upload: has('upload'),
      replace: has('replace'),
      archive: has('archive'),
      viewRestricted: has('view_restricted'),
    };
  }

  // ─── Types ──────────────────────────────────────────────────────────────

  @Get('types')
  @ApiOperation({ summary: 'Document types, with how many documents are filed under each' })
  @CheckPolicies(canRead)
  @RequireAnyAction(vaultAction('view'), vaultAction('manage_types'))
  async types(@Query('include_inactive') includeInactive?: string) {
    const rows = await this.service.listTypes(includeInactive !== 'false');
    return createApiResponse(rows, HttpStatus.OK, 'Document types fetched');
  }

  @Post('types')
  @ApiOperation({ summary: 'Add a document type' })
  @CheckPolicies(canRead)
  @RequireAction(vaultAction('manage_types'))
  async createType(@Body() dto: CreateDocumentTypeDto, @CurrentUser() user: IJwtStaffPayload) {
    const row = await this.service.createType(dto, user.username || user.sub);
    return createApiResponse(row, HttpStatus.CREATED, 'Document type added');
  }

  @Patch('types/:id')
  @ApiOperation({ summary: 'Rename, reorder, require, restrict or retire a document type' })
  @CheckPolicies(canRead)
  @RequireAction(vaultAction('manage_types'))
  async updateType(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDocumentTypeDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const row = await this.service.updateType(id, dto, user.username || user.sub);
    return createApiResponse(row, HttpStatus.OK, 'Document type saved');
  }

  // ─── Reading ────────────────────────────────────────────────────────────

  @Get('summary')
  @ApiOperation({ summary: 'Required-document completeness for a list of students (search results)' })
  @CheckPolicies(canRead)
  @RequireAction(vaultAction('view'))
  async summary(@Query() query: SummaryQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    const rows = await this.service.summary(query.ccs, user);
    return createApiResponse(rows, HttpStatus.OK, 'Summary fetched');
  }

  @Get('missing')
  @ApiOperation({ summary: 'Students missing a required document, with totals per type' })
  @CheckPolicies(canRead)
  @RequireAction(vaultAction('view'))
  async missing(@Query() query: MissingQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    if (query.all && !isSuperAdmin(user) && !actionsCover(new Set(user.actions ?? []), vaultAction('export'))) {
      throw new ForbiddenException(`Missing permission: ${vaultAction('export')}.`);
    }
    const data = await this.service.missingReport(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Missing documents fetched');
  }

  @Get('activity')
  @ApiOperation({ summary: 'Recent uploads, replacements and archives' })
  @CheckPolicies(canRead)
  @RequireAction(vaultAction('view'))
  async activity(@Query() query: ActivityQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    const rows = await this.service.activity(query, user);
    return createApiResponse(rows, HttpStatus.OK, 'Activity fetched');
  }

  @Get('students/:cc')
  @ApiOperation({ summary: "A student's vault: their documents, their parents', and what is missing" })
  @CheckPolicies(canRead)
  @RequireAction(vaultAction('view'))
  async vault(@Param('cc', ParseIntPipe) cc: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.service.getVault(cc, user, this.perms(user));
    return createApiResponse(data, HttpStatus.OK, 'Documents fetched');
  }

  @Get('versions/:id/link')
  @ApiOperation({ summary: 'A short-lived link to view or download one version. Logged.' })
  @CheckPolicies(canRead)
  @RequireAction(vaultAction('view'))
  async link(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: LinkQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.link(id, query.disposition ?? 'inline', user, this.perms(user));
    return createApiResponse(data, HttpStatus.OK, 'Link ready');
  }

  // ─── Writing ────────────────────────────────────────────────────────────

  @Post('students/:cc/upload')
  @ApiOperation({ summary: 'File a document, or a clearer copy of one. Several files become one PDF.' })
  @ApiConsumes('multipart/form-data')
  @CheckPolicies(canRead)
  @RequireAnyAction(vaultAction('upload'), vaultAction('replace'))
  @UseInterceptors(FilesInterceptor('files', MAX_FILES_PER_UPLOAD, { limits: { fileSize: MAX_FILE_BYTES } }))
  async upload(
    @Param('cc', ParseIntPipe) cc: number,
    @Body() dto: UploadDocumentDto,
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.upload(cc, dto, files ?? [], user, this.perms(user));
    return createApiResponse(data, HttpStatus.CREATED, data.replaced ? 'New version saved' : 'Document filed');
  }

  @Post(':id/versions/:versionId/make-current')
  @ApiOperation({ summary: 'Bring an older version back as the current one (copied forward, nothing lost)' })
  @CheckPolicies(canRead)
  @RequireAction(vaultAction('replace'))
  async makeCurrent(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.makeCurrent(id, versionId, user, this.perms(user));
    return createApiResponse(data, HttpStatus.OK, 'Version made current');
  }

  @Post(':id/archive')
  @ApiOperation({ summary: 'Archive a document (hidden, never deleted). Reason required.' })
  @CheckPolicies(canRead)
  @RequireAction(vaultAction('archive'))
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ArchiveDocumentDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.service.archive(id, dto.reason, user, this.perms(user));
    return createApiResponse(null, HttpStatus.OK, 'Document archived');
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Bring an archived document back' })
  @CheckPolicies(canRead)
  @RequireAction(vaultAction('archive'))
  async restore(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    await this.service.restore(id, user, this.perms(user));
    return createApiResponse(null, HttpStatus.OK, 'Document restored');
  }
}
