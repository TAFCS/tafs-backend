const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const prisma = new PrismaClient();
const JWT_SECRET = '123456789';
const BASE_URL = 'http://localhost:3000/api/v1';

async function run() {
  try {
    console.log('1. Fetching a Family and Admin user from DB...');
    const family = await prisma.families.findFirst();
    const staff = await prisma.users.findFirst({ where: { role: 'SUPER_ADMIN' } });

    if (!family || !staff) {
      throw new Error('Database needs at least one family and one staff member.');
    }

    console.log(`✅ Using Family: ${family.id}, Staff: ${staff.username}`);

    console.log('\n2. Seeding Test Data (Conversations & Messages)...');
    
    // Clear old data for clean test
    await prisma.chat_messages.deleteMany({});
    await prisma.chat_conversations.deleteMany({});

    const conv = await prisma.chat_conversations.create({
      data: {
        family_id: family.id,
        last_message_snippet: "Testing the inbox!",
        unread_by_admin: 1
      }
    });

    await prisma.chat_messages.createMany({
      data: [
        { conversation_id: conv.id, sender_type: 'ADMIN', message_type: 'TEXT', content: 'Hello Parent!' },
        { conversation_id: conv.id, sender_type: 'GUARDIAN', message_type: 'TEXT', content: 'Hi Admin!' },
        { conversation_id: conv.id, sender_type: 'GUARDIAN', message_type: 'TEXT', content: 'Testing the inbox!' },
      ]
    });
    console.log('✅ Seeded 1 conversation and 3 messages.');

    console.log('\n3. Generating JWTs...');
    const staffJwt = jwt.sign({ sub: staff.id, username: staff.username, role: staff.role, userType: 'STAFF' }, JWT_SECRET, { expiresIn: '1h' });
    const parentJwt = jwt.sign({ sub: family.id, familyId: family.id, userType: 'PARENT' }, JWT_SECRET, { expiresIn: '1h' });

    console.log('\n4. Testing GET /chat/inbox (Admin)...');
    const inboxRes = await axios.get(`${BASE_URL}/chat/inbox`, {
      headers: { Cookie: `tafs_access=${staffJwt}` }
    });
    if (inboxRes.status === 200 && inboxRes.data.length > 0) {
      console.log(`✅ Inbox Success: Found ${inboxRes.data.length} conversation(s). Last message: "${inboxRes.data[0].last_message_snippet}"`);
    } else {
      throw new Error('Inbox fetch failed or empty.');
    }

    console.log('\n5. Testing GET /chat/history/admin/:familyId (Admin)...');
    const adminHistoryRes = await axios.get(`${BASE_URL}/chat/history/admin/${family.id}`, {
      headers: { Cookie: `tafs_access=${staffJwt}` }
    });
    if (adminHistoryRes.status === 200 && adminHistoryRes.data.length === 3) {
      console.log('✅ Admin History Success: Retrieved exactly 3 messages.');
    } else {
      throw new Error(`Admin History failed. Found ${adminHistoryRes.data?.length} messages.`);
    }

    console.log('\n6. Testing GET /chat/history/parent (Parent)...');
    const parentHistoryRes = await axios.get(`${BASE_URL}/chat/history/parent`, {
      headers: { Authorization: `Bearer ${parentJwt}` }
    });
    if (parentHistoryRes.status === 200 && parentHistoryRes.data.length === 3) {
      console.log('✅ Parent History Success: Retrieved exactly 3 messages.');
    } else {
      throw new Error(`Parent History failed. Found ${parentHistoryRes.data?.length} messages.`);
    }

    console.log('\n7. Testing POST /chat/media (File Upload)...');
    fs.writeFileSync('dummy.png', 'fake image data');
    const formData = new FormData();
    formData.append('file', fs.createReadStream('dummy.png'));
    
    // Using Staff JWT for upload test
    const uploadRes = await axios.post(`${BASE_URL}/chat/media`, formData, {
      headers: { 
        ...formData.getHeaders(),
        Cookie: `tafs_access=${staffJwt}`
      }
    });

    if (uploadRes.status === 201 && uploadRes.data.url) {
      console.log(`✅ Upload Success: File saved to DigitalOcean Spaces at ${uploadRes.data.url}`);
    } else {
      throw new Error('Upload failed.');
    }

  } catch (error) {
    console.error('❌ Test Failed:', error.response?.data || error.message);
  } finally {
    if (fs.existsSync('dummy.png')) fs.unlinkSync('dummy.png');
    await prisma.$disconnect();
  }
}
run();
