// src/lib/favorites.ts
"use client";

const STORAGE_KEY = "cc_favorites_v1";
const EVENT_NAME = "cc-favorites-changed";

export type FavoriteItem = {
  slug: string;
  title: string;
  cover?: string;
  seller?: string;
  brand?: string;
  category?: string;
  price?: number | null;
  mulebuy?: string;
  addedAt: number;
};

function safeParse(raw: string | null): FavoriteItem[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function read(): FavoriteItem[] {
  if (typeof window === "undefined") return [];
  return safeParse(window.localStorage.getItem(STORAGE_KEY));
}

function write(list: FavoriteItem[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: list }));
}

export function getFavorites(): FavoriteItem[] {
  return read().sort((a, b) => b.addedAt - a.addedAt);
}

export function getFavoriteSlugs(): Set<string> {
  return new Set(read().map((x) => x.slug));
}

export function isFavorite(slug: string): boolean {
  return read().some((x) => x.slug === slug);
}

export function getFavoritesCount(): number {
  return read().length;
}

export function addFavorite(item: Omit<FavoriteItem, "addedAt">) {
  const list = read();
  if (list.some((x) => x.slug === item.slug)) return;
  list.push({ ...item, addedAt: Date.now() });
  write(list);
}

export function removeFavorite(slug: string) {
  const list = read().filter((x) => x.slug !== slug);
  write(list);
}

export function toggleFavorite(item: Omit<FavoriteItem, "addedAt">): boolean {
  const list = read();
  const exists = list.some((x) => x.slug === item.slug);

  if (exists) {
    write(list.filter((x) => x.slug !== item.slug));
    return false;
  }

  list.push({ ...item, addedAt: Date.now() });
  write(list);
  return true;
}

export function clearFavorites() {
  write([]);
}

export function subscribeFavorites(callback: (list: FavoriteItem[]) => void) {
  if (typeof window === "undefined") return () => {};

  const handler = (e: Event) => {
    const detail = (e as CustomEvent<FavoriteItem[]>).detail;
    callback(Array.isArray(detail) ? detail : read());
  };

  const storageHandler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback(read());
  };

  window.addEventListener(EVENT_NAME, handler);
  window.addEventListener("storage", storageHandler);

  return () => {
    window.removeEventListener(EVENT_NAME, handler);
    window.removeEventListener("storage", storageHandler);
  };
}
