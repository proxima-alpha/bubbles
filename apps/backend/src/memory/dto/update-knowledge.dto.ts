import { IsArray, IsString } from 'class-validator';

export class UpdateKnowledgeDto {
  @IsArray()
  @IsString({ each: true })
  contents: string[];

  @IsString()
  summary: string;
}
