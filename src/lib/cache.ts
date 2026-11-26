import { useEffect, useState } from 'react';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class MemoryTtlCache {
  private map = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs = 120_000): void {
    this.map.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  invalidatePrefix(prefix: string): void {
    for (const k of this.map.keys()) {
      if (k.startsWith(prefix)) {
        this.map.delete(k);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export const appCache = new MemoryTtlCache();

export function useDebouncedValue<T>(value: T, delayMs = 380): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
