import { locale } from './i18n.js';

// Rounded up, so that a size over a limit never reads as equal to it.
export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.ceil(n / 1024)} KB`;
    return `${Math.ceil(n / (1024 * 1024) * 10) / 10} MB`;
}

const formatters = new Map();

// An Intl formatter for the language shown, made on first use: the language is known only once i18n init() has run.
export function formatter(Kind, options) {
    const key = `${Kind.name} ${locale()} ${JSON.stringify(options)}`;
    if (!formatters.has(key)) formatters.set(key, new Kind(locale(), options));
    return formatters.get(key);
}

export function formatNumber(n) {
    return formatter(Intl.NumberFormat).format(n);
}

// what toLocaleString() shows
const TIME = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' };

export function formatTime(ms) {
    return Number.isFinite(ms) ? formatter(Intl.DateTimeFormat, TIME).format(ms) : '';
}

export function formatClock(ms) {
    return Number.isFinite(ms) ? formatter(Intl.DateTimeFormat, { hour: 'numeric', minute: '2-digit' }).format(ms) : '';
}

const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];

// "5 minutes ago", in the language shown.
export function formatRelative(ms, now = Date.now()) {
    if (!Number.isFinite(ms)) return '';
    const seconds = Math.round((ms - now) / 1000);
    const [unit, size] = UNITS.find(([, s]) => Math.abs(seconds) >= s) ?? UNITS.at(-1);
    return formatter(Intl.RelativeTimeFormat, { numeric: 'auto' }).format(Math.round(seconds / size), unit);
}

const BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3',
    'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL']);
const IGNORED = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

// Plain text of saved HTML with line breaks where blocks and <br> were. DOMParser documents run no scripts and load nothing.
export function htmlToText(html) {
    const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    const parts = [];
    const walk = node => {
        for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) parts.push(child.nodeValue);
            else if (child.nodeType !== Node.ELEMENT_NODE || IGNORED.has(child.tagName)) continue;
            else if (child.tagName === 'BR') parts.push('\n');
            else {
                const block = BLOCKS.has(child.tagName);
                if (block) parts.push('\n');
                walk(child);
                if (block) parts.push('\n');
            }
        }
    };
    walk(doc.body);
    return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// htmlToText parses a document per call, and the pages ask for the same entry many times while filtering
const derivedTexts = new Map();

// Plain text of an entry. Rich text saved by the content script carries its own; only entries without it (migrated ones) have it derived, once per version.
export function entryText(entry) {
    if (entry.kind !== 'html') return String(entry.value ?? '');
    if (typeof entry.text === 'string') return entry.text;
    const key = `${entry.id}:${entry.modified}`;
    if (!derivedTexts.has(key)) derivedTexts.set(key, htmlToText(entry.value));
    return derivedTexts.get(key);
}

// One line of at most `n` characters.
export function snippet(entry, n = 100) {
    const text = entryText(entry).replace(/\s+/g, ' ').trim();
    return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

const CSV_COLUMNS = ['id', 'url', 'title', 'kind', 'created', 'modified', 'value', 'text'];

function csvField(value) {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// Spreadsheets take a cell that starts with one of these for a formula; the leading quote keeps it text.
function inert(value) {
    const text = value === undefined || value === null ? '' : String(value);
    return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function isoTime(ms) {
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

// RFC 4180: CRLF between records, fields quoted when they hold a quote, comma, CR or LF. The BOM makes spreadsheets read the file as UTF-8.
export function toCsv(entries) {
    const rows = entries.map(entry => [entry.id, inert(entry.url), inert(entry.title), entry.kind, isoTime(entry.created), isoTime(entry.modified),
        inert(entry.value), inert(entryText(entry))]);
    return '\uFEFF' + [CSV_COLUMNS, ...rows].map(row => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}
