require('dotenv').config();

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

// ===============================
// Middleware
// ===============================
app.use(cors());

app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.url}`);
  next();
});

// ===============================
// Firebase Admin Setup
// ===============================
// ✅ Build from individual Render env variables
const serviceAccount = {
  type: 'service_account',
  project_id: process.env.PROJECT_ID,
  private_key_id: process.env.PRIVATE_KEY_ID,
  private_key: process.env.PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.CLIENT_EMAIL,
  client_id: process.env.CLIENT_ID,
  auth_uri: process.env.AUTH_URI,
  token_uri: process.env.TOKEN_URI,
  auth_provider_x509_cert_url: process.env.AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.CLIENT_X509_CERT_URL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ===============================
// Health Route
// ===============================
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'CampusEra Notification Server Running',
    uptime: process.uptime(),
  });
});

// ===============================
// Send Notification Route
// ===============================
app.post('/sendNotification', async (req, res) => {
  try {
    const {
      receiverId,
      senderName,
      body,
      senderId,
      activeChatUserId,
      type,
      postId,
    } = req.body;

    console.log('📨 Notification Request:', req.body);

    if (!receiverId) {
      return res.status(400).json({
        success: false,
        error: 'receiverId missing',
      });
    }

    // Skip if user already inside chat
    if (type !== 'new_post' && activeChatUserId && activeChatUserId === senderId) {
      return res.json({
        success: true,
        skipped: true,
        reason: 'User already in chat',
      });
    }

    // ✅ Always fetch fresh token from Firestore
    const userDoc = await admin
      .firestore()
      .collection('users')
      .doc(receiverId)
      .get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Receiver not found',
      });
    }

    const token = userDoc.data()?.fcmToken;

    if (!token) {
      return res.json({
        success: true,
        skipped: true,
        reason: 'No FCM token for user',
      });
    }

    const isPost = type === 'new_post';

    const message = {
      token,

      notification: {
        title: isPost ? `${senderName} posted` : senderName || 'New Message',
        body: body || '',
      },

      data: {
        type: type || 'chat',
        senderId: senderId || '',
        receiverId: receiverId || '',
        senderName: senderName || '',
        postId: postId || '',
      },

      android: {
        priority: 'high',
        notification: {
          channelId: 'campusera_channel',
          sound: 'default',
          priority: 'high',
          visibility: 'public',
        },
      },

      apns: {
        payload: {
          aps: {
            sound: 'default',
          },
        },
      },
    };

    const response = await admin.messaging().send(message);

    console.log('✅ Push sent:', response);

    return res.json({
      success: true,
      response,
    });

  } catch (error) {
    console.error('❌ Notification Error:', error);

    // ✅ Auto-cleanup stale/invalid tokens
    if (error.code === 'messaging/registration-token-not-registered') {
      console.log('⚠️ Stale token — deleting from Firestore');
      try {
        await admin
          .firestore()
          .collection('users')
          .doc(req.body.receiverId)
          .update({
            fcmToken: admin.firestore.FieldValue.delete(),
          });
        console.log('🗑️ Stale token deleted for:', req.body.receiverId);
      } catch (cleanupError) {
        console.log('⚠️ Cleanup error:', cleanupError);
      }
    }

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ===============================
// Send Broadcast Route
// ===============================
app.post('/sendBroadcast', async (req, res) => {
  try {
    const { title, body, senderId, type } = req.body;

    console.log('📨 Broadcast Request:', req.body);

    if (!title || !body) {
      return res.status(400).json({ success: false, error: 'title and body missing' });
    }

    // Fetch all users with tokens
    const usersSnap = await admin.firestore().collection('users').get();
    const tokens = [];
    usersSnap.forEach((doc) => {
      const token = doc.data().fcmToken;
      if (token) tokens.push(token);
    });

    if (tokens.length === 0) {
      return res.json({ success: true, skipped: true, reason: 'No tokens found' });
    }

    const message = {
      notification: { title, body },
      data: {
        type: type || 'notice',
        senderId: senderId || 'admin',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'campusera_channel',
          sound: 'default',
        },
      },
      apns: {
        payload: { aps: { sound: 'default' } },
      },
    };

    let successCount = 0;
    let failureCount = 0;

    // Send in chunks of 500
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 500) {
      chunks.push(tokens.slice(i, i + 500));
    }

    for (const chunk of chunks) {
      const multicastPayload = { ...message, tokens: chunk };
      // Compatibility fallback: check if sendEachForMulticast exists (admin SDK v10+), otherwise sendMulticast
      let response;
      if (admin.messaging().sendEachForMulticast) {
        response = await admin.messaging().sendEachForMulticast(multicastPayload);
      } else {
        response = await admin.messaging().sendMulticast(multicastPayload);
      }
      successCount += response.successCount;
      failureCount += response.failureCount;
    }

    console.log(`✅ Broadcast sent: Success ${successCount}, Failed ${failureCount}`);
    return res.json({ success: true, successCount, failureCount });

  } catch (error) {
    console.error('❌ Broadcast Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ===============================
// Global Error Handlers
// ===============================
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ UNHANDLED REJECTION:', reason);
});

// ===============================
// Start Server
// ===============================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Notification server running on port ${PORT}`);
});