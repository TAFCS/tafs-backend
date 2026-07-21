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
import { CurrentUser } from '../../decorators/current-user.decorator';

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
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Admin: list all posts' })
  adminList(@Query('cursor') cursor?: string) {
    return this.service.getAllPosts(cursor ? parseInt(cursor) : undefined);
  }

  @Post('admin/notice-board')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Admin: create a post' })
  create(@CurrentUser() user: any, @Body() dto: CreatePostDto) {
    return this.service.createPost(user.sub, dto, user.username || user.sub);
  }

  @Patch('admin/notice-board/:id')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Admin: edit / pin / set expiry on a post' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePostDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updatePost(id, dto, user?.username || user?.sub || 'system');
  }

  @Delete('admin/notice-board/:id')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Admin: soft-delete a post' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.deletePost(id, user?.username || user?.sub || 'system');
  }

  @Get('admin/notice-board/:id/reads')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Admin: read analytics for a post' })
  readStats(@Param('id') id: string) {
    return this.service.getReadStats(id);
  }

  @Post('admin/notice-board/upload')
  @UseGuards(JwtStaffGuard)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Admin: upload media for a notice post' })
  uploadMedia(@UploadedFile() file: Express.Multer.File) {
    return this.service.uploadMedia(file);
  }
}
