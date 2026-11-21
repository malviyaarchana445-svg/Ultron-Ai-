import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  sendPasswordResetEmail,
  sendEmailVerification,
  signOut,
  updateProfile,
  User,
  AuthError
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  Unsubscribe
} from 'firebase/firestore';
import { auth, db, googleProvider, OperationType, handleFirestoreError } from '../firebase';
import {
  ApiSettings,
  Conversation,
  CustomAgent,
  FileRecord,
  GoogleUser,
  Message,
  UserMemory,
  WorkspaceItem
} from '../types';
import { getConversationsFromIndexedDB } from '../utils/chatStorage';

// --- Safe Value Cleaners ---

function sanitizeId(rawId: string): string {
  const cleaned = (rawId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return cleaned || `conv_${Date.now()}`;
}

function stripUndefinedDeep<T>(val: T): T {
  if (Array.isArray(val)) {
    return val.map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (val !== null && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out as T;
  }
  return val;
}

// Keep messages well under Firestore 1MB doc limit by trimming giant base64 blobs
function sanitizeMessageForFirestore(msg: Message): Record<string, unknown> {
  const safeAttachedImage =
    msg.attachedImage && msg.attachedImage.length <= 45000 ? msg.attachedImage : undefined;

  const safeGeneratedUrl =
    msg.generatedImageUrl && msg.generatedImageUrl.length <= 120000
      ? msg.generatedImageUrl
      : msg.generatedImageUrl && !msg.generatedImageUrl.startsWith('data:')
      ? msg.generatedImageUrl
      : undefined;

  const safeAttachedFile = msg.attachedFile
    ? stripUndefinedDeep({
        name: String(msg.attachedFile.name || 'attachment').slice(0, 200),
        type: String(msg.attachedFile.type || 'application/octet-stream').slice(0, 100),
        size: Number(msg.attachedFile.size || 0),
        ...(msg.attachedFile.dataUrl && msg.attachedFile.dataUrl.length <= 45000
          ? { dataUrl: msg.attachedFile.dataUrl }
          : {}),
        ...(msg.attachedFile.textContent
          ? { textContent: String(msg.attachedFile.textContent).slice(0, 12000) }
          : {})
      })
    : undefined;

  let safeContent = typeof msg.content === 'string' ? msg.content : String(msg.content || '');
  if (safeContent.startsWith('data:image/') && safeContent.length > 120000) {
    safeContent = msg.imagePrompt ? `🎨 Image: ${msg.imagePrompt}` : '🎨 Generated Image';
  } else if (safeContent.length > 60000) {
    safeContent = safeContent.slice(0, 60000);
  }

  return stripUndefinedDeep({
    id: String(msg.id || `msg_${Date.now()}`),
    role: msg.role || 'assistant',
    content: safeContent,
    timestamp: String(msg.timestamp || ''),
    attachedImage: safeAttachedImage,
    attachedFile: safeAttachedFile,
    thought: msg.thought ? String(msg.thought).slice(0, 15000) : undefined,
    searchSources: Array.isArray(msg.searchSources) ? msg.searchSources.slice(0, 15) : undefined,
    imagePrompt: msg.imagePrompt ? String(msg.imagePrompt).slice(0, 1000) : undefined,
    generatedImageUrl: safeGeneratedUrl
  });
}

// Convert Firebase Auth User -> UI GoogleUser object
export function toAppUser(user: User): GoogleUser {
  const fallbackName = user.email ? user.email.split('@')[0] : 'Ultron User';
  return {
    id: user.uid,
    uid: user.uid,
    name: (user.displayName || fallbackName).trim(),
    email: user.email || '',
    picture: user.photoURL || undefined,
    emailVerified: user.emailVerified,
    providerId: user.providerData?.[0]?.providerId || 'password'
  };
}

// --- Firebase Auth Error Mapping ---

export function mapFirebaseAuthError(err: unknown): string {
  const code = (err as AuthError)?.code || '';
  const msg = (err as Error)?.message || '';

  switch (code) {
    case 'auth/email-already-in-use':
      return 'Account already exists. Please Sign In.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Invalid email or password. Please check your credentials and try again.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/weak-password':
      return 'Password is too weak. Use at least 6 characters.';
    case 'auth/operation-not-allowed':
      return 'Email/Password sign-in is not yet enabled in Firebase Console. Enable Email/Password under Authentication > Sign-in method, or use Continue with Google.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'auth/popup-closed-by-user':
      return 'Google Sign-In popup was closed before finishing.';
    case 'auth/popup-blocked':
      return 'Sign-In popup was blocked by your browser. Please allow popups and try again.';
    case 'auth/network-request-failed':
      return 'Network error while connecting to Firebase. Check your internet connection.';
    case 'auth/requires-recent-login':
      return 'Please sign out and sign back in to perform this action.';
    default:
      if (msg.includes('auth/email-already-in-use')) {
        return 'Account already exists. Please Sign In.';
      }
      return msg || 'Authentication failed. Please try again.';
  }
}

// --- Firebase Authentication Operations ---

export async function signUpWithEmail(
  fullName: string,
  email: string,
  password: string
): Promise<{ user: User; verificationSent: boolean }> {
  const cleanName = fullName.trim();
  const cleanEmail = email.trim().toLowerCase();

  const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
  if (cleanName) {
    await updateProfile(cred.user, { displayName: cleanName });
  }

  let verificationSent = false;
  try {
    await sendEmailVerification(cred.user);
    verificationSent = true;
  } catch (verifyErr) {
    console.warn('Email verification send skipped:', verifyErr);
  }

  return { user: cred.user, verificationSent };
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
  const cleanEmail = email.trim().toLowerCase();
  const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
  return cred.user;
}

export async function signInWithGoogle(): Promise<User> {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

export async function resetPassword(email: string): Promise<void> {
  const cleanEmail = email.trim().toLowerCase();
  await sendPasswordResetEmail(auth, cleanEmail);
}

export async function resendVerificationEmail(): Promise<void> {
  if (!auth.currentUser) {
    throw new Error('No signed-in user found.');
  }
  await sendEmailVerification(auth.currentUser);
}

export async function refreshAuthUser(): Promise<User | null> {
  if (!auth.currentUser) return null;
  await auth.currentUser.reload();
  return auth.currentUser;
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

// --- Cloud Preferences Helper (Never stores apiKey in Firestore) ---

export function extractCloudPreferences(settings: ApiSettings): Record<string, unknown> {
  return stripUndefinedDeep({
    theme: settings.theme,
    responseMode: settings.responseMode,
    voiceLang: settings.voiceLang,
    speechRate: settings.speechRate,
    speechPitch: settings.speechPitch,
    speechEnabled: settings.speechEnabled,
    autoInterrupt: settings.autoInterrupt,
    searchEnabled: settings.searchEnabled,
    memoryEnabled: settings.memoryEnabled,
    model: settings.model,
    wakeWordEnabled: settings.wakeWordEnabled,
    wakeWordPhrase: settings.wakeWordPhrase,
    backgroundListeningEnabled: settings.backgroundListeningEnabled
  });
}

// --- Firestore User Profile Sync ---

export async function syncUserProfileOnLogin(
  user: User,
  currentSettings: ApiSettings
): Promise<Partial<ApiSettings> | null> {
  const uid = user.uid;
  const userPath = `users/${uid}`;
  const userRef = doc(db, 'users', uid);

  const safeDisplayName = (
    user.displayName ||
    user.email?.split('@')[0] ||
    'Ultron User'
  )
    .trim()
    .slice(0, 120);
  const safeEmail = (user.email || `${uid}@ultron.local`).trim().slice(0, 254);
  const safePhotoURL =
    user.photoURL && user.photoURL.length <= 2048 ? user.photoURL : undefined;

  try {
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      const newProfile: Record<string, unknown> = {
        uid,
        displayName: safeDisplayName,
        email: safeEmail,
        createdAt: serverTimestamp(),
        lastLogin: serverTimestamp(),
        preferences: extractCloudPreferences(currentSettings)
      };
      if (safePhotoURL) {
        newProfile.photoURL = safePhotoURL;
      }

      await setDoc(userRef, newProfile);
      return null;
    }

    const data = snap.data();
    const updatePayload: Record<string, unknown> = {
      lastLogin: serverTimestamp()
    };

    if (safeDisplayName && data.displayName !== safeDisplayName) {
      updatePayload.displayName = safeDisplayName;
    }
    if (safeEmail && data.email !== safeEmail) {
      updatePayload.email = safeEmail;
    }
    if (safePhotoURL && data.photoURL !== safePhotoURL) {
      updatePayload.photoURL = safePhotoURL;
    }

    await updateDoc(userRef, updatePayload);

    if (data.preferences && typeof data.preferences === 'object') {
      const prefs = data.preferences as Record<string, unknown>;
      const restored: Partial<ApiSettings> = {};
      if (prefs.theme === 'dark' || prefs.theme === 'light') restored.theme = prefs.theme;
      if (prefs.responseMode === 'pro' || prefs.responseMode === 'plus' || prefs.responseMode === 'thinking') {
        restored.responseMode = prefs.responseMode;
      }
      if (prefs.voiceLang === 'hi-IN' || prefs.voiceLang === 'en-US') restored.voiceLang = prefs.voiceLang;
      if (typeof prefs.speechRate === 'number') restored.speechRate = prefs.speechRate;
      if (typeof prefs.speechPitch === 'number') restored.speechPitch = prefs.speechPitch;
      if (typeof prefs.speechEnabled === 'boolean') restored.speechEnabled = prefs.speechEnabled;
      if (typeof prefs.autoInterrupt === 'boolean') restored.autoInterrupt = prefs.autoInterrupt;
      if (typeof prefs.searchEnabled === 'boolean') restored.searchEnabled = prefs.searchEnabled;
      if (typeof prefs.memoryEnabled === 'boolean') restored.memoryEnabled = prefs.memoryEnabled;
      if (typeof prefs.model === 'string' && prefs.model.length > 0) restored.model = prefs.model;
      if (typeof prefs.wakeWordEnabled === 'boolean') restored.wakeWordEnabled = prefs.wakeWordEnabled;
      if (typeof prefs.wakeWordPhrase === 'string' && prefs.wakeWordPhrase.length > 0) {
        restored.wakeWordPhrase = prefs.wakeWordPhrase;
      }
      if (typeof prefs.backgroundListeningEnabled === 'boolean') {
        restored.backgroundListeningEnabled = prefs.backgroundListeningEnabled;
      }
      return restored;
    }

    return null;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }
}

export async function updateUserPreferencesInCloud(
  uid: string,
  settings: ApiSettings
): Promise<void> {
  if (!uid) return;
  const userPath = `users/${uid}`;
  const userRef = doc(db, 'users', uid);

  try {
    await updateDoc(userRef, {
      preferences: extractCloudPreferences(settings),
      lastLogin: serverTimestamp()
    });
  } catch (err) {
    console.warn('Preferences cloud update skipped:', err);
  }
}

// --- Firestore Chat Sync ---

export async function saveChatToCloud(
  uid: string,
  conv: Conversation,
  model: string,
  knownCloudIds?: Set<string>
): Promise<void> {
  if (!uid || !conv || !conv.id) return;
  // Never persist empty welcome-only New Chats to Firestore
  if (!conv.messages || conv.messages.length <= 1) return;

  const chatId = sanitizeId(conv.id);
  const chatPath = `users/${uid}/chats/${chatId}`;
  const chatRef = doc(db, 'users', uid, 'chats', chatId);

  const safeTitle = (conv.title || 'New Chat').trim().slice(0, 200) || 'New Chat';
  const safeModel = (model || 'gemini-3-flash-preview').trim().slice(0, 100);
  const safeMode =
    conv.mode === 'plus' || conv.mode === 'thinking' || conv.mode === 'pro' ? conv.mode : 'pro';
  const sanitizedMessages = (conv.messages || []).slice(-500).map(sanitizeMessageForFirestore);
  const nowMs = Date.now();
  const metadata = {
    messageCount: sanitizedMessages.length,
    syncedFrom: 'web',
    ...(conv.agentId ? { agentId: String(conv.agentId).slice(0, 128) } : {})
  };

  try {
    let existsInCloud = knownCloudIds ? knownCloudIds.has(chatId) : false;
    if (!existsInCloud) {
      const snap = await getDoc(chatRef);
      existsInCloud = snap.exists();
    }

    if (existsInCloud) {
      await updateDoc(chatRef, {
        title: safeTitle,
        messages: sanitizedMessages,
        updatedAt: serverTimestamp(),
        clientUpdatedAt: conv.updatedAt || nowMs,
        model: safeModel,
        mode: safeMode,
        metadata
      });
    } else {
      await setDoc(chatRef, {
        chatId,
        userId: uid,
        title: safeTitle,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        clientCreatedAt: conv.createdAt || nowMs,
        clientUpdatedAt: conv.updatedAt || nowMs,
        messages: sanitizedMessages,
        model: safeModel,
        mode: safeMode,
        metadata
      });
    }

    knownCloudIds?.add(chatId);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, chatPath);
  }
}

export async function renameChatInCloud(
  uid: string,
  chatIdRaw: string,
  newTitle: string,
  knownCloudIds?: Set<string>
): Promise<void> {
  if (!uid || !chatIdRaw || !newTitle.trim()) return;
  const chatId = sanitizeId(chatIdRaw);
  const chatPath = `users/${uid}/chats/${chatId}`;
  const chatRef = doc(db, 'users', uid, 'chats', chatId);

  try {
    const existsInCloud = knownCloudIds?.has(chatId);
    if (!existsInCloud) {
      const snap = await getDoc(chatRef);
      if (!snap.exists()) return;
      knownCloudIds?.add(chatId);
    }

    await updateDoc(chatRef, {
      title: newTitle.trim().slice(0, 200),
      updatedAt: serverTimestamp(),
      clientUpdatedAt: Date.now(),
      metadata: {
        renamedAt: Date.now()
      }
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, chatPath);
  }
}

export async function deleteChatFromCloud(
  uid: string,
  chatIdRaw: string,
  knownCloudIds?: Set<string>
): Promise<void> {
  if (!uid || !chatIdRaw) return;
  const chatId = sanitizeId(chatIdRaw);
  const chatPath = `users/${uid}/chats/${chatId}`;
  const chatRef = doc(db, 'users', uid, 'chats', chatId);

  try {
    await deleteDoc(chatRef);
    knownCloudIds?.delete(chatId);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, chatPath);
  }
}

export async function clearAllCloudChats(uid: string, knownCloudIds?: Set<string>): Promise<void> {
  if (!uid) return;
  const chatsPath = `users/${uid}/chats`;

  try {
    const q = query(collection(db, 'users', uid, 'chats'), where('userId', '==', uid));
    const snap = await getDocs(q);
    if (snap.empty) return;

    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = writeBatch(db);
      for (const d of docs.slice(i, i + 400)) {
        batch.delete(d.ref);
        knownCloudIds?.delete(d.id);
      }
      await batch.commit();
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, chatsPath);
  }
}

function docToConversation(data: Record<string, unknown>, docId: string): Conversation {
  const createdTs =
    typeof data.clientCreatedAt === 'number'
      ? data.clientCreatedAt
      : data.createdAt && typeof (data.createdAt as { toMillis?: () => number }).toMillis === 'function'
      ? (data.createdAt as { toMillis: () => number }).toMillis()
      : Date.now();

  const updatedTs =
    typeof data.clientUpdatedAt === 'number'
      ? data.clientUpdatedAt
      : data.updatedAt && typeof (data.updatedAt as { toMillis?: () => number }).toMillis === 'function'
      ? (data.updatedAt as { toMillis: () => number }).toMillis()
      : createdTs;

  const mode =
    data.mode === 'plus' || data.mode === 'thinking' || data.mode === 'pro' ? data.mode : 'pro';

  const meta =
    data.metadata && typeof data.metadata === 'object'
      ? (data.metadata as Record<string, unknown>)
      : {};

  return {
    id: String(data.chatId || docId),
    title: String(data.title || 'Untitled Chat'),
    createdAt: createdTs,
    updatedAt: updatedTs,
    messages: Array.isArray(data.messages) ? (data.messages as Message[]) : [],
    mode,
    ...(typeof meta.agentId === 'string' && meta.agentId ? { agentId: meta.agentId } : {})
  };
}

// Real-time multi-device listener scoped to users/{uid}/chats
export function subscribeToUserChats(
  uid: string,
  onChats: (chats: Conversation[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const chatsPath = `users/${uid}/chats`;
  const q = query(collection(db, 'users', uid, 'chats'), where('userId', '==', uid));

  return onSnapshot(
    q,
    (snapshot) => {
      const list = snapshot.docs.map((d) =>
        docToConversation(d.data() as Record<string, unknown>, d.id)
      );
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      onChats(list);
    },
    (error) => {
      console.error('Firestore chat listener error:', error);
      if (onError) {
        onError(error);
      } else {
        handleFirestoreError(error, OperationType.LIST, chatsPath);
      }
    }
  );
}

// --- Guest Chat Migration Helpers ---

export async function getMigratableGuestChats(
  existingCloudChats: Conversation[]
): Promise<Conversation[]> {
  const localMap = new Map<string, Conversation>();

  try {
    const idbChats = await getConversationsFromIndexedDB();
    for (const c of idbChats) {
      if (c && c.id && Array.isArray(c.messages) && c.messages.length > 1) {
        localMap.set(c.id, c);
      }
    }
  } catch {}

  try {
    const raw = localStorage.getItem('ultron_conversations');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const c of parsed) {
          if (c && c.id && Array.isArray(c.messages) && c.messages.length > 1 && !localMap.has(c.id)) {
            localMap.set(c.id, c);
          }
        }
      }
    }
  } catch {}

  if (localMap.size === 0) return [];

  const cloudIds = new Set(existingCloudChats.map((c) => sanitizeId(c.id)));
  const cloudFingerprints = new Set(
    existingCloudChats.map((c) => {
      const firstUserMsg = c.messages.find((m) => m.role === 'user')?.content || '';
      return `${(c.title || '').toLowerCase()}::${firstUserMsg.slice(0, 80).toLowerCase()}`;
    })
  );

  return Array.from(localMap.values()).filter((guestConv) => {
    if (cloudIds.has(sanitizeId(guestConv.id))) return false;
    const firstUserMsg = guestConv.messages.find((m) => m.role === 'user')?.content || '';
    const fp = `${(guestConv.title || '').toLowerCase()}::${firstUserMsg.slice(0, 80).toLowerCase()}`;
    return !cloudFingerprints.has(fp);
  });
}

