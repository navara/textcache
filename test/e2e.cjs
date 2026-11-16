// Loads the unpacked extension into a throw-away Chromium profile and exercises the real thing, one reported step per item of the R3 test plan:
// loading, saving from textareas, editors, shadow roots and frames, the skip list, the size limit, clean-up and migration across a browser restart,
// hostile data in the pages, the list page, the real action popup, the options page, and the layout with screenshots in light and dark.
//
// Usage: npm run test:e2e [-- <screenshot folder>]   (default STATE/shots)
// Needs a full Chromium (not headless_shell). CHROMIUM=<path to chrome.exe> names one; without it the newest Chromium that Playwright has downloaded
// to %LOCALAPPDATA%\ms-playwright is used. Web pages come from a local HTTP server on 127.0.0.1, which also counts requests that must never happen.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const EXT = path.resolve(__dirname, '..', 'extension');
const SHOTS = path.resolve(process.argv[2] || path.join(__dirname, '..', 'STATE', 'shots'));
const EXT_ID = 'lfpadkcnbbhojjmamnmnchjcefhmmnnp';
const messagesOf = code => JSON.parse(fs.readFileSync(path.join(EXT, '_locales', code, 'messages.json'), 'utf8'));
const MESSAGES = messagesOf('en');
const CZECH = messagesOf('cs');
const DEFAULT_SKIP = ['docs.google.com/spreadsheets', 'slack.com', 'messenger.com'];

// the page text for a message key, with $1, $2 substituted the way chrome.i18n does
const msg = (key, ...subs) => MESSAGES[key].message.replace(/\$(\d)/g, (_, n) => subs[n - 1]);

function findChromium() {
    if (process.env.CHROMIUM) return process.env.CHROMIUM;
    const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    const found = (fs.existsSync(root) ? fs.readdirSync(root) : [])
        .filter(d => /^chromium-\d+$/.test(d))
        .sort((a, b) => parseInt(b.slice(9)) - parseInt(a.slice(9)))
        .map(d => path.join(root, d, 'chrome-win64', 'chrome.exe'))
        .find(p => fs.existsSync(p));
    if (!found) throw new Error(`no Chromium under ${root}; set CHROMIUM to a chrome.exe`);
    return found;
}

let passed = 0;
const step = text => {
    passed++;
    console.log(`ok ${passed} - ${text}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// polls fn until it returns a value that passes test; returns the last value either way, the caller asserts on it
async function until(fn, test, ms = 5000) {
    let v = await fn();
    for (let t = 0; !test(v) && t < ms; t += 100) {
        await sleep(100);
        v = await fn();
    }
    return v;
}

// ---- local web server: the pages typed into, plus /leak/* which hostile saved HTML points at and which must never be requested

const hits = [];
const FORM = `<!doctype html><html><head><title>Form page</title></head><body>
<textarea id="ta"></textarea>
<textarea id="paste"></textarea>
<input id="inp">
<div id="ce" contenteditable="true"><p>start <b id="inner">bold</b></p><ul><li>one</li><li>two</li></ul></div>
<div id="shadowHost"></div>
<iframe id="child" src="/frame"></iframe>
<iframe id="sd" srcdoc="<!doctype html><title>s</title><textarea id='s'></textarea>"></iframe>
<iframe id="blank"></iframe>
<script>
document.getElementById('shadowHost').attachShadow({ mode: 'open' }).append(document.createElement('textarea'));
</script>
</body></html>`;
const FRAME = '<!doctype html><title>Frame page</title><textarea id="f"></textarea>';
const PLAYGROUND = fs.readFileSync(path.join(__dirname, 'playground', 'index.html'));

const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/form')) res.end(FORM);
    else if (req.url.startsWith('/frame')) res.end(FRAME);
    else if (req.url.startsWith('/playground')) res.end(PLAYGROUND);
    else res.end('');
});

// ---- browser

const errors = [];
const excluded = new Map();

// Chrome logs these for hostile saved HTML although nothing runs or loads; any other console error fails the test.
// 1. Parsing saved HTML that has on...= attributes (htmlToText, through DOMParser) makes Chrome report the extension page's CSP once per attribute
//    and policy. Every HTML parser reachable from an extension page does this (probe 2026-11-16), and no handler is created. Only rich text
//    without a saved `text` (migrated entries) is parsed; the hostile-data step checks that an entry with `text` causes no report.
// 2. The sandboxed preview (about:srcdoc) reports what its sandbox and its CSP block: the <script>, the meta refresh and remote images.
const CSP_REPORT = 'CSP report for an on...= attribute while parsing saved HTML';
const PREVIEW_NOISE = [
    [text => text === 'Blocked script execution in \'about:srcdoc\' because the document\'s frame is sandboxed and the \'allow-scripts\' '
        + 'permission is not set.', 'sandboxed preview blocked a script'],
    [text => text === 'Refused to execute the redirect specified via \'<meta http-equiv=\'refresh\' content=\'...\'>\'. The document is sandboxed, '
        + 'and the \'allow-scripts\' keyword is not set.', 'sandboxed preview blocked a meta refresh'],
    [text => /^Loading the image 'http:\/\/127\.0\.0\.1:\d+\/leak\/\w+' violates the following /.test(text)
        && text.endsWith(' Content Security Policy directive: "img-src data:". The action has been blocked.'), 'preview CSP blocked a remote image'],
];

function documentedNoise(text, frameUrl, pageUrl) {
    if (pageUrl.startsWith(`chrome-extension://${EXT_ID}/`)
        && text.startsWith('Executing inline event handler violates the following Content Security Policy directive \'script-src \'self\'')) {
        return CSP_REPORT;
    }
    if (frameUrl !== 'about:srcdoc') return null;
    return PREVIEW_NOISE.find(([matches]) => matches(text))?.[1] ?? null;
}

function watchPage(page) {
    page.on('pageerror', e => errors.push(`${page.url()}: uncaught ${e.message}`));
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const why = documentedNoise(m.text(), m.location().url, page.url());
        if (why) excluded.set(why, (excluded.get(why) || 0) + 1);
        else errors.push(`${page.url()}: console error ${m.text()} (from ${m.location().url || 'unknown'})`);
    });
}

function watchWorker(worker) {
    worker.on('console', m => {
        if (m.type() === 'error') errors.push(`service worker: console error ${m.text()}`);
    });
}

async function launch(profile) {
    const ctx = await chromium.launchPersistentContext(profile, {
        executablePath: findChromium(),
        headless: true,
        // the debugging port and the unsafe-extension-debugging flag are for CDP Extensions.triggerAction, which opens the real popup
        // --lang pins the browser language, so that the language setting "auto" means English on any machine
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-extension-debugging', '--remote-debugging-port=0',
            '--lang=en-US'],
    });
    ctx.on('page', watchPage);
    ctx.pages().forEach(watchPage);
    ctx.on('serviceworker', watchWorker);
    ctx.serviceWorkers().forEach(watchWorker);
    const sw = ctx.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${EXT_ID}/`))
        || await ctx.waitForEvent('serviceworker', w => w.url().startsWith(`chrome-extension://${EXT_ID}/`));
    // Playwright takes an extension origin for opaque, so the grant covers every origin of this throw-away profile
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    return { ctx, sw };
}

// a second connection over the debugging port: Playwright does not show action popups as pages, and Extensions.* needs a browser session
async function cdp(profile) {
    const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    return { browser, session: await browser.newBrowserCDPSession() };
}

const extUrl = page => `chrome-extension://${EXT_ID}/${page}`;

async function openExt(ctx, page, width = 1280) {
    const p = await ctx.newPage();
    await p.setViewportSize({ width, height: 900 });
    await p.goto(extUrl(page));
    return p;
}

const optionsReady = page => page.waitForFunction(() =>
    document.querySelector('#storageUsage').textContent !== '' && document.querySelector('#cleanupPreview').textContent !== '');

// ---- storage helpers, run in an extension page

const allItems = page => page.evaluate(() => chrome.storage.local.get());
const savedTexts = async page => Object.entries(await allItems(page)).filter(([k]) => k.startsWith('t:')).map(([, v]) => v);
const storedSettings = async page => (await page.evaluate(() => chrome.storage.local.get('settings'))).settings;
const clearSaved = page => page.evaluate(async () => {
    const keys = Object.keys(await chrome.storage.local.get()).filter(k => k.startsWith('t:'));
    await chrome.storage.local.remove(keys);
});
const putSaved = (page, entries) => page.evaluate(list => chrome.storage.local.set(Object.fromEntries(list.map(e => [`t:${e.id}`, e]))), entries);
const savedFrom = async (page, url) => (await savedTexts(page)).filter(e => e.url === url);
const valuesFrom = async (page, url) => (await savedFrom(page, url)).map(e => e.value).sort();

