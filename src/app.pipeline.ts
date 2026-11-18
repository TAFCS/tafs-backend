import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

/**
 * Global request pipeline every route runs under: the `api/v1` prefix, DTO
 * validation and the error envelope. Shared by main.ts and the DB test suite
 * (test/db), so the suite exercises exactly what production serves.
 */
export function applyGlobalPipeline(app: INestApplication) {
  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
}
