import { Module } from '@nestjs/common';
import { CampusesService } from './campuses.service';
import { CampusesController } from './campuses.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [AuthModule],
    controllers: [CampusesController],
    providers: [CampusesService],
    exports: [CampusesService],
})
export class CampusesModule { }
