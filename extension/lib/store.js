import { idsOfOlderCopies, idsToPrune, newestFirst } from './cleanup.js';
import { hasUnlimitedStorage } from './settings.js';

export const PREFIX = 't:';

export function keyOf(id) {
    return PREFIX + id;
}

export function isEntryKey(key) {
    return key.startsWith(PREFIX);
}

export async function list() {
    const items = await chrome.storage.local.get();
    return Object.entries(items)
        .filter(([key, value]) => isEntryKey(key) && value && typeof value === 'object')
        .map(([, value]) => value)
        .sort(newestFirst);
}

export async function get(id) {
    const key = keyOf(id);
    const items = await chrome.storage.local.get(key);
    return items[key] ?? null;
}

export async function remove(ids) {
    const keys = [].concat(ids).map(keyOf);
    if (keys.length) await chrome.storage.local.remove(keys);
}

// Saved texts only: the settings stay.
export async function clear() {
    const items = await chrome.storage.local.get();
    const keys = Object.keys(items).filter(isEntryKey);
    if (keys.length) await chrome.storage.local.remove(keys);
}

export async function usage() {
    const [entries, bytes] = await Promise.all([list(), chrome.storage.local.getBytesInUse(null)]);
    return {
        count: entries.length,
        bytes,
        quota: hasUnlimitedStorage() ? null : chrome.storage.local.QUOTA_BYTES ?? 10485760,
    };
}

export async function prune(keep) {
    const ids = idsToPrune(await list(), keep);
    await remove(ids);
    return ids.length;
}

// Deletes every saved text whose plain text a newer one repeats; returns the number deleted.
export async function removeCopies() {
    const ids = idsOfOlderCopies(await list());
    await remove(ids);
    return ids.length;
}
