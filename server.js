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