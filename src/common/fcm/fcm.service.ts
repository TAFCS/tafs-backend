import { Injectable, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { PrismaService } from '../../../prisma/prisma.service';

const EXPECTED_FIREBASE_PROJECT_ID = 'tafs-bb6c4';

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
          const projectId = serviceAccount.project_id ?? 'unknown';
          console.log(
            `[FCM] Firebase Admin initialized (project_id=${projectId})`,
          );
          if (projectId !== EXPECTED_FIREBASE_PROJECT_ID) {
            console.warn(
              `[FCM] WARNING: project_id "${projectId}" does not match Flutter app ` +
                `project "${EXPECTED_FIREBASE_PROJECT_ID}". Push delivery will fail.`,
            );
          }
        } else {
          admin.initializeApp({ credential: admin.credential.applicationDefault() });
          console.log(
            '[FCM] Firebase Admin initialized with application default credentials',
          );
          console.warn(
            '[FCM] FIREBASE_SERVICE_ACCOUNT_JSON is not set — set it on Railway for production.',
          );
        }
      } catch (e) {
        console.warn('[FCM] Firebase Admin not initialized:', e.message);
      }
    }
  }

  private stringifyData(
    data?: Record<string, string>,
  ): Record<string, string> | undefined {
    if (!data) return { click_action: 'FLUTTER_NOTIFICATION_CLICK' };

    const out: Record<string, string> = { click_action: 'FLUTTER_NOTIFICATION_CLICK' };
    for (const [key, value] of Object.entries(data)) {
      out[key] = value == null ? '' : String(value);
    }
    return out;
  }

  async sendToFamily(
    familyId: number,
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    if (admin.apps.length === 0) {
      console.error(
        `[FCM] Firebase Admin not initialized — cannot send to family ${familyId}. ` +
          'Set FIREBASE_SERVICE_ACCOUNT_JSON on the server.',
      );
      return;
    }

    const tokens = await this.prisma.fcm_device_tokens.findMany({
      where: { family_id: familyId },
    });

    if (tokens.length === 0) {
      console.warn(
        `[FCM] No device tokens for family ${familyId} — push skipped`,
      );
      return;
    }

    const stringData = this.stringifyData(data);

    const messages = tokens.map((t) => ({
      token: t.device_token,
      notification: { title, body },
      data: stringData,
      apns: { payload: { aps: { badge: 1, sound: 'default' } } },
      android: {
        priority: 'high' as const,
        notification: { channelId: 'high_importance_channel' },
      },
    }));

    try {
      const result = await admin.messaging().sendEach(messages);

      const successCount = result.responses.filter((r) => r.success).length;
      const failureCount = result.responses.length - successCount;
      const firstError = result.responses.find((r) => !r.success)?.error;

      console.log(
        `[FCM] sendToFamily ${familyId}: ${successCount} ok, ${failureCount} failed` +
          (firstError ? ` (first error: ${firstError.code})` : ''),
      );

      const staleTokens: string[] = [];
      result.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errCode = resp.error?.code;
          if (
            errCode === 'messaging/registration-token-not-registered' ||
            errCode === 'messaging/invalid-registration-token'
          ) {
            staleTokens.push(tokens[idx].device_token);
          }
        }
      });

      if (staleTokens.length > 0) {
        console.log(
          `[FCM] Purging ${staleTokens.length} stale token(s) for family ${familyId}`,
        );
        await this.prisma.fcm_device_tokens
          .deleteMany({ where: { device_token: { in: staleTokens } } })
          .catch((e) =>
            console.error('[FCM] Failed to purge stale tokens:', e.message),
          );
      }
    } catch (error) {
      console.error(`[FCM] send to family ${familyId} failed:`, error.message);
    }
  }

  async registerToken(familyId: number, token: string, deviceType?: string) {
    const row = await this.prisma.fcm_device_tokens.upsert({
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
    console.log(
      `[FCM] Registered token for family ${familyId} (${deviceType ?? 'unknown'}, id=${row.id})`,
    );
    return row;
  }
}
