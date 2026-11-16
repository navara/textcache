// content.js is a classic script. It runs here in a vm sandbox: without `chrome` it only defines its top-level functions, which the tests call;
// with a fake `chrome`, `document` and `window` it starts, and the tests drive its listeners by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../../extension/content.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function sandbox(extra = {}) {
    const context = vm.createContext({ TextEncoder, crypto, setTimeout, clearTimeout, ...extra });
    vm.runInContext(SOURCE, context, { filename: 'content.js' });
    return context;
}

const pure = sandbox();

test('readSettings: missing or invalid values mean no limit and no skip list', () => {
    assert.deepEqual(plain(pure.readSettings(undefined)), { maxBytes: 0, skip: [] });
    assert.deepEqual(plain(pure.readSettings({ maxItemKb: 'x', skip: 'slack.com' })), { maxBytes: 0, skip: [] });
    assert.deepEqual(plain(pure.readSettings({ maxItemKb: 2, skip: ['a', '', 3] })), { maxBytes: 2048, skip: ['a'] });
});

test('isSkipped matches any part of the address', () => {
    assert.equal(pure.isSkipped('https://app.slack.com/client', ['slack.com']), true);
    assert.equal(pure.isSkipped('https://example.org/', ['slack.com']), false);
    assert.equal(pure.isSkipped('https://example.org/', []), false);
});

test('oversize counts UTF-8 bytes', () => {
    assert.equal(pure.oversize('x'.repeat(5000), 0), 0);
    assert.equal(pure.oversize('x'.repeat(1024), 1024), 0);
    assert.equal(pure.oversize('x'.repeat(1025), 1024), 1025);
    assert.equal(pure.oversize('é'.repeat(600), 1024), 1200);
    assert.equal(pure.oversize('é'.repeat(500), 1024), 0);
    assert.equal(pure.oversize('\u{1F600}'.repeat(300), 1024), 1200);
});

test('fieldFor: textarea, outermost editing host, never an input', () => {
    const textarea = { nodeType: 1, tagName: 'TEXTAREA' };
    assert.equal(pure.fieldFor(textarea).element, textarea);
    assert.equal(pure.fieldFor(textarea).kind, 'text');
    assert.equal(pure.fieldFor({ nodeType: 1, tagName: 'INPUT', isContentEditable: false }), null);
    assert.equal(pure.fieldFor({ nodeType: 3 }), null);
    assert.equal(pure.fieldFor(null), null);

    const body = { nodeType: 1, tagName: 'BODY', isContentEditable: false, parentElement: null };
    const host = { nodeType: 1, tagName: 'DIV', isContentEditable: true, parentElement: body };
    const inner = { nodeType: 1, tagName: 'B', isContentEditable: true, parentElement: host };
    assert.equal(pure.fieldFor(inner).element, host);
    assert.equal(pure.fieldFor(inner).kind, 'html');
    assert.equal(pure.fieldFor(host).element, host);
    assert.equal(pure.fieldFor({ nodeType: 1, tagName: 'DIV', isContentEditable: false, parentElement: body }), null);
});

test('isBlank', () => {
    assert.equal(pure.isBlank(' \n\t'), true);
    assert.equal(pure.isBlank(' a '), false);
});

