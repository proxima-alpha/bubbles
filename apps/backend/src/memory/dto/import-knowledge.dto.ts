import { IsArray, IsString } from 'class-validator';

export class ImportKnowledgeDto {
  @IsArray()
  @IsString({ each: true })
  contents: string[];
}
