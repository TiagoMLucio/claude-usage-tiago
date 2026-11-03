/* Transcript scanner, run by lib/transcripts.js as a subprocess:
 *
 *   gjs scan.js <extension dir> <window days> <known serial> <prices json>
 *
 * GNOME Shell 42's GJS drops JS callbacks that land while its GC is sweeping,
 * so a refresh built from many async steps inside the shell can hang for good,
 * and parsing there fills the shell's heap. This process does all transcript
 * I/O and parsing synchronously, owns the on-disk cache, and prints the cache
 * entries changed since <known serial> as one JSON object.
 *
 * Transcripts are append-only, so each entry keeps the byte offset it has
 * consumed: a changed file is read only from there (usually a few KB of the
 * active session) instead of from the start. */

const { GLib, Gio } = imports.gi;
const ByteArray = imports.byteArray;

const [extDir, windowDaysArg, knownSerialArg, pricesArg] = ARGV;
imports.searchPath.unshift(extDir);
const Pricing = imports.lib.pricing;
const Format = imports.lib.format;

const PROJECTS_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects']);
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'claude-usage']);
const CACHE_PATH = GLib.build_filenamev([CACHE_DIR, 'transcripts-cache.json']);
const CACHE_VERSION = 1;
const CHUNK_BYTES = 4 * 1024 * 1024;

// Every *.jsonl under ~/.claude/projects, recursing into the nested
// <session>/subagents/ dirs that hold Task/workflow subagent transcripts.
// `project` is always the top-level project dir; `isSub` flags subagent files.
function listFiles() {
    const files = [];
    const root = Gio.File.new_for_path(PROJECTS_DIR);
    let topDirs;
    try {
        topDirs = root.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return files;
    }
    let dirInfo;
    while ((dirInfo = topDirs.next_file(null)) !== null) {
        if (dirInfo.get_file_type() !== Gio.FileType.DIRECTORY)
            continue;
        const project = dirInfo.get_name();
        collect(root.get_child(project), project, files, false);
    }
    topDirs.close(null);
    return files;
}

function collect(dir, project, files, inSub) {
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
            collect(dir.get_child(name), project, files, inSub || name === 'subagents');
        } else if (info.get_file_type() === Gio.FileType.REGULAR && name.endsWith('.jsonl')) {
            files.push({
                path: dir.get_child(name).get_path(),
                project,
                isSub: inSub,
                mtime: info.get_attribute_uint64('time::modified'),
                size: info.get_size(),
            });
        }
    }
    entries.close(null);
}

// Reads `path` from byte `offset` to EOF in chunks, passing each run of
// complete lines to onText. Returns the offset just past the last newline; a
// trailing partial line (one still being written) is left for the next scan.
function readLinesFrom(path, offset, onText) {
    const stream = Gio.File.new_for_path(path).read(null);
    try {
        if (offset > 0)
            stream.seek(offset, GLib.SeekType.SET, null);
        let carry = new Uint8Array(0);
        for (;;) {
            let buf = stream.read_bytes(CHUNK_BYTES, null).toArray();
            if (buf.length === 0)
                return offset;
            if (carry.length > 0) {
                const joined = new Uint8Array(carry.length + buf.length);
                joined.set(carry);
                joined.set(buf, carry.length);
                buf = joined;
            }
            const nl = buf.lastIndexOf(10);
            if (nl < 0) {
                carry = buf;
                continue;
            }
            onText(ByteArray.toString(buf.subarray(0, nl)));
            offset += nl + 1;
            carry = buf.slice(nl + 1);
        }
    } finally {
        stream.close(null);
    }
}

// Adds (sign 1) or removes (sign -1) one message's totals in a byDay map.
function applyTotals(byDay, day, model, t, sign) {
    if (!byDay[day])
        byDay[day] = {};
    const perModel = byDay[day];
    if (!perModel[model])
        perModel[model] = Format.emptyTotals();
    const dst = perModel[model];
    for (const k of Object.keys(dst))
        dst[k] += sign * t[k];
    if (dst.messages <= 0) {
        delete perModel[model];
        if (Object.keys(perModel).length === 0)
            delete byDay[day];
    }
}