function entry(id, minutesAgo, fields = {}) {
    const t = Date.now() - minutesAgo * 60000;
    return { id, url: 'http://example.test/page', title: '', kind: 'text', value: `text ${id}`, created: t - 1000, modified: t, ...fields };
}

// change a number field the way a person does: type, leave the field
async function setField(opt, id, value) {
    await opt.fill(`#${id}`, value);
    await opt.press(`#${id}`, 'Tab');
}

// Runs test/playground with ?autorun in a new tab and returns, per scenario, how the saved texts differ from the page's "Expected result" table.
// `copies` is how many saved texts scenario 8 (the same text in two fields) should leave: 1 with duplicate removal on, 2 with it off.
async function playground(ctx, opt, url, copies) {
    const page = await ctx.newPage();
    await page.goto(url);
    await page.bringToFront();
    const tabs = await opt.evaluate(() => chrome.tabs.query({ active: true }));
    assert.strictEqual(tabs.length, 1, `expected one active tab, found ${tabs.length}`);
    await page.waitForFunction(() => document.querySelector('#runState').textContent === 'done', null, { timeout: 60000 });
    const run = await page.textContent('#run');
    const textOf = e => String(e.kind === 'html' && typeof e.text === 'string' ? e.text : e.value).trim();
    const check = async () => {
        const all = await savedTexts(opt);
        const mine = name => all.filter(e => textOf(e).startsWith(`TC-${run}-${name} `));
        const failures = [];
        const expect = (name, ok, what) => {
            if (!ok) failures.push(`${name}: ${what}; found ${JSON.stringify(mine(name).map(e => [e.kind, e.url, textOf(e).slice(-40)]))}`);
        };
        const once = name => mine(name).length === 1;
        expect('textarea', once('textarea') && mine('textarea')[0].kind === 'text', 'once, kind text');
        expect('input', mine('input').length === 0, 'never saved');
        expect('search', mine('search').length === 0, 'never saved');
        expect('searchchat', once('searchchat'), 'once');
        expect('editor', once('editor') && mine('editor')[0].kind === 'html' && textOf(mine('editor')[0]).endsWith(' bold and plain'),
            'once, kind html, text ending "bold and plain"');
        expect('shadow', once('shadow'), 'once');
        expect('frame', once('frame') && mine('frame')[0].url === 'about:srcdoc', 'once, from about:srcdoc');
        expect('late', once('late'), 'once');
        expect('remount', once('remount') && textOf(mine('remount')[0]).endsWith('step 3'), 'once, ending in "step 3"');
        expect('duplicate', mine('duplicate').length === copies, `${copies} time(s)`);
        expect('big', once('big') && textOf(mine('big')[0]).endsWith(' short'), 'once, the short version');
        const sent = mine('send').map(textOf).map(t => t.slice(`TC-${run}-send `.length)).sort();
        expect('send', JSON.stringify(sent) === JSON.stringify(['and now a different second one', 'first message']), 'twice, the sent and the next message');
        const badge = await opt.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabs[0].id);
        if (badge !== 'MAX') failures.push(`big: tab badge ${JSON.stringify(badge)}, expected MAX`);
        const unmarked = all.filter(e => e.url === url && !textOf(e).startsWith(`TC-${run}-`));
        if (unmarked.length) failures.push(`blank: saved without a marker ${JSON.stringify(unmarked.map(e => e.value))}`);
        return failures;
    };
    const failures = await until(check, f => f.length === 0);
    await page.close();
    return { run, failures };
}

