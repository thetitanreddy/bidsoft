export default function handler(req, res) {
  res.status(200).json({
    apiKey: process.env.FIREBASE_API_KEY || "AIzaSyAtlfpb_wqzW96V2pX3gguwKUc3_hq1KjU",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "bid-soft.firebaseapp.com",
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://bid-soft-default-rtdb.firebaseio.com",
    projectId: process.env.FIREBASE_PROJECT_ID || "bid-soft",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "bid-soft.firebasestorage.app",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "898223898663",
    appId: process.env.FIREBASE_APP_ID || "1:898223898663:web:989c1336b393d2fd4bce02"
  });
}
