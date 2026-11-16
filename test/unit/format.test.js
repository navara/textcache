// htmlToText needs a DOM (DOMParser); the browser test covers it, and with it snippet() for html entries. Here a counting stand-in for DOMParser
// shows when entryText falls back to parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { entryText, formatBytes, formatClock, formatNumber, formatTime, formatRelative, snippet, toCsv } from '../../extension/lib/format.js';
import { init } from '../../extension/lib/i18n.js';

// loads the real messages of `code` into the loader that format.js and dom.js share
async function useLanguage(code) {
    globalThis.chrome = {
        runtime: { getURL: file => file },
        i18n: { getUILanguage: () => 'en-US' },
        storage: { local: { get: async () => ({ settings: { language: code } }) } },
    };
    globalThis.fetch = async file => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(new URL(`../../extension/${file}`, import.meta.url))) });
    await init();
}

let parses = 0;
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
globalThis.DOMParser = class {
    parseFromString(html) {
        parses++;
        return { body: { childNodes: [{ nodeType: 3, nodeValue: `parsed ${html}` }] } };
    }
};

test('formatBytes rounds up', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1025), '2 KB');
    assert.equal(formatBytes(1024 * 1024), '1 MB');
    assert.equal(formatBytes(1.01 * 1024 * 1024), '1.1 MB');
    assert.equal(formatBytes(undefined), '0 B');
});

test('formatTime and formatRelative give nothing for a missing time', () => {
    assert.equal(formatTime(undefined), '');
    assert.equal(formatRelative('x'), '');
    assert.notEqual(formatTime(0), '');
});

// Stored entries can lack a time or hold null (what JSON makes of NaN) or a string; none of them may throw.
const BAD_TIMES = [undefined, null, NaN, Infinity, '1700000000000', 'x', {}];

test('formatTime, formatClock, formatRelative and the popup\'s relativeTime give nothing for a missing or non-finite time', async () => {
    const { relativeTime } = await import('../../extension/ui/dom.js');
    for (const ms of BAD_TIMES) {
        for (const format of [formatTime, formatClock, formatRelative, relativeTime]) assert.equal(format(ms), '', `${format.name}(${String(ms)})`);
    }
    const now = Date.UTC(2026, 10, 16, 12);
    // before i18n init() the language is English, whatever the machine's
    assert.equal(formatClock(now), new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(now));
    assert.equal(formatTime(now), new Date(now).toLocaleString('en'));
    await useLanguage('en');
    assert.equal(relativeTime(now - 1000, now), 'just now');
    assert.equal(relativeTime(now - 3 * 3600000, now), '3 hours ago');
});

test('formatRelative picks the largest unit', () => {
    const now = Date.UTC(2026, 10, 16);
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    assert.equal(formatRelative(now - 5 * 60000, now), rtf.format(-5, 'minute'));
    assert.equal(formatRelative(now - 3 * 86400000, now), rtf.format(-3, 'day'));
    assert.equal(formatRelative(now, now), rtf.format(0, 'second'));
});

test('snippet of a text entry is one shortened line', () => {
    assert.equal(snippet({ kind: 'text', value: '  one\n\ttwo   three ' }), 'one two three');
    assert.equal(snippet({ kind: 'text', value: 'abcdefghij' }, 5), 'abcd…');
    assert.equal(snippet({ kind: 'text', value: 'abcde' }, 5), 'abcde');
    assert.equal(snippet({ kind: 'text' }), '');
});

