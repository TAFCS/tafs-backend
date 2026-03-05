import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');

  // Security headers (HSTS, X-Frame-Options, X-Content-Type-Options, etc.)
  app.use(helmet());

  // Gzip / Brotli compression — reduces JSON payload size by 60-80%
  app.use(compression());

  // Required to read cookies in controllers / strategies
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Consistent JSON error shape for all unhandled exceptions
  app.useGlobalFilters(new HttpExceptionFilter());

  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true,
  });

  app.use(
    morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'),
  );

  const config = new DocumentBuilder()
    .setTitle('TAFS API')
    .setDescription('TAFS Backend API documentation')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        in: 'header',
      },
      'access-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 3000);

  const appUrl = await app.getUrl();
  // eslint-disable-next-line no-console
  console.log(`Swagger docs available at: ${appUrl}/api/docs`);
}
bootstrap();
