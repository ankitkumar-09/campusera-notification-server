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
// Auth Middlewares
// ===============================
const API_KEY = process.env.API_KEY || 'Ankit#9921';

// API Key auth — for server-to-server / admin routes (old endpoints)
const requireApiKey = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== API_KEY) {
    console.log('❌ Unauthorized: Invalid API key');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
};

// Firebase ID Token auth — for user-facing routes (new scalable endpoints)
// Flutter sends: FirebaseAuth.instance.currentUser.getIdToken()
// This guarantees the request comes from a real, logged-in app user.
const requireFirebaseAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing Firebase token' });
  }
  const idToken = authHeader.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.uid = decoded.uid; // attach verified UID to request
    next();
  } catch (err) {
    console.log('❌ Invalid Firebase token:', err.message);
    return res.status(401).json({ success: false, error: 'Invalid or expired Firebase token' });
  }
};

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
app.post('/sendNotification', requireApiKey, async (req, res) => {
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

    // ✅ Always fetch fresh token from Firestore private subcollection
    const userDoc = await admin
      .firestore()
      .collection('users')
      .doc(receiverId)
      .collection('private')
      .doc('data')
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
    const isChat = type === 'chat';

    const message = {
      token,

      data: {
        type: type || 'chat',
        senderId: String(senderId || ''),
        receiverId: String(receiverId || ''),
        senderName: String(senderName || ''),
        postId: String(postId || ''),
        body: String(body || ''),
        title: String(senderName || 'New Message'),
      },

      android: {
        priority: 'high',
      },

      apns: {
        payload: {
          aps: {
            sound: 'default',
          },
        },
      },
    };

    if (!isChat) {
      message.notification = {
        title: isPost ? `${senderName} posted` : senderName || 'New Message',
        body: body || '',
      };
      message.android.notification = {
        channelId: 'campusera_channel',
        sound: 'default',
        priority: 'high',
        visibility: 'public',
        tag: senderId || 'default',
      };
    }

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
          .collection('private')
          .doc('data')
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
app.post('/sendBroadcast', requireApiKey, async (req, res) => {
  try {
    const { title, body, senderId, type } = req.body;

    console.log('📨 Broadcast Request:', req.body);

    if (!title || !body) {
      return res.status(400).json({ success: false, error: 'title and body missing' });
    }

    // Fetch all users with tokens from private subcollections
    // (This requires a collectionGroup query or fetching all users then their private data)
    // Since fetching all subcollections is heavy, we'll use a collectionGroup query.
    // Note: this requires creating a single-field index for fcmToken in the Firebase Console if you query by it, 
    // but just getting all from collection group 'private' is possible.
    const privateDocsSnap = await admin.firestore().collectionGroup('private').get();
    const tokens = [];
    privateDocsSnap.forEach((doc) => {
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
// SCALABLE: Feed Post Notification via FCM Topic
// All users subscribe to 'all_feed_posts' topic on login.
// This single call fans out to ALL subscribed devices instantly — no token loops.
// ===============================
app.post('/sendFeedPost', requireFirebaseAuth, async (req, res) => {
  try {
    const { senderName, postId, body } = req.body;
    const senderId = req.uid; // 🔒 Always use verified Firebase UID — client cannot spoof this

    console.log(`📨 Feed Post from verified user ${senderId}:`, { senderName, postId });

    if (!senderName || !postId) {
      return res.status(400).json({ success: false, error: 'senderName and postId are required' });
    }

    const message = {
      topic: 'all_feed_posts',
      notification: {
        title: senderName,
        body: body || `${senderName} shared a new post`,
      },
      data: {
        type: 'new_post',
        postId: String(postId),
        senderId: String(senderId || ''),
        senderName: String(senderName),
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
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
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    };

    const response = await admin.messaging().send(message);
    console.log('✅ Feed topic notification sent:', response);
    return res.json({ success: true, response });

  } catch (error) {
    console.error('❌ Feed Notification Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ===============================
// SCALABLE: Comment Notification (targeted — one token, one call)
// No user loops. Fetches only the post author's token.
// ===============================
app.post('/sendCommentNotification', requireFirebaseAuth, async (req, res) => {
  try {
    const { postAuthorId, commenterName, postId, commentPreview } = req.body;
    const commenterId = req.uid; // 🔒 Always use verified Firebase UID — client cannot spoof this

    console.log(`📨 Comment Notification from verified user ${commenterId}:`, { postAuthorId, postId });

    if (!postAuthorId || !commenterName || !postId) {
      return res.status(400).json({ success: false, error: 'postAuthorId, commenterName, postId are required' });
    }

    // Don't notify if author comments on their own post (using verified UID)
    if (commenterId === postAuthorId) {
      return res.json({ success: true, skipped: true, reason: 'Self-comment' });
    }

    // Fetch only the post author's token (1 Firestore read)
    const userDoc = await admin.firestore()
      .collection('users').doc(postAuthorId)
      .collection('private').doc('data')
      .get();

    if (!userDoc.exists || !userDoc.data()?.fcmToken) {
      return res.json({ success: true, skipped: true, reason: 'No FCM token for author' });
    }

    const token = userDoc.data().fcmToken;
    const bodyText = commentPreview
      ? `${commenterName}: ${commentPreview}`
      : `${commenterName} commented on your post`;

    const message = {
      token,
      notification: { title: commenterName, body: bodyText },
      data: {
        type: 'new_comment',
        postId: String(postId),
        senderId: String(commenterId || ''),
        senderName: String(commenterName),
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'campusera_channel',
          sound: 'default',
          priority: 'high',
          tag: commenterId || 'comment',
        },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    };

    const response = await admin.messaging().send(message);
    console.log('✅ Comment notification sent:', response);
    return res.json({ success: true, response });

  } catch (error) {
    console.error('❌ Comment Notification Error:', error);

    // Auto-cleanup stale token
    if (error.code === 'messaging/registration-token-not-registered') {
      try {
        await admin.firestore()
          .collection('users').doc(req.body.postAuthorId)
          .collection('private').doc('data')
          .update({ fcmToken: admin.firestore.FieldValue.delete() });
        console.log('🗑️ Stale token deleted for:', req.body.postAuthorId);
      } catch (cleanupError) {
        console.log('⚠️ Cleanup error:', cleanupError);
      }
    }

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