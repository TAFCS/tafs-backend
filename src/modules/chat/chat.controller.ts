import { Controller, Get, Post, Param, Query, UseGuards, UseInterceptors, UploadedFile, ParseIntPipe, BadRequestException, Res } from '@nestjs/common';
import { ChatService } from './chat.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { CurrentUser } from '../../decorators/current-user.decorator';

@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('inbox')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Get all conversations for admin inbox' })
  getInbox() {
    return this.chatService.getAdminInbox();
  }

  @Get('family/:familyId/students')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Get all students belonging to a family' })
  getFamilyStudents(@Param('familyId', ParseIntPipe) familyId: number) {
    return this.chatService.getFamilyStudents(familyId);
  }

  @Get('history/admin/:familyId')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Admin fetch chat history with a family' })
  getAdminChatHistory(
    @Param('familyId', ParseIntPipe) familyId: number,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.chatService.getChatHistory(familyId, take ? parseInt(take) : 50, skip ? parseInt(skip) : 0);
  }

  @Get('history/parent')
  @UseGuards(JwtParentGuard)
  @ApiOperation({ summary: 'Parent fetch their own chat history' })
  getParentChatHistory(
    @CurrentUser() user: any,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const familyId = user.familyId; 
    return this.chatService.getChatHistory(familyId, take ? parseInt(take) : 50, skip ? parseInt(skip) : 0);
  }

  @Post('media')
  @ApiOperation({ summary: 'Upload an image/voice note and get the CDN URL' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } })) // 10MB
  uploadMedia(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.chatService.uploadMedia(file);
  }

  @Get('media/proxy')
  @ApiOperation({ summary: 'Proxy media to bypass CORS' })
  async proxyMedia(
    @Query('key') key: string,
    @Res() res: any,
  ) {
    const { buffer, mime } = await this.chatService.getMediaFile(key);
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'public, max-age=31536000');
    res.send(buffer);
  }
}
