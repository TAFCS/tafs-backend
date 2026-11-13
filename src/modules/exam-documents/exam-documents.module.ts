import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { StorageModule } from '../../common/storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { ExamDocumentsController } from './exam-documents.controller';
import { ExamDocumentsService } from './exam-documents.service';

/** TAFSD-510: exam schedules, admit cards and statements of entry gated by dues. */
@Module({
    imports: [PrismaModule, AuthModule, StorageModule],
    controllers: [ExamDocumentsController],
    providers: [ExamDocumentsService],
    exports: [ExamDocumentsService],
})
export class ExamDocumentsModule {}
