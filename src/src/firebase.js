import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

// TODO: Replace with your Firebase project config from
// Firebase Console > Project Settings > Your apps > SDK setup & configuration
const firebaseConfig = {
  apiKey: "AIzaSyD_p9z2XlkmTvqNKZc5WMP9zQTkrwBZiyU",
  authDomain: "self-rating-app-b3b2b.firebaseapp.com",
  projectId: "self-rating-app-b3b2b",
  storageBucket: "self-rating-app-b3b2b.firebasestorage.app",
  messagingSenderId: "386911881814",
  appId: "1:386911881814:web:a7e2af1a621cf62428c9f7",
  measurementId: "G-PE0DDFPB5M"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);
export const googleProvider = new GoogleAuthProvider();
