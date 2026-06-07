import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;

  async connectToRedis(redisUrl: string): Promise<void> {
    this.pubClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      // Reconnect with exponential backoff — keeps Redis alive across brief outages
      retryStrategy: (times: number) => {
        if (times > 10) {
          console.error('[RedisAdapter] Max reconnection attempts reached. Giving up.');
          return null; // stop retrying
        }
        const delay = Math.min(times * 200, 3000);
        console.warn(`[RedisAdapter] Redis reconnecting in ${delay}ms (attempt ${times})`);
        return delay;
      },
    });

    this.subClient = this.pubClient.duplicate();

    // Log errors without crashing the process
    this.pubClient.on('error', (err) => {
      console.error('[RedisAdapter] PubClient error:', err.message);
    });
    this.subClient.on('error', (err) => {
      console.error('[RedisAdapter] SubClient error:', err.message);
    });

    this.pubClient.on('reconnecting', () => {
      console.warn('[RedisAdapter] PubClient reconnecting...');
    });
    this.subClient.on('reconnecting', () => {
      console.warn('[RedisAdapter] SubClient reconnecting...');
    });

    this.pubClient.on('ready', () => {
      console.log('[RedisAdapter] PubClient ready');
    });
    this.subClient.on('ready', () => {
      console.log('[RedisAdapter] SubClient ready');
    });

    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          this.pubClient!.once('ready', resolve);
          this.pubClient!.once('error', reject);
        }),
        new Promise<void>((resolve, reject) => {
          this.subClient!.once('ready', resolve);
          this.subClient!.once('error', reject);
        }),
      ]);

      this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const closeClient = async (client: Redis | null) => {
      if (!client) return;
      try {
        client.removeAllListeners();
        await client.quit();
      } catch {
        client.disconnect();
      }
    };

    await Promise.all([closeClient(this.pubClient), closeClient(this.subClient)]);
    this.pubClient = null;
    this.subClient = null;
    this.adapterConstructor = undefined;
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    } else {
      console.warn('[RedisAdapter] No Redis adapter — using in-memory. Multi-instance presence may be inaccurate.');
    }
    return server;
  }
}