// A page with one document and window whose listeners the test calls directly, and a chrome whose storage and messages are recorded.
function page({ settings = { schema: 2, maxItemKb: 1, autoClean: true, keepNewest: 100, skip: ['skipped.example'] }, href = 'https://site.example/a' } = {}) {
    const listeners = { document: {}, window: {}, storage: [] };
    const target = name => ({
        addEventListener: (type, f) => { (listeners[name][type] ??= []).push(f); },
        removeEventListener: (type, f) => { listeners[name][type] = (listeners[name][type] ?? []).filter(g => g !== f); },
    });
    const stored = { settings };
    const messages = [];
    const runtime = { id: 'test', sendMessage: async message => { messages.push(plain(message)); } };
    const chrome = {
        runtime,
        storage: {
            local: {
                get: async key => ({ [key]: stored[key] }),
                set: async items => { Object.assign(stored, plain(items)); },
            },
            onChanged: {
                addListener: f => listeners.storage.push(f),
                removeListener: f => { listeners.storage = listeners.storage.filter(g => g !== f); },
            },
        },
    };
    const document = { ...target('document'), title: 'Page title', visibilityState: 'visible' };
    const location = { href };
    sandbox({ chrome, document, window: target('window'), location });
    const fire = (where, type, event = {}) => (listeners[where][type] ?? []).forEach(f => f(event));
    return {
        stored, messages, listeners, runtime, chrome, document, location,
        type(element, value) {
            if ('value' in element) element.value = value;
            else element.innerHTML = element.innerText = value;
            fire('document', 'input', { composedPath: () => [element] });
        },
        fire,
        changeSettings(newValue) {
            stored.settings = newValue;
        },
        entries: () => Object.values(stored).filter(value => value.id),
    };
}

