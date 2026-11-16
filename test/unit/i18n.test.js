// The language loader and every locale file against the English one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installChrome, importFresh } from './fake-chrome.js';

const LOCALES = new URL('../../extension/_locales/', import.meta.url);
const read = code => fs.readFileSync(new URL(`${code}/messages.json`, LOCALES));
const ENGLISH = JSON.parse(read('en'));

// chrome with a browser UI language, fetch serving the real locale files (or failing for the codes in `broken`), and a log of fetched files
function setUp({ ui = 'en-US', stored = {}, broken = [] } = {}) {
    installChrome({ stored });
    const fetched = [];
    chrome.runtime.getURL = file => `ext:/${file}`;
    chrome.i18n = { getUILanguage: () => ui };
    globalThis.fetch = async url => {
        const code = url.match(/_locales\/(\w+)\/messages\.json$/)[1];
        fetched.push(code);
        if (broken.includes(code)) return { ok: false, status: 404 };
        return { ok: true, json: async () => JSON.parse(read(code)) };
    };
    return fetched;
}

// console.warn calls made while fn runs
async function warnings(fn) {
    const seen = [];
    const original = console.warn;
    console.warn = (...args) => seen.push(args.map(String).join(' '));
    try {
        await fn();
    } finally {
        console.warn = original;
    }
    return seen;
}

test('pickLanguage: a supported setting wins, then the UI language exactly, then its base language, else English', async () => {
    const { pickLanguage } = await importFresh('i18n.js');
    assert.equal(pickLanguage('cs', 'de-DE'), 'cs');
    assert.equal(pickLanguage('pt_BR', 'en'), 'pt_BR');
    assert.equal(pickLanguage('auto', 'pt-BR'), 'pt_BR');
    assert.equal(pickLanguage('auto', 'zh-CN'), 'zh_CN');
    assert.equal(pickLanguage('auto', 'cs'), 'cs');
    assert.equal(pickLanguage('auto', 'pt-PT'), 'pt_BR');
    assert.equal(pickLanguage('auto', 'de-AT'), 'de');
    assert.equal(pickLanguage('auto', 'zh-TW'), 'zh_CN');
    assert.equal(pickLanguage('auto', 'en-GB'), 'en');
    assert.equal(pickLanguage('auto', 'ar-EG'), 'ar');
    for (const ui of ['sk', 'nl-NL', '', undefined]) assert.equal(pickLanguage('auto', ui), 'en', `UI ${ui}`);
    // a stored value that is not a supported code behaves like auto
    for (const setting of [undefined, null, 'xx', 'pt', 'toString', 7, {}]) assert.equal(pickLanguage(setting, 'de-CH'), 'de', `setting ${setting}`);
});

test('every locale has exactly the English keys in the same order, the same placeholders, and no empty message', () => {
    const codes = fs.readdirSync(LOCALES);
    const placeholders = text => [...new Set(text.match(/\$\d/g) ?? [])].sort().join(' ');
    for (const code of codes) {
        const messages = JSON.parse(read(code));
        assert.deepEqual(Object.keys(messages), Object.keys(ENGLISH), `${code}: keys or their order differ`);
        for (const [key, { message, ...rest }] of Object.entries(messages)) {
            assert.deepEqual(rest, {}, `${code} ${key}: only "message" is expected`);
            assert.ok(typeof message === 'string' && message.trim() !== '', `${code} ${key}: empty`);
            assert.equal(placeholders(message), placeholders(ENGLISH[key].message), `${code} ${key}: placeholders`);
        }
        for (const key of ['app_name', 'options_unit_kb']) assert.equal(messages[key].message, ENGLISH[key].message, `${code} ${key}`);
    }
});

