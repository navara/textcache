import { LANGUAGES } from './i18n.js';

export const SCHEMA = 2;

export const POPUP_WIDTHS = Object.freeze(['narrow', 'normal', 'wide']);

export function hasUnlimitedStorage() {
    return (chrome.runtime.getManifest().permissions ?? []).includes('unlimitedStorage');
}

export const DEFAULTS = Object.freeze({
    schema: SCHEMA,
    maxItemKb: hasUnlimitedStorage() ? 1024 : 100,
    autoClean: true,
    keepNewest: 100,
    dedupe: true,
    skip: Object.freeze(['docs.google.com/spreadsheets', 'slack.com', 'messenger.com']),
    // 'auto' follows the browser's language; otherwise one of the codes in LANGUAGES
    language: 'auto',
    // the popup is 380, 480 or 640 px wide (popup/popup.css)
    popupWidth: 'normal',
});

// Complete settings from anything stored: each missing or invalid value comes from `base`, unknown keys are dropped. Pure.
export function normalize(raw, base = DEFAULTS) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const kb = toNumber(source.maxItemKb);
    const keep = toNumber(source.keepNewest);
    return {
        schema: SCHEMA,
        maxItemKb: Number.isFinite(kb) && kb >= 0 ? kb : base.maxItemKb,
        autoClean: typeof source.autoClean === 'boolean' ? source.autoClean : base.autoClean,
        keepNewest: Number.isInteger(keep) && keep >= 1 ? keep : base.keepNewest,
        dedupe: typeof source.dedupe === 'boolean' ? source.dedupe : base.dedupe,
        skip: toSkipList(source.skip) ?? [...base.skip],
        language: source.language === 'auto' || Object.hasOwn(LANGUAGES, source.language) ? source.language : base.language,
        popupWidth: POPUP_WIDTHS.includes(source.popupWidth) ? source.popupWidth : base.popupWidth,
    };
}

// Numbers typed into a form arrive as strings; an empty string must stay invalid rather than become 0.
function toNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') return Number(value);
    return NaN;
}

function toSkipList(value) {
    const items = typeof value === 'string' ? value.split('\n') : Array.isArray(value) ? value : null;
    if (!items) return null;
    const cleaned = items.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean);
    return [...new Set(cleaned)];
}

export async function load() {
    const { settings } = await chrome.storage.local.get('settings');
    return normalize(settings);
}

// An invalid value in `patch` keeps the value stored now; returns what was written.
export async function save(patch = {}) {
    const current = await load();
    const next = normalize({ ...current, ...patch }, current);
    await chrome.storage.local.set({ settings: next });
    return next;
}
