import { normalize, SCHEMA } from './settings.js';
import { keyOf, isEntryKey } from './store.js';

const OLD_CONFIG = ['version', 'setting', 'exceptions'];

export function isOldEntry(key, value) {
    return !OLD_CONFIG.includes(key) && key !== 'settings' && !isEntryKey(key)
        && value !== null && typeof value === 'object' && typeof value.val === 'string';
}

// 5.x times were epoch milliseconds stored as strings.
function toTime(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// The new id is derived from the old key, so a migration interrupted between writing and removing writes the same keys again instead of duplicates.
async function idFor(oldKey) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(oldKey));
    const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `m-${hex.slice(0, 32)}`;
}

export async function convertEntry(oldKey, old, now = Date.now()) {
    const created = toTime(old.time) ?? toTime(old.last_modified) ?? now;
    const id = await idFor(oldKey);
    return {
        id,
        url: typeof old.url === 'string' ? old.url : '',
        title: '',
        kind: old.type === 'WYSIWYG' ? 'html' : 'text',
        value: old.val,
        created,
        modified: toTime(old.last_modified) ?? created,
    };
}

export function convertSettings(setting, exceptions) {
    const old = setting && typeof setting === 'object' ? setting : {};
    const autoClean = old.shouldAutoClear === 'true' ? true : old.shouldAutoClear === 'false' ? false : old.shouldAutoClear;
    return normalize({ maxItemKb: old.maxItemSize, autoClean, keepNewest: old.autoClear_keep, skip: exceptions });
}

// Moves 5.x data to the current layout. Safe to run any number of times; returns what it did.
export async function migrate() {
    const items = await chrome.storage.local.get();
    const oldKeys = Object.keys(items).filter(key => isOldEntry(key, items[key]));
    const writes = {};
    for (const key of oldKeys) {
        const entry = await convertEntry(key, items[key]);
        writes[keyOf(entry.id)] = entry;
    }
    const settingsMigrated = items.settings?.schema !== SCHEMA;
    if (settingsMigrated) writes.settings = convertSettings(items.setting, items.exceptions);

    const removals = [...oldKeys, ...OLD_CONFIG.filter(key => key in items)];
    if (Object.keys(writes).length) await chrome.storage.local.set(writes);
    if (removals.length) await chrome.storage.local.remove(removals);
    return { entries: oldKeys.length, settings: settingsMigrated };
}