const noHorizontalScroll = page => page.evaluate(() => {
    const d = document.documentElement;
    return { scroll: d.scrollWidth, client: d.clientWidth };
});

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const WEB = `http://127.0.0.1:${port}`;
    const WEB2 = `http://localhost:${port}`;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'textcache-e2e-'));
    let { ctx, sw } = await launch(profile);
    try {
        // 1. loading
        const extId = new URL(sw.url()).host;
        assert.strictEqual(extId, EXT_ID, 'the ID no longer comes from the manifest key');
        let opt = await openExt(ctx, 'options/options.html');
        await optionsReady(opt);
        assert.strictEqual(await opt.evaluate(() => chrome.runtime.getManifest().version), '1.1');
        const icons = await opt.evaluate(async () => {
            const { icons: sizes, action } = chrome.runtime.getManifest();
            const files = [...new Set([...Object.values(sizes), ...Object.values(action.default_icon)])];
            const sizesOf = await Promise.all(files.map(async file => {
                const bitmap = await createImageBitmap(await (await fetch(chrome.runtime.getURL(file))).blob());
                return `${file} ${bitmap.width}x${bitmap.height}`;
            }));
            return { sizes, action: action.default_icon, sizesOf, brand: document.querySelector('.brand img').naturalWidth };
        });
        assert.deepStrictEqual(icons.sizes, { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' });
        assert.deepStrictEqual(icons.action, { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' });
        assert.deepStrictEqual(icons.sizesOf.sort(), ['icons/icon-128.png 128x128', 'icons/icon-16.png 16x16', 'icons/icon-32.png 32x32',
            'icons/icon-48.png 48x48']);
        assert.strictEqual(icons.brand, 48, 'the page header icon did not load');
        const alarm = await until(() => opt.evaluate(() => chrome.alarms.get('clean')), a => a);
        assert.ok(alarm && alarm.periodInMinutes === 60, `hourly alarm "clean" missing: ${JSON.stringify(alarm)}`);
        assert.strictEqual((await until(() => storedSettings(opt), s => s))?.schema, 2, 'the background did not write the settings at install');
        assert.deepStrictEqual(errors.filter(e => e.startsWith('service worker')), []);
        step(`extension loads with id ${extId}, version 1.1, icons 16/32/48/128 load at their sizes; the worker wrote the settings and the hourly `
            + 'alarm, no service worker error');

        // 12. options (first, while the profile still has its defaults)
        assert.deepStrictEqual(await storedSettings(opt),
            { schema: 2, maxItemKb: 1024, autoClean: true, keepNewest: 100, dedupe: true, skip: DEFAULT_SKIP, language: 'auto', popupWidth: 'normal' },
            'stored defaults');
        assert.strictEqual(await opt.inputValue('#maxItemKb'), '1024');
        assert.strictEqual(await opt.inputValue('#keepNewest'), '100');
        assert.strictEqual(await opt.isChecked('#autoClean'), true);
        assert.strictEqual(await opt.isChecked('#dedupe'), true);
        assert.strictEqual(await opt.inputValue('#skip'), DEFAULT_SKIP.join('\n'));
        assert.strictEqual(await opt.textContent('#cleanupPreview'), msg('options_preview_none', '0'));
        for (const bad of ['', '0', '1.5']) {
            await setField(opt, 'keepNewest', bad);
            await sleep(400);
            assert.strictEqual((await storedSettings(opt)).keepNewest, 100, `keepNewest "${bad}" was saved`);
            assert.strictEqual(await opt.getAttribute('#keepNewest', 'aria-invalid'), 'true', `keepNewest "${bad}" not marked`);
            assert.ok(await opt.isVisible('#keepNewest_error'), `no message for keepNewest "${bad}"`);
            assert.strictEqual(await opt.textContent('#keepNewest_error'), msg('options_invalid_keep'));
        }
        // a settings change made elsewhere (here: a skip entry written by the worker) must leave the rejected entry and its message alone
        const addSkip = entryText => sw.evaluate(async item => {
            const { settings } = await chrome.storage.local.get('settings');
            await chrome.storage.local.set({ settings: { ...settings, skip: item ? [...settings.skip, item] : settings.skip.slice(0, 3) } });
        }, entryText);
        await addSkip('elsewhere.test');
        assert.ok((await until(() => opt.inputValue('#skip'), v => v.includes('elsewhere.test'))).includes('elsewhere.test'), 'the page missed the change');
        assert.strictEqual(await opt.inputValue('#keepNewest'), '1.5', 'a settings change elsewhere replaced the rejected entry');
        assert.strictEqual(await opt.getAttribute('#keepNewest', 'aria-invalid'), 'true', 'a settings change elsewhere cleared the mark');
        assert.ok(await opt.isVisible('#keepNewest_error'), 'a settings change elsewhere hid the message');
        await addSkip(null);
        await until(() => opt.inputValue('#skip'), v => !v.includes('elsewhere.test'));
        await setField(opt, 'keepNewest', '7');
        assert.strictEqual((await until(() => storedSettings(opt), s => s.keepNewest === 7)).keepNewest, 7, 'a valid keepNewest was not saved');
        assert.strictEqual(await opt.getAttribute('#keepNewest', 'aria-invalid'), 'false');
        assert.strictEqual(await opt.isVisible('#keepNewest_error'), false);
        await setField(opt, 'keepNewest', '100');
        await until(() => storedSettings(opt), s => s.keepNewest === 100);
        const bytes = await opt.evaluate(async () => {
            const big = {};
            for (let i = 0; i < 12; i++) {
                big[`t:big-${i}`] = { id: `big-${i}`, url: 'http://big.test/', title: '', kind: 'text', value: 'x'.repeat(1048576), created: 1, modified: 1 };
            }
            await chrome.storage.local.set(big);
            const n = await chrome.storage.local.getBytesInUse(null);
            await chrome.storage.local.remove(Object.keys(big));
            return n;
        });
        assert.ok(bytes > 10485760, `only ${bytes} bytes stored`);
        step('options: defaults shown and stored (1024 KB, keep 100, clean-up on, three skip entries); keepNewest "", "0", "1.5" not saved and '
            + `marked, and still marked after a settings change made elsewhere; "7" saved; stored ${bytes} bytes, above the former 10485760 byte quota`);

        // 2. typing, script paste, <input>
        const form = await ctx.newPage();
        await form.goto(`${WEB}/form`);
        await form.locator('#ta').pressSequentially('hello from e2e');
        const early = await valuesFrom(opt, `${WEB}/form`);
        assert.ok(!early.includes('hello from e2e'), 'saved before the debounce passed');
        assert.ok((await until(() => valuesFrom(opt, `${WEB}/form`), v => v.includes('hello from e2e'))).includes('hello from e2e'), 'typed text not saved');
        await form.evaluate(() => {
            const ta = document.getElementById('paste');
            ta.value = 'pasted by script';
            ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
        });
        assert.ok((await until(() => valuesFrom(opt, `${WEB}/form`), v => v.includes('pasted by script'))).includes('pasted by script'),
            'text set by script with an input event not saved');
        await form.locator('#inp').pressSequentially('not for saving');
        await form.locator('#inp').press('Tab');
        await sleep(1000);
        assert.deepStrictEqual(await valuesFrom(opt, `${WEB}/form`), ['hello from e2e', 'pasted by script'], 'unexpected saved texts (an <input> saved?)');
        step('typing in a textarea is saved after the debounce (not before); text set by script with an input event is saved; an <input> is not');

        // 3. contentEditable
        await form.locator('#inner').click();
        await form.keyboard.press('End');
        await form.keyboard.type(' typed');
        await form.evaluate(() => {
            const inner = document.getElementById('inner');
            inner.append(' and more');
            inner.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        });
        const ceHtml = await form.evaluate(() => document.getElementById('ce').innerHTML);
        const html = await until(async () => (await savedFrom(opt, `${WEB}/form`)).filter(e => e.kind === 'html'),
            l => l.length === 1 && l[0].value === ceHtml);
        assert.strictEqual(html.length, 1, `expected one html entry, found ${html.length}`);
        assert.strictEqual(html[0].value, ceHtml);
        assert.ok(ceHtml.includes('typed') && ceHtml.includes('and more'), `editor content ${ceHtml}`);
        assert.strictEqual(html[0].title, 'Form page');
        const ceText = await form.evaluate(() => document.getElementById('ce').innerText);
        assert.strictEqual(html[0].text, ceText, 'the saved text is not the editor\'s innerText');
        assert.ok(ceText.includes('and more\n') && ceText.includes('one\ntwo'), `editor text ${JSON.stringify(ceText)}`);
        const editorList = await openExt(ctx, 'list/list.html');
        await editorList.click(`#entries [data-id="${html[0].id}"] .row-main`);
        assert.strictEqual(await editorList.textContent('#detailText'), ceText, 'the list does not show the saved text');
        const editorPop = await openExt(ctx, 'popup/popup.html', 380);
        await editorPop.click(`#entries [data-id="${html[0].id}"] .row-main`);
        assert.strictEqual(await editorPop.textContent('#detailText'), ceText, 'the popup does not show the saved text');
        await editorList.close();
        await editorPop.close();
        step('a contentEditable editor is saved as html with the outermost host\'s innerHTML and its innerText as text (list items one line each), '
            + 'which the list and the popup show; input inside the nested <b> gives one entry, not two');

        // 4. shadow root, iframe, plus the srcdoc and about:blank frames (probe for match_origin_as_fallback)
        await form.locator('#shadowHost textarea').pressSequentially('in the shadow');
        await form.frameLocator('#child').locator('#f').pressSequentially('in the frame');
        await form.frameLocator('#sd').locator('#s').pressSequentially('in srcdoc');
        await form.evaluate(() => {
            const d = document.getElementById('blank').contentDocument;
            d.body.append(d.createElement('textarea'));
        });
        await form.frameLocator('#blank').locator('textarea').pressSequentially('in about:blank');
        const want = { [`${WEB}/form`]: 'in the shadow', [`${WEB}/frame`]: 'in the frame', 'about:srcdoc': 'in srcdoc', 'about:blank': 'in about:blank' };
        const framesOk = async () => {
            const all = await savedTexts(opt);
            return Object.entries(want).filter(([url, value]) => !all.some(e => e.url === url && e.value === value)).map(([url]) => url);
        };
        assert.deepStrictEqual(await until(framesOk, l => l.length === 0), [], 'not saved from these frames');
        step('a textarea in an open shadow root and one in an iframe are saved; so are textareas in srcdoc and about:blank frames '
            + '(match_origin_as_fallback with <all_urls> accepted)');

        // 5. skip list
        await form.route('http://app.slack.com/**', r => r.fulfill({ contentType: 'text/html', body: FORM }));
        await form.goto('http://app.slack.com/client');
        await form.locator('#ta').pressSequentially('should not be saved');
        await form.locator('#ta').press('Tab');
        await sleep(1000);
        assert.deepStrictEqual((await savedTexts(opt)).filter(e => e.url.includes('slack.com')), [], 'a skipped page was saved');
        const skipUrl = `${WEB2}/form`;
        await form.goto(skipUrl);
        await form.locator('#ta').pressSequentially('before skip');
        assert.deepStrictEqual(await until(() => valuesFrom(opt, skipUrl), v => v.length === 1), ['before skip']);
        await opt.bringToFront();
        await opt.fill('#skip', [...DEFAULT_SKIP, `localhost:${port}`].join('\n'));
        await opt.click('#saveSkip');
        await until(() => storedSettings(opt), s => s.skip.includes(`localhost:${port}`));
        await form.bringToFront();
        await form.locator('#ta').pressSequentially(' and after');
        await form.locator('#ta').press('Tab');
        await sleep(1000);
        assert.deepStrictEqual(await valuesFrom(opt, skipUrl), ['before skip'], 'saving went on after the host was added to the skip list');
        await opt.fill('#skip', DEFAULT_SKIP.join('\n'));
        await opt.click('#saveSkip');
        await until(() => storedSettings(opt), s => s.skip.length === DEFAULT_SKIP.length);
        step('a page on the skip list (app.slack.com) saves nothing; adding localhost:<port> in the options stops saving in the open page without a reload');

        // plain http on a host that is not localhost is not a secure context, and crypto.randomUUID does not exist there
        const plainUrl = 'http://notes.example.test/compose';
        await form.route('http://notes.example.test/**', r => r.fulfill({ contentType: 'text/html', body: FORM }));
        await form.goto(plainUrl);
        assert.deepStrictEqual(await form.evaluate(() => [window.isSecureContext, typeof crypto.randomUUID]), [false, 'undefined']);
        await form.locator('#ta').pressSequentially('typed on plain http');
        assert.deepStrictEqual(await until(() => valuesFrom(opt, plainUrl), v => v.length === 1), ['typed on plain http'], 'not saved on a plain http page');
        step('on plain http://notes.example.test (not a secure context, no crypto.randomUUID in the page) a textarea is saved');

        // the playground (test/playground/index.html): twelve scenarios run by the page itself, checked against its table of expected results
        const pg = await playground(ctx, opt, `${WEB}/playground?autorun`, 1);
        assert.deepStrictEqual(pg.failures, [], `playground run ${pg.run}`);
        step(`playground run ${pg.run} with default settings: all twelve scenarios give the saved texts in the page's table of expected results`);

        // duplicate removal: the options switch and the clean-up preview, then the playground with it off
        await opt.bringToFront();
        await clearSaved(opt);
        await putSaved(opt, [
            entry('d0', 1, { value: 'same text' }),
            entry('d1', 2, { value: '  same text  ', url: 'http://other.test/' }),
            entry('d2', 3, { kind: 'html', value: '<p>same <b>text</b></p>', text: 'same text' }),
            entry('d3', 4, { value: 'same text and more' }),
        ]);
        const cleanupPreview = want => until(() => opt.textContent('#cleanupPreview'), t => t === want);
        const settled = test => until(() => storedSettings(opt), test);
        assert.strictEqual(await cleanupPreview(msg('options_preview_some', '2', '4')), msg('options_preview_some', '2', '4'),
            'preview with duplicate removal on');
        await opt.setChecked('#dedupe', false);
        assert.strictEqual((await settled(s => s.dedupe === false)).dedupe, false, 'switching duplicate removal off was not saved');
        assert.strictEqual(await cleanupPreview(msg('options_preview_none', '4')), msg('options_preview_none', '4'), 'preview with duplicate removal off');
        await opt.setChecked('#autoClean', false);
        await settled(s => s.autoClean === false);
        assert.strictEqual(await cleanupPreview(msg('options_preview_off')), msg('options_preview_off'), 'preview with both off');
        await opt.setChecked('#dedupe', true);
        await settled(s => s.dedupe === true);
        assert.strictEqual(await cleanupPreview(msg('options_preview_some', '2', '4')), msg('options_preview_some', '2', '4'), 'preview with only dedupe on');
        await opt.setChecked('#autoClean', true);
        await opt.setChecked('#dedupe', false);
        await settled(s => s.autoClean === true && s.dedupe === false);
        const pgOff = await playground(ctx, opt, `${WEB}/playground?autorun&dedupe=off`, 2);
        assert.deepStrictEqual(pgOff.failures, [], `playground run ${pgOff.run} with duplicate removal off`);
        await opt.setChecked('#dedupe', true);
        await settled(s => s.dedupe === true);
        await clearSaved(opt);
        step(`options: "remove older copies" is on by default; with 4 saved texts of which 2 repeat a newer one the preview says 2 of 4, off it says `
            + `none, with clean-up off too it says off, with only it on 2 of 4; playground run ${pgOff.run} with it off keeps both copies of scenario 8`);

        // 6. size limit
        await opt.bringToFront();
        await setField(opt, 'maxItemKb', '1');
        await until(() => storedSettings(opt), s => s.maxItemKb === 1);
        const sizeUrl = `${WEB}/form?size`;
        await form.goto(sizeUrl);
        await form.bringToFront();
        const tabs = await opt.evaluate(async () => ({
            own: (await chrome.tabs.getCurrent()).id,
            active: (await chrome.tabs.query({ active: true })).map(t => t.id),
        }));
        assert.strictEqual(tabs.active.length, 1, `expected one active tab, found ${tabs.active.length}`);
        const formTab = tabs.active[0];
        assert.notStrictEqual(formTab, tabs.own);
        const badge = tabId => opt.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId);
        const ta = form.locator('#ta');
        await ta.fill('short version');
        assert.deepStrictEqual(await until(() => valuesFrom(opt, sizeUrl), v => v.length === 1), ['short version']);
        await ta.fill('long '.repeat(300));
        await sleep(1000);
        assert.deepStrictEqual(await valuesFrom(opt, sizeUrl), ['short version'], 'a text over 1 KB replaced the last version that fitted');
        assert.strictEqual(await until(() => badge(formTab), v => v === 'MAX'), 'MAX', 'no MAX badge on the form tab');
        assert.strictEqual(await badge(tabs.own), '', 'the badge is not limited to the form tab');
        assert.strictEqual(await opt.evaluate(id => chrome.action.getTitle({ tabId: id }), formTab), msg('badge_too_large', '2 KB', '1 KB'));
        await ta.fill('shrunk again');
        assert.deepStrictEqual(await until(() => valuesFrom(opt, sizeUrl), v => v[0] === 'shrunk again'), ['shrunk again'], 'the shrunk text was not saved');
        assert.strictEqual(await until(() => badge(formTab), v => v === ''), '', 'the MAX badge was not cleared');
        await setField(opt, 'maxItemKb', '1024');
        await until(() => storedSettings(opt), s => s.maxItemKb === 1024);
        step('size limit 1 KB: a 1500 byte text is not saved, the earlier version stays, the tab shows MAX; shrinking it saves and clears the badge');
        await form.close();

        // 9. hostile data, plus htmlToText and snippet() on html entries. First alone: rich text with a saved `text` is never parsed as HTML.
        const PAYLOAD = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;
        const RICH_TEXT = 'Rich text\nas the editor showed it';
        await clearSaved(opt);
        await putSaved(opt, [entry('hostile-rich', 0.5, {
            title: 'Rich with text', kind: 'html', text: RICH_TEXT,
            value: `<p onclick="window.__pwned=1">Rich</p>${PAYLOAD}<svg onload="window.__pwned=1"></svg>`,
        })]);
        const cspBefore = excluded.get(CSP_REPORT) || 0;
        const list = await openExt(ctx, 'list/list.html');
        await list.click('#entries [data-id="hostile-rich"] .row-main');
        assert.strictEqual(await list.textContent('#detailText'), RICH_TEXT);
        const richPop = await openExt(ctx, 'popup/popup.html', 380);
        await richPop.click('#entries [data-id="hostile-rich"] .row-main');
        assert.strictEqual(await richPop.textContent('#detailText'), RICH_TEXT);
        await sleep(500);
        assert.strictEqual(excluded.get(CSP_REPORT) || 0, cspBefore, 'an entry with a saved text was parsed as HTML');
        await richPop.close();
        const hostile = [
            entry('hostile-html', 1, {
                url: `https://evil.test/?q=${PAYLOAD}`, title: `Title ${PAYLOAD}`, kind: 'html',
                value: `<p>Rich <b>bold</b></p>${PAYLOAD}<img src="${WEB}/leak/img"><meta http-equiv="refresh" content="0;url=${WEB}/leak/refresh">`
                    + `<div style="background:url(${WEB}/leak/css)">styled</div><p>Second<br>line</p>`,
            }),
            entry('hostile-text', 2, { url: `javascript:window.__pwned=1//${PAYLOAD}`, title: '', value: `Value ${PAYLOAD}` }),
        ];
        await putSaved(opt, hostile);
        await list.waitForSelector('#entries [data-id="hostile-html"]');
        const rowText = id => list.textContent(`#entries [data-id="${id}"]`);
        assert.ok((await rowText('hostile-html')).includes(`Title ${PAYLOAD}`), 'the title is not shown as text');
        assert.ok((await rowText('hostile-html')).includes('Rich bold styled Second line'), `html snippet: ${await rowText('hostile-html')}`);
        assert.ok((await rowText('hostile-text')).includes(`Value ${PAYLOAD}`), 'the text value is not shown as text');
        assert.strictEqual(await list.locator('#entries img, #entries script').count(), 0, 'markup from storage became elements in the list');
        await list.click('#entries [data-id="hostile-html"] .row-main');
        assert.strictEqual(await list.textContent('#detailTitle'), `Title ${PAYLOAD}`);
        assert.strictEqual(await list.textContent('#detailAddress'), `https://evil.test/?q=${PAYLOAD}`);
        assert.strictEqual(await list.textContent('#detailText'), 'Rich bold\n\nstyled\n\nSecond\nline', 'htmlToText of the html entry');
        assert.strictEqual(await list.locator('#detail img, #detail script').count(), 0);
        await list.click('#formattingToggle');
        const frame = list.locator('#detailFrame');
        assert.strictEqual(await frame.getAttribute('sandbox'), '', 'the preview iframe is not sandbox=""');
        assert.ok((await frame.getAttribute('srcdoc')).startsWith(
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">'),
        'the preview does not start with the CSP meta tag');
        assert.strictEqual(await list.isVisible('#detailText'), false);
        await sleep(1500); // time for any image, refresh or handler in the preview to fire
        const previewFrame = list.frames().find(f => f.parentFrame() && f.name() === '' && f.url() === 'about:srcdoc');
        assert.ok(previewFrame, `no preview frame at about:srcdoc: ${list.frames().map(f => f.url()).join(', ')}`);
        assert.strictEqual(await previewFrame.evaluate(() => window.__pwned), undefined, 'the preview ran the payload');
        assert.ok((await previewFrame.textContent('body')).includes('Rich bold'), 'the preview does not show the saved HTML');
        await list.click('#entries [data-id="hostile-text"] .row-main');
        assert.strictEqual(await list.textContent('#detailText'), `Value ${PAYLOAD}`);
        assert.strictEqual(await list.locator('#detailAddress a').count(), 0, 'a javascript: address became a link');
        const pop = await openExt(ctx, 'popup/popup.html', 380);
        await pop.waitForSelector('#entries [data-id="hostile-html"]');
        assert.ok((await pop.textContent('#entries [data-id="hostile-html"]')).includes(`Title ${PAYLOAD}`));
        assert.ok((await pop.textContent('#entries [data-id="hostile-html"]')).includes('Rich bold styled Second line'));
        assert.ok((await pop.textContent('#entries [data-id="hostile-text"]')).includes(`Value ${PAYLOAD}`));
        assert.strictEqual(await pop.locator('#entries img, #entries script').count(), 0);
        await pop.click('#entries [data-id="hostile-html"] .row-main');
        assert.strictEqual(await pop.textContent('#detailText'), 'Rich bold\n\nstyled\n\nSecond\nline');
        await sleep(500);
        for (const p of [list, pop]) {
            assert.strictEqual(await p.evaluate(() => window.__pwned), undefined, `${p.url()} ran the payload`);
        }
        assert.deepStrictEqual(hits.filter(h => h.startsWith('/leak')), [], 'saved HTML made the browser fetch from the network');
        step('hostile data: url, title and value with <img onerror> and <script> show as text in list and popup, window.__pwned stays unset, '
            + 'the preview is <iframe sandbox=""> with the CSP meta first, 0 requests reached /leak; an html entry with a saved text shows it and '
            + 'causes no CSP report; for one without, htmlToText and snippet() give the plain text');
        await pop.close();

        // 10. list page
        const fruit = ['apple pie', 'banana bread', 'cherry cake', 'banana split', 'date loaf', 'elder tea'];
        await clearSaved(opt);
        await putSaved(opt, fruit.map((v, i) => entry(`f${i}`, i + 1, { value: v, title: `Recipe ${i}` })));
        await list.reload();
        await list.waitForSelector('#entries [data-id="f0"]');
        const rowIds = () => list.$$eval('#entries [data-id]', rows => rows.map(r => r.dataset.id));
        assert.deepStrictEqual(await rowIds(), ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'], 'rows not newest first');
        await list.fill('#search', 'banana');
        assert.deepStrictEqual(await rowIds(), ['f1', 'f3'], 'search did not filter');
        assert.strictEqual(await list.textContent('#count'), msg('list_count_filtered', '2', '6'));
        await list.fill('#search', '');
        assert.strictEqual((await rowIds()).length, 6);
        await list.check('#entries [data-id="f2"] input[type=checkbox]');
        await list.check('#entries [data-id="f4"] input[type=checkbox]');
        await list.click('#deleteSelected');
        assert.ok(await list.isVisible('#confirm'), 'delete selected did not ask');
        assert.strictEqual(await list.textContent('#confirmText'), msg('confirm_delete_selected', '2'));
        await list.click('#confirmOk');
        assert.deepStrictEqual((await until(async () => (await savedTexts(opt)).map(e => e.id).sort(), l => l.length === 4)),
            ['f0', 'f1', 'f3', 'f5'], 'delete selected did not delete exactly the selection');
        assert.deepStrictEqual(await until(rowIds, l => l.length === 4), ['f0', 'f1', 'f3', 'f5']);
        const settingsBefore = await storedSettings(opt);
        await list.click('#deleteAll');
        assert.ok(await list.isVisible('#confirm'), 'delete all did not ask');
        assert.strictEqual(await list.textContent('#confirmText'), msg('confirm_delete_all', '4'));
        await list.click('#confirmCancel');
        await sleep(300);
        assert.strictEqual((await savedTexts(opt)).length, 4, 'cancel deleted something');
        await list.click('#deleteAll');
        await list.click('#confirmOk');
        assert.strictEqual((await until(() => savedTexts(opt), l => l.length === 0)).length, 0, 'delete all left saved texts');
        assert.deepStrictEqual(await storedSettings(opt), settingsBefore, 'delete all changed the settings');
        assert.ok(await until(() => list.isVisible('#empty'), v => v), 'no empty state after delete all');
        step('list page: search "banana" shows 2 of 6; delete selected (2) asks and deletes exactly those; delete all asks with the count, '
            + 'cancel keeps everything, OK deletes all saved texts and leaves the settings');

        // list detail pane: an open formatted preview is left alone by saves of other texts and follows changes of its own entry
        const r0 = entry('r0', 2, { kind: 'html', title: 'Preview', value: '<p>first version</p>', text: 'first version' });
        await putSaved(opt, [r0]);
        await list.click('#entries [data-id="r0"] .row-main');
        await list.click('#formattingToggle');
        const preview = () => list.frames().find(f => f.parentFrame() && f.url() === 'about:srcdoc');
        const previewText = async () => {
            try {
                return await preview().textContent('body');
            } catch {
                return '';
            }
        };
        assert.ok((await until(previewText, t => t.includes('first version'))).includes('first version'), 'the preview does not show the entry');
        await preview().evaluate(() => { window.__mark = 'kept'; });
        await list.evaluate(() => { window.__frameElement = document.querySelector('#detailFrame'); });
        await putSaved(opt, [entry('r1', 1, { value: 'saved elsewhere' })]);
        await list.waitForSelector('#entries [data-id="r1"]');
        await sleep(500);
        assert.strictEqual(await list.evaluate(() => document.querySelector('#detailFrame') === window.__frameElement), true,
            'the preview iframe was replaced');
        assert.strictEqual(await preview().evaluate(() => window.__mark), 'kept', 'a save of another text reloaded the preview');
        assert.strictEqual(await list.isChecked('#showFormatting'), true);
        await putSaved(opt, [{ ...r0, value: '<p>second version</p>', text: 'second version', modified: r0.modified + 1000 }]);
        assert.ok((await until(previewText, t => t.includes('second version'))).includes('second version'), 'the preview did not follow its entry');
        assert.strictEqual(await preview().evaluate(() => window.__mark), undefined);
        await opt.evaluate(() => chrome.storage.local.remove('t:r0'));
        assert.ok(await until(() => list.isVisible('#detailNone'), v => v), 'the detail pane still shows a deleted entry');
        step('list detail pane: with a formatted preview open, saving another text keeps the same iframe element and its document; '
            + 'a change of the open entry updates the preview, its deletion empties the pane');

        // an entry with a broken modified and no created: listed last, without a time, in the list and the popup
        await putSaved(opt, [{
            id: 'nodate', url: 'http://example.test/page', title: 'No date', kind: 'text', value: 'when?', modified: 'yesterday', created: null,
        }]);
        await list.waitForSelector('#entries [data-id="nodate"]');
        assert.deepStrictEqual(await list.$$eval('#entries [data-id]', rows => rows.map(r => r.dataset.id)), ['r1', 'nodate'], 'not sorted last in the list');
        assert.strictEqual(await list.textContent('#entries [data-id="nodate"] .row-time'), '');
        assert.strictEqual(await list.locator('.day-heading').last().textContent(), msg('day_unknown'));
        await list.click('#entries [data-id="nodate"] .row-main');
        assert.strictEqual(await list.textContent('#detailMeta'), msg('list_detail_meta', msg('time_unknown'), msg('time_unknown'), '5', '5 B'));
        const datelessPop = await openExt(ctx, 'popup/popup.html', 380);
        await datelessPop.waitForSelector('#entries [data-id="nodate"]');
        assert.deepStrictEqual(await datelessPop.$$eval('#entries [data-id]', rows => rows.map(r => r.dataset.id)), ['r1', 'nodate'],
            'not sorted last in the popup');
        assert.strictEqual(await datelessPop.textContent('#entries [data-id="nodate"] .row-time'), '');
        await datelessPop.click('#entries [data-id="nodate"] .row-main');
        assert.strictEqual(await datelessPop.textContent('#detailMeta'), msg('popup_detail_meta', 'example.test', msg('time_unknown')));
        await datelessPop.close();
        assert.deepStrictEqual(errors, [], 'errors while showing an entry without a valid time');
        step('an entry with modified "yesterday" and created null is listed last without a time (list under "No date"), its detail says "unknown" '
            + 'in the list and the popup, and nothing throws');

        // 11. the real action popup, opened on a web tab through CDP Extensions.triggerAction, which grants activeTab like a click on the icon
        await clearSaved(opt);
        const popupEntries = [
            entry('p0', 1, { url: `${WEB}/a`, title: 'Here newest', value: 'copy me please' }),
            entry('p1', 2, { url: `${WEB2}/b`, title: 'Elsewhere', value: 'other site' }),
            entry('p2', 3, { url: `${WEB}/c`, title: 'Here older', value: 'here too' }),
            entry('p3', 4, { url: 'https://far.test/', title: 'Far away', value: 'far' }),
        ];
        await putSaved(opt, popupEntries);
        const site = await ctx.newPage();
        await site.goto(`${WEB}/form?site`);
        await site.bringToFront();
        const extra = await cdp(profile);
        const tabTarget = (await extra.session.send('Target.getTargets', { filter: [{ type: 'tab' }] }))
            .targetInfos.find(t => t.url === `${WEB}/form?site`);
        assert.ok(tabTarget, 'no tab target for the web page');
        await extra.session.send('Extensions.triggerAction', { id: EXT_ID, targetId: tabTarget.targetId });
        // a connection made before the popup opened does not list it as a page, so wait for its target and connect again
        await until(async () => (await extra.session.send('Target.getTargets')).targetInfos.some(t => t.url === extUrl('popup/popup.html')), v => v);
        const viewer = (await cdp(profile)).browser;
        const popupPage = viewer.contexts().flatMap(c => c.pages()).find(p => p.url() === extUrl('popup/popup.html'));
        assert.ok(popupPage, 'the action popup did not open');
        watchPage(popupPage);
        await popupPage.waitForSelector('#entries [data-id="p0"]');
        const popIds = () => popupPage.$$eval('#entries [data-id]', rows => rows.map(r => r.dataset.id));
        assert.deepStrictEqual(await popIds(), ['p0', 'p1', 'p2', 'p3'], 'popup rows are not newest first');
        const popSize = await popupPage.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.strictEqual(popSize.width, 480, `popup width ${popSize.width}`);
        assert.ok(popSize.scroll <= popSize.width, `popup scrolls sideways: ${popSize.scroll}`);
        assert.strictEqual(await popupPage.textContent('#siteHost'), `127.0.0.1:${port}`);
        assert.strictEqual(await popupPage.isDisabled('#thisSite'), false);
        await popupPage.check('#thisSite');
        assert.deepStrictEqual(await popIds(), ['p0', 'p2'], '"this site" did not filter');
        await popupPage.click('#entries [data-id="p0"] .row-main');
        assert.strictEqual(await popupPage.textContent('#detailText'), 'copy me please');
        await popupPage.click('#copy');
        assert.strictEqual(await until(() => popupPage.textContent('#status'), s => s !== ''), msg('status_copied'));
        assert.strictEqual(await popupPage.evaluate(() => navigator.clipboard.readText()), 'copy me please', 'clipboard does not hold the text');
        await popupPage.click('#delete');
        assert.deepStrictEqual(await until(async () => (await savedTexts(opt)).map(e => e.id).sort(), l => l.length === 3), ['p1', 'p2', 'p3']);
        assert.deepStrictEqual(await until(popIds, l => l.length === 1), ['p2'], 'the deleted text is still listed');
        step('popup (real action popup, 480 px, no sideways scroll): lists newest first; "this site" (127.0.0.1:<port>) filters to 2 of 4; '
            + 'Copy puts the text on the clipboard; Delete removes it from storage and the list');
        await site.close();

        // popup under load: the real action popup opened ten times in a row, the 5th to 7th while a page saves a text every 100 ms
        await clearSaved(opt);
        await putSaved(opt, Array.from({ length: 30 }, (_, i) => entry(`load${String(i).padStart(2, '0')}`, i + 1, { value: `seeded text ${i}` })));
        const loadUrl = `${WEB}/form?load`;
        const loadPage = await ctx.newPage();
        await loadPage.goto(loadUrl);
        await loadPage.bringToFront();
        const driver = (await cdp(profile)).session;
        const loadTab = (await driver.send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos.find(t => t.url === loadUrl);
        assert.ok(loadTab, 'no tab target for the saving page');
        const popupOpen = async () => (await driver.send('Target.getTargets')).targetInfos.some(t => t.url === extUrl('popup/popup.html'));
        const startSaving = () => loadPage.evaluate(() => {
            const area = document.getElementById('ta');
            let n = 0;
            window.__saver = setInterval(() => {
                area.value = `saving under load ${++n}`;
                area.dispatchEvent(new InputEvent('input', { bubbles: true }));
                area.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
            }, 100);
        });
        const stopSaving = () => loadPage.evaluate(() => clearInterval(window.__saver));
        // what #empty and the rows did from the moment of the call: any time #empty showed, and the fewest rows after the first ones appeared
        const RECORDER = () => {
            const seen = window.__seen = { emptyShown: false, rows: [] };
            const snap = () => {
                const empty = document.getElementById('empty');
                if (empty && !empty.hidden) seen.emptyShown = true;
                const rows = document.querySelectorAll('#entries [data-id]').length;
                if (seen.rows.at(-1) !== rows) seen.rows.push(rows);
            };
            new MutationObserver(snap).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
            snap();
        };
        const judge = (seen, what) => {
            assert.strictEqual(seen.emptyShown, false, `${what}: #empty showed`);
            const first = seen.rows.findIndex(n => n > 0);
            assert.ok(first >= 0, `${what}: no rows`);
            assert.ok(seen.rows.slice(first).every(n => n >= 30), `${what}: rows went from ${seen.rows.join(' -> ')}`);
        };
        const popupRows = [];
        for (let i = 1; i <= 10; i++) {
            if (i === 5) await startSaving();
            const errorsBefore = errors.length;
            await driver.send('Extensions.triggerAction', { id: EXT_ID, targetId: loadTab.targetId });
            assert.ok(await until(popupOpen, v => v), `open ${i}: no popup target`);
            const popup = (await cdp(profile)).browser.contexts().flatMap(c => c.pages()).find(p => p.url() === extUrl('popup/popup.html'));
            assert.ok(popup, `open ${i}: the action popup did not open`);
            watchPage(popup);
            await popup.evaluate(RECORDER);
            const rows = await until(() => popup.$$eval('#entries [data-id]', r => r.length), n => n >= 30);
            assert.ok(rows >= 30, `open ${i}: ${rows} rows`);
            await sleep(i >= 5 && i <= 7 ? 1500 : 300);
            assert.strictEqual(await popup.isVisible('#empty'), false, `open ${i}: #empty visible`);
            judge(await popup.evaluate(() => window.__seen), `popup open ${i}`);
            assert.deepStrictEqual(errors.slice(errorsBefore), [], `open ${i}: errors`);
            popupRows.push(rows);
            await popup.close();
            assert.strictEqual(await until(popupOpen, v => !v), false, `open ${i}: the popup did not close`);
            if (i === 7) await stopSaving();
        }
        // The same pages as tabs while the page saves. The popup is recorded from the start of its document through an init script; the list only
        // from its commit on, because Playwright runs init scripts in every frame, and the list's sandboxed preview frame logs an error for that.
        await startSaving();
        for (const page of ['popup/popup.html', 'list/list.html', 'popup/popup.html', 'list/list.html']) {
            const tab = await ctx.newPage();
            const isPopup = page.startsWith('popup');
            if (isPopup) await tab.addInitScript(RECORDER);
            await tab.goto(extUrl(page), { waitUntil: 'commit' });
            if (!isPopup) await tab.evaluate(RECORDER);
            await until(() => tab.$$eval('#entries [data-id]', r => r.length), n => n >= 30);
            await sleep(1000);
            const seen = await tab.evaluate(() => window.__seen);
            if (isPopup) assert.strictEqual(seen.rows[0], 0, `${page}: the recorder did not start before the first read (${seen.rows[0]} rows)`);
            judge(seen, `${page} as a tab`);
            await tab.close();
        }
        // an open list keeps refreshing while the page saves continuously
        const liveList = await openExt(ctx, 'list/list.html');
        await liveList.waitForSelector('#entries [data-id="load00"]');
        await sleep(500);
        await putSaved(opt, [entry('fresh', 0, { value: 'saved while another page saves' })]);
        const shownAfter = Date.now();
        await until(() => liveList.$$eval('#entries [data-id="fresh"]', r => r.length), n => n === 1, 2000);
        const freshMs = Date.now() - shownAfter;
        assert.strictEqual(await liveList.locator('#entries [data-id="fresh"]').count(), 1, 'the open list did not show a new entry within 2 s');
        await liveList.close();
        await opt.evaluate(() => chrome.storage.local.remove('t:fresh'));
        await stopSaving();
        await loadPage.close();
        step(`popup under load: the real action popup opened 10 times with 30 saved texts (5th to 7th while a page saved every 100 ms) showed `
            + `${popupRows.join(', ')} rows, #empty never shown, no error; popup (recorded from document start) and list as tabs while saving: `
            + `#empty never shown, never fewer than 30 rows once rows appeared; an open list showed a new entry after ${freshMs} ms while the page saved`);

        // order: newest modified first (ties: later created, then id), the same on every opening when nothing was saved in between
        const tied = Date.now() - 90 * 60000;
        await putSaved(opt, ['tie-c', 'tie-a', 'tie-b'].map(id => ({ ...entry(id, 0, { value: `tied ${id}` }), created: tied, modified: tied })));
        const time = v => (Number.isFinite(v) ? v : 0);
        const expectedOrder = (await savedTexts(opt))
            .sort((a, b) => time(b.modified) - time(a.modified) || time(b.created) - time(a.created) || (a.id < b.id ? -1 : 1)).map(e => e.id);
        const idsOn = async page => {
            const tab = await openExt(ctx, page, page.startsWith('popup') ? 380 : 1280);
            await until(() => tab.$$eval('#entries [data-id]', r => r.length), n => n === expectedOrder.length);
            const ids = await tab.$$eval('#entries [data-id]', r => r.map(row => row.dataset.id));
            await tab.close();
            return ids;
        };
        for (const page of ['popup/popup.html', 'list/list.html']) {
            const first = await idsOn(page);
            assert.deepStrictEqual(first, expectedOrder, `${page}: not newest modified first`);
            assert.deepStrictEqual(await idsOn(page), first, `${page}: the order changed between two openings without a save`);
        }
        await clearSaved(opt);
        step(`order: popup and list show the ${expectedOrder.length} saved texts newest modified first (three with equal times by id), `
            + 'and the same order when opened a second time');

        // a first read that fails shows a lasting error where the list would be, and logs it. Playwright runs the init script in every frame; for the
        // list's sandboxed preview frame Chrome may log that it blocked it, the test's own doing and the only other message accepted here.
        for (const page of ['popup/popup.html', 'list/list.html']) {
            const before = errors.length;
            const tab = await ctx.newPage();
            await tab.addInitScript(() => {
                // the preview frame has no chrome.storage
                if (globalThis.chrome?.storage) chrome.storage.local.get = () => Promise.reject(new Error('forced read failure'));
            });
            await tab.goto(extUrl(page));
            await tab.waitForSelector('#loadError:not([hidden])');
            assert.strictEqual(await tab.textContent('#loadError'), msg('load_failed', 'forced read failure'));
            assert.strictEqual(await tab.isVisible('#empty'), false, `${page}: #empty shown after a failed read`);
            assert.strictEqual(await tab.locator('#entries [data-id]').count(), 0);
            await sleep(300);
            const logged = errors.splice(before);
            assert.ok(logged.some(e => e.includes('console error TextCache:') && e.includes('forced read failure')), `${page}: not logged: ${logged}`);
            const sandboxNoise = e => page === 'list/list.html' && e.includes("Blocked script execution in 'about:blank'");
            assert.deepStrictEqual(logged.filter(e => !e.includes('forced read failure') && !sandboxNoise(e)), [], `${page}: other errors`);
            await tab.close();
        }
        step('a failing first read (chrome.storage.local.get rejected) shows "The saved texts could not be loaded: <error>" in the popup and the '
            + 'list instead of an empty or blank list, and logs the error');

        // 13. layout and screenshots
        await clearSaved(opt);
        const sample = [
            entry('s0', 3, { url: 'https://mail.example.com/compose', title: 'Compose message', value: 'Hi Ana,\n\nthanks for the notes from Monday. '
                + 'I went through the draft and left comments on the second section.\n\nBest,\nJ.' }),
            entry('s1', 50, { url: 'https://forum.example.org/t/42', title: 'Reply to: printer settings', kind: 'html',
                value: '<p>Try a <b>0.2 mm</b> layer height first.</p><ul><li>slower outer walls</li><li>less retraction</li></ul>' }),
            entry('s2', 200, { url: 'https://docs.example.net/form', title: '', value: 'A longer text without a title, so the host is shown instead. '
                .repeat(4) }),
            entry('s3', 60 * 26, { url: 'https://shop.example.com/review', title: 'Write a review', value: 'Works well, arrived early.' }),
            entry('s4', 60 * 24 * 5, { url: 'about:blank', title: '', value: 'From an empty frame' }),
        ];
        await putSaved(opt, sample);
        fs.mkdirSync(SHOTS, { recursive: true });
        const shots = [];
        const shoot = async (page, name, width, scheme) => {
            await page.emulateMedia({ colorScheme: scheme });
            await page.setViewportSize({ width, height: page.viewportSize().height });
            await sleep(200);
            const { scroll, client } = await noHorizontalScroll(page);
            assert.ok(scroll <= client, `${name} scrolls sideways at ${width} px ${scheme}: content ${scroll} px, window ${client} px`);
            const file = path.join(SHOTS, `${name}-${scheme}.png`);
            await page.screenshot({ path: file, fullPage: true });
            shots.push(path.relative(process.cwd(), file));
        };
        await opt.reload();
        await optionsReady(opt);
        await list.reload();
        await list.waitForSelector('#entries [data-id="s1"]');
        await list.click('#entries [data-id="s1"] .row-main');
        const popTab = await openExt(ctx, 'popup/popup.html', 380);
        await popTab.setViewportSize({ width: 380, height: 560 });
        await popTab.waitForSelector('#entries [data-id="s0"]');
        for (const scheme of ['light', 'dark']) {
            for (const width of [1280, 400]) {
                await shoot(opt, `options-${width}`, width, scheme);
                await shoot(list, `list-${width}`, width, scheme);
            }
            await popTab.evaluate(() => document.querySelector('#back').click());
            await shoot(popTab, 'popup-list', 480, scheme);
            await popTab.click('#entries [data-id="s1"] .row-main');
            await shoot(popTab, 'popup-detail', 480, scheme);
        }
        step(`options and list at 1280 and 400 px and the popup at 480 px have no horizontal scrollbar, light and dark; screenshots ${shots.join(', ')}`);

        // the popup width chosen on the options page is the width of the popup's body, which is what sizes the real popup
        const bodyWidth = () => popTab.evaluate(() => document.body.offsetWidth);
        assert.strictEqual(await opt.inputValue('#popupWidth'), 'normal');
        for (const [choice, px] of [['narrow', 380], ['wide', 640], ['normal', 480]]) {
            await opt.selectOption('#popupWidth', choice);
            assert.strictEqual(await until(bodyWidth, w => w === px), px, `popup body with "${choice}"`);
            assert.strictEqual((await storedSettings(opt)).popupWidth, choice);
        }
        step('popup width: "narrow", "wide" and "normal" chosen on the options page are saved and give an open popup page a body of 380, 640 '
            + 'and 480 px');

        // language: "auto" is English in this browser; a chosen language rebuilds the open options, list and popup pages in it
        const ui = await opt.evaluate(() => chrome.i18n.getUILanguage());
        assert.match(ui, /^en\b/, 'the test browser does not run in English');
        await popTab.evaluate(() => document.querySelector('#back').click());
        await opt.setViewportSize({ width: 1280, height: 900 });
        await list.setViewportSize({ width: 1280, height: 900 });
        // a page's language and direction, polled through the reload a language change causes
        const docLang = page => page.evaluate(() => `${document.documentElement.lang} ${document.documentElement.dir}`).catch(() => '');
        const textOf = (page, selector) => page.textContent(selector).catch(() => null);
        assert.strictEqual(await docLang(opt), 'en ltr');
        assert.strictEqual(await opt.inputValue('#language'), 'auto');
        const choices = await opt.$$eval('#language option', options => options.map(o => `${o.value}=${o.textContent}`));
        assert.deepStrictEqual(choices, [`auto=${msg('options_language_auto', 'English')}`, 'en=English', 'cs=Čeština / Czech', 'de=Deutsch / German',
            'es=Español / Spanish', 'fr=Français / French', 'pt_BR=Português (Brasil) / Portuguese (Brazil)', 'uk=Українська / Ukrainian',
            'zh_CN=简体中文 / Chinese (Simplified)', 'ja=日本語 / Japanese', 'hi=हिन्दी / Hindi', 'ar=العربية / Arabic']);
        const czech = (key, ...subs) => CZECH[key].message.replace(/\$(\d)/g, (_, n) => subs[n - 1]);
        await opt.selectOption('#language', 'cs');
        assert.strictEqual((await until(() => storedSettings(opt), s => s.language === 'cs')).language, 'cs', 'the language was not saved');
        for (const page of [opt, list, popTab]) assert.strictEqual(await until(() => docLang(page), v => v === 'cs ltr'), 'cs ltr', `${page.url()} lang`);
        await optionsReady(opt);
        assert.strictEqual(await opt.textContent('h1'), czech('options_title'));
        assert.strictEqual(await opt.inputValue('#language'), 'cs');
        assert.strictEqual(await opt.textContent('#keepNewest_desc'), czech('options_keepNewest_desc'));
        assert.strictEqual(await until(() => textOf(list, '#count'), v => v === czech('list_count', '5')), czech('list_count', '5'));
        assert.strictEqual(await list.textContent('.nav a[aria-current="page"]'), czech('nav_list'));
        assert.strictEqual(await until(() => textOf(popTab, '#openList'), v => v === czech('popup_open_list')), czech('popup_open_list'));
        await opt.selectOption('#language', 'ar');
        for (const page of [opt, list, popTab]) assert.strictEqual(await until(() => docLang(page), v => v === 'ar rtl'), 'ar rtl', `${page.url()} dir`);
        await optionsReady(opt);
        await list.waitForSelector('#entries [data-id="s1"]');
        await list.click('#entries [data-id="s1"] .row-main');
        for (const width of [1280, 400]) {
            await shoot(opt, `options-ar-${width}`, width, 'light');
            await shoot(list, `list-ar-${width}`, width, 'light');
        }
        await list.setViewportSize({ width: 1280, height: 900 });
        const rtlLayout = await list.evaluate(() => {
            const box = selector => document.querySelector(selector).getBoundingClientRect();
            return {
                columns: box('#detail').right <= box('.browser').left,
                rowCheck: box('#entries [data-id="s1"] .row-check').left > box('#entries [data-id="s1"] .row-main').left,
                textDir: document.querySelector('#detailText').dir,
            };
        });
        assert.deepStrictEqual(rtlLayout, { columns: true, rowCheck: true, textDir: 'auto' }, 'the list is not laid out right to left');
        await shoot(popTab, 'popup-ar', 480, 'light');
        await opt.selectOption('#language', 'auto');
        for (const page of [opt, list, popTab]) assert.strictEqual(await until(() => docLang(page), v => v === 'en ltr'), 'en ltr', `${page.url()} back`);
        await optionsReady(opt);
        assert.strictEqual(await opt.textContent('h1'), msg('options_title'));
        assert.strictEqual(await opt.inputValue('#language'), 'auto');
        assert.strictEqual(await until(() => textOf(list, '#count'), v => v === msg('list_count', '5')), msg('list_count', '5'));
        assert.strictEqual(await until(() => textOf(popTab, '#openList'), v => v === msg('popup_open_list')), msg('popup_open_list'));
        assert.strictEqual((await storedSettings(opt)).language, 'auto');
        await popTab.close();
        step(`language: browser language ${ui}; with "auto" options, list and popup are English (lang en, ltr) and the selector offers automatic `
            + '(English) and 11 languages by their own names; choosing cs saves it and turns the open options, list and popup Czech with lang cs; ar '
            + 'gives dir rtl, the list columns and rows mirrored, saved text dir auto, no horizontal scrollbar on options and list at 1280 and 400 px; '
            + '"auto" restores English');

        // 7. clean-up at browser start
        await clearSaved(opt);
        const base = Date.now() - 3600000;
        await putSaved(opt, Array.from({ length: 150 }, (_, i) => ({
            id: `c${String(i).padStart(3, '0')}`, url: 'http://old.test/', title: '', kind: 'text', value: `old ${i}`,
            created: base - i * 60000 - 1, modified: base - i * 60000,
        })));
        await opt.reload();
        await optionsReady(opt);
        await setField(opt, 'keepNewest', '5');
        await until(() => storedSettings(opt), s => s.keepNewest === 5);
        assert.strictEqual(await until(() => opt.textContent('#cleanupPreview'), t => t === msg('options_preview_some', '145', '150')),
            msg('options_preview_some', '145', '150'));
        assert.strictEqual((await savedTexts(opt)).length, 150, 'saved texts deleted before the restart');
        await ctx.close();
        ({ ctx, sw } = await launch(profile));
        opt = await openExt(ctx, 'options/options.html');
        const left = await until(async () => (await savedTexts(opt)).map(e => e.id).sort(), l => l.length === 5, 10000);
        assert.deepStrictEqual(left, ['c000', 'c001', 'c002', 'c003', 'c004'], 'clean-up did not keep exactly the 5 newest');
        step('clean-up: with 150 saved texts and keepNewest 5 the options preview said "deletes 145 of 150"; '
            + 'after a browser restart exactly the 5 newest are left');

        // 8. migration from 5.x at browser start
        await opt.evaluate(async () => {
            await chrome.storage.local.clear();
            await chrome.storage.local.set({
                version: '5.0.8.1',
                setting: { maxItemSize: 512, shouldAutoClear: false, autoClear_day: 90, autoClear_hour: 0, autoClear_min: 0, autoClear_keep: 42 },
                exceptions: ['example.org', 'slack.com'],
                '1700000000000 http://old.test/a 0.123': {
                    time: '1700000000000', last_modified: '1700000500000', type: 'txt', url: 'http://old.test/a', val: 'old plain text' },
                '1700001000000 http://old.test/b c 0.456': {
                    time: '1700001000000', type: 'WYSIWYG', url: 'http://old.test/b c', val: '<div>old <b>rich</b></div>' },
            });
        });
        await ctx.close();
        ({ ctx, sw } = await launch(profile));
        opt = await openExt(ctx, 'options/options.html');
        const migrated = await until(() => allItems(opt), items => items.settings?.schema === 2 && Object.keys(items).length === 3, 10000);
        assert.deepStrictEqual(Object.keys(migrated).filter(k => !k.startsWith('t:')), ['settings'], 'old keys left after migration');
        assert.deepStrictEqual(migrated.settings,
            { schema: 2, maxItemKb: 512, autoClean: false, keepNewest: 42, dedupe: true, skip: ['example.org', 'slack.com'], language: 'auto',
                popupWidth: 'normal' });
        const moved = Object.entries(migrated).filter(([k]) => k.startsWith('t:')).map(([k, v]) => {
            assert.strictEqual(k, `t:${v.id}`, 'key and id disagree');
            const { id, ...rest } = v;
            return rest;
        }).sort((a, b) => a.created - b.created);
        assert.deepStrictEqual(moved, [
            { url: 'http://old.test/a', title: '', kind: 'text', value: 'old plain text', created: 1700000000000, modified: 1700000500000 },
            { url: 'http://old.test/b c', title: '', kind: 'html', value: '<div>old <b>rich</b></div>', created: 1700001000000, modified: 1700001000000 },
        ]);
        step('migration: a profile with 5.x keys (setting, exceptions, version, two entries) has after a restart settings schema 2 '
            + '(512 KB, clean-up off, keep 42, two skip entries) and two t: entries with the right kind, times and value, and no old keys');

        // probe: what a content script sees and does after its extension goes away. chrome.runtime.reload() unloads the extension, and in this
        // Chromium an extension loaded with --load-extension does not come back, which leaves the page's content script orphaned (the case of
        // finding 5). Playwright does not report console messages from isolated worlds, so a raw CDP session on the page watches every context.
        const orphan = await ctx.newPage();
        await orphan.goto(`${WEB}/form?orphan`);
        await orphan.locator('#ta').pressSequentially('before the reload');
        assert.deepStrictEqual(await until(() => valuesFrom(opt, `${WEB}/form?orphan`), v => v.length === 1), ['before the reload']);
        const pageSession = await ctx.newCDPSession(orphan);
        const worlds = [];
        const problems = [];
        pageSession.on('Runtime.executionContextCreated', e => worlds.push(e.context));
        pageSession.on('Runtime.exceptionThrown', e => problems.push(`exception: ${e.exceptionDetails.exception?.description ?? e.exceptionDetails.text}`));
        pageSession.on('Runtime.consoleAPICalled', e => problems.push(`console.${e.type}: ${e.args.map(a => a.value ?? a.description).join(' ')}`));
        pageSession.on('Log.entryAdded', e => {
            if (e.entry.level === 'error' || e.entry.level === 'warning') problems.push(`log ${e.entry.level}: ${e.entry.text}`);
        });
        await pageSession.send('Runtime.enable');
        await pageSession.send('Log.enable');
        const world = await until(() => worlds.find(c => c.auxData?.type === 'isolated' && c.name === 'TextCache' && c.auxData.isDefault === false
            && c.auxData.frameId === worlds.find(m => m.auxData?.isDefault)?.auxData.frameId), c => c);
        assert.ok(world, `no isolated world of the extension in the page: ${JSON.stringify(worlds.map(c => c.name))}`);
        const seen = async () => (await pageSession.send('Runtime.evaluate', { expression: 'String(globalThis.chrome?.runtime?.id)', contextId: world.id }))
            .result.value;
        assert.strictEqual(await seen(), EXT_ID);
        // self-check: a message from the content script's world does reach `problems`
        await pageSession.send('Runtime.evaluate', { expression: 'console.warn("probe self-check")', contextId: world.id });
        assert.deepStrictEqual(await until(() => problems, l => l.length > 0), ['console.warning: probe self-check']);
        problems.length = 0;
        const reloaded = sw.evaluate(() => chrome.runtime.reload()).then(() => 'returned', e => `ended: ${e.message.split('\n')[0]}`);
        const idAfter = await until(seen, v => v !== EXT_ID);
        assert.strictEqual(idAfter, 'undefined', 'chrome.runtime.id in the orphaned content script');
        await orphan.bringToFront();
        await orphan.locator('#ta').pressSequentially(' typed after the reload');
        await orphan.locator('#ta').press('Tab');
        await orphan.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await sleep(1000);
        assert.deepStrictEqual(problems, [], 'the orphaned content script was not quiet');
        step(`probe: after chrome.runtime.reload() (${await reloaded}) the content script's world sees chrome.runtime.id ${idAfter}; typing, `
            + 'leaving the field and visibilitychange then give no exception, console message or log error in any world of the page');

        assert.deepStrictEqual(errors, [], 'unexpected errors');
        const noise = [...excluded].map(([why, n]) => `${n} x ${why}`).join('; ') || 'none';
        step(`no uncaught page errors and no unexpected console errors in pages and the service worker (documented noise excluded: ${noise})`);
        console.log(`${passed} steps passed`);
    } finally {
        await ctx.close();
        server.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch(e => {
    console.error(`not ok - ${e.stack || e}`);
    if (errors.length) console.error(`errors collected so far:\n${errors.join('\n')}`);
    process.exit(1);
});