test('entryText takes the saved text of rich text and parses only entries without it, once per version', () => {
    parses = 0;
    assert.equal(entryText({ id: 'a', kind: 'text', value: 'plain', modified: 1 }), 'plain');
    assert.equal(entryText({ id: 'a', kind: 'text', modified: 1 }), '');
    const saved = { id: 'h', kind: 'html', value: '<p>x</p>', text: 'from the editor', modified: 1 };
    assert.equal(entryText(saved), 'from the editor');
    assert.equal(entryText({ ...saved, text: '' }), '');
    assert.equal(snippet(saved), 'from the editor');
    assert.equal(parses, 0);

    const migrated = { id: 'm', kind: 'html', value: '<b>old</b>', modified: 5 };
    assert.equal(entryText(migrated), 'parsed <b>old</b>');
    assert.equal(entryText(migrated), 'parsed <b>old</b>');
    assert.equal(snippet(migrated), 'parsed <b>old</b>');
    assert.equal(parses, 1);
    assert.equal(entryText({ ...migrated, value: '<b>new</b>', modified: 6 }), 'parsed <b>new</b>');
    assert.equal(entryText({ ...migrated, text: 42 }), 'parsed <b>old</b>');
    assert.equal(parses, 2);
});

test('toCsv quotes quote, comma, CR and LF, and writes undefined as empty', () => {
    const csv = toCsv([
        { id: 'a', url: 'https://x/?a,b', title: 'say "hi"', kind: 'text', created: 0, modified: 1000, value: 'line1\rline2' },
        { id: 'b', url: undefined, title: null, kind: 'html', value: '<p>x</p>', text: 'x\ny' },
        { id: 'c', url: 'u', title: 't', kind: 'text', created: 0, modified: 0, value: 'plain' },
    ]);
    assert.equal(csv, '\uFEFF' + [
        'id,url,title,kind,created,modified,value,text',
        'a,"https://x/?a,b","say ""hi""",text,1970-01-01T00:00:00.000Z,1970-01-01T00:00:01.000Z,"line1\rline2","line1\rline2"',
        'b,,,html,,,<p>x</p>,"x\ny"',
        'c,u,t,text,1970-01-01T00:00:00.000Z,1970-01-01T00:00:00.000Z,plain,plain',
        '',
    ].join('\r\n'));
});

test('toCsv of nothing is the BOM and the header line', () => {
    assert.equal(toCsv([]), '\uFEFFid,url,title,kind,created,modified,value,text\r\n');
});

test('toCsv puts a quote before url, title, value and text that a spreadsheet would read as a formula', () => {
    for (const start of ['=', '+', '-', '@', '\t', '\r']) {
        const bad = `${start}HYPERLINK("http://evil.test")`;
        const [, row] = toCsv([{ id: 'x', url: bad, title: bad, kind: 'text', value: bad }]).slice(1).split('\r\n');
        const field = `'${bad}`;
        const quoted = /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
        assert.equal(row, ['x', quoted, quoted, 'text', '', '', quoted, quoted].join(','), JSON.stringify(start));
    }
    const html = toCsv([{ id: 'h', url: 'https://ok/', title: 'a=b', kind: 'html', value: '<p>=1+1</p>', text: '=1+1' }]);
    assert.equal(html.split('\r\n')[1], "h,https://ok/,a=b,html,,,<p>=1+1</p>,'=1+1");
    assert.equal(toCsv([{ id: '=x', kind: '-', value: 'v' }]).split('\r\n')[1], '=x,,,-,,,v,v', 'only the four page-derived columns change');
});

// last, as it leaves the loader in Czech
test('numbers, times and relative times follow the language chosen in the settings', async () => {
    await useLanguage('cs');
    const { relativeTime } = await import('../../extension/ui/dom.js');
    const now = Date.UTC(2026, 10, 16, 12);
    assert.equal(formatNumber(1234567), new Intl.NumberFormat('cs').format(1234567));
    assert.equal(formatTime(now), new Date(now).toLocaleString('cs'));
    assert.equal(formatClock(now), new Intl.DateTimeFormat('cs', { hour: 'numeric', minute: '2-digit' }).format(now));
    assert.equal(formatRelative(now - 5 * 60000, now), new Intl.RelativeTimeFormat('cs', { numeric: 'auto' }).format(-5, 'minute'));
    assert.equal(relativeTime(now - 3 * 3600000, now), new Intl.RelativeTimeFormat('cs', { numeric: 'auto' }).format(-3, 'hour'));
    assert.equal(relativeTime(now - 1000, now), 'právě teď');
});