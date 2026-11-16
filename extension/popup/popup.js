import * as settings from '../lib/settings.js';
import * as store from '../lib/store.js';
import { entryText, formatNumber, formatTime, snippet } from '../lib/format.js';
import { t, localize, languageChanged } from '../lib/i18n.js';
import { $, el, hostOf, entryLabel, relativeTime, toast, errorText, copyText, showLoadError, watchStorage } from '../ui/dom.js';

// the popup is for the latest few; the full list has the rest
const LIMIT = 50;

let entries = [];
let siteHost = '';
let openId = null;

function visible() {
    return $('#thisSite').checked ? entries.filter(e => hostOf(e.url) === siteHost) : entries;
}

function row(entry) {
    const label = entryLabel(entry);
    return el('li', { className: 'row', data: { id: entry.id } },
        el('button', { className: 'row-main', attrs: { type: 'button' } },
            el('span', { className: 'row-top' },
                el('span', { className: 'row-title', text: label, attrs: { dir: 'auto' } }),
                el('span', { className: 'row-time', text: relativeTime(entry.modified), attrs: { title: formatTime(entry.modified) } })),
            el('span', { className: 'row-snippet', text: snippet(entry, 140), attrs: { dir: 'auto' } })),
        el('button', { className: 'button quiet small row-copy', text: t('copy'), attrs: { type: 'button', 'aria-label': t('popup_copy_one', label) } }));
}

function renderList() {
    const list = visible();
    $('#entries').replaceChildren(...list.slice(0, LIMIT).map(row));
    $('#more').hidden = list.length <= LIMIT;
    $('#more').textContent = t('popup_more', [formatNumber(LIMIT), formatNumber(list.length)]);
    $('#empty').hidden = entries.length > 0;
    $('#noSiteMatches').hidden = entries.length === 0 || list.length > 0;
}

function renderDetail() {
    const entry = entries.find(e => e.id === openId);
    if (!entry) openId = null;
    $('#listView').hidden = Boolean(entry);
    $('#detailView').hidden = !entry;
    if (!entry) return;
    $('#detailTitle').textContent = entryLabel(entry);
    $('#detailMeta').textContent = t('popup_detail_meta', [hostOf(entry.url) || entry.url, formatTime(entry.modified) || t('time_unknown')]);
    $('#detailText').textContent = entryText(entry);
}

function open(id) {
    openId = id;
    renderDetail();
    $('#copy').focus();
}

function back() {
    const id = openId;
    openId = null;
    renderDetail();
    $(`#entries [data-id="${CSS.escape(id ?? '')}"] .row-main`)?.focus();
}

async function copy(id) {
    const entry = entries.find(e => e.id === id);
    if (!entry) return;
    try {
        await copyText(entryText(entry));
        toast(t('status_copied'));
    } catch (error) {
        toast(t('status_failed', errorText(error)), true);
    }
}

async function remove() {
    if (!openId) return;
    try {
        await store.remove([openId]);
        toast(t('status_deleted', formatNumber(1)));
        openId = null;
        await refresh();
    } catch (error) {
        toast(t('status_failed', errorText(error)), true);
    }
}

async function refresh() {
    entries = await store.list();
    renderList();
    renderDetail();
}

async function findSite() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? '';
    siteHost = /^https?:/.test(url) ? hostOf(url) : '';
    $('#siteHost').textContent = siteHost;
    $('#thisSite').disabled = !siteHost;
    $('#siteFilter').classList.toggle('is-unavailable', !siteHost);
}

function openList() {
    const hash = openId ? `#${encodeURIComponent(openId)}` : '';
    chrome.tabs.create({ url: chrome.runtime.getURL(`list/list.html${hash}`) });
    window.close();
}

// the body's width is the popup's width; popup.css has the three sizes
async function applyWidth() {
    document.documentElement.dataset.width = (await settings.load()).popupWidth;
}

async function init() {
    await localize();
    await applyWidth();
    $('#entries').addEventListener('click', event => {
        const id = event.target.closest('[data-id]')?.dataset.id;
        if (!id) return;
        if (event.target.closest('.row-copy')) copy(id);
        else if (event.target.closest('.row-main')) open(id);
    });
    $('#thisSite').addEventListener('change', renderList);
    $('#back').addEventListener('click', back);
    $('#copy').addEventListener('click', () => copy(openId));
    $('#delete').addEventListener('click', remove);
    $('#openList').addEventListener('click', openList);
    $('#openSettings').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
        window.close();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Backspace' && openId && !event.target.closest('input, textarea')) back();
    });
    watchStorage(async changed => {
        if (changed.settings && await languageChanged()) {
            location.reload();
            return;
        }
        if (changed.settings) await applyWidth();
        if (changed.savedTexts) refresh();
    });

    await findSite();
    await refresh();
}

init().catch(showLoadError);
