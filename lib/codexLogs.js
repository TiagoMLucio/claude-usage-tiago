/* Codex session logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl), parsed
 * by scan.js. Runs started with `codex exec --ephemeral` write no log, so
 * their tokens are missing here (the live utilization still counts them).
 *
 * Newer CLIs log one token_usage_record per model response; older ones only
 * a token_count event carrying the thread's running total. A forked thread's
 * running total starts at its parent's, so records are used whenever a file
 * has them (they come before the first token_count) and the running total's
 * deltas only otherwise. */

const { GLib, Gio } = imports.gi;

const Pricing = imports.lib.pricing;
const Format = imports.lib.format;

var CACHE_FILE = 'codex-cache.json';
var CACHE_VERSION = 1;

const CODEX_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
const FIVE_HOUR_MIN = 300;
const WEEK_MIN = 10080;

function listFiles() {
    const files = [];
    for (const sub of ['sessions', 'archived_sessions'])
        collect(Gio.File.new_for_path(GLib.build_filenamev([CODEX_DIR, sub])), files);
    return files;
}

function collect(dir, files) {
    let entries;
    try {
        entries = dir.enumerate_children('standard::name,standard::type,time::modified,standard::size',
            Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return;
    }
    let info;
    while ((info = entries.next_file(null)) !== null) {
        const name = info.get_name();
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            collect(dir.get_child(name), files);
        } else if (info.get_file_type() === Gio.FileType.REGULAR && name.endsWith('.jsonl')) {
            files.push({
                path: dir.get_child(name).get_path(),
                mtime: info.get_attribute_uint64('time::modified'),
                size: info.get_size(),
            });
        }
    }
    entries.close(null);
}

function newState() {
    return {
        project: 'unknown', isSub: false, byDay: {}, model: null,
        mode: 'delta', prev: null, limits: [],
    };
}

function restoreState(entry) {
    const state = JSON.parse(JSON.stringify(entry));
    delete state.mtime;
    delete state.size;
    delete state.offset;
    delete state.serial;
    return state;
}

function saveState(state) {
    return state;
}

// Same naming as ~/.claude/projects dirs, so Format.prettyProject applies.
function projectSlug(cwd) {
    return cwd ? cwd.replace(/[^A-Za-z0-9]/g, '-') : 'unknown';
}

function sub(a, b) {
    const out = {};
    for (const k of Object.keys(a))
        out[k] = (a[k] || 0) - (b[k] || 0);
    return out;
}

// A forked thread's first token_count is a seed with no input or output.
function addUsage(state, ts, windowStart, prices, u) {
    if (ts < windowStart || !u)
        return;
    const allInput = u.input_tokens || 0;
    const output = u.output_tokens || 0;
    if (allInput <= 0 && output <= 0)
        return;
    const model = state.model || 'unknown';
    const cacheRead = u.cached_input_tokens || 0;
    const cacheWrite = u.cache_write_input_tokens || 0;
    const input = Math.max(0, allInput - cacheRead - cacheWrite);
    const t = {
        cost: Pricing.messageCost(prices, model,
            { input, output, cacheRead, write5m: cacheWrite, write1h: 0 },
            allInput > Pricing.LONG_CONTEXT_TOKENS),
        input, output, cacheRead, cacheWrite, messages: 1,
    };
    Format.applyTotals(state.byDay, Format.dayKey(ts), model, t, 1);
}

// A utilization sample in UtilHistory's shape, or null.
function limitSample(ts, rl) {
    if (!rl || (rl.limit_id && rl.limit_id !== 'codex'))
        return null;
    const rec = { t: Math.floor(ts / 1000), five: null, week: null, fr: null, wr: null };
    for (const w of [rl.primary, rl.secondary]) {
        if (!w || typeof w.used_percent !== 'number')
            continue;
        if (w.window_minutes === FIVE_HOUR_MIN) {
            rec.five = w.used_percent;
            rec.fr = w.resets_at || null;
        } else if (w.window_minutes === WEEK_MIN) {
            rec.week = w.used_percent;
            rec.wr = w.resets_at || null;
        }
    }
    return rec.five === null && rec.week === null ? null : rec;
}

function sameLimits(a, b) {
    return !!a && !!b && a.five === b.five && a.week === b.week && a.fr === b.fr && a.wr === b.wr;
}

function parseLines(text, windowStart, prices, state) {
    for (const line of text.split('\n')) {
        const head = line.slice(0, 120);
        const kind = head.includes('"type":"token_usage_record"') ? 'record'
            : head.includes('"type":"token_count"') ? 'count'
            : head.includes('"type":"turn_context"') ? 'turn'
            : head.includes('"type":"session_meta"') ? 'meta' : null;
        if (!kind)
            continue;
        let o;
        try {
            o = JSON.parse(line);
        } catch (e) {
            continue;
        }
        const p = o.payload || {};
        const ts = Date.parse(o.timestamp || '');
        if (isNaN(ts))
            continue;
        switch (kind) {
        case 'meta':
            state.project = projectSlug(p.cwd);
            state.isSub = !!p.thread_source && p.thread_source !== 'user';
            break;
        case 'turn':
            if (p.model)
                state.model = p.model;
            break;
        case 'record':
            state.mode = 'record';
            addUsage(state, ts, windowStart, prices, p.usage);
            break;
        case 'count': {
            const sample = limitSample(ts, p.rate_limits);
            if (sample && !sameLimits(sample, state.limits[state.limits.length - 1]))
                state.limits.push(sample);
            const info = p.info;
            if (!info || !info.total_token_usage)
                break;
            const total = info.total_token_usage;
            if (state.mode === 'delta') {
                let delta = state.prev ? sub(total, state.prev) : info.last_token_usage;
                if (delta && Object.values(delta).some(v => v < 0))
                    delta = info.last_token_usage;
                addUsage(state, ts, windowStart, prices, delta);
            }
            state.prev = total;
            break;
        }
        }
    }
}
