require('dotenv').config();

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const serviceAccount = require('./serviceAccountKey.json');

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