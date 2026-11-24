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
  collection,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
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

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;

function serializeMessagesForFirestore(messages: Message[]): string {
  const raw = JSON.stringify(messages || []);
  if (raw.length <= 890000) return raw;

  // Strip oversized inline data URI attachments so session document stays safely within blueprint limit
  const trimmedMessages = (messages || []).map((m) => ({
    ...m,
    attachments: m.attachments?.map((att) =>
      att.previewUrl && att.previewUrl.length > 50000
        ? { ...att, previewUrl: '' }
        : att
    ),
    generatedPhoto:
      m.generatedPhoto && m.generatedPhoto.url.length > 200000
        ? { ...m.generatedPhoto, url: '' }
        : m.generatedPhoto,
  }));
  const compact = JSON.stringify(trimmedMessages);
  if (compact.length <= 890000) return compact;

  return JSON.stringify(trimmedMessages.slice(-20)).slice(0, 890000);
}

/**
 * Save or update a chat session in permanent Firestore database (strictly scoped to userId)
 */
export async function saveSessionToFirestore(
  userId: string,
  session: ChatSession
): Promise<void> {
  if (!userId || !session || !session.id) return;
  if (!auth.currentUser || auth.currentUser.uid !== userId) return;
  if (!VALID_ID_REGEX.test(userId) || !VALID_ID_REGEX.test(session.id)) return;

  const path = `users/${userId}/sessions/${session.id}`;
  try {
    const sessionDocRef = doc(db, 'users', userId, 'sessions', session.id);
    const safeTitle = (session.title || 'New chat').trim().slice(0, 100) || 'New chat';
    const safeMode: ChatMode =
      session.chatMode === 'photo' || session.chatMode === 'video' ? session.chatMode : 'chat';

    const dataToStore = {
      id: session.id.slice(0, 128),
      userId: userId.slice(0, 128),
      title: safeTitle,
      chatMode: safeMode,
      messages: serializeMessagesForFirestore(session.messages || []),
      createdAt: Number(session.createdAt) || Date.now(),
      updatedAt: Number(session.updatedAt) || Date.now(),
    };
    await setDoc(sessionDocRef, dataToStore, { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

/**
 * Delete a session permanently from Firestore database (strictly scoped to userId)
 */
export async function deleteSessionFromFirestore(
  userId: string,
  sessionId: string
): Promise<void> {
  if (!userId || !sessionId) return;
  if (!auth.currentUser || auth.currentUser.uid !== userId) return;
  if (!VALID_ID_REGEX.test(userId) || !VALID_ID_REGEX.test(sessionId)) return;

  const path = `users/${userId}/sessions/${sessionId}`;
  try {
    const sessionDocRef = doc(db, 'users', userId, 'sessions', sessionId);
    await deleteDoc(sessionDocRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

/**
 * Subscribe to real-time updates of a specific user's private chat sessions from Firestore
 */
export function subscribeToUserSessions(
  userId: string,
  onSessionsUpdate: (sessions: ChatSession[]) => void,
  onError?: (err: unknown) => void
): () => void {
  if (!userId || !auth.currentUser || auth.currentUser.uid !== userId) {
    return () => {};
  }
  const path = `users/${userId}/sessions`;
  try {
    const sessionsCollRef = collection(db, 'users', userId, 'sessions');
    const q = query(sessionsCollRef, where('userId', '==', userId));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const loaded: ChatSession[] = [];
        snapshot.forEach((docSnap) => {
          const d = docSnap.data();
          if (d.userId && d.userId !== userId) return;

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
            userId,
            title: d.title || 'Chat',
            chatMode: (d.chatMode as ChatMode) || 'chat',
            messages: parsedMessages,
            createdAt: Number(d.createdAt) || Date.now(),
            updatedAt: Number(d.updatedAt) || Date.now(),
          });
        });

        loaded.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
        onSessionsUpdate(loaded);
      },
      (error) => {
        console.warn('Firestore session listener error:', path, error);
        if (onError) {
          onError(error);
        }
      }
    );

    return unsubscribe;
  } catch (err) {
    console.warn('Firestore session subscription setup error:', path, err);
    if (onError) {
      onError(err);
    }
    return () => {};
  }
}

export { onAuthStateChanged };
export type { FirebaseUser };
