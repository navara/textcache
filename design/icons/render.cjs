// Renders an SVG icon to the PNG sizes the manifest needs: node design/icons/render.cjs <icon.svg> <output dir>
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const [svgPath, outDir] = process.argv.slice(2);
const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
const exe = process.env.CHROMIUM || fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d))
    .sort((a, b) => parseInt(b.slice(9)) - parseInt(a.slice(9)))
    .map(d => path.join(root, d, 'chrome-win64', 'chrome.exe')).find(p => fs.existsSync(p));

(async () => {
    const svg = fs.readFileSync(svgPath, 'utf8');
    const browser = await chromium.launch({ executablePath: exe });
    const page = await browser.newPage();
    for (const size of [16, 32, 48, 128]) {
        await page.setViewportSize({ width: size, height: size });
        await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
        const out = path.join(outDir, `icon-${size}.png`);
        await page.screenshot({ path: out, omitBackground: true });
        console.log(out);
    }
    await browser.close();
})();
