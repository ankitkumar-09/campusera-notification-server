const admin = require('firebase-admin');

const serviceAccount =
  require('./serviceAccountKey.json');

admin.initializeApp({
  credential:
    admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function deleteCollection(name) {

  const snapshot =
    await db.collection(name).get();

  if (snapshot.empty) {
    console.log(`${name} already empty`);
    return;
  }

  const batch = db.batch();

  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });

  await batch.commit();

  console.log(`Deleted ${name}`);
}

async function run() {

  const collections = [
    'chatmessages',
    'discussion_notifications',
    'discussions',
    'lostItems',
    'marketItems',
    'marketPayments',
    'mess',
    'roommateprofiles',
    'rooms',
    'notifications',
  ];

  for (const c of collections) {
    await deleteCollection(c);
  }

  console.log('✅ Cleanup complete');
}

run();