// watchStorage from ui/dom.js against a fake chrome.storage.onChanged, with real timers.
import test from 'node:test';
import assert from 'node:assert/strict';

const listeners = [];
globalThis.chrome = { storage: { onChanged: { addListener: f => listeners.push(f) } } };
const { watchStorage } = await import('../../extension/ui/dom.js');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const change = (key = 't:a', area = 'local') => listeners.forEach(f => f({ [key]: {} }, area));

test('a short burst of changes is reported once, after the debounce', async () => {
    const calls = [];
    listeners.length = 0;
    watchStorage(what => calls.push(what), 150, 1000);
    change();
    change('settings');
    change('other');
    change('t:b', 'sync');
    await wait(100);
    assert.equal(calls.length, 0);
    await wait(150);
    assert.deepEqual(calls, [{ savedTexts: true, settings: true }]);
});

test('changes that never pause are still reported, at most a second apart', async () => {
    const calls = [];
    listeners.length = 0;
    watchStorage(() => calls.push(Date.now()), 150, 1000);
    const start = Date.now();
    for (let i = 0; i < 25; i++) {
        change();
        await wait(100);
    }
    assert.ok(calls.length >= 2, `${calls.length} reports in ${Date.now() - start} ms`);
    assert.ok(calls[0] - start < 1150, `first report after ${calls[0] - start} ms`);
});
