/* Pure formatting + totals helpers (GLib only, no St/Gtk). Importable from
 * both the shell and the prefs process. */

const { GLib } = imports.gi;

function fmtTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
}

function pctOf(bucket) {
    if (!bucket || bucket.utilization === null || bucket.utilization === undefined)
        return null;
    return Math.max(0, Math.min(100, bucket.utilization));
}

function fmtReset(iso) {
    const ts = Date.parse(iso || '');
    if (isNaN(ts))
        return '';
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(ts / 1000));
    const withinDay = ts - Date.now() < 24 * 3600 * 1000;
    return dt.format(withinDay ? '%H:%M' : '%a %H:%M');
}

function emptyTotals() {
    return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
}

function addTotals(dst, src) {
    dst.cost += src.cost;
    dst.input += src.input;
    dst.output += src.output;
    dst.cacheRead += src.cacheRead;
    dst.cacheWrite += src.cacheWrite;
    dst.messages += src.messages;
}

// Adds (sign 1) or removes (sign -1) one message's totals in a byDay map.
function applyTotals(byDay, day, model, t, sign) {
    if (!byDay[day])
        byDay[day] = {};
    const perModel = byDay[day];
    if (!perModel[model])
        perModel[model] = emptyTotals();
    const dst = perModel[model];
    for (const k of Object.keys(dst))
        dst[k] += sign * t[k];
    if (dst.messages <= 0) {
        delete perModel[model];
        if (Object.keys(perModel).length === 0)
            delete byDay[day];
    }
}

function localDayBounds() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return [start, start + 24 * 3600 * 1000];
}

function pad2(n) {
    return n < 10 ? `0${n}` : String(n);
}

function startOfTodayMs() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
}

// Start (ms) of the current calendar period. Week starts Monday.
function periodStartMs(period) {
    const n = new Date();
    switch (period) {
    case 'week': {
        const today = startOfTodayMs();
        const dow = new Date(today).getDay(); // 0 = Sun
        return today - (dow === 0 ? 6 : dow - 1) * 24 * 3600 * 1000;
    }
    case 'month': return new Date(n.getFullYear(), n.getMonth(), 1).getTime();
    case 'year': return new Date(n.getFullYear(), 0, 1).getTime();
    case 'all': return 0;
    case 'day':
    default: return startOfTodayMs();
    }
}

// Number of calendar days from the period start through today (inclusive).
function periodLookbackDays(period) {
    if (period === 'all')
        return 36500; // ~100y — forces the parser to cover everything
    return Math.round((startOfTodayMs() - periodStartMs(period)) / (24 * 3600 * 1000)) + 1;
}

const PERIOD_LABELS = {
    day: 'Today', week: 'This week', month: 'This month', year: 'This year', all: 'All time',
};

function periodLabel(period) {
    return PERIOD_LABELS[period] || 'Today';
}

// Local calendar-day key (YYYY-MM-DD) for a millisecond timestamp.
function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Keys for the last `n` local days, oldest first, ending today.
function lastNDayKeys(n) {
    const keys = [];
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    for (let i = n - 1; i >= 0; i--)
        keys.push(dayKey(base - i * 24 * 3600 * 1000));
    return keys;
}

// Start-of-day (ms) `n-1` days ago — i.e. the lower bound of an n-day window.
function windowStartMs(n) {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return base - (n - 1) * 24 * 3600 * 1000;
}

const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos',
    'sol', 'astra', 'luna', 'terra'];

// Ids whose parts don't read as a name.
const MODEL_NAMES = { 'codex-auto-review': 'Auto-review' };

function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// 'claude-opus-4-8' -> 'Opus 4.8', 'claude-3-5-sonnet-20241022' -> 'Sonnet 3.5',
// 'gpt-6.1-sol' -> 'Sol 6.1', 'gpt-5.5' -> 'GPT 5.5'.
// Falls back gracefully for unrecognized ids.
function prettyModel(id) {
    if (!id)
        return id;
    if (MODEL_NAMES[id])
        return MODEL_NAMES[id];
    const s = id.replace(/^(claude|gpt)-/, '').replace(/-\d{6,}$/, ''); // strip prefix + date
    const tokens = s.split('-');
    const fi = tokens.findIndex(t => MODEL_FAMILIES.includes(t.toLowerCase()));
    if (fi === -1 && id.startsWith('gpt-'))
        return `GPT ${tokens.join(' ')}`;
    if (fi === -1) {
        const fam = tokens.shift() || s;
        const ver = tokens.join('.');
        return ver ? `${cap(fam)} ${ver}` : cap(fam);
    }
    const ver = tokens.filter((_, i) => i !== fi).join('.');
    return ver ? `${cap(tokens[fi])} ${ver}` : cap(tokens[fi]);
}

// 'claude-opus-4-8' -> 'Opus'. Ids with no known family keep their pretty name.
function modelFamily(id) {
    const fam = (id || '').toLowerCase().split('-').find(t => MODEL_FAMILIES.includes(t));
    return fam ? cap(fam) : prettyModel(id);
}

// perModel totals grouped by family: [{ family, total, models: [[id, totals]] }],
// families and the models inside each sorted by output.
function groupByFamily(perModel) {
    const groups = {};
    for (const [model, t] of Object.entries(perModel)) {
        const family = modelFamily(model);
        if (!groups[family])
            groups[family] = { family, total: emptyTotals(), models: [] };
        addTotals(groups[family].total, t);
        groups[family].models.push([model, t]);
    }
    for (const g of Object.values(groups))
        g.models.sort((a, b) => b[1].output - a[1].output);
    return Object.values(groups).sort((a, b) => b.total.output - a.total.output);
}

// ~/.claude/projects dir names are the cwd path with '/' replaced by '-'.
// Show the trailing path segment as a friendly project name.
function prettyProject(slug) {
    if (!slug)
        return slug;
    const parts = slug.replace(/^-+/, '').split('-').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : slug;
}

// '#rrggbb' or 'rgb(r,g,b)' -> { r, g, b } in 0..1, or accent fallback.
function parseColor(str) {
    const fallback = { r: 0.851, g: 0.467, b: 0.341 }; // #D97757
    if (!str)
        return fallback;
    let m = str.match(/^#([0-9a-fA-F]{6})$/);
    if (m) {
        const v = parseInt(m[1], 16);
        return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
    }
    m = str.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m)
        return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255 };
    return fallback;
}
