// Thin helpers for the Cribl platform KV store.
//
// The platform intercepts all fetch() calls to CRIBL_API_URL and proxies them
// through the parent window — auth headers are injected automatically.
//
// In local dev mode (npm run dev without the platform init script),
// CRIBL_API_URL is undefined and these calls fail silently so the rest of the
// app still works with in-memory state.

declare global {
  interface Window {
    CRIBL_API_URL?: string;
  }
}

function base(): string | undefined {
  return window.CRIBL_API_URL;
}

/** Read a value by key. Returns null if the key is missing or an error occurs. */
export async function kvGet<T>(key: string): Promise<T | null> {
  const b = base();
  if (!b) return null;
  try {
    const res = await fetch(`${b}/kvstore/${key}`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Write a value to a key. */
export async function kvSet(key: string, value: unknown): Promise<void> {
  const b = base();
  if (!b) return;
  try {
    await fetch(`${b}/kvstore/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch {
    // Silently fail — the app continues working with in-memory state
  }
}

/** Delete a key. */
export async function kvDelete(key: string): Promise<void> {
  const b = base();
  if (!b) return;
  try {
    await fetch(`${b}/kvstore/${key}`, { method: 'DELETE' });
  } catch {
    // Silently fail
  }
}
