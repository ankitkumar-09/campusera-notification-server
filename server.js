require('dotenv').config();

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const serviceAccount = {
  type: process.env.TYPE,
  project_id: process.env.PROJECT_ID,
  private_key_id: process.env.PRIVATE_KEY_ID,
  private_key:
    process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
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

const app = express();

app.use(cors());
app.use(express.json());

app.post('/sendNotification', async (req, res) => {
  try {
    const {
      token,
      title,
      body,
      senderId,
      receiverId,
    } = req.body;

    if (!token) {
      return res.status(400).json({
        error: 'Missing token',
      });
    }
app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});
    const message = {
      notification: {
        title: title || 'New Message',
        body: body || '',
      },

      data: {
        senderId: senderId || '',
        receiverId: receiverId || '',
        type: 'chat',
      },

      android: {
        priority: 'high',
        notification: {
          channelId: 'campusera_channel',
          sound: 'default',
        },
      },

      token,
    };

    const response = await admin
      .messaging()
      .send(message);

    console.log('✅ Notification sent:', response);

    res.json({
      success: true,
      response,
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
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