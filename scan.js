/* Log scanner, run by lib/transcripts.js as a subprocess:
 *
 *   gjs scan.js <extension dir> <claude|codex> <window days> <known serial> <prices json>
 *
 * GNOME Shell 42's GJS drops JS callbacks that land while its GC is sweeping,
 * so a refresh built from many async steps inside the shell can hang for good,
 * and parsing there fills the shell's heap. This process does all log I/O and
 * parsing synchronously, owns the provider's on-disk cache, and prints the
 * cache entries changed since <known serial> as one JSON object.
 *
 * Logs are append-only, so each entry keeps the byte offset it has consumed:
 * a changed file is read only from there (usually a few KB of the active
 * session) instead of from the start. The parsing itself is per provider
 * (lib/claudeLogs.js, lib/codexLogs.js). */

const { GLib, Gio } = imports.gi;
const ByteArray = imports.byteArray;

const [extDir, providerArg, windowDaysArg, knownSerialArg, pricesArg] = ARGV;
imports.searchPath.unshift(extDir);
const Pricing = imports.lib.pricing;
const Format = imports.lib.format;
const Logs = providerArg === 'codex' ? imports.lib.codexLogs : imports.lib.claudeLogs;

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'claude-usage']);
const CACHE_PATH = GLib.build_filenamev([CACHE_DIR, Logs.CACHE_FILE]);
const CHUNK_BYTES = 4 * 1024 * 1024;

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

// Parses `file` from `base.offset` onward into a copy of base's state, or from
// the start when base is null. Returns the new entry, or null if unreadable.
function parseFile(file, windowStart, prices, base) {
    const state = base ? Logs.restoreState(base) : Logs.newState(file);
    let offset;
    try {
        offset = readLinesFrom(file.path, base ? base.offset : 0,
            text => Logs.parseLines(text, windowStart, prices, state));
    } catch (e) {
        return null;
    }
    return { ...Logs.saveState(state), mtime: file.mtime, size: file.size, offset };
}

function main() {
    const prices = Pricing.parsePricing(pricesArg);
    const pricingKey = Pricing.pricingKey(providerArg, prices);
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
    const usable = !!data && data.version === Logs.CACHE_VERSION && data.pricingKey === pricingKey;
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

    for (const f of Logs.listFiles()) {
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
            version: Logs.CACHE_VERSION, pricingKey, coverageStart, serial, files,
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