test('locale files: one per supported language, UTF-8 without BOM, CRLF only, 3-space indent, no en or em dash', async () => {
    const { LANGUAGES } = await importFresh('i18n.js');
    assert.deepEqual(fs.readdirSync(LOCALES).sort(), Object.keys(LANGUAGES).sort());
    for (const code of Object.keys(LANGUAGES)) {
        const bytes = read(code);
        assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${code}: BOM`);
        const text = bytes.toString('utf8');
        assert.equal(Buffer.from(text, 'utf8').equals(bytes), true, `${code}: not valid UTF-8`);
        const lf = text.split('\n').length - 1;
        assert.equal(text.split('\r\n').length - 1, lf, `${code}: a line does not end in CRLF`);
        assert.equal(text, JSON.stringify(JSON.parse(text), null, 3).replace(/\n/g, '\r\n') + '\r\n', `${code}: layout differs from English`);
        assert.doesNotMatch(text, /[\u2013\u2014]/, `${code}: en or em dash`);
    }
});

test('init loads the chosen language and English; t() falls back to English, then to the key', async () => {
    const fetched = setUp({ ui: 'en-US', stored: { settings: { language: 'cs' } } });
    const i18n = await importFresh('i18n.js');
    await i18n.init();
    assert.deepEqual(fetched.sort(), ['cs', 'en']);
    assert.equal(i18n.locale(), 'cs');
    assert.equal(i18n.t('list_count', 3), 'Uložené texty: 3');
    assert.equal(i18n.t('options_usage_space_of', ['1 KB', '2 KB']), '1 KB z 2 KB');
    // a message the chosen language lacks comes from English
    const czech = JSON.parse(read('cs'));
    delete czech.copy;
    globalThis.fetch = async url => ({ ok: true, json: async () => (url.includes('/cs/') ? czech : ENGLISH) });
    const fresh = await importFresh('i18n.js');
    await fresh.init();
    assert.equal(fresh.t('copy'), 'Copy');
    assert.equal(fresh.t('delete'), 'Smazat');
    const warned = await warnings(() => assert.equal(fresh.t('no_such_key'), 'no_such_key'));
    assert.deepEqual(warned, ['i18n: no message "no_such_key"']);
    assert.equal(fresh.t('constructor'), 'constructor', 'an Object.prototype name is not a message');
});

test('init follows the browser for auto and for an unsupported stored value, and gives BCP 47 tags', async () => {
    for (const [stored, ui, code, tag] of [
        [{}, 'pt-BR', 'pt_BR', 'pt-BR'], [{ settings: { language: 'auto' } }, 'zh-TW', 'zh_CN', 'zh-CN'], [{ settings: { language: 'xx' } }, 'ar', 'ar', 'ar'],
        [{ settings: { language: 'auto' } }, 'sk-SK', 'en', 'en'],
    ]) {
        const fetched = setUp({ ui, stored });
        const i18n = await importFresh('i18n.js');
        await i18n.init();
        assert.equal(i18n.locale(), tag, `${JSON.stringify(stored)} ${ui}`);
        assert.deepEqual(fetched.sort(), [...new Set(['en', code])].sort());
    }
});

test('init keeps loaded files, notices a changed setting, and falls back to English when a file cannot be read', async () => {
    const fetched = setUp({ ui: 'de-DE', stored: { settings: { language: 'auto' } } });
    const i18n = await importFresh('i18n.js');
    assert.equal(await i18n.languageChanged(), true, 'before init nothing is loaded');
    await i18n.init();
    await i18n.init();
    assert.deepEqual(fetched.sort(), ['de', 'en'], 'files were fetched again for the same language');
    assert.equal(await i18n.languageChanged(), false);
    await chrome.storage.local.set({ settings: { language: 'de' } });
    assert.equal(await i18n.languageChanged(), false, 'an explicit choice of the same language is no change');
    await chrome.storage.local.set({ settings: { language: 'ja' } });
    assert.equal(await i18n.languageChanged(), true);
    await i18n.init();
    assert.equal(i18n.locale(), 'ja');

    setUp({ ui: 'en', stored: { settings: { language: 'cs' } }, broken: ['cs'] });
    const broken = await importFresh('i18n.js');
    const warned = await warnings(() => broken.init());
    assert.equal(warned.length, 1, warned.join('\n'));
    assert.match(warned[0], /messages of cs: HTTP 404/);
    assert.equal(broken.locale(), 'en');
    assert.equal(broken.t('copy'), 'Copy');
    assert.equal(await broken.languageChanged(), false, 'a broken file must not make pages reload over and over');

    // a failing settings read still loads the browser's language
    setUp({ ui: 'fr-FR' });
    chrome.storage.local.get = async () => { throw new Error('forced'); };
    const unreadable = await importFresh('i18n.js');
    const warnedRead = await warnings(() => unreadable.init());
    assert.match(warnedRead.join('\n'), /language setting not read/);
    assert.equal(unreadable.locale(), 'fr');
});
