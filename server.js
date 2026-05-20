require('dotenv').config();

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

app.use(cors());
app.use(express.json());

// Firebase Admin Init
const serviceAccount = {
  type: process.env.TYPE,
  project_id: process.env.PROJECT_ID,
  private_key_id: process.env.PRIVATE_KEY_ID,
  private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.CLIENT_EMAIL,
  client_id: process.env.CLIENT_ID,
  auth_uri: process.env.AUTH_URI,
  token_uri: process.env.TOKEN_URI,
  auth_provider_x509_cert_url:
    process.env.AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url:
    process.env.CLIENT_X509_CERT_URL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Health Route
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'CampusEra Notification Server Running',
  });
});

// Send Notification Route
app.post('/sendNotification', async (req, res) => {
  try {
    const {
      token,
      senderName,
      body,
      senderId,
      receiverId,
      activeChatUserId,
    } = req.body;

    // Validation
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'FCM token missing',
      });
    }

    // WhatsApp-style suppression
    if (
      activeChatUserId &&
      activeChatUserId === senderId
    ) {
      return res.json({
        success: true,
        skipped: true,
        reason: 'User already inside chat',
      });
    }

    const message = {
      token,

      notification: {
        title: senderName || 'New Message',
        body: body || '',
      },

      data: {
        type: 'chat',
        senderId: senderId || '',
        receiverId: receiverId || '',
        senderName: senderName || '',
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

    const response = await admin
      .messaging()
      .send(message);

    console.log('✅ Push notification sent:', response);

    return res.json({
      success: true,
      response,
    });

  } catch (error) {
    console.error('❌ Notification Error:', error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    `🚀 Notification server running on port ${PORT}`
  );
});