/**
 * Most statuses held for devices not discovered yet a session can keep. They
 * normally arrive just before their discovery read; a panel streaming statuses
 * for IDs it never lists (or a flood) must not grow the map without limit.
 */
export const PENDING_STATUS_LIMIT = 512;

/** `map.set`, dropping the oldest entries beyond `limit` (insertion order). */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit = PENDING_STATUS_LIMIT): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
    }
}