export async function migrateGuestChatsToCloud(
  uid: string,
  guestChats: Conversation[],
  model: string,
  knownCloudIds?: Set<string>
): Promise<number> {
  if (!uid || guestChats.length === 0) return 0;

  let migratedCount = 0;
  for (const conv of guestChats) {
    try {
      await saveChatToCloud(uid, conv, model, knownCloudIds);
      migratedCount += 1;
    } catch (err) {
      console.warn('Guest chat migration error for conv:', conv.id, err);
    }
  }
  return migratedCount;
}

// --- Phase 7: User Memories Cloud Sync (users/{uid}/memories/{memoryId}) ---

export function subscribeToUserMemories(
  uid: string,
  onMemories: (items: UserMemory[]) => void
): Unsubscribe {
  const path = `users/${uid}/memories`;
  const q = query(collection(db, 'users', uid, 'memories'), where('userId', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const items: UserMemory[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: String(data.id || d.id),
          fact: String(data.fact || ''),
          category: String(data.category || 'General'),
          enabled: typeof data.enabled === 'boolean' ? data.enabled : true,
          createdAt: Number(data.clientCreatedAt || Date.now()),
          updatedAt: Number(data.clientUpdatedAt || Date.now())
        };
      });
      items.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
      onMemories(items);
    },
    (err) => {
      console.error('Memories listener error:', err);
      handleFirestoreError(err, OperationType.LIST, path);
    }
  );
}

