import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './fake-chrome.js';

installChrome();
const { migrate } = await import('../../extension/lib/migrate.js');

const OLD = {
    version: '10',
    setting: { popupType: 'tab', shouldAutoClear: false, autoClear_day: 90, autoClear_keep: '25', maxItemSize: '200', intervalToSave: 2000 },
    exceptions: ['example.org', 'slack.com'],
    '1700000000000 https://a.example/x?q=a b 0.123': { time: '1700000000000', type: 'txt', val: 'plain text', url: 'https://a.example/x?q=a b',
        last_modified: '1700000005000' },
    '1700000100000 https://b.example/ w-0.5': { time: '1700000100000', type: 'WYSIWYG', val: '<div contenteditable="true"><b>rich</b></div>',
        url: 'https://b.example/' },
};

const entriesOf = data => Object.entries(data).filter(([key]) => key.startsWith('t:')).map(([, value]) => value);

test('moves old entries and settings, removes old keys', async () => {
    const data = installChrome({ stored: OLD });
    assert.deepEqual(await migrate(), { entries: 2, settings: true });

    assert.deepEqual(Object.keys(data).filter(key => !key.startsWith('t:')), ['settings']);
    assert.deepEqual(data.settings,
        { schema: 2, maxItemKb: 200, autoClean: false, keepNewest: 25, dedupe: true, skip: ['example.org', 'slack.com'], language: 'auto',
            popupWidth: 'normal' });

    const entries = entriesOf(data).sort((a, b) => a.created - b.created);
    assert.equal(entries.length, 2);
    const [text, html] = entries;
    assert.deepEqual({ ...text, id: undefined }, { id: undefined, url: 'https://a.example/x?q=a b', title: '', kind: 'text', value: 'plain text',
        created: 1700000000000, modified: 1700000005000 });
    assert.deepEqual({ ...html, id: undefined }, { id: undefined, url: 'https://b.example/', title: '', kind: 'html',
        value: '<div contenteditable="true"><b>rich</b></div>', created: 1700000100000, modified: 1700000100000 });
    for (const entry of entries) assert.equal(data[`t:${entry.id}`], entry);
});

test('running again changes nothing', async () => {
    const data = installChrome({ stored: OLD });
    await migrate();
    const after = structuredClone(data);
    assert.deepEqual(await migrate(), { entries: 0, settings: false });
    assert.deepEqual(data, after);
});

test('an interrupted migration does not duplicate entries', async () => {
    const data = installChrome({ stored: OLD });
    const remove = chrome.storage.local.remove;
    chrome.storage.local.remove = async () => { throw new Error('killed'); };
    await assert.rejects(migrate());
    chrome.storage.local.remove = remove;
    await migrate();
    assert.equal(entriesOf(data).length, 2);
    assert.equal('setting' in data, false);
});

test('nothing to migrate on a fresh profile writes default settings', async () => {
    const data = installChrome();
    assert.deepEqual(await migrate(), { entries: 0, settings: true });
    assert.equal(data.settings.schema, 2);
    assert.equal(data.settings.keepNewest, 100);
    assert.deepEqual(Object.keys(data), ['settings']);
});

test('data in the current layout is left alone', async () => {
    const stored = { settings: { schema: 2, maxItemKb: 1, autoClean: true, keepNewest: 3, skip: [] },
        't:x': { id: 'x', url: '', title: '', kind: 'text', value: 'v', created: 1, modified: 1 } };
    const data = installChrome({ stored });
    assert.deepEqual(await migrate(), { entries: 0, settings: false });
    assert.deepEqual(data, stored);
});

test('invalid old settings fall back to defaults', async () => {
    const data = installChrome({ stored: { setting: { autoClear_keep: '0', maxItemSize: '', shouldAutoClear: 'true' }, exceptions: 'nope' } });
    await migrate();
    assert.equal(data.settings.keepNewest, 100);
    assert.equal(data.settings.maxItemKb, 1024);
    assert.equal(data.settings.autoClean, true);
    assert.deepEqual(data.settings.skip, ['nope']);
});

test('values that are not old entries stay', async () => {
    const data = installChrome({ stored: { 'some key': { val: 3 }, other: 'string', settings: { schema: 2 } } });
    await migrate();
    assert.deepEqual(Object.keys(data).sort(), ['other', 'settings', 'some key']);
});
