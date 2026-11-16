// Builds dist/textcache-<version>.zip from extension/: a folder textcache-<version>/ to unzip and load with "Load unpacked", plus INSTALL.txt.
// With --store it builds dist/textcache-<version>-store.zip for the Chrome Web Store instead: the files at the zip's root, and the manifest without
// its "key". The store gives the item its own ID either way; whether it accepts an upload with a key is not documented, so the key is left out.
// The version is the manifest's. Usage: node tools/pack.cjs [--store]  (prints the path of the zip)
// The zip is written here, without a dependency: stored file names are UTF-8, entries are deflated, and times are fixed, so the same tree always
// gives the same bytes.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const source = path.join(root, 'extension');
const { version } = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const folder = `textcache-${version}`;
const store = process.argv.includes('--store');

const INSTALL = [
    `TextCache ${version}`,
    '',
    'Install (Chrome, Brave, Edge and other Chromium browsers):',
    '1. Unzip this archive and keep the folder somewhere permanent; the browser loads the extension from it every time it starts.',
    '2. Open chrome://extensions and switch on "Developer mode".',
    `3. Press "Load unpacked" and pick the folder ${folder}.`,
    '',
    'Update: replace the contents of the folder with the new version and press the reload arrow on the extension\'s card.',
    'Your saved texts and settings stay, because the extension keeps its ID.',
    '',
].join('\r\n');

function filesUnder(dir, prefix = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap(entry => {
        const name = `${prefix}${entry.name}`;
        return entry.isDirectory() ? filesUnder(path.join(dir, entry.name), `${name}/`) : [{ name, data: fs.readFileSync(path.join(dir, entry.name)) }];
    });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(data) {
    let c = 0xffffffff;
    for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00, the earliest time a zip can hold
const DOS_TIME = 0;
const DOS_DATE = 0x21;

function zip(files) {
    const parts = [];
    const directory = [];
    let offset = 0;
    for (const { name, data } of files) {
        const nameBytes = Buffer.from(name, 'utf8');
        const packed = zlib.deflateRawSync(data, { level: 9 });
        // version needed 2.0, flag bit 11 (UTF-8 names), method 8 (deflate)
        const common = Buffer.alloc(26);
        common.writeUInt16LE(20, 0);
        common.writeUInt16LE(0x0800, 2);
        common.writeUInt16LE(8, 4);
        common.writeUInt16LE(DOS_TIME, 6);
        common.writeUInt16LE(DOS_DATE, 8);
        common.writeUInt32LE(crc32(data), 10);
        common.writeUInt32LE(packed.length, 14);
        common.writeUInt32LE(data.length, 18);
        common.writeUInt16LE(nameBytes.length, 22);

        const local = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), common, nameBytes, packed]);
        const central = Buffer.alloc(46);
        central.write('PK\x01\x02', 0, 'latin1');
        central.writeUInt16LE(20, 4);
        common.copy(central, 6);
        central.writeUInt32LE(offset, 42);
        directory.push(central, nameBytes);
        parts.push(local);
        offset += local.length;
    }
    const directoryBytes = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.write('PK\x05\x06', 0, 'latin1');
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directoryBytes.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, directoryBytes, end]);
}

// the store copy of the manifest is the same bytes without the line that holds the top-level key; the parsed result must equal the manifest minus
// its key and nothing else, so a nested "key" or a key written differently stops the build instead of shipping a changed manifest
function withoutKey(data) {
    const text = data.toString('utf8');
    const expected = JSON.parse(text);
    if (!('key' in expected)) throw new Error('manifest.json has no top-level "key" to drop for the store build');
    delete expected.key;
    const stripped = text.replace(/^ *"key": "[^"]*",\r\n/m, '');
    if (JSON.stringify(JSON.parse(stripped)) !== JSON.stringify(expected)) throw new Error('manifest.json: the "key" line could not be dropped cleanly');
    return Buffer.from(stripped, 'utf8');
}

const files = store
    ? filesUnder(source).map(f => (f.name === 'manifest.json' ? { ...f, data: withoutKey(f.data) } : f))
    : [...filesUnder(source), { name: 'INSTALL.txt', data: Buffer.from(INSTALL, 'utf8') }].map(f => ({ ...f, name: `${folder}/${f.name}` }));
const out = path.join(root, 'dist', `${folder}${store ? '-store' : ''}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zip(files));
console.log(out);
