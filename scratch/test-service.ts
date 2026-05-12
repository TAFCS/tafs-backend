import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { ChatService } from './src/modules/chat/chat.service';
import { PrismaService } from './prisma/prisma.service';
import { StorageService } from './src/common/storage/storage.service';

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const chatService = app.get(ChatService);
  const prisma = app.get(PrismaService);
  const storage = app.get(StorageService);

  try {
    console.log('1. Fetching a Family from DB...');
    const family = await prisma.families.findFirst();
    if (!family) throw new Error('No family found.');

    console.log('\n2. Seeding Data...');
    await prisma.chat_messages.deleteMany({});
    await prisma.chat_conversations.deleteMany({});
    
    const conv = await prisma.chat_conversations.create({
      data: { family_id: family.id, last_message_snippet: "Direct testing!", unread_by_admin: 1 }
    });

    await prisma.chat_messages.createMany({
      data: [
        { conversation_id: conv.id, sender_type: 'ADMIN', message_type: 'TEXT', content: 'Hello' },
        { conversation_id: conv.id, sender_type: 'GUARDIAN', message_type: 'TEXT', content: 'Hi' }
      ]
    });
    console.log('✅ Seeded successfully.');

    console.log('\n3. Testing getAdminInbox()...');
    const inbox = await chatService.getAdminInbox();
    console.log(`✅ Inbox Success: Found ${inbox.length} conversations. Snippet: "${inbox[0].last_message_snippet}"`);

    console.log('\n4. Testing getChatHistory()...');
    const history = await chatService.getChatHistory(family.id);
    console.log(`✅ History Success: Found ${history.length} messages.`);

    console.log('\n5. Testing uploadMedia() [Mock Buffer]...');
    const dummyFile = {
      buffer: Buffer.from('fake image'),
      mimetype: 'image/png',
      originalname: 'test.png',
      size: 10
    } as any;
    
    const uploadRes = await chatService.uploadMedia(dummyFile);
    console.log(`✅ Upload Success: ${uploadRes.url}`);
    
  } catch (error) {
    console.error('❌ Test Failed:', error);
  } finally {
    await app.close();
  }
}
run();
