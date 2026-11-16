import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './fake-chrome.js';

installChrome();
const store = await import('../../extension/lib/store.js');

const entry = (id, modified) => ({ id, url: `https://example.com/${id}`, title: '', kind: 'text', value: id, created: modified - 10, modified });
const SETTINGS = { schema: 2, maxItemKb: 1024, autoClean: true, keepNewest: 100, skip: [] };

function seed(count) {
    const stored = { settings: SETTINGS };
    for (let i = 1; i <= count; i++) stored[`t:e${i}`] = entry(`e${i}`, i * 1000);
    return installChrome({ stored });
}

test('list returns saved texts only, newest first', async () => {
    const stored = { settings: SETTINGS, 't:old': entry('old', 1000), 't:new': entry('new', 3000), 't:mid': entry('mid', 2000), other: { val: 'x' } };
    installChrome({ stored });
    assert.deepEqual((await store.list()).map(e => e.id), ['new', 'mid', 'old']);
});

test('get returns one saved text or null', async () => {
    seed(2);
    assert.equal((await store.get('e2')).value, 'e2');
    assert.equal(await store.get('missing'), null);
});

test('remove takes one id or many', async () => {
    const data = seed(3);
    await store.remove('e1');
    await store.remove(['e2', 'e3']);
    await store.remove([]);
    assert.deepEqual(Object.keys(data), ['settings']);
});

test('clear removes saved texts and leaves the settings', async () => {
    const data = seed(5);
    data.unrelated = 1;
    await store.clear();
    assert.deepEqual(Object.keys(data).sort(), ['settings', 'unrelated']);
    assert.deepEqual(data.settings, SETTINGS);
});

test('prune keeps the newest and returns the number deleted', async () => {
    const data = seed(150);
    assert.equal(await store.prune(5), 145);
    assert.deepEqual(Object.keys(data).filter(k => k.startsWith('t:')).sort(), ['t:e146', 't:e147', 't:e148', 't:e149', 't:e150']);
    assert.ok(data.settings);
    assert.equal(await store.prune(5), 0);
    assert.equal(await store.prune(0), 0);
    assert.equal(Object.keys(data).length, 6);
});

test('usage with unlimitedStorage has no quota', async () => {
    const data = seed(3);
    assert.deepEqual(await store.usage(), { count: 3, bytes: JSON.stringify(data).length, quota: null });
});

test('usage without unlimitedStorage reports the quota', async () => {
    installChrome({ permissions: ['storage'], stored: { settings: SETTINGS, 't:a': entry('a', 1) } });
    const usage = await store.usage();
    assert.equal(usage.count, 1);
    assert.equal(usage.quota, 10485760);
});

test('keyOf and isEntryKey agree', () => {
    assert.equal(store.keyOf('abc'), 't:abc');
    assert.equal(store.isEntryKey(store.keyOf('abc')), true);
    assert.equal(store.isEntryKey('settings'), false);
});

test('removeCopies deletes older copies of the same text and returns how many', async () => {
    const data = installChrome({ stored: {
        settings: SETTINGS,
        't:old': { ...entry('old', 1000), value: 'same' },
        't:new': { ...entry('new', 3000), value: ' same ' },
        't:mid': { ...entry('mid', 2000), value: 'different' },
    } });
    assert.equal(await store.removeCopies(), 1);
    assert.deepEqual(Object.keys(data).sort(), ['settings', 't:mid', 't:new']);
    assert.equal(await store.removeCopies(), 0);
});
