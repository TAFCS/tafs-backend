import { Module } from '@nestjs/common';
import { CampusesService } from './campuses.service';
import { CampusesController } from './campuses.controller';
import { AuthModule } from '../auth/auth.module';
import { StudentAllocationModule } from '../student-allocation/student-allocation.module';

@Module({
    imports: [AuthModule, StudentAllocationModule],
    controllers: [CampusesController],
    providers: [CampusesService],
    exports: [CampusesService],
})
export class CampusesModule { }
