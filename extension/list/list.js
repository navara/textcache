import * as store from '../lib/store.js';
import { entryText, formatBytes, formatClock, formatNumber, formatTime, formatter, snippet } from '../lib/format.js';
import { t, localize, languageChanged } from '../lib/i18n.js';
import {
    $, el, hostOf, safeHref, entryLabel, sandboxedDoc, toast, errorText, copyText, copyHtml, confirmDialog, showLoadError, watchStorage,
} from '../ui/dom.js';

const SNIPPET = 220;

let entries = [];
let shown = [];
let openId = null;
const selected = new Set();

const narrow = window.matchMedia('(max-width: 860px)');

function terms() {
    return $('#search').value.toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(entry, words) {
    if (!words.length) return true;
    const haystack = `${entry.url}\n${entry.title}\n${entryText(entry)}`.toLowerCase();
    return words.every(word => haystack.includes(word));
}

// text with every occurrence of the search words wrapped in <mark>, built from text nodes only
function highlighted(text, words) {
    const fragment = document.createDocumentFragment();
    if (!words.length) {
        fragment.append(text);
        return fragment;
    }
    const pattern = new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    let last = 0;
    for (const hit of text.matchAll(pattern)) {
        fragment.append(text.slice(last, hit.index), el('mark', { text: hit[0] }));
        last = hit.index + hit[0].length;
    }
    fragment.append(text.slice(last));
    return fragment;
}

// while searching, the snippet starts a little before the first hit in the text, so the reason for the match is visible
function rowSnippet(entry, words) {
    if (!words.length) return snippet(entry, SNIPPET);
    const text = entryText(entry).replace(/\s+/g, ' ').trim();
    const lower = text.toLowerCase();
    const at = Math.min(...words.map(w => lower.indexOf(w)).filter(i => i >= 0));
    if (!Number.isFinite(at) || at < 60) return text.slice(0, SNIPPET);
    return `…${text.slice(at - 40, at - 40 + SNIPPET)}`;
}

const DAY = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };

function dayLabel(ms) {
    if (!Number.isFinite(ms)) return t('day_unknown');
    const day = new Date(ms).setHours(0, 0, 0, 0);
    const today = new Date().setHours(0, 0, 0, 0);
    if (day === today) return t('day_today');
    if (day === new Date(today).setDate(new Date(today).getDate() - 1)) return t('day_yesterday');
    return formatter(Intl.DateTimeFormat, DAY).format(ms);
}

function row(entry, words) {
    const label = entryLabel(entry);
    const host = hostOf(entry.url) || entry.url;
    const check = el('input', { attrs: { type: 'checkbox', 'aria-label': t('list_select_one', label) } });
    check.checked = selected.has(entry.id);
    const title = el('span', { className: 'row-title', attrs: { dir: 'auto' } }, highlighted(label, words));
    if (entry.kind === 'html') title.append(el('span', { className: 'tag', text: t('kind_formatted') }));
    return el('li', { className: 'row', data: { id: entry.id }, attrs: openId === entry.id ? { 'aria-current': 'true' } : {} },
        el('label', { className: 'row-check' }, check),
        el('button', { className: 'row-main', attrs: { type: 'button' } },
            el('span', { className: 'row-top' }, title, el('span', { className: 'row-time', text: formatClock(entry.modified) })),
            label === host ? null : el('span', { className: 'row-host', attrs: { dir: 'auto' } }, highlighted(host, words)),
            el('span', { className: 'row-snippet', attrs: { dir: 'auto' } }, highlighted(rowSnippet(entry, words), words))));
}

function renderList() {
    const words = terms();
    shown = entries.filter(entry => matches(entry, words));
    const focusedId = document.activeElement?.closest?.('#entries [data-id]')?.dataset.id;

    const days = [];
    for (const entry of shown) {
        const label = dayLabel(entry.modified);
        if (days.at(-1)?.label !== label) days.push({ label, rows: [] });
        days.at(-1).rows.push(row(entry, words));
    }
    $('#entries').replaceChildren(...days.map(day =>
        el('section', { className: 'day' }, el('h3', { className: 'day-heading', text: day.label }), el('ul', { className: 'rows' }, ...day.rows))));

    if (focusedId) $(`#entries [data-id="${CSS.escape(focusedId)}"] .row-main`)?.focus();
    $('#empty').hidden = entries.length > 0;
    $('#noMatches').hidden = entries.length === 0 || shown.length > 0;
    $('#count').textContent = words.length
        ? t('list_count_filtered', [formatNumber(shown.length), formatNumber(entries.length)])
        : t('list_count', formatNumber(entries.length));
    renderSelection();
}

function renderSelection() {
    const visibleSelected = shown.filter(entry => selected.has(entry.id)).length;
    const all = $('#selectAll');
    all.checked = shown.length > 0 && visibleSelected === shown.length;
    all.indeterminate = visibleSelected > 0 && visibleSelected < shown.length;
    all.disabled = shown.length === 0;
    $('#deleteSelected').textContent = t('list_delete_selected', formatNumber(selected.size));
    $('#deleteSelected').disabled = selected.size === 0;
    $('#deleteAll').disabled = entries.length === 0;
}

