import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, importFresh } from './fake-chrome.js';

installChrome();
const { DEFAULTS, normalize, load, save } = await importFresh('settings.js');

test('defaults with unlimitedStorage', () => {
    assert.deepEqual({ ...DEFAULTS, skip: [...DEFAULTS.skip] }, {
        schema: 2, maxItemKb: 1024, autoClean: true, keepNewest: 100, dedupe: true, skip: ['docs.google.com/spreadsheets', 'slack.com', 'messenger.com'],
        language: 'auto',
        popupWidth: 'normal',
    });
});

test('default size limit without unlimitedStorage is 100 KB', async () => {
    installChrome({ permissions: ['storage', 'alarms'] });
    const limited = await importFresh('settings.js');
    assert.equal(limited.DEFAULTS.maxItemKb, 100);
    installChrome();
});

test('normalize fills defaults for nothing stored', () => {
    for (const raw of [undefined, null, 'x', 42, {}]) assert.deepEqual(normalize(raw), { ...DEFAULTS, skip: [...DEFAULTS.skip] });
});

test('normalize coerces strings from forms and drops unknown keys', () => {
    const result = normalize({ maxItemKb: '0', keepNewest: '25', autoClean: false, skip: ' a.com \n\nb.org\na.com', popupType: 'tab', schema: 1 });
    assert.deepEqual(result,
        { schema: 2, maxItemKb: 0, autoClean: false, keepNewest: 25, dedupe: true, skip: ['a.com', 'b.org'], language: 'auto', popupWidth: 'normal' });
    assert.equal(normalize({ dedupe: false }).dedupe, false);
});

test('normalize replaces invalid values with the base', () => {
    const base = { ...DEFAULTS, maxItemKb: 7, keepNewest: 9, autoClean: false, skip: ['x'] };
    for (const keepNewest of ['', '0', 0, -3, 1.5, '1.5', 'abc', null, NaN, Infinity]) {
        assert.equal(normalize({ keepNewest }, base).keepNewest, 9, `keepNewest ${keepNewest}`);
    }
    for (const maxItemKb of ['', -1, 'abc', null, Infinity]) {
        assert.equal(normalize({ maxItemKb }, base).maxItemKb, 7, `maxItemKb ${maxItemKb}`);
    }
    assert.equal(normalize({ autoClean: 'yes' }, base).autoClean, false);
    for (const dedupe of ['false', 0, null]) assert.equal(normalize({ dedupe }, { ...base, dedupe: false }).dedupe, false, `dedupe ${dedupe}`);
    assert.equal(normalize({ dedupe: 'no' }, base).dedupe, true);
    assert.deepEqual(normalize({ skip: 5 }, base).skip, ['x']);
    assert.deepEqual(normalize({ skip: ['a', 3, '', ' '] }, base).skip, ['a']);
    assert.deepEqual(normalize({ skip: [] }, base).skip, []);
});

test('normalize keeps auto or a supported language code, anything else becomes the base', () => {
    for (const language of ['auto', 'en', 'cs', 'pt_BR', 'zh_CN', 'ar']) assert.equal(normalize({ language }).language, language);
    for (const language of ['pt', 'pt-BR', 'CS', '', null, 3, 'toString']) {
        assert.equal(normalize({ language }, { ...DEFAULTS, language: 'de' }).language, 'de', `language ${language}`);
    }
    assert.equal(normalize({}).language, 'auto');
});

test('normalize keeps a known popup width, anything else becomes the base', () => {
    for (const popupWidth of ['narrow', 'normal', 'wide']) assert.equal(normalize({ popupWidth }).popupWidth, popupWidth);
    for (const popupWidth of ['Wide', '', null, 480, 'toString']) {
        assert.equal(normalize({ popupWidth }, { ...DEFAULTS, popupWidth: 'wide' }).popupWidth, 'wide', `popupWidth ${popupWidth}`);
    }
    assert.equal(normalize({}).popupWidth, 'normal');
});

test('save completes the stored settings and keeps the current value for an invalid patch', async () => {
    const data = installChrome({ stored: { settings: { keepNewest: 5, junk: 1 } } });
    assert.deepEqual((await load()).keepNewest, 5);
    const written = await save({ keepNewest: '0', maxItemKb: 50 });
    assert.equal(written.keepNewest, 5);
    assert.equal(written.maxItemKb, 50);
    assert.deepEqual(data.settings, written);
    assert.equal('junk' in data.settings, false);
});
