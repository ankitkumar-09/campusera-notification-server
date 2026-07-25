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

// How recent the receiver's "actively viewing this chat" presence must be for
// us to suppress a push. A client heartbeat refreshes it every ~25s, so 60s
// gives comfortable slack. If the app is force-killed while a chat is open,
// the presence goes stale within this window and notifications resume — no
// more permanent silencing of a partner.
const PRESENCE_FRESHNESS_MS =
  parseInt(process.env.PRESENCE_FRESHNESS_MS, 10) || 60 * 1000;

// ── Lightweight in-memory rate limiter ────────────────────────────────────
// Render free tier runs a single instance, so an in-memory bucket is enough to
// blunt spam/abuse. Buckets reset on their window (and on restart — acceptable).
const _rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = _rateBuckets.get(key);
  if (!b || now > b.reset) {
    _rateBuckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}
// Occasionally clear expired buckets so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateBuckets) if (now > v.reset) _rateBuckets.delete(k);
}, 10 * 60 * 1000);

// Auth for the notification routes.
//
// SECURITY: the previous version "failed open" — a request with no Authorization
// header was allowed through, so anyone could send/spoof pushes. This now
// REQUIRES a credential:
//   1. A verified Firebase ID token (preferred — used by current app builds).
//      When present, req.uid is the real, verified sender (can't be spoofed).
//   2. The shared API key (legacy fallback for older installed builds).
// Anything else (missing/empty/invalid) is rejected.
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing credentials' });
  }
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, error: 'Missing credentials' });
  }
  // Prefer a verified Firebase ID token.
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    req.email = (decoded.email || '').toLowerCase();
    req.authMethod = 'idtoken';
    return next();
  } catch (_) {
    // Not an ID token — accept the legacy API key (old builds only).
    if (token === API_KEY) {
      req.authMethod = 'apikey';
      return next();
    }
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
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
app.post('/sendNotification', requireAuth, async (req, res) => {
  try {
    const {
      receiverId,
      senderName,
      body,
      type,
      postId,
    } = req.body;

    // Anti-spoof: when the caller is a verified app user, the sender is THEIR
    // uid — never trust a client-supplied senderId. Legacy (API-key) callers
    // fall back to the body value.
    const senderId = req.authMethod === 'idtoken' ? req.uid : req.body.senderId;

    // Rate limit per authenticated sender (or IP for legacy) to blunt spam.
    const rlKey = 'notif:' + (req.uid || req.ip || 'anon');
    if (!rateLimit(rlKey, 30, 60 * 1000)) {
      return res.status(429).json({ success: false, error: 'Too many requests' });
    }

    console.log('📨 Notification Request:', { receiverId, type, senderId });

    if (!receiverId) {
      return res.status(400).json({
        success: false,
        error: 'receiverId missing',
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SINGLE READ — presence + token.
    // The receiver's private/data doc holds BOTH the FCM token AND the chat
    // presence (activeChatUserId + activeChatUpdatedAt). Reading it once covers
    // suppression and delivery, halving Firestore reads per message.
    //
    // Presence lives in the OWNER-ONLY private subcollection (not the public
    // user doc), so a user's "who am I chatting with right now" never leaks to
    // other users. The Admin SDK bypasses security rules, so we can still read it.
    // ─────────────────────────────────────────────────────────────────────────
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

    const userData = userDoc.data() || {};

    // ─────────────────────────────────────────────────────────────────────────
    // SUPPRESSION CHECK — tamper-proof & self-healing (TTL).
    //
    // Suppress only when the receiver is CURRENTLY (freshly) viewing the chat
    // with this sender. The activeChatUpdatedAt timestamp is refreshed by a
    // client heartbeat while the chat is foregrounded; if the app is killed or
    // backgrounded, it goes stale within PRESENCE_FRESHNESS_MS and we deliver
    // the notification normally. This removes the old "stuck flag → messages
    // silenced forever" failure mode.
    // ─────────────────────────────────────────────────────────────────────────
    if (type === 'chat' && senderId && userData.activeChatUserId === senderId) {
      const updatedAt = userData.activeChatUpdatedAt;
      const updatedMs =
        updatedAt && typeof updatedAt.toMillis === 'function'
          ? updatedAt.toMillis()
          : 0;
      const ageMs = Date.now() - updatedMs;

      if (updatedMs > 0 && ageMs <= PRESENCE_FRESHNESS_MS) {
        console.log(
          `🔕 Suppressed: ${receiverId} is actively viewing chat with ${senderId} (presence ${ageMs}ms old)`
        );
        return res.json({
          success: true,
          skipped: true,
          reason: 'Receiver actively viewing chat with sender',
        });
      }
      console.log(
        `🔔 Presence stale (${ageMs}ms > ${PRESENCE_FRESHNESS_MS}ms) — delivering notification to ${receiverId}`
      );
    }

    const token = userData.fcmToken;

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
              // Firebase Admin (Node) expects ttl as a NUMBER of milliseconds.
              // The '86400s' string form is only valid in the FCM REST API and
              // was making every chat push fail validation ("TTL must be a
              // non-negative duration in milliseconds").
              ttl: 86400000, // 24h in ms — messages shouldn't expire quickly
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
app.post('/sendBroadcast', requireAuth, async (req, res) => {
  try {
    const { title, body, senderId, type, imageUrl } = req.body;

    console.log('📨 Broadcast Request:', { title, type, hasImage: !!imageUrl });

    // Broadcast blasts EVERY user — admins only. A verified ID token whose
    // email is in the `admins` collection is required (the legacy API key,
    // which ships in the APK, is NOT sufficient here).
    if (req.authMethod !== 'idtoken' || !req.email) {
      return res.status(403).json({ success: false, error: 'Admin login required' });
    }
    try {
      const adminDoc = await admin.firestore().collection('admins').doc(req.email).get();
      if (!adminDoc.exists) {
        return res.status(403).json({ success: false, error: 'Admins only' });
      }
    } catch (e) {
      return res.status(403).json({ success: false, error: 'Admin check failed' });
    }

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

    const hasImage = typeof imageUrl === 'string' && imageUrl.trim().length > 0;

    // Which admin sound did the portal pick? 'default' (or empty) = normal
    // channel/sound; otherwise route to the matching custom-sound channel that
    // the app created (campusera_admin_<key> / raw resource admin_<key>).
    const soundKey =
      typeof req.body.sound === 'string' && req.body.sound.trim()
        ? req.body.sound.trim().toLowerCase()
        : 'default';
    const isCustomSound = soundKey !== 'default';
    // Must match the app's versioned admin channel id (_adminChannelIdFor).
    // Bump this suffix in lockstep with the app whenever sounds change.
    const androidChannelId = isCustomSound ? `campusera_admin_${soundKey}_v2` : 'campusera_channel';
    const androidSound = isCustomSound ? soundKey : 'default';
    const iosSound = isCustomSound ? `${soundKey}.caf` : 'default';

    const message = {
      notification: {
        title,
        body,
        // Top-level image → shown as a big picture by the OS on Android.
        ...(hasImage ? { imageUrl: imageUrl.trim() } : {}),
      },
      data: {
        type: type || 'notice',
        senderId: senderId || 'admin',
        // Passed through so the Flutter foreground handler can render the image
        // and pick the correct custom-sound channel.
        imageUrl: hasImage ? imageUrl.trim() : '',
        sound: soundKey,
      },
      android: {
        priority: 'high',
        notification: {
          channelId: androidChannelId,
          sound: androidSound,
          visibility: 'public',
          ...(hasImage ? { imageUrl: imageUrl.trim() } : {}),
        },
      },
      apns: {
        payload: { aps: { sound: iosSound, 'mutable-content': 1 } },
        ...(hasImage ? { fcmOptions: { imageUrl: imageUrl.trim() } } : {}),
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

    // Anti-spam: this fans out to EVERY user, so cap how often one account can
    // trigger it. Blocks the "post in a loop → notification-bomb everyone"
    // abuse. ~1 broadcast per 30s per user.
    if (!rateLimit('feed:' + senderId, 1, 30 * 1000)) {
      return res.status(429).json({ success: false, error: 'You are posting too fast. Please wait a moment.' });
    }

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