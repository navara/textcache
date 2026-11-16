// Newest first by `modified`; ties go to the later `created`, then to the id, so the order never depends on storage order.
export function newestFirst(a, b) {
    return time(b.modified) - time(a.modified) || time(b.created) - time(a.created) || String(a.id).localeCompare(String(b.id));
}

function time(value) {
    return Number.isFinite(value) ? value : 0;
}

// What two saved texts are compared by: the plain text, without leading and trailing whitespace.
function comparable(entry) {
    return String(entry.kind === 'html' && typeof entry.text === 'string' ? entry.text : entry.value ?? '').trim();
}

// Ids of every saved text whose plain text equals that of a newer one: the newest copy stays, whatever page it came from.
export function idsOfOlderCopies(entries) {
    const seen = new Set();
    const ids = [];
    for (const entry of [...entries].sort(newestFirst)) {
        const text = comparable(entry);
        if (seen.has(text)) ids.push(entry.id);
        else seen.add(text);
    }
    return ids;
}

// Everything a clean-up with these settings deletes: older copies when `dedupe` is on, then, when `autoClean` is on, all but the `keepNewest` newest
// of the rest.
export function idsToClean(entries, { dedupe, autoClean, keepNewest }) {
    const copies = dedupe ? idsOfOlderCopies(entries) : [];
    const removed = new Set(copies);
    const rest = entries.filter(entry => !removed.has(entry.id));
    return [...copies, ...(autoClean ? idsToPrune(rest, keepNewest) : [])];
}

// Ids of every saved text except the `keep` newest. Anything but an integer >= 1 deletes nothing, so a broken setting can never mean "keep none".
export function idsToPrune(entries, keep) {
    if (!Number.isInteger(keep) || keep < 1) return [];
    return [...entries].sort(newestFirst).slice(keep).map(entry => entry.id);
}
