import { Injectable, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class FcmService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    if (admin.apps.length === 0) {
      const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      try {
        if (serviceAccountJson) {
          const serviceAccount = JSON.parse(serviceAccountJson);
          admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
          console.log('Firebase Admin initialized with service account JSON');
        } else {
          admin.initializeApp({ credential: admin.credential.applicationDefault() });
          console.log('Firebase Admin initialized with application default credentials');
        }
      } catch (e) {
        console.warn('Firebase Admin not initialized:', e.message);
      }
    }
  }

  async sendToFamily(familyId: number, title: string, body: string, data?: Record<string, string>) {
    const tokens = await this.prisma.fcm_device_tokens.findMany({
      where: { family_id: familyId },
    });
    if (tokens.length === 0) return;

    const messages = tokens.map((t) => ({
      token: t.device_token,
      notification: { title, body },
      data: { ...data, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
      apns: { payload: { aps: { badge: 1, sound: 'default' } } },
      android: {
        priority: 'high' as const,
        notification: { channelId: 'high_importance_channel' },
      },
    }));

    try {
      const sendPromise = admin.messaging().sendEach(messages);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('FCM Timeout')), 5000),
      );
      await Promise.race([sendPromise, timeoutPromise]);
    } catch (error) {
      console.error(`FCM send to family ${familyId} failed:`, error.message);
    }
  }

  async registerToken(familyId: number, token: string, deviceType?: string) {
    return this.prisma.fcm_device_tokens.upsert({
      where: { device_token: token },
      update: { family_id: familyId, device_os: deviceType, last_active_at: new Date() },
      create: { family_id: familyId, device_token: token, device_os: deviceType },
    });
  }
}
