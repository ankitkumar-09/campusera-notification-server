const admin = require("firebase-admin");

const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "YOUR_BUCKET.appspot.com",
});

const db = admin.firestore();
const bucket = admin.storage().bucket();


// ==========================
// DELETE ALL AUTH USERS
// ==========================
async function deleteAllUsers(nextPageToken) {
  const result = await admin.auth().listUsers(1000, nextPageToken);

  for (const user of result.users) {
    await admin.auth().deleteUser(user.uid);
    console.log(`Deleted user: ${user.uid}`);
  }

  if (result.pageToken) {
    await deleteAllUsers(result.pageToken);
  }
}


// ==========================
// DELETE ALL FIRESTORE DATA
// ==========================
async function deleteCollection(collectionRef) {
  const snapshot = await collectionRef.get();

  if (snapshot.empty) return;

  const batch = db.batch();

  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });

  await batch.commit();
}

async function deleteAllCollections() {
  const collections = await db.listCollections();

  for (const collection of collections) {
    await deleteCollection(collection);
    console.log(`Deleted collection: ${collection.id}`);
  }
}


// ==========================
// DELETE ALL STORAGE FILES
// ==========================
async function deleteAllStorageFiles() {
  const [files] = await bucket.getFiles();

  for (const file of files) {
    await file.delete();
    console.log(`Deleted file: ${file.name}`);
  }
}


// ==========================
// MAIN
// ==========================
async function cleanup() {
  try {

    console.log("Deleting Firebase Auth users...");
    await deleteAllUsers();

    console.log("Deleting Firestore data...");
    await deleteAllCollections();

    console.log("Deleting Storage files...");
    await deleteAllStorageFiles();

    console.log("✅ EVERYTHING DELETED");

  } catch (error) {
    console.error(error);
  }
}

cleanup();