export async function createMemoryInCloud(
  uid: string,
  fact: string,
  category = 'General'
): Promise<UserMemory> {
  const id = sanitizeId(`mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const now = Date.now();
  const path = `users/${uid}/memories/${id}`;
  try {
    await setDoc(doc(db, 'users', uid, 'memories', id), {
      id,
      userId: uid,
      fact: fact.trim().slice(0, 1000),
      category: category.trim().slice(0, 60) || 'General',
      enabled: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      clientCreatedAt: now,
      clientUpdatedAt: now
    });
    return { id, fact: fact.trim(), category, enabled: true, createdAt: now, updatedAt: now };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function updateMemoryInCloud(
  uid: string,
  memoryId: string,
  patch: Partial<Pick<UserMemory, 'fact' | 'category' | 'enabled'>>
): Promise<void> {
  const id = sanitizeId(memoryId);
  const path = `users/${uid}/memories/${id}`;
  try {
    const updatePayload: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
      clientUpdatedAt: Date.now()
    };
    if (patch.fact !== undefined) updatePayload.fact = patch.fact.trim().slice(0, 1000);
    if (patch.category !== undefined) updatePayload.category = patch.category.trim().slice(0, 60);
    if (patch.enabled !== undefined) updatePayload.enabled = patch.enabled;
    await updateDoc(doc(db, 'users', uid, 'memories', id), updatePayload);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteMemoryFromCloud(uid: string, memoryId: string): Promise<void> {
  const id = sanitizeId(memoryId);
  const path = `users/${uid}/memories/${id}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'memories', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function clearAllMemoriesInCloud(uid: string): Promise<void> {
  const path = `users/${uid}/memories`;
  try {
    const q = query(collection(db, 'users', uid, 'memories'), where('userId', '==', uid));
    const snap = await getDocs(q);
    if (snap.empty) return;
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = writeBatch(db);
      for (const d of snap.docs.slice(i, i + 400)) {
        batch.delete(d.ref);
      }
      await batch.commit();
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// --- Phase 6: AI Workspace Cloud Sync (users/{uid}/workspace/{itemId}) ---

export function subscribeToWorkspaceItems(
  uid: string,
  onItems: (items: WorkspaceItem[]) => void
): Unsubscribe {
  const path = `users/${uid}/workspace`;
  const q = query(collection(db, 'users', uid, 'workspace'), where('userId', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const items: WorkspaceItem[] = snap.docs.map((d) => {
        const data = d.data();
        const type =
          data.type === 'document' || data.type === 'task' || data.type === 'draft'
            ? data.type
            : 'note';
        return {
          id: String(data.id || d.id),
          type,
          folder: String(data.folder || 'General'),
          title: String(data.title || 'Untitled'),
          content: String(data.content || ''),
          completed: Boolean(data.completed),
          tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
          updatedAt: Number(data.clientUpdatedAt || Date.now())
        };
      });
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      onItems(items);
    },
    (err) => {
      console.error('Workspace listener error:', err);
      handleFirestoreError(err, OperationType.LIST, path);
    }
  );
}

export async function saveWorkspaceItemInCloud(
  uid: string,
  item: Omit<WorkspaceItem, 'updatedAt'> & { updatedAt?: number }
): Promise<WorkspaceItem> {
  const id = sanitizeId(item.id || `ws_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const ref = doc(db, 'users', uid, 'workspace', id);
  const path = `users/${uid}/workspace/${id}`;
  const now = Date.now();
  const safePayload = {
    type: item.type,
    folder: (item.folder || 'General').trim().slice(0, 100),
    title: (item.title || 'Untitled').trim().slice(0, 200) || 'Untitled',
    content: (item.content || '').slice(0, 150000),
    completed: Boolean(item.completed),
    tags: (item.tags || []).slice(0, 20).map((t) => String(t).slice(0, 40)),
    clientUpdatedAt: now
  };

  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, { ...safePayload, updatedAt: serverTimestamp() });
    } else {
      await setDoc(ref, {
        id,
        userId: uid,
        ...safePayload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
    return { ...safePayload, id, updatedAt: now };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteWorkspaceItemFromCloud(uid: string, itemId: string): Promise<void> {
  const id = sanitizeId(itemId);
  const path = `users/${uid}/workspace/${id}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'workspace', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// --- Phase 10: Custom AI Agents Cloud Sync (users/{uid}/agents/{agentId}) ---

export const DEFAULT_ULTRON_AGENTS: Array<Omit<CustomAgent, 'updatedAt'>> = [
  {
    id: 'agent_ultron_general',
    name: 'Ultron General Assistant',
    avatar: '🤖',
    description: 'Versatile daily assistant for reasoning, Q&A, math, and web lookups.',
    instructions: 'You are Ultron General Assistant, created by Krishna Chouhan and Kiran Panwar. Deliver direct, clear, helpful answers across general knowledge, planning, and live web queries.',
    model: 'gemini-4-hydrogen',
    responseStyle: 'balanced',
    tools: ['web_search', 'device_control', 'files', 'writing'],
    isDefault: true
  },
  {
    id: 'agent_ultron_coding',
    name: 'Ultron Coding Agent',
    avatar: '💻',
    description: 'Senior full-stack software engineer for clean code, debugging, and architecture.',
    instructions: 'You are Ultron Coding Agent. Write clean, modular, type-safe production code with brief architectural reasoning, edge-case handling, and clear verification steps.',
    model: 'gemini-4-hydrogen',
    responseStyle: 'technical',
    tools: ['code', 'files', 'web_search'],
    isDefault: true
  },
  {
    id: 'agent_ultron_research',
    name: 'Ultron Research Agent',
    avatar: '🔬',
    description: 'Evidence-focused analyst comparing sources and separating verified facts from uncertainty.',
    instructions: 'You are Ultron Research Agent. Ground claims in verifiable sources, explicitly flag conflicting data or uncertainty, and structure findings with executive summaries and tables.',
    model: 'gemini-4-hydrogen',
    responseStyle: 'detailed',
    tools: ['web_search', 'files'],
    isDefault: true
  },
  {
    id: 'agent_ultron_writing',
    name: 'Ultron Writing Agent',
    avatar: '✍️',
    description: 'Editorial writer for essays, emails, technical docs, scripts, and multilingual polish.',
    instructions: 'You are Ultron Writing Agent. Craft compelling, clear, audience-tailored prose in English, Hindi, or Hinglish with strong narrative flow and zero filler.',
    model: 'gemini-4-hydrogen',
    responseStyle: 'creative',
    tools: ['writing', 'files'],
    isDefault: true
  },
  {
    id: 'agent_ultron_study',
    name: 'Ultron Study Agent',
    avatar: '🎓',
    description: 'Patient academic tutor breaking down complex concepts with analogies and practice questions.',
    instructions: 'You are Ultron Study Agent. Teach step by step using intuitive examples, visual ASCII/table breakdowns, and quick check-for-understanding questions.',
    model: 'gemini-4-hydrogen',
    responseStyle: 'detailed',
    tools: ['web_search', 'files', 'code'],
    isDefault: true
  },
  {
    id: 'agent_ultron_creative',
    name: 'Ultron Creative Agent',
    avatar: '🎨',
    description: 'Brainstorming partner for ideation, storytelling, worldbuilding, and creative concepts.',
    instructions: 'You are Ultron Creative Agent. Generate imaginative creative concepts, character lore, scripts, and original ideas.',
    model: 'gemini-4-hydrogen',
    responseStyle: 'creative',
    tools: ['writing', 'web_search', 'device_control'],
    isDefault: true
  }
];

export function subscribeToCustomAgents(
  uid: string,
  onAgents: (items: CustomAgent[]) => void
): Unsubscribe {
  const path = `users/${uid}/agents`;
  const q = query(collection(db, 'users', uid, 'agents'), where('userId', '==', uid));
  let seeded = false;

  return onSnapshot(
    q,
    async (snap) => {
      if (snap.empty && !seeded) {
        seeded = true;
        try {
          const now = Date.now();
          for (const def of DEFAULT_ULTRON_AGENTS) {
            await setDoc(doc(db, 'users', uid, 'agents', def.id), {
              ...def,
              userId: uid,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              clientUpdatedAt: now
            });
          }
          return;
        } catch (seedErr) {
          console.warn('Default agent seed warning:', seedErr);
        }
      }

      const items: CustomAgent[] = snap.docs.map((d) => {
        const data = d.data();
        const style =
          data.responseStyle === 'concise' ||
          data.responseStyle === 'detailed' ||
          data.responseStyle === 'creative' ||
          data.responseStyle === 'technical'
            ? data.responseStyle
            : 'balanced';
        return {
          id: String(data.id || d.id),
          name: String(data.name || 'Custom Agent'),
          avatar: String(data.avatar || '🤖'),
          description: String(data.description || ''),
          instructions: String(data.instructions || ''),
          model: String(data.model || 'gemini-4-hydrogen'),
          responseStyle: style,
          tools: Array.isArray(data.tools) ? data.tools : ['web_search'],
          isDefault: Boolean(data.isDefault),
          updatedAt: Number(data.clientUpdatedAt || Date.now())
        };
      });
      items.sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) || b.updatedAt - a.updatedAt);
      onAgents(items);
    },
    (err) => {
      console.error('Agents listener error:', err);
      handleFirestoreError(err, OperationType.LIST, path);
    }
  );
}

export async function saveCustomAgentInCloud(
  uid: string,
  agent: Omit<CustomAgent, 'updatedAt'> & { updatedAt?: number }
): Promise<CustomAgent> {
  const id = sanitizeId(agent.id || `agent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const ref = doc(db, 'users', uid, 'agents', id);
  const path = `users/${uid}/agents/${id}`;
  const now = Date.now();
  const payload = {
    name: agent.name.trim().slice(0, 100) || 'Custom Agent',
    avatar: (agent.avatar || '🤖').slice(0, 32),
    description: (agent.description || '').trim().slice(0, 400),
    instructions: agent.instructions.trim().slice(0, 12000),
    model: (agent.model || 'gemini-4-hydrogen').trim().slice(0, 100),
    responseStyle: agent.responseStyle || 'balanced',
    tools: (agent.tools || []).slice(0, 20),
    clientUpdatedAt: now
  };

  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, { ...payload, updatedAt: serverTimestamp() });
    } else {
      await setDoc(ref, {
        id,
        userId: uid,
        ...payload,
        isDefault: Boolean(agent.isDefault),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
    return { ...payload, id, isDefault: Boolean(agent.isDefault), updatedAt: now };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteCustomAgentFromCloud(uid: string, agentId: string): Promise<void> {
  const id = sanitizeId(agentId);
  const path = `users/${uid}/agents/${id}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'agents', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// --- Phase 2: Analyzed Files Cloud Sync (users/{uid}/files/{fileId}) ---

export function subscribeToFileRecords(
  uid: string,
  onFiles: (items: FileRecord[]) => void
): Unsubscribe {
  const path = `users/${uid}/files`;
  const q = query(collection(db, 'users', uid, 'files'), where('userId', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const items: FileRecord[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: String(data.id || d.id),
          name: String(data.name || 'Document'),
          mimeType: String(data.mimeType || 'text/plain'),
          size: Number(data.size || 0),
          extractedText: String(data.extractedText || ''),
          summary: data.summary ? String(data.summary) : undefined,
          updatedAt: Number(data.clientUpdatedAt || Date.now())
        };
      });
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      onFiles(items);
    },
    (err) => {
      console.error('Files listener error:', err);
      handleFirestoreError(err, OperationType.LIST, path);
    }
  );
}

export async function saveFileRecordInCloud(
  uid: string,
  record: Omit<FileRecord, 'updatedAt'>
): Promise<FileRecord> {
  const id = sanitizeId(record.id || `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const ref = doc(db, 'users', uid, 'files', id);
  const path = `users/${uid}/files/${id}`;
  const now = Date.now();

  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, {
        extractedText: (record.extractedText || '').slice(0, 120000),
        summary: (record.summary || '').slice(0, 25000),
        updatedAt: serverTimestamp(),
        clientUpdatedAt: now
      });
    } else {
      await setDoc(ref, {
        id,
        userId: uid,
        name: record.name.slice(0, 240),
        mimeType: record.mimeType.slice(0, 120),
        size: Number(record.size || 0),
        extractedText: (record.extractedText || '').slice(0, 120000),
        ...(record.summary ? { summary: record.summary.slice(0, 25000) } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        clientUpdatedAt: now
      });
    }
    return { ...record, id, updatedAt: now };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteFileRecordFromCloud(uid: string, fileId: string): Promise<void> {
  const id = sanitizeId(fileId);
  const path = `users/${uid}/files/${id}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'files', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
