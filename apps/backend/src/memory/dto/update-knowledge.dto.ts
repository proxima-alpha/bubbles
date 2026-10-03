import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

export class UpdateKnowledgeContentDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  text: string;
}

export class UpdateKnowledgeDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateKnowledgeContentDto)
  contents: UpdateKnowledgeContentDto[];

  @IsString()
  summary: string;
}
