import { IsString } from 'class-validator';

export class UpdateLicenseKeyDto {
  @IsString()
  provider: string;

  @IsString()
  key: string;
}
