// Helpers shared by the popup, the full list and the options page. Page-derived data (address, title, text) only ever reaches the DOM through
// textContent and setAttribute, never through HTML parsing in the extension's own document.

import { t } from '../lib/i18n.js';
import { formatter } from '../lib/format.js';

export const $ = (selector, root = document) => root.querySelector(selector);

// el('p', {className: 'x', text: 'y', attrs: {title: 'z'}, data: {id: '1'}}, child, ...)
export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    if (props.className) node.className = props.className;
    if (props.text !== undefined) node.textContent = props.text;
    for (const [name, value] of Object.entries(props.attrs || {})) node.setAttribute(name, value);
    Object.assign(node.dataset, props.data || {});
    node.append(...children.filter(c => c !== null && c !== undefined));
    return node;
}

export function hostOf(url) {
    try {
        return new URL(url).host;
    } catch {
        return '';
    }
}

// only web addresses become links; javascript:, data:, file: and the like stay text
export function safeHref(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
        return null;
    }
}

export function entryLabel(entry) {
    return entry.title?.trim() || hostOf(entry.url) || entry.url || t('entry_untitled');
}

const STEPS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];

export function relativeTime(ms, now = Date.now()) {
    if (!Number.isFinite(ms)) return '';
    const seconds = Math.round((ms - now) / 1000);
    if (Math.abs(seconds) < 60) return t('time_just_now');
    const rtf = formatter(Intl.RelativeTimeFormat, { numeric: 'auto' });
    for (const [unit, size] of STEPS) {
        if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
    }
    return rtf.format(Math.round(seconds / 60), 'minute');
}

// the formatted preview: a document with its own CSP, shown in <iframe sandbox="">, so it can neither run script nor load anything.
// chrome-extension: URLs bypass a page's CSP, and a srcdoc document resolves relative URLs against the extension page, so <img src=x> would
// still request chrome-extension://<id>/list/x; the base about:blank leaves relative URLs nothing to resolve against.
const CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">'
    + '<base href="about:blank">';
const FRAME_STYLE = '<style>:root{color-scheme:light dark}body{margin:16px;font:15px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}'
    + 'img{max-width:100%;height:auto}</style>';

export function sandboxedDoc(html) {
    return CSP + FRAME_STYLE + html;
}

// The first read failed: a lasting message where the list would be, instead of a blank or "nothing saved" list, and the error in the console.
export function showLoadError(error) {
    console.error('TextCache:', error);
    const box = $('#loadError');
    box.textContent = t('load_failed', errorText(error));
    box.hidden = false;
}

let toastTimer = 0;

export function toast(text, isError = false) {
    const status = $('#status');
    status.textContent = text;
    status.classList.toggle('is-error', isError);
    status.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => status.classList.remove('is-visible'), isError ? 6000 : 2000);
}

export function errorText(error) {
    return String(error?.message || error);
}

export async function copyText(text) {
    await navigator.clipboard.writeText(text);
}

// HTML and its plain text together, so a rich editor gets the formatting and a plain field the text
export async function copyHtml(html, text) {
    await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
}

// resolves true when the person confirms; needs the <dialog id="confirm"> block every page carries
export function confirmDialog(message, okLabel) {
    const dialog = $('#confirm');
    $('#confirmText').textContent = message;
    $('#confirmOk').textContent = okLabel;
    dialog.returnValue = '';
    dialog.showModal();
    $('#confirmCancel').focus();
    return new Promise(resolve => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    });
}

// calls back once per burst of storage changes: savedTexts when a t:<id> key changed, settings when the settings did. A burst that goes on (a page
// saving continuously) is still reported every `maxWait` ms, counted from its first change.
export function watchStorage(callback, delay = 150, maxWait = 1000) {
    let timer = 0;
    let since = 0;
    let pending = { savedTexts: false, settings: false };
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const keys = Object.keys(changes);
        pending.savedTexts ||= keys.some(k => k.startsWith('t:'));
        pending.settings ||= keys.includes('settings');
        if (!pending.savedTexts && !pending.settings) return;
        since ||= Date.now();
        clearTimeout(timer);
        timer = setTimeout(() => {
            const what = pending;
            pending = { savedTexts: false, settings: false };
            since = 0;
            callback(what);
        }, Math.max(0, Math.min(delay, since + maxWait - Date.now())));
    });
}
