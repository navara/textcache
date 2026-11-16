import test from 'node:test';
import assert from 'node:assert/strict';
import { idsOfOlderCopies, idsToClean, idsToPrune } from '../../extension/lib/cleanup.js';

const entries = [
    { id: 'b', modified: 2000, created: 1 },
    { id: 'a', modified: 3000, created: 1 },
    { id: 'd', modified: 1000, created: 1 },
    { id: 'c', modified: 4000, created: 1 },
];

test('keeps the N newest by modified', () => {
    assert.deepEqual(idsToPrune(entries, 2), ['b', 'd']);
    assert.deepEqual(idsToPrune(entries, 1), ['a', 'b', 'd']);
    assert.deepEqual(idsToPrune(entries, 4), []);
    assert.deepEqual(idsToPrune(entries, 100), []);
    assert.deepEqual(idsToPrune([], 1), []);
});

test('does not reorder the input', () => {
    const copy = entries.map(entry => entry.id);
    idsToPrune(entries, 1);
    assert.deepEqual(entries.map(entry => entry.id), copy);
});

test('an invalid keep deletes nothing', () => {
    for (const keep of [0, -1, 1.5, '2', NaN, null, undefined, Infinity]) assert.deepEqual(idsToPrune(entries, keep), [], `keep ${keep}`);
});

test('ties on modified go to the later created, then to the id', () => {
    const tied = [
        { id: 'z', modified: 5, created: 1 },
        { id: 'y', modified: 5, created: 2 },
        { id: 'x', modified: 5, created: 1 },
    ];
    assert.deepEqual(idsToPrune(tied, 1), ['x', 'z']);
    assert.deepEqual(idsToPrune([...tied].reverse(), 1), ['x', 'z']);
});

test('an entry without a valid time counts as the oldest', () => {
    assert.deepEqual(idsToPrune([{ id: 'broken', modified: '7' }, { id: 'ok', modified: 1 }], 1), ['broken']);
});

const saved = (id, modified, value, extra = {}) => ({ id, kind: 'text', value, created: modified, modified, ...extra });

test('older copies: the same plain text after trimming, the latest modified stays whatever page it came from', () => {
    const list = [
        saved('a', 1000, 'hello world', { url: 'https://one/' }),
        saved('b', 3000, '  hello world\n', { url: 'https://two/' }),
        saved('c', 2000, 'hello world and more'),
        saved('d', 4000, 'hello'),
        saved('e', 500, 'Hello world'),
    ];
    assert.deepEqual(idsOfOlderCopies(list), ['a']);
    assert.deepEqual(idsOfOlderCopies([]), []);
});

test('older copies: ties on modified go to the later created, then to the id', () => {
    const tied = [saved('y', 5, 'x', { created: 1 }), saved('x', 5, 'x', { created: 1 }), saved('z', 5, 'x', { created: 2 })];
    assert.deepEqual(idsOfOlderCopies(tied), ['x', 'y']);
    assert.deepEqual(idsOfOlderCopies([...tied].reverse()), ['x', 'y']);
});

test('older copies: html entries compare by their text when they have it, else by their value', () => {
    const list = [
        saved('t', 4000, 'one two'),
        saved('h1', 3000, '<p>one <b>two</b></p>', { kind: 'html', text: 'one two\n' }),
        saved('h2', 2000, '<p>one <b>two</b></p>'),
        saved('h3', 1000, '<p>one <b>two</b></p>', { kind: 'html' }),
        saved('h4', 500, ' <p>one <b>two</b></p>', { kind: 'html', text: 42 }),
    ];
    assert.deepEqual(idsOfOlderCopies(list), ['h1', 'h3', 'h4']);
});

test('idsToClean: copies first, then all but the newest of the rest; each part only when its setting is on', () => {
    const list = [saved('a', 4000, 'same'), saved('b', 3000, 'same'), saved('c', 2000, 'other'), saved('d', 1000, 'third')];
    assert.deepEqual(idsToClean(list, { dedupe: true, autoClean: true, keepNewest: 2 }), ['b', 'd']);
    assert.deepEqual(idsToClean(list, { dedupe: false, autoClean: true, keepNewest: 2 }), ['c', 'd']);
    assert.deepEqual(idsToClean(list, { dedupe: true, autoClean: false, keepNewest: 2 }), ['b']);
    assert.deepEqual(idsToClean(list, { dedupe: false, autoClean: false, keepNewest: 2 }), []);
    assert.deepEqual(idsToClean(list, { dedupe: false, autoClean: true, keepNewest: 100 }), []);
});
