// background.js against a fake chrome: listeners registered at load, set-up migrates and cleans, messages set the badges.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installChrome } from './fake-chrome.js';

const data = installChrome({ stored: {
    setting: { autoClear_keep: '2', shouldAutoClear: true },
    '1 https://a/ 0.1': { time: '1000', type: 'txt', val: 'one', url: 'https://a/' },
    '2 https://a/ 0.2': { time: '2000', type: 'txt', val: 'two', url: 'https://a/' },
    '3 https://a/ 0.3': { time: '3000', type: 'txt', val: 'three', url: 'https://a/' },
} });

// The listeners start their work without returning it. Every call it can wait on is counted while in flight (storage, alarms, badges, the digest of
// the migration), so settle() can wait until a whole turn of the event loop passes with none of them in flight.
let inFlight = 0;
const tracked = fn => async (...args) => {
    inFlight++;
    try {
        return await fn(...args);
    } finally {
        inFlight--;
    }
};
for (const name of ['get', 'set', 'remove', 'clear', 'getBytesInUse']) {
    chrome.storage.local[name] = tracked(chrome.storage.local[name].bind(chrome.storage.local));
}
crypto.subtle.digest = tracked(crypto.subtle.digest.bind(crypto.subtle));

const listeners = {};
const event = name => ({ addListener: f => { listeners[name] = f; } });
const calls = [];
const alarms = new Map();
const record = name => tracked(async details => { calls.push([name, details]); });
Object.assign(chrome.runtime, {
    getManifest: () => ({ permissions: ['storage', 'unlimitedStorage'], action: { default_title: 'Default title' } }),
    onInstalled: event('installed'),
    onStartup: event('startup'),
    onMessage: event('message'),
});
chrome.alarms = {
    onAlarm: event('alarm'),
    get: tracked(async name => alarms.get(name)),
    create: tracked(async (name, info) => { alarms.set(name, { name, ...info }); }),
};
chrome.action = { setBadgeText: record('text'), setBadgeBackgroundColor: record('color'), setTitle: record('title') };
// the real locale files, as the worker fetches them
let uiLanguage = 'en-US';
chrome.runtime.getURL = file => file;
chrome.i18n = { getUILanguage: () => uiLanguage };
globalThis.fetch = tracked(async file => {
    const text = fs.readFileSync(new URL(`../../extension/${file}`, import.meta.url), 'utf8');
    return { ok: true, json: async () => JSON.parse(text) };
});

await import('../../extension/background.js');
const settle = async () => {
    do await new Promise(resolve => setImmediate(resolve));
    while (inFlight > 0);
};

test('listeners are registered when the module loads, and the hourly alarm exists', async () => {
    assert.deepEqual(Object.keys(listeners).sort(), ['alarm', 'installed', 'message', 'startup']);
    await settle();
    assert.deepEqual(alarms.get('clean'), { name: 'clean', periodInMinutes: 60 });
});

test('install migrates 5.x data, writes settings and keeps the newest', async () => {
    listeners.installed({ reason: 'update' });
    await settle();
    assert.equal(data.settings.schema, 2);
    assert.equal(data.settings.keepNewest, 2);
    const values = Object.keys(data).filter(key => key.startsWith('t:')).map(key => data[key].value).sort();
    assert.deepEqual(values, ['three', 'two']);
    assert.equal('setting' in data, false);
});

test('the alarm cleans only when autoClean is on', async () => {
    data['t:x'] = { id: 'x', kind: 'text', value: 'new', created: 9000, modified: 9000 };
    data.settings = { ...data.settings, autoClean: false };
    listeners.alarm({ name: 'clean' });
    await settle();
    assert.equal(Object.keys(data).filter(key => key.startsWith('t:')).length, 3);
    data.settings = { ...data.settings, autoClean: true };
    listeners.alarm({ name: 'other' });
    await settle();
    assert.equal(Object.keys(data).filter(key => key.startsWith('t:')).length, 3);
    listeners.alarm({ name: 'clean' });
    await settle();
    assert.equal(Object.keys(data).filter(key => key.startsWith('t:')).length, 2);
});

