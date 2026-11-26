import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GuideController } from './guide.controller';
import { GuideService } from './guide.service';

/** TAFSD-616: the Guide tile. PDFs come from tafs-software-manual's latest release. */
@Module({
  imports: [AuthModule],
  controllers: [GuideController],
  providers: [GuideService],
})
export class GuideModule {}
