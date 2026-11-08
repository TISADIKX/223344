import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAnalytics, isSupported } from 'firebase/analytics';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User as FirebaseUser,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
  collection,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import { ChatSession, Message, ChatMode } from './types';

// Initialize or reuse Firebase app
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Auth instance
export const auth = getAuth(app);

// Firestore database instance using the specific database ID
export const db: Firestore = getFirestore(app, (firebaseConfig as any).firestoreDatabaseId);

// Test Firestore connectivity on boot
export async function testFirestoreConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn("Please check your Firebase configuration or internet connection.");
    }
  }
}
testFirestoreConnection().catch(() => {});

// Google Auth Provider configured for popups
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: 'select_account',
});

// Analytics (safe check for SSR / environments without window)
export const initAnalytics = async () => {
  if (typeof window !== 'undefined') {
    const supported = await isSupported().catch(() => false);
    if (supported) {
      try {
        return getAnalytics(app);
      } catch (_e) {}
    }
  }
  return null;
};

// Helper: Sign in with Google
export const signInWithGoogle = async (): Promise<FirebaseUser> => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (err: any) {
    if (
      err?.code === 'auth/popup-blocked' ||
      err?.code === 'auth/popup-closed-by-user' ||
      err?.code === 'auth/cancelled-popup-request'
    ) {
      throw err;
    }
    try {
      await signInWithRedirect(auth, googleProvider);
      const redirectResult = await getRedirectResult(auth);
      if (redirectResult?.user) {
        return redirectResult.user;
      }
    } catch (_redirErr) {}
    throw err;
  }
};

// Helper: Sign out
export const logOutFromFirebase = async (): Promise<void> => {
  await firebaseSignOut(auth);
};

// ----------------- FIRESTORE CHAT HISTORY SYNC -----------------

// Error handling helper per Firebase skill
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
}

/**
 * Save or update a chat session in permanent Firestore database
 */
export async function saveSessionToFirestore(
  userId: string,
  session: ChatSession
): Promise<void> {
  if (!userId || !session || !session.id) return;
  const path = `users/${userId}/sessions/${session.id}`;
  try {
    const sessionDocRef = doc(db, 'users', userId, 'sessions', session.id);
    const dataToStore = {
      id: session.id,
      userId,
      title: session.title.slice(0, 100),
      chatMode: session.chatMode || 'chat',
      messages: JSON.stringify(session.messages || []),
      createdAt: session.createdAt || Date.now(),
      updatedAt: session.updatedAt || Date.now(),
    };
    await setDoc(sessionDocRef, dataToStore, { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

/**
 * Delete a session permanently from Firestore database
 */
export async function deleteSessionFromFirestore(
  userId: string,
  sessionId: string
): Promise<void> {
  if (!userId || !sessionId) return;
  const path = `users/${userId}/sessions/${sessionId}`;
  try {
    const sessionDocRef = doc(db, 'users', userId, 'sessions', sessionId);
    await deleteDoc(sessionDocRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

/**
 * Subscribe to real-time updates of user chat sessions from Firestore
 */
export function subscribeToUserSessions(
  userId: string,
  onSessionsUpdate: (sessions: ChatSession[]) => void
): () => void {
  if (!userId) return () => {};
  const path = `users/${userId}/sessions`;
  try {
    const sessionsCollRef = collection(db, 'users', userId, 'sessions');
    const q = query(sessionsCollRef, orderBy('updatedAt', 'desc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const loaded: ChatSession[] = [];
        snapshot.forEach((docSnap) => {
          const d = docSnap.data();
          let parsedMessages: Message[] = [];
          if (typeof d.messages === 'string') {
            try {
              parsedMessages = JSON.parse(d.messages);
            } catch {}
          } else if (Array.isArray(d.messages)) {
            parsedMessages = d.messages;
          }

          loaded.push({
            id: d.id || docSnap.id,
            title: d.title || 'Chat',
            chatMode: (d.chatMode as ChatMode) || 'chat',
            messages: parsedMessages,
            createdAt: d.createdAt || Date.now(),
            updatedAt: d.updatedAt || Date.now(),
          });
        });
        onSessionsUpdate(loaded);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, path);
      }
    );

    return unsubscribe;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
    return () => {};
  }
}

export { onAuthStateChanged };
export type { FirebaseUser };
