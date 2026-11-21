import { UserMemory } from '../types';

const LEGACY_MEMORIES_KEY = 'ultron_user_memories';

function getScopedKey(uid?: string | null): string {
  return uid ? `ultron_user_memories_${uid}` : LEGACY_MEMORIES_KEY;
}

export function loadUserMemories(uid?: string | null): UserMemory[] {
  try {
    const key = getScopedKey(uid);
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('Error loading memories from localStorage:', err);
  }
  return [];
}

export function saveUserMemories(memories: UserMemory[], uid?: string | null): void {
  try {
    localStorage.setItem(getScopedKey(uid), JSON.stringify(memories));
  } catch (err) {
    console.warn('Error saving memories to localStorage:', err);
  }
}

export function addUserMemory(
  fact: string,
  uid?: string | null,
  category = 'General'
): UserMemory {
  const current = loadUserMemories(uid);
  const newMemory: UserMemory = {
    id: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    fact: fact.trim(),
    category,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const updated = [newMemory, ...current];
  saveUserMemories(updated, uid);
  return newMemory;
}

export function updateUserMemory(
  id: string,
  patch: Partial<Pick<UserMemory, 'fact' | 'category' | 'enabled'>>,
  uid?: string | null
): UserMemory[] {
  const current = loadUserMemories(uid);
  const updated = current.map((m) =>
    m.id === id
      ? {
          ...m,
          ...patch,
          updatedAt: Date.now()
        }
      : m
  );
  saveUserMemories(updated, uid);
  return updated;
}

export function deleteUserMemory(id: string, uid?: string | null): UserMemory[] {
  const current = loadUserMemories(uid);
  const updated = current.filter((m) => m.id !== id);
  saveUserMemories(updated, uid);
  return updated;
}

export function clearUserMemories(uid?: string | null): void {
  try {
    localStorage.removeItem(getScopedKey(uid));
  } catch (err) {
    console.warn('Error clearing memories:', err);
  }
}
