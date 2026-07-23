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
  // Fallback for older APK builds that were compiled without --dart-define
  // They send either no header, or 'Bearer ' (empty string).
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    if (token && token !== '' && token !== API_KEY) {
      console.log('❌ Unauthorized: Invalid API key', token);
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
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

// Lightweight warmup endpoint — Flutter calls this on app launch so the
// server is hot before the first real notification request arrives.
app.get('/ping', (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
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

    // ─────────────────────────────────────────────────────────────────────────
    // SUPPRESSION CHECK — Scalable & tamper-proof.
    // We fetch the receiver's activeChatUserId directly from Firestore so we
    // never rely on a client-supplied value. This is the only source of truth.
    //
    // Scenario: User B (receiver) is currently inside the chat with User A
    // (sender). Their activeChatUserId in Firestore is set to User A's ID.
    // In this case, we must NOT deliver a push notification — Flutter's
    // foreground message handler will update the UI directly.
    // ─────────────────────────────────────────────────────────────────────────
    if (type === 'chat' && senderId) {
      try {
        const receiverDoc = await admin
          .firestore()
          .collection('users')
          .doc(receiverId)
          .get();

        if (receiverDoc.exists) {
          const receiverActiveChatUserId = receiverDoc.data()?.activeChatUserId;
          if (receiverActiveChatUserId === senderId) {
            console.log(`🔕 Suppressed: Receiver ${receiverId} is already inside chat with sender ${senderId}`);
            return res.json({
              success: true,
              skipped: true,
              reason: 'Receiver already in chat with sender',
            });
          }
        }
      } catch (suppressionErr) {
        // Non-fatal: if Firestore read fails, we proceed to send the notification
        // rather than silently dropping it. Fail open for reliability.
        console.warn('⚠️ Suppression check failed — proceeding to send:', suppressionErr.message);
      }
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

    const isChat = type === 'chat';
    const isPost = type === 'new_post';

    // ─────────────────────────────────────────────────────────────────────────
    // FCM MESSAGE CONSTRUCTION
    //
    // For CHAT messages we send a DATA-ONLY payload (no notification block).
    // Why: This lets Flutter's background isolate intercept the message and
    // show a local notification WITH action buttons (Reply, Mark as Read).
    // If we used a notification block, the OS would show a plain notification
    // and bypass our Flutter handler entirely — no action buttons.
    //
    // For all OTHER types (new_post, notice, etc.) we use a notification block
    // so the OS renders them immediately even if Flutter isn't running.
    //
    // iOS note: data-only messages require `content-available: 1` and
    // `apns-priority: 10` (highest) to wake the device. Without these, iOS
    // silently drops background data messages.
    // ─────────────────────────────────────────────────────────────────────────
    const message = {
      token,

      // All types carry the full data payload so Flutter can deep-link on tap
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
        // HIGH priority ensures delivery even when the device is in Doze mode.
        priority: 'high',
        ...(isChat
          ? {
              // For data-only chat messages we still specify the channel so
              // Android picks the right importance/sound settings.
              // The local notification shown by Flutter will also use this channel.
              ttl: '86400s', // 24 hours — messages shouldn't expire quickly
            }
          : {
              notification: {
                channelId: 'campusera_channel',
                sound: 'default',
                priority: 'high',
                visibility: 'public',
                tag: senderId || 'default',
              },
            }),
      },

      apns: isChat
        ? {
            // content-available: 1 → wakes iOS device to process the data message.
            // apns-priority: 10   → highest delivery priority (must pair with content-available).
            // Without these two, iOS silently drops data-only push messages.
            payload: {
              aps: {
                contentAvailable: true, // tells iOS to wake up the app
                sound: 'default',       // play default sound (needed on iOS 10+)
              },
            },
            headers: {
              'apns-priority': '10',   // 10 = immediate delivery (5 = power-saving)
              'apns-push-type': 'background', // required by Apple when using content-available
            },
          }
        : {
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
              },
            },
            headers: {
              'apns-priority': '10',
            },
          },
    };

    // For non-chat types, add a visible notification block
    if (!isChat) {
      message.notification = {
        title: isPost ? `${senderName} posted` : senderName || 'New Message',
        body: body || '',
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

    // ✅ Auto-cleanup stale/invalid tokens — scalable, runs in O(1) Firestore writes
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

  // ─────────────────────────────────────────────────────────────────
  // KEEPALIVE SELF-PING — Prevents Render free-tier sleep
  //
  // Render free-tier spins the server DOWN after 15 minutes of no
  // inbound traffic. Cold-boot takes ~50s. Flutter's HTTP timeout is
  // 70s which MIGHT cover it, but the first notification after a long
  // idle period is still at risk.
  //
  // Fix: ping ourselves every 14 minutes. As long as the server is
  // running, this keeps it "warm" so the next real request lands
  // instantly instead of waiting for a cold boot.
  // ─────────────────────────────────────────────────────────────────
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

  setInterval(async () => {
    try {
      const https = require('https');
      const http  = require('http');
      const url   = new URL(RENDER_URL);
      const lib   = url.protocol === 'https:' ? https : http;

      lib.get(RENDER_URL, (res) => {
        console.log(`🏓 Self-ping OK — status ${res.statusCode} (server is warm)`);
      }).on('error', (err) => {
        console.warn('⚠️ Self-ping failed:', err.message);
      });
    } catch (e) {
      console.warn('⚠️ Self-ping error:', e.message);
    }
  }, 14 * 60 * 1000); // every 14 minutes
});