// Folds assistant entries since windowStart into state.byDay. A streamed
// message repeats its id on consecutive usage lines (possibly across two
// scans), so state.last holds the previous one's totals and a repeat replaces
// them: the last occurrence wins.
function parseLines(text, windowStart, prices, state) {
    for (const line of text.split('\n')) {
        // Cheap pre-filter: every assistant usage entry has this key.
        if (!line.includes('"usage"'))
            continue;
        let o;
        try {
            o = JSON.parse(line);
        } catch (e) {
            continue;
        }
        if (o.type !== 'assistant' || !o.message || !o.message.usage)
            continue;
        const ts = Date.parse(o.timestamp || '');
        if (isNaN(ts) || ts < windowStart)
            continue;
        const msg = o.message;
        const last = state.last;
        if (last && msg.id && last.id === msg.id)
            applyTotals(state.byDay, last.day, last.model, last.t, -1);
        state.last = null;

        const model = msg.model || 'unknown';
        if (model === '<synthetic>')
            continue;
        const u = msg.usage;
        const input = u.input_tokens || 0;
        const output = u.output_tokens || 0;
        const cacheRead = u.cache_read_input_tokens || 0;
        let write5m = 0, write1h = 0;
        if (u.cache_creation) {
            write5m = u.cache_creation.ephemeral_5m_input_tokens || 0;
            write1h = u.cache_creation.ephemeral_1h_input_tokens || 0;
        } else {
            write5m = u.cache_creation_input_tokens || 0;
        }

        const t = {
            cost: Pricing.messageCost(prices, model,
                { input, output, cacheRead, write5m, write1h }),
            input,
            output,
            cacheRead,
            cacheWrite: write5m + write1h,
            messages: 1,
        };
        const day = Format.dayKey(ts);
        applyTotals(state.byDay, day, model, t, 1);
        if (msg.id)
            state.last = { id: msg.id, day, model, t };
    }
}

// Parses `file` from `base.offset` onward into a copy of base's totals, or from
// the start when base is null. Returns the new entry, or null if unreadable.
function parseFile(file, windowStart, prices, base) {
    const state = base
        ? { byDay: JSON.parse(JSON.stringify(base.byDay)), last: base.last || null }
        : { byDay: {}, last: null };
    let offset;
    try {
        offset = readLinesFrom(file.path, base ? base.offset : 0,
            text => parseLines(text, windowStart, prices, state));
    } catch (e) {
        return null;
    }
    return {
        mtime: file.mtime,
        size: file.size,
        project: file.project,
        isSub: !!file.isSub,
        byDay: state.byDay,
        offset,
        last: state.last,
    };
}

function main() {
    const prices = Pricing.parsePricing(pricesArg);
    const pricingKey = JSON.stringify(prices);
    const knownSerial = Number(knownSerialArg) || 0;
    const days = Math.max(1, Number(windowDaysArg) || 1);

    let data = null;
    try {
        const [, bytes] = GLib.file_get_contents(CACHE_PATH);
        data = JSON.parse(ByteArray.toString(bytes));
    } catch (e) {
        // no cache yet, or unreadable
    }
    const prevSerial = data && typeof data.serial === 'number' ? data.serial : 0;
    // Prices are baked into each entry's cost, so a price change starts over.
    const usable = !!data && data.version === CACHE_VERSION && data.pricingKey === pricingKey;
    const files = usable ? data.files || {} : {};
    let coverageStart = usable && typeof data.coverageStart === 'number' ? data.coverageStart : null;
    const serial = prevSerial + 1;
    let dirty = !usable;

    // Grow-only coverage: the oldest day parsed so far. If we need older data,
    // re-parse every in-window file at the new (older) start; a shorter window
    // needs nothing, since aggregations just slice the data already cached.
    const desired = Format.windowStartMs(days);
    const grow = coverageStart === null || desired < coverageStart;
    if (grow) {
        coverageStart = desired;
        dirty = true;
    }

    for (const f of listFiles()) {
        if (f.mtime * 1000 < coverageStart)
            continue; // outside the parse window: skip, but keep any cached data
        const cached = files[f.path];
        if (cached) {
            if (!grow && cached.mtime === f.mtime && cached.size === f.size)
                continue; // unchanged
            if (f.size < cached.size)
                continue; // shrank (truncated by a crash / compaction) — keep the fuller parse
        }
        // Entries saved before offsets existed are re-read once from the start.
        const base = !grow && cached && typeof cached.offset === 'number' ? cached : null;
        const entry = parseFile(f, coverageStart, prices, base);
        if (entry) {
            entry.serial = serial;
            files[f.path] = entry;
            dirty = true;
        }
    }
    // Deliberately NOT pruning entries whose file has disappeared: Claude Code
    // deletes transcripts after cleanupPeriodDays (default 30), and dropping
    // them would make the all-time total shrink day by day.

    if (dirty) {
        GLib.mkdir_with_parents(CACHE_DIR, 0o755);
        GLib.file_set_contents(CACHE_PATH, JSON.stringify({
            version: CACHE_VERSION, pricingKey, coverageStart, serial, files,
        }));
    }

    const changed = {};
    for (const [path, entry] of Object.entries(files)) {
        if (!usable || (entry.serial || 0) > knownSerial)
            changed[path] = entry;
    }
    print(JSON.stringify({ reset: !usable, serial: dirty ? serial : prevSerial, files: changed }));
}

main();
