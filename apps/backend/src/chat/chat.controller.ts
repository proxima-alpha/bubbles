import { Controller, Post, Get, Body, UseGuards, Request, Res } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('chat')
@UseGuards(AuthGuard('jwt'))
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('stream')
  sendMessageStream(@Request() req: any, @Body() dto: SendMessageDto, @Res() res: Response) {
    return this.chatService.sendMessageStream(req.user.id, dto, res);
  }

  @Get('history')
  getHistory(@Request() req: any) {
    return this.chatService.getHistory(req.user.id);
  }
}
