import { IsString } from 'class-validator';

export class ImportKnowledgeDto {
  @IsString()
  content: string;
}
