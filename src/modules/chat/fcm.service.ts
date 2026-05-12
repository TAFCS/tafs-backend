import { Injectable, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class FcmService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    if (admin.apps.length === 0) {
      // In production, you would point to a service account JSON file
      // via GOOGLE_APPLICATION_CREDENTIALS or initialize with cert()
      try {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
        });
      } catch (e) {
        console.warn('Firebase Admin not initialized: Missing credentials');
      }
    }
  }

  async sendToFamily(familyId: number, title: string, body: string, data?: any) {
    const tokens = await this.prisma.fcm_device_tokens.findMany({
      where: { family_id: familyId },
    });

    if (tokens.length === 0) return;

    const messages = tokens.map((t) => ({
      token: t.device_token,
      notification: { title, body },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
    }));

    try {
      await admin.messaging().sendEach(messages);
    } catch (error) {
      console.error('Error sending FCM notifications:', error);
    }
  }

  async registerToken(familyId: number, token: string, deviceType?: string) {
    return this.prisma.fcm_device_tokens.upsert({
      where: { device_token: token },
      update: {
        family_id: familyId,
        device_os: deviceType,
        last_active_at: new Date(),
      },
      create: {
        family_id: familyId,
        device_token: token,
        device_os: deviceType,
      },
    });
  }
}
