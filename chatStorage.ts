// Ultron AI Persistent Chat Storage Engine
// Uses native IndexedDB with localStorage fallback and server sync
// Guarantees conversations survive refresh, close, restart, and device reboot

import { Conversation, Message } from '../types';

const DB_NAME = 'ultron_ai_db';
const DB_VERSION = 1;
const STORE_CONVERSATIONS = 'conversations';
const STORE_METADATA = 'metadata';

let dbInstance: IDBDatabase | null = null;
let dbInitPromise: Promise<IDBDatabase> | null = null;

// Helper to open or initialize IndexedDB
export function openChatDatabase(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB not supported in this environment'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Store: conversations
      if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        const convStore = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' });
        convStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        convStore.createIndex('createdAt', 'createdAt', { unique: false });
      }

      // Store: metadata
      if (!db.objectStoreNames.contains(STORE_METADATA)) {
        db.createObjectStore(STORE_METADATA, { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;

      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
        dbInitPromise = null;
      };

      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.warn('Failed to open IndexedDB:', (event.target as IDBOpenDBRequest).error);
      reject((event.target as IDBOpenDBRequest).error);
    };
  });

  return dbInitPromise;
}

// Generate short, clean, capitalized title from user prompt
// e.g. "Make a 2D anime warrior" -> "2D Anime Warrior"
export function generateCleanTitle(userText: string): string {
  if (!userText || typeof userText !== 'string') return 'New Chat';

  let cleaned = userText
    .replace(/^🎨\s*Artwork Prompt:\s*/i, '')
    .replace(/^\s*(?:please|can you|could you|i want you to|help me|tell me|make|generate|draw|create|render|paint|design|banao|बनाओ|दिखाओ|what is|how to|who is|explain|write)\s+(?:a|an|the|me|some)?\s*/i, '')
    .replace(/[?!.,;:]+$/g, '')
    .trim();

  if (!cleaned) cleaned = userText.trim().slice(0, 30);

  // Capitalize words
  const words = cleaned.split(/\s+/).slice(0, 5);
  const capitalized = words
    .map((w) => {
      if (w.length === 0) return '';
      // Keep acronyms like 2D, 3D, AI, SEO, HTML uppercase
      if (/^(?:2d|3d|ai|seo|api|ui|ux|pwa|css|html|js|ts|sql)$/i.test(w)) {
        return w.toUpperCase();
      }
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');

  return capitalized.slice(0, 36) || 'New Chat';
}

// Group conversations by date
export type DateGroupLabel = 'Today' | 'Yesterday' | 'Previous 7 Days' | 'Older';

export function getDateGroupLabel(timestamp: number): DateGroupLabel {
  const now = new Date();
  const date = new Date(timestamp);

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfSevenDaysAgo = startOfToday - 7 * 86400000;

  if (timestamp >= startOfToday) {
    return 'Today';
  } else if (timestamp >= startOfYesterday) {
    return 'Yesterday';
  } else if (timestamp >= startOfSevenDaysAgo) {
    return 'Previous 7 Days';
  } else {
    return 'Older';
  }
}

// Format relative/readable time for chat list item
export function formatConversationTime(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;

  if (timestamp >= startOfToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (timestamp >= startOfYesterday) {
    return 'Yesterday';
  } else if (now.getFullYear() === date.getFullYear()) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } else {
    return date.toLocaleDateString([], { year: '2-digit', month: 'short', day: 'numeric' });
  }
}

// Get last message preview snippet
export function getLastMessageSnippet(conv: Conversation): string {
  if (!conv.messages || conv.messages.length === 0) return 'Empty conversation';
  const lastMsg = conv.messages[conv.messages.length - 1];

  if (lastMsg.generatedImageUrl || (lastMsg.imagePrompt && lastMsg.imagePrompt.length > 0)) {
    return '🖼️ Saved media';
  }

  const raw = typeof lastMsg.content === 'string' ? lastMsg.content : '';
  const clean = raw
    .replace(/^#+\s+/gm, '')
    .replace(/[*_~`#[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return clean ? clean.slice(0, 48) : 'New conversation';
}

// Generate unique ID for message
export function createMessageId(prefix = 'msg'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

// Generate unique ID for conversation
export function createConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

// Deduplicate messages in an array by ID
export function deduplicateMessages(messages: Message[]): Message[] {
  const seen = new Set<string>();
  const result: Message[] = [];
  for (const m of messages) {
    if (!m || !m.id) continue;
    if (!seen.has(m.id)) {
      seen.add(m.id);
      result.push(m);
    }
  }
  return result;
}

// --- IndexedDB Operations ---

// 1. Get all conversations from IndexedDB sorted by updatedAt DESC
export async function getConversationsFromIndexedDB(): Promise<Conversation[]> {
  try {
    const db = await openChatDatabase();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_CONVERSATIONS, 'readonly');
      const store = transaction.objectStore(STORE_CONVERSATIONS);
      const request = store.getAll();

      request.onsuccess = () => {
        const list: Conversation[] = request.result || [];
        // Sort descending by updatedAt
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(list);
      };

      request.onerror = () => {
        resolve([]);
      };
    });
  } catch (err) {
    console.warn('IndexedDB read error:', err);
    return [];
  }
}

// 2. Save a single conversation into IndexedDB
export async function saveConversationToIndexedDB(conv: Conversation): Promise<void> {
  if (!conv || !conv.id) return;
  try {
    const db = await openChatDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_CONVERSATIONS, 'readwrite');
      const store = transaction.objectStore(STORE_CONVERSATIONS);

      // Clean and deduplicate messages before saving
      const cleanedConv: Conversation = {
        ...conv,
        updatedAt: conv.updatedAt || Date.now(),
        messages: deduplicateMessages(conv.messages || [])
      };

      const request = store.put(cleanedConv);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('IndexedDB write error for conv:', conv.id, err);
  }
}

// 3. Save all conversations to IndexedDB (batch)
export async function saveAllConversationsToIndexedDB(convs: Conversation[]): Promise<void> {
  if (!Array.isArray(convs)) return;
  try {
    const db = await openChatDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_CONVERSATIONS, 'readwrite');
      const store = transaction.objectStore(STORE_CONVERSATIONS);

      for (const conv of convs) {
        if (!conv || !conv.id) continue;
        store.put({
          ...conv,
          updatedAt: conv.updatedAt || Date.now(),
          messages: deduplicateMessages(conv.messages || [])
        });
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (err) {
    console.warn('IndexedDB batch write error:', err);
  }
}

// 4. Delete conversation from IndexedDB
export async function deleteConversationFromIndexedDB(id: string): Promise<void> {
  if (!id) return;
  try {
    const db = await openChatDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_CONVERSATIONS, 'readwrite');
      const store = transaction.objectStore(STORE_CONVERSATIONS);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('IndexedDB delete error for conv:', id, err);
  }
}

// 5. Active Conversation ID in IndexedDB
export async function getActiveConversationIdFromIndexedDB(): Promise<string | null> {
  try {
    const db = await openChatDatabase();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_METADATA, 'readonly');
      const store = transaction.objectStore(STORE_METADATA);
      const request = store.get('active_conversation_id');

      request.onsuccess = () => {
        resolve(request.result?.value || null);
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setActiveConversationIdInIndexedDB(id: string): Promise<void> {
  if (!id) return;
  try {
    const db = await openChatDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_METADATA, 'readwrite');
      const store = transaction.objectStore(STORE_METADATA);
      const request = store.put({ key: 'active_conversation_id', value: id, updatedAt: Date.now() });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('IndexedDB set active ID error:', err);
  }
}

// --- Server Synchronization API ---

// Fetch conversations backed up on server
export async function fetchServerConversations(): Promise<Conversation[]> {
  try {
    const res = await fetch('/api/conversations');
    if (!res.ok) return [];
    const data = await res.json();
    if (data.success && Array.isArray(data.conversations)) {
      return data.conversations;
    }
  } catch (e) {
    // Network / offline
  }
  return [];
}

// Sync conversation to server
export function syncConversationToServer(conv: Conversation): void {
  if (!conv || !conv.id) return;
  fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation: conv })
  }).catch(() => {
    // Background sync silent fail / offline
  });
}

// Delete conversation from server
export function deleteConversationFromServer(id: string): void {
  if (!id) return;
  fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  }).catch(() => {});
}

// Unified Full Storage Loader
// Priority: IndexedDB (has complete blobs/data) -> localStorage bootstrap -> Server Sync
export async function loadInitialConversations(): Promise<{
  conversations: Conversation[];
  activeId: string | null;
}> {
  let loadedList: Conversation[] = [];

  // 1. Try IndexedDB first (most reliable, high capacity)
  try {
    const idbList = await getConversationsFromIndexedDB();
    if (idbList.length > 0) {
      loadedList = idbList;
    }
  } catch (e) {
    console.warn('IndexedDB initial load fallback:', e);
  }

  // 2. If IndexedDB had nothing, check localStorage
  if (loadedList.length === 0) {
    try {
      const saved = localStorage.getItem('ultron_conversations');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          loadedList = parsed;
          // Seed IndexedDB with localStorage items
          saveAllConversationsToIndexedDB(parsed).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('localStorage read error:', e);
    }
  }

  // 3. Background merge with server backup if online
  fetchServerConversations().then((serverList) => {
    if (serverList.length > 0) {
      // Merge without duplicating
      const map = new Map<string, Conversation>();
      for (const c of loadedList) map.set(c.id, c);
      for (const s of serverList) {
        const existing = map.get(s.id);
        if (!existing || (s.updatedAt || 0) > (existing.updatedAt || 0)) {
          map.set(s.id, s);
        }
      }
      const merged = Array.from(map.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      saveAllConversationsToIndexedDB(merged).catch(() => {});
    }
  }).catch(() => {});

  // On application startup, Chat History is loaded but activeId is null
  // This guarantees a clean, fresh New Chat screen on every restart without deleting old history.
  return {
    conversations: loadedList,
    activeId: null
  };
}

// Factory for a fresh, independent conversation with a unique ID
export function createFreshConversation(): Conversation {
  return {
    id: createConversationId(),
    title: 'New Chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      {
        id: createMessageId('welcome'),
        role: 'assistant',
        content:
          'Hello! I am **Ultron AI**, created by Krishna Chouhan and Kiran Panwar. How can I assist you today? You can ask questions, search Google for live web information, generate anime artworks, or converse using voice.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ],
    mode: 'pro'
  };
}
