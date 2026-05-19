import { Controller, Get, UseGuards, Request } from '@nestjs/common';
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
}
