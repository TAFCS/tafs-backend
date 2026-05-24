import { Controller, Get, Post, Param, Query, Body, UseGuards, UseInterceptors, UploadedFile, ParseIntPipe, BadRequestException, Res } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { ChatMessageType } from '@prisma/client';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { CurrentUser } from '../../decorators/current-user.decorator';

@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
  ) {}

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

  @Get('students')
  @UseGuards(JwtParentGuard)
  @ApiOperation({ summary: 'Get all students belonging to the current parent' })
  getParentStudents(@CurrentUser() user: any) {
    return this.chatService.getParentStudents(user.familyId);
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
      console.error('[ChatController] Upload failed: No file provided');
      throw new BadRequestException('No file uploaded');
    }
    console.log(`[ChatController] Received file: ${file.originalname} (${file.mimetype}, ${file.size} bytes)`);
    return this.chatService.uploadMedia(file);
  }

  @Post('messages')
  @UseGuards(JwtParentGuard)
  @ApiOperation({ summary: 'Parent sends a chat message (REST fallback, idempotent via mediaMetadata.tempId)' })
  async sendParentMessage(
    @CurrentUser() user: any,
    @Body() body: { messageType: ChatMessageType; content: string; mediaMetadata?: Record<string, unknown> },
  ) {
    const { newMessage, updatedConv, isDuplicate } = await this.chatService.createMessage(user.familyId, {
      senderType: 'GUARDIAN',
      messageType: body.messageType,
      content: body.content,
      mediaMetadata: body.mediaMetadata,
    });

    if (!isDuplicate) {
      await this.chatGateway.broadcastNewMessage(
        user.familyId,
        newMessage,
        updatedConv,
        'GUARDIAN',
        body.messageType,
        body.content,
      );
    }

    return newMessage;
  }

  @Post('mark-read')
  @UseGuards(JwtParentGuard)
  @ApiOperation({ summary: 'Parent marks their messages as read' })
  markParentRead(@CurrentUser() user: any) {
    return this.chatService.markAsRead(user.familyId, 'GUARDIAN');
  }

  @Post('mark-read/admin/:familyId')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Admin marks messages for a family as read' })
  markAdminRead(@Param('familyId', ParseIntPipe) familyId: number) {
    return this.chatService.markAsRead(familyId, 'ADMIN');
  }

  @Post('messages/:messageId/acknowledge')
  @UseGuards(JwtParentGuard)
  @ApiOperation({ summary: 'Parent acknowledges a message that requires acknowledgment' })
  async acknowledgeMessage(
    @Param('messageId') messageId: string,
    @CurrentUser() user: any,
  ) {
    return this.chatService.acknowledgeMessage(messageId, user.familyId);
  }

  @Get('admin/messages/:messageId/acknowledgments')
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Admin: see which families have acknowledged a message' })
  getAcknowledgments(@Param('messageId') messageId: string) {
    return this.chatService.getAcknowledgments(messageId);
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
