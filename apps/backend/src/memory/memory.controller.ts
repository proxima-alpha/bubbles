import { Controller, Get, Post, Delete, Patch, Put, Body, Param, UseGuards, Request, Response, HttpCode, NotFoundException } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { MemoryService } from './memory.service';
import { UpdateKnowledgeDto } from './dto/update-knowledge.dto';
import { UpdateMainMemoryDto } from './dto/update-main-memory.dto';
import { ImportKnowledgeDto } from './dto/import-knowledge.dto';

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

  @Delete('knowledge/:id')
  @HttpCode(204)
  deleteKnowledge(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.memoryService.deleteKnowledge(req.user.id, id);
  }

  @Patch('knowledge/:id/pin')
  togglePin(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.memoryService.togglePin(req.user.id, id);
  }

  @Put('knowledge/:id')
  updateKnowledge(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() dto: UpdateKnowledgeDto,
  ) {
    return this.memoryService.updateKnowledge(req.user.id, id, dto.contents, dto.summary);
  }

  @Get('main')
  getMainMemory(@Request() req: { user: { id: string } }) {
    return this.memoryService.getMainMemory(req.user.id);
  }

  @Get('keywords')
  getKeywordDashboard(@Request() req: { user: { id: string } }) {
    return this.memoryService.getKeywordDashboard(req.user.id);
  }

  @Get('keywords/:code/memories')
  getKnowledgeByKeyword(@Request() req: { user: { id: string } }, @Param('code') code: string) {
    return this.memoryService.getKnowledgeByKeyword(req.user.id, code);
  }

  @Put('main')
  updateMainMemory(@Request() req: { user: { id: string } }, @Body() dto: UpdateMainMemoryDto) {
    return this.memoryService.updateMainMemory(req.user.id, dto.summary);
  }

  @Post('import')
  importKnowledge(@Request() req: { user: { id: string } }, @Body() dto: ImportKnowledgeDto) {
    return this.memoryService.importKnowledge(req.user.id, dto.contents);
  }

  @Get('knowledge/:id/export')
  async exportKnowledgeById(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
    @Response() res: ExpressResponse,
  ) {
    const content = await this.memoryService.exportKnowledgeById(req.user.id, id);
    if (content === null) throw new NotFoundException();
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="memory-${id}.md"`);
    res.send(content);
  }

  @Get('export')
  async exportAllKnowledge(@Request() req: { user: { id: string } }, @Response() res: ExpressResponse) {
    const content = await this.memoryService.exportAllKnowledge(req.user.id);
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', 'attachment; filename="memory-export.md"');
    res.send(content);
  }
}
