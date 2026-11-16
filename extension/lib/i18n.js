// Visible strings come from _locales/<code>/messages.json in the language picked from the settings and the browser. chrome.i18n always follows the
// browser, so the files are read here instead. A message missing in that language comes from English; a key missing there too shows as the key
// itself, so it is noticed instead of leaving a blank.

// Native name and English name, shown untranslated in the language selector.
export const LANGUAGES = Object.freeze({
    en: 'English',
    cs: 'Čeština / Czech',
    de: 'Deutsch / German',
    es: 'Español / Spanish',
    fr: 'Français / French',
    pt_BR: 'Português (Brasil) / Portuguese (Brazil)',
    uk: 'Українська / Ukrainian',
    zh_CN: '简体中文 / Chinese (Simplified)',
    ja: '日本語 / Japanese',
    hi: 'हिन्दी / Hindi',
    ar: 'العربية / Arabic',
});

const RTL = new Set(['ar']);

// The language to show: the stored setting when it names a supported language, else the browser's UI language (exact match, then the same base
// language, so pt-PT gets pt_BR and zh-TW gets zh_CN), else English. Pure.
export function pickLanguage(setting, uiLanguage) {
    if (typeof setting === 'string' && Object.hasOwn(LANGUAGES, setting)) return setting;
    const wanted = String(uiLanguage ?? '').replaceAll('-', '_').toLowerCase();
    const codes = Object.keys(LANGUAGES);
    return codes.find(code => code.toLowerCase() === wanted)
        ?? codes.find(code => code.split('_')[0].toLowerCase() === wanted.split('_')[0])
        ?? 'en';
}

let code = 'en';
let messages = {};
let english = {};
let loaded = null;

async function readMessages(lang) {
    const response = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
    if (!response.ok) throw new Error(`messages of ${lang}: HTTP ${response.status}`);
    return response.json();
}

async function storedLanguage() {
    try {
        return (await chrome.storage.local.get('settings')).settings?.language;
    } catch (error) {
        // the page reports a storage failure itself when it reads the saved texts; the language falls back to the browser's
        console.warn('TextCache: language setting not read:', error);
        return undefined;
    }
}

function wantedLanguage(setting) {
    return pickLanguage(setting, chrome.i18n.getUILanguage());
}

// Loads the messages of the language the settings ask for now; files already loaded for that language are kept. A file that cannot be read leaves
// English (and if English fails too, the bare keys) and logs why; it never throws.
export async function init() {
    const wanted = wantedLanguage(await storedLanguage());
    if (loaded === wanted) return;
    const failed = error => {
        console.warn('TextCache:', error);
        return null;
    };
    const [en, chosen] = await Promise.all([readMessages('en').catch(failed), wanted === 'en' ? null : readMessages(wanted).catch(failed)]);
    english = en ?? {};
    messages = wanted === 'en' ? english : chosen ?? english;
    code = wanted === 'en' || chosen ? wanted : 'en';
    loaded = wanted;
}

// The BCP 47 tag of the language shown (pt-BR, zh-CN), for Intl and toLocaleString.
export function locale() {
    return code.replace('_', '-');
}

// True when the stored setting or the browser now resolve to another language than the one loaded, which needs the page to be built again.
export async function languageChanged() {
    return wantedLanguage(await storedLanguage()) !== loaded;
}

function lookup(key) {
    if (Object.hasOwn(messages, key)) return messages[key].message;
    if (Object.hasOwn(english, key)) return english[key].message;
    return null;
}

// $1 to $9 are replaced by subs in order, as chrome.i18n does.
export function t(key, subs) {
    const text = lookup(key);
    if (typeof text !== 'string') {
        console.warn(`i18n: no message "${key}"`);
        return key;
    }
    const values = subs === undefined ? [] : [].concat(subs).map(String);
    return text.replace(/\$([1-9])/g, (_, n) => values[n - 1] ?? '');
}

// data-i18n="key" sets the text; data-i18n-attr="placeholder:key aria-label:key" sets attributes
export function translate(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) {
        el.textContent = t(el.dataset.i18n);
    }
    for (const el of root.querySelectorAll('[data-i18n-attr]')) {
        for (const pair of el.dataset.i18nAttr.trim().split(/\s+/)) {
            const [attr, key] = pair.split(':');
            el.setAttribute(attr, t(key));
        }
    }
}

// For a page: load the messages, set the document's language and direction, fill in the strings.
export async function localize() {
    await init();
    document.documentElement.lang = locale();
    document.documentElement.dir = RTL.has(code) ? 'rtl' : 'ltr';
    translate();
}
