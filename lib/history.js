/* Append-only utilization snapshot store.
 *
 * Anthropic's usage endpoint only returns the current snapshot, so the trend
 * graph has to accumulate history over time. Samples are appended to a JSONL
 * file under the user's state dir and retained indefinitely (the user asked to
 * keep this data). To stop the file growing without bound, a sample is only
 * written when it differs from the previous one — utilization is flat between
 * actual usage, so in practice this stays small. */

const { GLib, Gio } = imports.gi;
const ByteArray = imports.byteArray;

const STORE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'claude-usage']);
const STORE_PATH = GLib.build_filenamev([STORE_DIR, 'util-history.jsonl']);

function round1(x) {
    return x === null || x === undefined ? null : Math.round(x * 10) / 10;
}

var UtilHistory = class UtilHistory {
    constructor() {
        this._samples = []; // [{ t, five, week, opus, sonnet }]
        this._loaded = false;
    }

    _ensureDir() {
        try {
            Gio.File.new_for_path(STORE_DIR).make_directory_with_parents(null);
        } catch (e) {
            // already exists (G_IO_ERROR_EXISTS) — fine
        }
    }

    load() {
        if (this._loaded)
            return;
        this._loaded = true;
        let text;
        try {
            const [, bytes] = GLib.file_get_contents(STORE_PATH);
            text = ByteArray.toString(bytes);
        } catch (e) {
            return; // no file yet
        }
        for (const line of text.split('\n')) {
            if (!line)
                continue;
            try {
                this._samples.push(JSON.parse(line));
            } catch (e) {
                // skip a corrupt line
            }
        }
    }

    _sameAsLast(rec) {
        const last = this._samples[this._samples.length - 1];
        if (!last)
            return false;
        // `fr` (5h reset) is included so a window boundary is always recorded,
        // even if the utilization value happens to be unchanged across it.
        return last.five === rec.five && last.week === rec.week &&
            last.opus === rec.opus && last.sonnet === rec.sonnet &&
            last.fr === rec.fr && last.wr === rec.wr;
    }

    // Record a snapshot from an OAuth usage payload. No-op on duplicate values.
    record(usage) {
        if (!usage)
            return;
        this.load();
        const pct = b => (b && b.utilization != null ? round1(b.utilization) : null);
        // resets_at (unix seconds) lets the graph render window resets honestly
        // instead of interpolating a rising line across a reset to 0.
        const resetSec = b => {
            const ts = Date.parse((b && b.resets_at) || '');
            return isNaN(ts) ? null : Math.floor(ts / 1000);
        };
        const rec = {
            t: Math.floor(Date.now() / 1000),
            five: pct(usage.five_hour),
            week: pct(usage.seven_day),
            opus: pct(usage.seven_day_opus),
            sonnet: pct(usage.seven_day_sonnet),
            fr: resetSec(usage.five_hour),
            wr: resetSec(usage.seven_day),
        };
        if (this._sameAsLast(rec))
            return;
        this._samples.push(rec);
        this._append(rec);
    }

    _append(rec) {
        this._ensureDir();
        const file = Gio.File.new_for_path(STORE_PATH);
        try {
            const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            const line = JSON.stringify(rec) + '\n';
            stream.write_all(ByteArray.fromString(line), null);
            stream.close(null);
        } catch (e) {
            logError(e, 'claude-usage: failed to append util history');
        }
    }

    // Samples within the last `days` days (default: everything).
    samples(days) {
        this.load();
        if (!days)
            return this._samples.slice();
        const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
        return this._samples.filter(s => s.t >= cutoff);
    }
};