test('save_skipped and save_resumed change only that tab', async () => {
    calls.length = 0;
    listeners.message({ type: 'save_skipped', size: 2000, limit: 1024 }, { tab: { id: 7 } });
    await settle();
    assert.deepEqual(calls.map(([name, d]) => [name, d.tabId, d.text ?? d.color]), [['text', 7, 'MAX'], ['title', 7, undefined], ['color', 7, '#b35c00']]);
    assert.match(calls[1][1].title, /2 KB.*1 KB/);
    calls.length = 0;
    listeners.message({ type: 'save_resumed' }, { tab: { id: 7 } });
    await settle();
    assert.deepEqual(calls, [['text', { tabId: 7, text: null }], ['title', { tabId: 7, title: 'Default title' }]]);
});

test('badge changes keep their order, and titles follow the language set when they are made', async () => {
    calls.length = 0;
    data.settings = { ...data.settings, language: 'cs' };
    listeners.message({ type: 'save_skipped', size: 2000, limit: 1024 }, { tab: { id: 8 } });
    listeners.message({ type: 'save_resumed' }, { tab: { id: 8 } });
    await settle();
    assert.deepEqual(calls.map(([name]) => name), ['text', 'title', 'color', 'text', 'title']);
    assert.match(calls[1][1].title, /^TextCache v této kartě neuložil text/);
    assert.equal(calls[4][1].title, 'Default title', 'the "too large" title landed after the later reset');
    data.settings = { ...data.settings, language: 'auto' };
    uiLanguage = 'ar-EG';
    calls.length = 0;
    listeners.message({ type: 'save_failed', error: 'x' }, {});
    await settle();
    assert.equal(calls[2][1].title, JSON.parse(fs.readFileSync(new URL('../../extension/_locales/ar/messages.json', import.meta.url), 'utf8'))
        .badge_save_failed.message.replace('$1', 'x'));
    uiLanguage = 'en-US';
});

test('save_failed sets the global badge; unknown messages and messages without a tab do nothing', async () => {
    calls.length = 0;
    listeners.message({ type: 'save_skipped', size: 1, limit: 1 }, {});
    listeners.message({ type: 'whatever' }, { tab: { id: 1 } });
    listeners.message(undefined, {});
    await settle();
    assert.equal(calls.length, 0);
    listeners.message({ type: 'save_failed', error: 'quota' }, { tab: { id: 3 } });
    await settle();
    assert.deepEqual(calls.map(([name, d]) => [name, d.tabId]), [['color', undefined], ['text', undefined], ['title', undefined]]);
    assert.equal(calls[1][1].text, '!');
    assert.match(calls[2][1].title, /quota/);
});

const savedIds = () => Object.keys(data).filter(key => key.startsWith('t:')).map(key => data[key].id).sort();
const copy = (id, value, modified) => ({ id, url: `https://${id}/`, title: '', kind: 'text', value, created: modified, modified });

test('the clean-up removes older copies of the same text before keeping the newest, only with dedupe on', async () => {
    for (const key of Object.keys(data).filter(k => k.startsWith('t:'))) delete data[key];
    Object.assign(data, { 't:a': copy('a', 'same', 1000), 't:b': copy('b', ' same\n', 2000), 't:c': copy('c', 'other', 3000) });
    data.settings = { ...data.settings, autoClean: true, keepNewest: 2, dedupe: false };
    listeners.alarm({ name: 'clean' });
    await settle();
    assert.deepEqual(savedIds(), ['b', 'c']);
    // pruning first would keep a and b and then lose b as a copy, leaving one saved text instead of two
    Object.assign(data, { 't:a': copy('a', 'same', 4000), 't:b': copy('b', ' same\n', 3000), 't:c': copy('c', 'other', 2000) });
    data.settings = { ...data.settings, dedupe: true };
    listeners.alarm({ name: 'clean' });
    await settle();
    assert.deepEqual(savedIds(), ['a', 'c'], 'the copy was pruned instead of removed, or removed after pruning');
});

test('field_done removes older copies when dedupe is on, whatever autoClean says', async () => {
    data['t:d'] = copy('d', 'other', 5000);
    data.settings = { ...data.settings, autoClean: false, keepNewest: 1, dedupe: false };
    listeners.message({ type: 'field_done' }, { tab: { id: 2 } });
    await settle();
    assert.deepEqual(savedIds(), ['a', 'c', 'd']);
    data.settings = { ...data.settings, dedupe: true };
    listeners.message({ type: 'field_done' }, { tab: { id: 2 } });
    await settle();
    assert.deepEqual(savedIds(), ['a', 'd']);
});
