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
