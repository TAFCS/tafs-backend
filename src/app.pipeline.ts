import {
  RequestMethod,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

/**
 * Global request pipeline every route runs under: the `api/v1` prefix (except
 * /.well-known), DTO validation and the error envelope. Shared by main.ts and the DB test suite
 * (test/db), so the suite exercises exactly what production serves.
 */
export function applyGlobalPipeline(app: INestApplication) {
  // OAuth discovery for the admin MCP server (TAFSD-531) is served at the
  // origin root, where MCP clients look for it.
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: '.well-known/{*path}', method: RequestMethod.GET }],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
}
