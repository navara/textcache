// Renders the Chrome Web Store screenshots (1280 x 800 PNG) into store/screenshots/ from the real extension in a throw-away Chromium profile, with
// made-up saved texts. Usage: node store/shots.cjs   Needs the same Chromium as npm run test:e2e (CHROMIUM=<chrome.exe>, else Playwright's newest).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const EXT = path.resolve(__dirname, '..', 'extension');
const OUT = path.join(__dirname, 'screenshots');
const EXT_ID = 'lfpadkcnbbhojjmamnmnchjcefhmmnnp';
const SIZE = { width: 1280, height: 800 };

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

const minutes = n => Date.now() - n * 60000;
const SAVED = [
    { id: 'd1', url: 'https://forum.example.org/t/1873/reply', title: 'Reply to: Best layer height for PETG?', kind: 'text', created: minutes(14),
        modified: minutes(3), value: 'I had the same stringing problem. What fixed it for me was lowering the nozzle to 235 °C, raising retraction to '
            + '1.2 mm and drying the spool for four hours. Layer height mattered less than I expected: 0.2 mm looked fine.' },
    { id: 'd2', url: 'https://mail.example.com/compose', title: 'New message', kind: 'html', created: minutes(52), modified: minutes(41),
        value: '<p>Hi Ana,</p><p>thanks for the notes from Monday. I went through the draft and left comments on the <b>second section</b>; the '
            + 'budget table still needs the Q3 numbers.</p><p>Best,<br>Sam</p>',
        text: 'Hi Ana,\n\nthanks for the notes from Monday. I went through the draft and left comments on the second section; the budget table '
            + 'still needs the Q3 numbers.\n\nBest,\nSam' },
    { id: 'd3', url: 'https://support.example.net/tickets/new', title: 'Open a support ticket', kind: 'text', created: minutes(130),
        modified: minutes(126), value: 'Since the update on Friday the export button does nothing in Firefox and Chrome. Steps: open a report, '
            + 'press Export, choose CSV. Expected a download, got nothing; the console shows no error.' },
    { id: 'd4', url: 'https://shop.example.com/product/4471/review', title: 'Write a review', kind: 'text', created: minutes(1500),
        modified: minutes(1490), value: 'Solid kettle. Boils a full litre in about three minutes and the lid no longer drips like my old one. '
            + 'Four stars because the light is too bright at night.' },
    { id: 'd5', url: 'https://wiki.example.org/edit/Onboarding', title: 'Editing Onboarding', kind: 'text', created: minutes(4400),
        modified: minutes(4300), value: 'New starters get their laptop on day one. Accounts are created the Friday before; the buddy sends the '
            + 'welcome mail and books the first lunch.' },
];

(async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'textcache-shots-'));
    let ctx = null;
    try {
        ctx = await chromium.launchPersistentContext(profile, {
            executablePath: findChromium(),
            headless: true,
            args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--lang=en-US'],
            viewport: SIZE,
        });
        if (!ctx.serviceWorkers().some(w => w.url().startsWith(`chrome-extension://${EXT_ID}/`))) {
            await ctx.waitForEvent('serviceworker', w => w.url().startsWith(`chrome-extension://${EXT_ID}/`));
        }
        const page = await ctx.newPage();
        await page.goto(`chrome-extension://${EXT_ID}/options/options.html`);
        await page.evaluate(list => chrome.storage.local.set(Object.fromEntries(list.map(e => [`t:${e.id}`, e]))), SAVED);
        fs.mkdirSync(OUT, { recursive: true });
        const shoot = async (name, scheme) => {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(300);
            const file = path.join(OUT, `${name}.png`);
            await page.screenshot({ path: file });
            console.log(file);
        };

        await page.goto(`chrome-extension://${EXT_ID}/list/list.html`);
        await page.click('#entries [data-id="d1"] .row-main');
        await shoot('1-list', 'light');
        await page.click('#entries [data-id="d2"] .row-main');
        await shoot('2-list-dark', 'dark');
        await page.fill('#search', 'export');
        await page.click('#entries [data-id="d3"] .row-main');
        await shoot('3-search', 'light');

        await page.goto(`chrome-extension://${EXT_ID}/options/options.html`);
        await page.waitForFunction(() => document.querySelector('#cleanupPreview').textContent !== '');
        await shoot('4-settings', 'light');
    } finally {
        try {
            await ctx?.close();
        } finally {
            fs.rmSync(profile, { recursive: true, force: true });
        }
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
