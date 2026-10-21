import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { NoticeBoardService } from './notice-board.service';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { RejectPostDto } from './dto/reject-post.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { Action } from '../auth/casl/actions';

// Parent-facing routes (feed/markRead) stay on JwtParentGuard. The admin
// routes previously had JwtStaffGuard alone — any logged-in staff member
// could post to every family. They now require communication.send_
// announcements (already wired into CASL as 'Chat', already granted only to
// SUPER_ADMIN and CAMPUS_ADMIN in the foundation), plus sub-permissions and
// scope (see NoticeBoardService.assertTargetingInScope).
@ApiTags('Notice Board')
@ApiBearerAuth()
@Controller()
export class NoticeBoardController {
  constructor(private readonly service: NoticeBoardService) {}

  // ── Parent routes ────────────────────────────────────────────────────────

  @Get('notice-board')
  @UseGuards(JwtParentGuard)
  @ApiOperation({ summary: 'Get notice board feed for logged-in family' })
  getFeed(
    @CurrentUser() user: any,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.getPostsForFamily(
      user.familyId,
      cursor ? parseInt(cursor) : undefined,
    );
  }

  @Post('notice-board/:id/read')
  @UseGuards(JwtParentGuard)
  @ApiOperation({ summary: 'Mark a post as read (fire-and-forget)' })
  markRead(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.service.markRead(id, user.familyId);
  }

  // ── Admin routes ─────────────────────────────────────────────────────────

  @Get('admin/notice-board')
  @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Chat'))
  @RequireAction('communication.notice_board#view')
  @ApiOperation({ summary: 'Admin: list all posts' })
  adminList(@Query('cursor') cursor: string | undefined, @CurrentUser() user: any) {
    return this.service.getAllPosts(cursor ? parseInt(cursor) : undefined, user);
  }

  @Post('admin/notice-board')
  @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Chat'))
  @RequireAction('communication.notice_board#create')
  @ApiOperation({ summary: 'Admin: create a post' })
  create(@CurrentUser() user: any, @Body() dto: CreatePostDto) {
    return this.service.createPost(user.sub, dto, auditActorLabel(user), user);
  }

  // ── Review queue ─────────────────────────────────────────────────────────
  // SUPER_ADMIN only (checked in the service): every other poster's notice
  // waits here as PENDING until approved. Declared before the :id routes.

  @Get('admin/notice-board/review')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Superadmin: list posts by review status (default PENDING), searchable by title, body or author' })
  reviewQueue(
    @Query('status') status: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('q') q: string | undefined,
    @CurrentUser() user: any,
  ) {
    return this.service.getReviewQueue(status, cursor ? parseInt(cursor) : undefined, user, q);
  }

  @Get('admin/notice-board/review/count')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Superadmin: number of posts awaiting approval' })
  reviewCount(@CurrentUser() user: any) {
    return this.service.getPendingCount(user);
  }

  @Patch('admin/notice-board/:id/approve')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Superadmin: approve a pending post (publishes and notifies families)' })
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.service.approvePost(id, user, auditActorLabel(user));
  }

  @Patch('admin/notice-board/:id/reject')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Superadmin: reject a pending post with a reason' })
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectPostDto,
    @CurrentUser() user: any,
  ) {
    return this.service.rejectPost(id, dto.reason, user, auditActorLabel(user));
  }

  // TAFSD-404: own pending / rejected notice, with only the create permission.
  @Patch('admin/notice-board/:id/mine')
  @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Chat'))
  @RequireAction('communication.notice_board#create')
  @ApiOperation({ summary: 'Edit your own notice while it awaits approval' })
  updateMine(
    @Param('id') id: string,
    @Body() dto: UpdatePostDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateOwnPost(id, dto, auditActorLabel(user) || 'system', user);
  }

  @Delete('admin/notice-board/:id/mine')
  @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Chat'))
  @RequireAction('communication.notice_board#create')
  @ApiOperation({ summary: 'Delete your own notice while it awaits approval' })
  removeMine(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.deleteOwnPost(id, auditActorLabel(user) || 'system', user);
  }

  @Patch('admin/notice-board/:id')
  @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Chat'))
  @RequireAction('communication.notice_board#edit')
  @ApiOperation({ summary: 'Admin: edit / pin / set expiry on a post' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePostDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updatePost(id, dto, auditActorLabel(user) || 'system', user);
  }

  @Delete('admin/notice-board/:id')
  @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Chat'))
  @RequireAction('communication.notice_board#delete')
  @ApiOperation({ summary: 'Admin: soft-delete a post' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.deletePost(id, auditActorLabel(user) || 'system', user);
  }

  @Get('admin/notice-board/:id/reads')
  @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Chat'))
  @RequireAction('communication.notice_board#view')
  @ApiOperation({ summary: 'Admin: read analytics for a post' })
  readStats(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.getReadStats(id, user);
  }

  @Post('admin/notice-board/upload')
  @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Chat'))
  @RequireAction('communication.notice_board#create')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Admin: upload media for a notice post' })
  uploadMedia(@UploadedFile() file: Express.Multer.File) {
    return this.service.uploadMedia(file);
  }
}
