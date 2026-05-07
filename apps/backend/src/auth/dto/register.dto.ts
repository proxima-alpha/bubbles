import { IsEmail, IsString, MinLength, IsArray, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';

class LicenseKeyDto {
  @IsString()
  provider: string;

  @IsString()
  key: string;
}

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  model: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LicenseKeyDto)
  @ArrayMinSize(1)
  licenseKeys: LicenseKeyDto[];
}
