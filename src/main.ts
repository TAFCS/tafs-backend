import { NestFactory } from '@nestjs/core';
// Triggering reload to connect to Redis service
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as express from 'express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';

/** If the Nest event loop stays blocked, Railway shows 499s with no app logs. */
function startEventLoopWatchdog() {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let blockedStreak = 0;
  setInterval(() => {
    const maxMs = histogram.max / 1e6;
    const p99Ms = histogram.percentile(99) / 1e6;
    histogram.reset();
    if (maxMs > 2000) {
      blockedStreak += 1;
      // eslint-disable-next-line no-console
      console.error(
        `[event-loop] blocked max=${maxMs.toFixed(0)}ms p99=${p99Ms.toFixed(0)}ms streak=${blockedStreak}`,
      );
    } else {
      blockedStreak = 0;
    }
    // Self-heal: exit so Railway restarts instead of sitting dead until a human.
    if (blockedStreak >= 3) {
      // eslint-disable-next-line no-console
      console.error('[event-loop] sustained block — exiting for Railway restart');
      process.exit(1);
    }
  }, 5000).unref();
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const redisUrl = process.env.REDIS_URL?.trim();
  const isProduction = process.env.NODE_ENV === 'production';
  const redisIoAdapter = new RedisIoAdapter(app);

  if (isProduction && !redisUrl) {
    console.error(
      '⚠️ [Startup] REDIS_URL is not set. Socket.IO will use the in-memory adapter — chat will NOT sync across multiple backend instances.',
    );
  }

  if (redisUrl) {
    try {
      await redisIoAdapter.connectToRedis(redisUrl);
      app.useWebSocketAdapter(redisIoAdapter);
      console.log('✅ Redis Socket.io adapter connected');
    } catch (err: any) {
      await redisIoAdapter.disconnect();
      const errMsg =
        err?.message ||
        (err?.errors ? err.errors.map((e: any) => e.message).join(', ') : String(err));
      console.warn(
        `ℹ️ Redis not available (${errMsg || 'connection refused'}); using in-memory Socket.IO adapter`,
      );
    }
  } else if (!isProduction) {
    console.log(
      'ℹ️ REDIS_URL not set — using in-memory Socket.IO adapter (OK for local dev)',
    );
  }

  // Parse ZKTeco device bodies as raw text before NestJS touches them.
  // 2mb is enough for a busy day's ATTLOG; 8mb concurrent backfills OOMed prod.
  app.use('/api/v1/iclock', express.text({ type: '*/*', limit: '2mb' }));

  app.setGlobalPrefix('api/v1');

  // 1. Setup Origins
  const rawOrigins = process.env.CORS_ORIGIN;
  const envOrigins = rawOrigins
    ? rawOrigins.split(',').map((o) => o.trim().replace(/\/$/, ''))
    : [];

  const corsOrigins: (string | RegExp)[] = [
    ...envOrigins,
    /^http:\/\/localhost(:\d+)?$/,
    /^https:\/\/tafs-webapp\.vercel\.app$/,
    /^https:\/\/.*\.vercel\.app$/,
  ];

  // eslint-disable-next-line no-console
  console.log('--- Startup: CORS Configuration ---');
  // eslint-disable-next-line no-console
  console.log('Allowed Origins Raw:', rawOrigins);
  // eslint-disable-next-line no-console
  console.log('Allowed Origins Parsed:', corsOrigins);

  // 2. Request Logger (Debug)
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS' || req.url.includes('auth')) {
      // eslint-disable-next-line no-console
      console.log(`[HTTP] ${req.method} ${req.url} | Origin: ${req.headers.origin}`);
    }
    next();
  });

  // 3. Enable CORS (Must be before Helmet if using global prefix)
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      const isAllowed = corsOrigins.some((pattern) => {
        if (pattern instanceof RegExp) return pattern.test(origin);
        // Case-insensitive and slash-agnostic comparison
        const normalizedOrigin = origin.trim().replace(/\/$/, '').toLowerCase();
        const normalizedPattern = String(pattern).trim().replace(/\/$/, '').toLowerCase();
        return normalizedOrigin === normalizedPattern;
      });

      if (isAllowed) {
        callback(null, true);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[CORS REJECTED] Origin: ${origin}`);
        callback(null, false);
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'X-Requested-With',
      'Origin',
    ],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // 4. Security Headers
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );

  app.use(compression());
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

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

  const port = process.env.PORT ?? 8080;
  await app.listen(port);

  // Fail hung requests instead of letting Railway/Vercel clients sit until they
  // abort with 499 and pile up more sockets. getrequest/login must never wait
  // minutes for a free event-loop turn behind a stuck upstream call.
  const server = app.getHttpServer();
  server.requestTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 60_000;
  startEventLoopWatchdog();

  // eslint-disable-next-line no-console
  console.log(`🚀 Server running at: http://localhost:${port}/api/v1`);
  // eslint-disable-next-line no-console
  console.log(`📖 Swagger docs available at: http://localhost:${port}/api/docs`);
}
bootstrap();
