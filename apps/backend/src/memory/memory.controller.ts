import { Controller, Get, Param, UseGuards, Request } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { MemoryService } from './memory.service';

@Controller('memory')
@UseGuards(AuthGuard('jwt'))
export class MemoryController {
  constructor(private memoryService: MemoryService) {}

  @Get('knowledge')
  getKnowledge(@Request() req: { user: { id: string } }) {
    return this.memoryService.getKnowledgeList(req.user.id);
  }

  @Get('knowledge/:id')
  getKnowledgeDetail(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.memoryService.getKnowledgeDetail(req.user.id, id);
  }

  @Get('knowledge/:id/history')
  getKnowledgeHistory(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.memoryService.getKnowledgeHistory(req.user.id, id);
  }

  @Get('content/:id/messages')
  getContentMessages(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.memoryService.getContentMessages(req.user.id, id);
  }
}
