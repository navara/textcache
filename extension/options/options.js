import * as settingsStore from '../lib/settings.js';
import * as store from '../lib/store.js';
import { idsToClean } from '../lib/cleanup.js';
import { formatBytes, formatNumber, toCsv } from '../lib/format.js';
import { LANGUAGES, t, localize, languageChanged, pickLanguage } from '../lib/i18n.js';
import { $, el, toast, errorText, confirmDialog, watchStorage } from '../ui/dom.js';

// the smallest value each number field accepts; anything else (empty, fractional, negative, not a number) is marked and not saved
const NUMBERS = { maxItemKb: 0, keepNewest: 1 };

let current = null;

function parseWhole(input, min) {
    const text = input.value.trim();
    if (input.validity.badInput || !/^\d+$/.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) && value >= min ? value : null;
}

function markInvalid(id, invalid) {
    $(`#${id}`).setAttribute('aria-invalid', String(invalid));
    $(`#${id}_error`).hidden = !invalid;
}

async function save(patch) {
    try {
        await settingsStore.save(patch);
        current = { ...current, ...patch };
        toast(t('status_saved'));
        return true;
    } catch (error) {
        toast(t('status_not_saved', errorText(error)), true);
        return false;
    }
}

function skipLines() {
    const lines = $('#skip').value.split('\n').map(line => line.trim()).filter(Boolean);
    return [...new Set(lines)];
}

function showSkip(skip) {
    const box = $('#skip');
    box.value = skip.join('\n');
    box.rows = Math.min(12, Math.max(4, skip.length + 1));
}

async function saveSkip() {
    const skip = skipLines();
    showSkip(skip);
    if (skip.join('\n') === current.skip.join('\n')) {
        toast(t('status_saved'));
        return;
    }
    await save({ skip });
}

function applyAutoClean() {
    const off = !$('#autoClean').checked;
    $('#keepNewest').disabled = off;
    $('#keepNewestRow').classList.toggle('is-disabled', off);
}

// fills the fields from the stored settings; a field the person is editing keeps what they typed, and so does a number field whose stored value
// did not change since `before` (a rejected entry keeps its message when some other setting changes)
function showSettings(before = null) {
    for (const id of Object.keys(NUMBERS)) {
        const input = $(`#${id}`);
        if (document.activeElement === input || before?.[id] === current[id]) continue;
        input.value = String(current[id]);
        markInvalid(id, false);
    }
    $('#language').value = current.language;
    $('#popupWidth').value = current.popupWidth;
    $('#autoClean').checked = current.autoClean;
    $('#dedupe').checked = current.dedupe;
    if (document.activeElement !== $('#skip')) showSkip(current.skip);
    applyAutoClean();
}

// "Automatic" names the language the browser's language leads to; the others are listed by their own names
function fillLanguages() {
    const auto = LANGUAGES[pickLanguage('auto', chrome.i18n.getUILanguage())];
    $('#language').replaceChildren(
        el('option', { text: t('options_language_auto', auto), attrs: { value: 'auto' } }),
        ...Object.entries(LANGUAGES).map(([code, name]) => el('option', { text: name, attrs: { value: code, lang: code.replace('_', '-') } })));
}

function figure(label, value) {
    return el('p', { className: 'usage-figure' },
        el('span', { className: 'usage-label', text: label }),
        el('span', { className: 'usage-value', text: value }));
}

async function showStorage() {
    const [entries, usage] = await Promise.all([store.list(), store.usage()]);
    const parts = [
        figure(t('options_usage_count'), formatNumber(usage.count)),
        figure(t('options_usage_space'), usage.quota === null
            ? formatBytes(usage.bytes)
            : t('options_usage_space_of', [formatBytes(usage.bytes), formatBytes(usage.quota)])),
    ];
    if (usage.quota !== null) {
        const percent = Math.min(100, Math.round(usage.bytes / usage.quota * 100));
        const fill = el('div', { className: 'usage-meter-fill' });
        fill.style.width = `${percent}%`;
        parts.push(el('div', {
            className: 'usage-meter',
            attrs: {
                role: 'progressbar', 'aria-label': t('options_usage_space'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percent),
            },
        }, fill));
    }
    $('#storageUsage').replaceChildren(...parts);
    $('#deleteAll').disabled = entries.length === 0;
    $('#exportCsv').disabled = entries.length === 0;

    const total = formatNumber(entries.length);
    let preview;
    if (!current.autoClean && !current.dedupe) preview = t('options_preview_off');
    else {
        const doomed = idsToClean(entries, current).length;
        preview = doomed === 0
            ? t('options_preview_none', [total])
            : t('options_preview_some', [formatNumber(doomed), total]);
    }
    $('#cleanupPreview').textContent = preview;
}

async function onNumberChange(event) {
    const input = event.target;
    const value = parseWhole(input, NUMBERS[input.id]);
    markInvalid(input.id, value === null);
    if (value === null || value === current[input.id]) return;
    if (await save({ [input.id]: value })) showStorage();
}

async function exportCsv() {
    try {
        const entries = await store.list();
        const url = URL.createObjectURL(new Blob([toCsv(entries)], { type: 'text/csv;charset=utf-8' }));
        const link = el('a', { attrs: { href: url, download: 'textcache-export.csv' } });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
        toast(t('status_failed', errorText(error)), true);
    }
}

async function deleteAll() {
    const { count } = await store.usage();
    if (count === 0) return;
    if (!await confirmDialog(t('confirm_delete_all', formatNumber(count)), t('confirm_delete_all_ok'))) return;
    try {
        await store.clear();
        toast(t('status_deleted_all'));
        showStorage();
    } catch (error) {
        toast(t('status_failed', errorText(error)), true);
    }
}

async function init() {
    await localize();
    fillLanguages();
    current = await settingsStore.load();
    showSettings();
    await showStorage();

    for (const id of Object.keys(NUMBERS)) $(`#${id}`).addEventListener('change', onNumberChange);
    // the page is built again in the new language when the storage change comes back
    $('#language').addEventListener('change', event => save({ language: event.target.value }));
    $('#popupWidth').addEventListener('change', event => save({ popupWidth: event.target.value }));
    $('#autoClean').addEventListener('change', async event => {
        applyAutoClean();
        if (await save({ autoClean: event.target.checked })) showStorage();
    });
    $('#dedupe').addEventListener('change', async event => {
        if (await save({ dedupe: event.target.checked })) showStorage();
    });
    $('#skip').addEventListener('change', saveSkip);
    $('#saveSkip').addEventListener('click', saveSkip);
    $('#exportCsv').addEventListener('click', exportCsv);
    $('#deleteAll').addEventListener('click', deleteAll);

    watchStorage(async changed => {
        if (changed.settings) {
            if (await languageChanged()) {
                location.reload();
                return;
            }
            const before = current;
            current = await settingsStore.load();
            showSettings(before);
        }
        showStorage();
    });
}

init().catch(error => toast(t('status_failed', errorText(error)), true));