function renderDetail() {
    const entry = entries.find(e => e.id === openId);
    $('#detailNone').hidden = Boolean(entry);
    $('#detailBody').hidden = !entry;
    for (const r of document.querySelectorAll('#entries [data-id]')) {
        if (r.dataset.id === openId) r.setAttribute('aria-current', 'true');
        else r.removeAttribute('aria-current');
    }
    if (!entry) return;

    $('#detailTitle').textContent = entryLabel(entry);
    const href = safeHref(entry.url);
    $('#detailAddress').replaceChildren(href
        ? el('a', { text: entry.url, attrs: { href, target: '_blank', rel: 'noreferrer' } })
        : el('span', { className: 'muted', text: entry.url }));

    const text = entryText(entry);
    $('#detailMeta').textContent = t('list_detail_meta', [
        formatTime(entry.modified) || t('time_unknown'),
        formatTime(entry.created) || t('time_unknown'),
        formatNumber(text.length),
        formatBytes(new TextEncoder().encode(entry.value).length),
    ]);
    $('#detailText').textContent = text;

    const isHtml = entry.kind === 'html';
    $('#copyHtml').hidden = !isHtml;
    $('#formattingToggle').hidden = !isHtml;
    showFormatting(isHtml && $('#showFormatting').checked, entry);
}

function showFormatting(on, entry) {
    const frame = $('#detailFrame');
    $('#detailText').hidden = on;
    frame.hidden = !on;
    if (on) frame.srcdoc = sandboxedDoc(entry.value);
    else frame.removeAttribute('srcdoc');
}

function open(id, { reveal = false } = {}) {
    if (openId !== id) $('#showFormatting').checked = false;
    openId = id;
    renderDetail();
    if (reveal && narrow.matches) $('#detail').scrollIntoView({ block: 'start' });
}

// The detail pane is rebuilt only when the open entry changed or went away, so saves elsewhere do not reload an open formatted preview.
async function refresh() {
    const before = entries.find(e => e.id === openId);
    entries = await store.list();
    const ids = new Set(entries.map(e => e.id));
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
    if (openId && !ids.has(openId)) openId = null;
    renderList();
    const after = entries.find(e => e.id === openId);
    if (!before || !after || before.modified !== after.modified) renderDetail();
}

async function remove(ids) {
    try {
        await store.remove(ids);
        for (const id of ids) selected.delete(id);
        toast(t('status_deleted', formatNumber(ids.length)));
        await refresh();
    } catch (error) {
        toast(t('status_failed', errorText(error)), true);
    }
}

async function deleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    if (await confirmDialog(t('confirm_delete_selected', formatNumber(ids.length)), t('confirm_delete_selected_ok'))) await remove(ids);
}

async function deleteAll() {
    if (!entries.length) return;
    if (!await confirmDialog(t('confirm_delete_all', formatNumber(entries.length)), t('confirm_delete_all_ok'))) return;
    try {
        await store.clear();
        selected.clear();
        toast(t('status_deleted_all'));
        await refresh();
    } catch (error) {
        toast(t('status_failed', errorText(error)), true);
    }
}

async function copy(asHtml) {
    const entry = entries.find(e => e.id === openId);
    if (!entry) return;
    try {
        if (asHtml) await copyHtml(entry.value, entryText(entry));
        else await copyText(entryText(entry));
        toast(t('status_copied'));
    } catch (error) {
        toast(t('status_failed', errorText(error)), true);
    }
}

function onEntriesClick(event) {
    const rowEl = event.target.closest('[data-id]');
    if (!rowEl) return;
    if (event.target.closest('.row-main')) open(rowEl.dataset.id, { reveal: true });
}

function onEntriesChange(event) {
    const rowEl = event.target.closest('[data-id]');
    if (!rowEl || event.target.type !== 'checkbox') return;
    if (event.target.checked) selected.add(rowEl.dataset.id);
    else selected.delete(rowEl.dataset.id);
    renderSelection();
}

// up and down move between rows and open the one reached
function onEntriesKey(event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...document.querySelectorAll('#entries .row-main')];
    const at = buttons.indexOf(document.activeElement);
    if (at < 0) return;
    const next = buttons[at + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    open(next.closest('[data-id]').dataset.id);
}

function onSelectAll(event) {
    for (const entry of shown) {
        if (event.target.checked) selected.add(entry.id);
        else selected.delete(entry.id);
    }
    for (const box of document.querySelectorAll('#entries [data-id] input[type="checkbox"]')) box.checked = event.target.checked;
    renderSelection();
}

function onGlobalKey(event) {
    const typing = event.target.closest('input, textarea, [contenteditable]');
    if (event.key === '/' && !typing) {
        event.preventDefault();
        $('#search').focus();
    }
}

async function init() {
    await localize();
    $('#search').addEventListener('input', renderList);
    $('#search').addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            $('#entries .row-main')?.focus();
        }
    });
    $('#entries').addEventListener('click', onEntriesClick);
    $('#entries').addEventListener('change', onEntriesChange);
    $('#entries').addEventListener('keydown', onEntriesKey);
    $('#selectAll').addEventListener('change', onSelectAll);
    $('#deleteSelected').addEventListener('click', deleteSelected);
    $('#deleteAll').addEventListener('click', deleteAll);
    $('#copyText').addEventListener('click', () => copy(false));
    $('#copyHtml').addEventListener('click', () => copy(true));
    $('#deleteOne').addEventListener('click', () => openId && remove([openId]));
    $('#showFormatting').addEventListener('change', event => showFormatting(event.target.checked, entries.find(e => e.id === openId)));
    document.addEventListener('keydown', onGlobalKey);
    watchStorage(async changed => {
        if (changed.settings && await languageChanged()) location.reload();
        else if (changed.savedTexts) refresh();
    });

    await refresh();
    // the popup links here with #<id> to open that saved text
    const wanted = decodeURIComponent(location.hash.slice(1));
    if (wanted && entries.some(e => e.id === wanted)) {
        open(wanted, { reveal: true });
        $(`#entries [data-id="${CSS.escape(wanted)}"]`)?.scrollIntoView({ block: 'center' });
    }
}

init().catch(showLoadError);
