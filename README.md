# TextCache

A Chrome extension that keeps a copy of what you type into text areas and rich-text editors, so you can get the text back after a page crashes or a form
is lost. Everything stays in your browser; nothing is sent anywhere.

Works in Chrome, Brave, Edge and other Chromium browsers. It is not in the Chrome Web Store.

## Install

1. Download `textcache-<version>.zip` from the [latest release](https://github.com/navara/textcache/releases/latest) and unzip it somewhere permanent.
2. Open `chrome://extensions` and switch on "Developer mode".
3. Press "Load unpacked" and pick the unzipped `textcache-<version>` folder.

To update, replace the folder's contents with the new version and press the reload arrow on the extension's card. Saved texts and settings stay.

## Development

```bash
npm install
npm test
npm run test:e2e
npm run pack
```

`npm run test:e2e` needs a full Chromium (Playwright's, or `CHROMIUM=<path to chrome.exe>`).
Pushing a tag `v<version>` that matches `extension/manifest.json` publishes a release with the zip.

## Credits and license

The idea comes from [Textarea Cache](https://github.com/wildskyf/TextareaCache) by wildskyf; TextCache is a rewrite and contains none of its code.

TextCache is free software under the GNU General Public License, version 3 or later; see [LICENSE](LICENSE).