const textarea = () => ({ nodeType: 1, tagName: 'TEXTAREA', value: '', isConnected: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('saves a textarea once the typing pauses', async () => {
    const p = page();
    const field = textarea();
    p.type(field, 'h');
    p.type(field, 'hello');
    await wait(100);
    assert.equal(p.entries().length, 0);
    await wait(450);
    const [entry] = p.entries();
    assert.equal(entry.value, 'hello');
    assert.equal(entry.kind, 'text');
    assert.equal(entry.url, 'https://site.example/a');
    assert.equal(entry.title, 'Page title');
    assert.equal(typeof entry.created, 'number');
    assert.ok(entry.modified >= entry.created);
    assert.ok(p.stored[`t:${entry.id}`]);
});

test('focusout, hidden and pagehide save at once; one id per field', async () => {
    const p = page();
    const field = textarea();
    p.type(field, 'one');
    p.fire('document', 'focusout');
    await wait(10);
    assert.equal(p.entries()[0].value, 'one');
    p.type(field, 'two');
    p.document.visibilityState = 'hidden';
    p.fire('document', 'visibilitychange');
    await wait(10);
    assert.equal(p.entries()[0].value, 'two');
    p.type(field, 'three');
    p.fire('window', 'pagehide');
    await wait(10);
    assert.equal(p.entries().length, 1);
    assert.equal(p.entries()[0].value, 'three');
});

test('blank text, skipped pages and inputs are not saved', async () => {
    const p = page({ href: 'https://skipped.example/' });
    p.type(textarea(), 'secret');
    const q = page();
    q.type(textarea(), '   ');
    q.type({ nodeType: 1, tagName: 'INPUT', value: '', isContentEditable: false }, 'input');
    await wait(450);
    assert.equal(p.entries().length + q.entries().length, 0);
});

test('a skip entry added in the settings applies without a reload', async () => {
    const p = page();
    p.changeSettings({ maxItemKb: 0, skip: ['site.example'] });
    p.type(textarea(), 'text');
    await wait(450);
    assert.equal(p.entries().length, 0);
});

test('ids do not need crypto.randomUUID, which plain http pages lack', () => {
    const insecure = sandbox({ crypto: { getRandomValues: array => crypto.getRandomValues(array) } });
    assert.match(insecure.newId(), /^[0-9a-f]{32}$/);
    assert.notEqual(insecure.newId(), insecure.newId());
});

test('an editing host is saved as html with its rendered text next to it', async () => {
    const p = page();
    const host = { nodeType: 1, tagName: 'DIV', isContentEditable: true, parentElement: null, innerHTML: '', innerText: '' };
    host.innerHTML = '<p>one</p><ul><li>two</li><li>three</li></ul>';
    host.innerText = 'one\n\ntwo\nthree';
    p.fire('document', 'input', { composedPath: () => [host] });
    await wait(450);
    const [entry] = p.entries();
    assert.equal(entry.kind, 'html');
    assert.equal(entry.value, '<p>one</p><ul><li>two</li><li>three</li></ul>');
    assert.equal(entry.text, 'one\n\ntwo\nthree');
});

test('a textarea entry has no separate text', async () => {
    const p = page();
    p.type(textarea(), 'plain');
    await wait(450);
    assert.equal('text' in p.entries()[0], false);
});

test('an editing host whose rendered text is blank is not saved, and the size limit counts the HTML only', async () => {
    const p = page();
    const empty = { nodeType: 1, tagName: 'DIV', isContentEditable: true, parentElement: null, innerHTML: '<br>', innerText: '\n' };
    p.fire('document', 'input', { composedPath: () => [empty] });
    const big = { nodeType: 1, tagName: 'DIV', isContentEditable: true, parentElement: null, innerHTML: `<b>${'x'.repeat(1100)}</b>`, innerText: 'short' };
    p.fire('document', 'input', { composedPath: () => [big] });
    await wait(450);
    assert.equal(p.entries().length, 0);
    assert.deepEqual(p.messages, [{ type: 'save_skipped', size: 1107, limit: 1024 }]);
});

test('over the size limit: last fitting version stays, skipped once, resumed once', async () => {
    const p = page();
    const field = textarea();
    p.type(field, 'small');
    await wait(450);
    p.type(field, 'x'.repeat(2000));
    await wait(450);
    p.type(field, 'y'.repeat(2000));
    await wait(450);
    assert.equal(p.entries()[0].value, 'small');
    assert.deepEqual(p.messages, [{ type: 'save_skipped', size: 2000, limit: 1024 }]);
    p.type(field, 'fits');
    await wait(450);
    assert.equal(p.entries()[0].value, 'fits');
    assert.deepEqual(p.messages.at(-1), { type: 'save_resumed' });
    assert.equal(p.messages.length, 2);
});

test('a failed write is reported', async () => {
    const p = page();
    p.chrome.storage.local.set = async () => { throw new Error('quota exceeded'); };
    p.type(textarea(), 'a');
    await wait(450);
    assert.deepEqual(p.messages, [{ type: 'save_failed', error: 'quota exceeded' }]);
});

test('a dead extension context removes the listeners and stays quiet', async () => {
    const p = page();
    p.runtime.id = undefined;
    p.type(textarea(), 'after reload');
    await wait(450);
    assert.equal(p.entries().length, 0);
    assert.deepEqual(p.listeners.document.input, []);
    assert.deepEqual(p.listeners.storage, []);
});

test('predecessor: a saved field of the same kind that left the document, the one saved last', () => {
    const c = (kind, connected, savedAt) => ({ kind, connected, savedAt });
    assert.equal(pure.predecessor([], 'html'), null);
    assert.equal(pure.predecessor([c('html', true, 1), c('text', false, 2)], 'html'), null);
    const later = c('html', false, 5);
    assert.equal(pure.predecessor([c('html', false, 3), later, c('html', true, 9), c('text', false, 7)], 'html'), later);
});

test('a field that replaces a saved field which left the document keeps its entry', async () => {
    const p = page();
    const first = textarea();
    p.type(first, 'a message written in steps, step 1');
    await wait(450);
    const [before] = p.entries();
    first.isConnected = false;
    const second = textarea();
    p.type(second, 'a message written in steps, step 2');
    await wait(450);
    assert.equal(p.entries().length, 1);
    const [after] = p.entries();
    assert.equal(after.id, before.id);
    assert.equal(after.created, before.created);
    assert.equal(after.value, 'a message written in steps, step 2');
    const third = textarea();
    second.isConnected = false;
    p.type(third, 'a message written in steps, step 3');
    await wait(450);
    assert.deepEqual(p.entries().map(e => [e.id, e.value]), [[before.id, 'a message written in steps, step 3']]);
});

test('no takeover from a field still in the document, of another kind, or taken over already', async () => {
    const p = page();
    const kept = textarea();
    p.type(kept, 'still here');
    await wait(450);
    p.type(textarea(), 'a second field');
    await wait(450);
    assert.equal(p.entries().length, 2);

    const q = page();
    const gone = textarea();
    q.type(gone, 'removed text');
    await wait(450);
    gone.isConnected = false;
    const host = { nodeType: 1, tagName: 'DIV', isContentEditable: true, parentElement: null, isConnected: true, innerHTML: '', innerText: '' };
    q.type(host, 'editor');
    await wait(450);
    assert.equal(q.entries().length, 2, 'an editor took over a textarea');
    const heir = textarea();
    q.type(heir, 'removed text!');
    const other = textarea();
    q.type(other, 'removed text!!');
    await wait(450);
    assert.deepEqual(q.entries().map(e => e.value).sort(), ['editor', 'removed text!', 'removed text!!']);
});

test('of several fields that left the document, the one saved last is continued', async () => {
    const p = page();
    const older = textarea();
    const newer = textarea();
    p.type(older, 'draft text A');
    await wait(450);
    p.type(newer, 'draft text B');
    await wait(450);
    const ids = Object.fromEntries(p.entries().map(e => [e.value, e.id]));
    older.isConnected = newer.isConnected = false;
    p.type(textarea(), 'draft text B.');
    await wait(450);
    assert.deepEqual(p.entries().map(e => [e.id, e.value]).sort(), [[ids['draft text A'], 'draft text A'], [ids['draft text B'], 'draft text B.']].sort());
});

test('continues: shared start and end cover 80 % of the longer text', () => {
    const long = 'Thanks for the notes, I will send the draft tomorrow morning.';
    assert.equal(pure.continues(long, `${long}!`), true, 'one more character');
    assert.equal(pure.continues(long, long.replace('draft', 'final draft')), true, 'an edit in the middle');
    assert.equal(pure.continues(long, '  ' + long + '\n'), true, 'identical after trimming');
    assert.equal(pure.continues(long, 'Ok'), false, 'new short text after a long one');
    assert.equal(pure.continues(long, ''), false, 'empty new field');
    assert.equal(pure.continues(long, 'h'), false, 'first key of a new message');
    assert.equal(pure.continues('first message', 'second message, different'), false);
    assert.equal(pure.continues('abcab', 'ab'), false, 'prefix and suffix do not overlap');
});

test('an editor emptied and rebuilt after sending starts a new entry for the next message', async () => {
    const p = page();
    const first = textarea();
    p.type(first, 'the message that was sent');
    await wait(450);
    first.isConnected = false;
    p.type(textarea(), 'n');
    await wait(450);
    assert.deepEqual(p.entries().map(e => e.value).sort(), ['n', 'the message that was sent']);
});

test('leaving a field after a save tells the background once; a save by the timer alone does not', async () => {
    const p = page();
    const field = textarea();
    p.type(field, 'first');
    await wait(450);
    assert.deepEqual(p.messages, []);
    p.fire('document', 'focusout');
    await wait(10);
    assert.deepEqual(p.messages, [{ type: 'field_done' }]);
    p.fire('document', 'focusout');
    await wait(10);
    assert.equal(p.messages.length, 1, 'told again without a new save');
    p.type(field, 'second');
    p.fire('window', 'pagehide');
    await wait(10);
    assert.equal(p.entries()[0].value, 'second');
    assert.deepEqual(p.messages, [{ type: 'field_done' }, { type: 'field_done' }]);
    p.type(field, 'third');
    p.document.visibilityState = 'hidden';
    p.fire('document', 'visibilitychange');
    await wait(10);
    assert.equal(p.messages.length, 3);
});

test('leaving a field whose text was not saved (blank) does not tell the background', async () => {
    const p = page();
    p.type(textarea(), '   ');
    p.fire('document', 'focusout');
    await wait(10);
    assert.deepEqual(p.messages, []);
});
