/* Token/cost accounting from ~/.claude transcripts or ~/.codex session logs.
 *
 * Scanning and parsing run in a subprocess (scan.js), which also owns the
 * on-disk cache: GNOME Shell 42's GJS drops JS callbacks that land while its GC
 * is sweeping, so a refresh built from many async steps here could hang, and
 * parsing here would fill the shell's heap. A refresh is a single subprocess
 * call that returns only the cache entries changed since the last one merged.
 *
 * Each entry holds per-calendar-day, per-model totals for one transcript, so
 * the same cache serves both today's breakdown and the multi-day graphs. Codex
 * entries also carry the utilization samples their log recorded (`limits`). */

const { GLib, Gio } = imports.gi;
const ByteArray = imports.byteArray;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Format = Me.imports.lib.format;
const Pricing = Me.imports.lib.pricing;

// Must match CACHE_FILE / CACHE_VERSION in lib/claudeLogs.js and lib/codexLogs.js.
const CACHE_FILES = { claude: 'transcripts-cache.json', codex: 'codex-cache.json' };
const CACHE_VERSIONS = { claude: 1, codex: 2 };
// A scan still running after this is presumed lost (hung, or its callback dropped).
const SCAN_TIMEOUT_US = 120 * 1000000;

var TranscriptReader = class TranscriptReader {
    // provider:       'claude' | 'codex'
    // getPrices:      () => prices table (live from settings)
    // getWindowDays:  () => how many days back to keep/parse
    constructor(provider, getPrices, getWindowDays) {
        this._provider = provider;
        this._cachePath = GLib.build_filenamev(
            [GLib.get_user_state_dir(), 'claude-usage', CACHE_FILES[provider]]);
        this._getPrices = getPrices;
        this._getWindowDays = getWindowDays;
        // path -> { mtime, size, project, isSub, byDay, offset, last, serial }
        this._cache = new Map();
        this._serial = 0; // newest cache serial merged into _cache
        // Bumped on every merge; invalidates the aggregation memo below.
        this._version = 0;
        this._memo = { v: -1 };
        // Bumped by invalidate(); output of a scan started before it is dropped.
        this._generation = 0;
        this._loaded = false; // have we tried to load the saved cache yet?
        // The scan in flight: its process, the promise callers wait on, and a
        // token so a superseded scan loop stops instead of running again.
        this._proc = null;
        this._running = null;
        this._runStart = 0;
        this._rerun = false;
        this._token = 0;
    }

    // Prices are baked into each cached entry's cost; the saved cache is tagged
    // with them so a price change (made while disabled) doesn't load stale costs.
    pricingKey() {
        return Pricing.pricingKey(this._provider, this._getPrices());
    }

    // Synchronous, once: makes the menu show saved totals right away.
    _loadPersisted() {
        if (this._loaded)
            return;
        this._loaded = true;
        let data;
        try {
            const [, bytes] = GLib.file_get_contents(this._cachePath);
            data = JSON.parse(ByteArray.toString(bytes));
        } catch (e) {
            return; // no cache yet, or unreadable
        }
        if (!data || data.version !== CACHE_VERSIONS[this._provider] ||
            data.pricingKey !== this.pricingKey())
            return; // incompatible — the scan rebuilds it
        this._serial = typeof data.serial === 'number' ? data.serial : 0;
        for (const [path, entry] of Object.entries(data.files || {}))
            this._cache.set(path, entry);
        this._version++;
    }

    // Starts a scan, or joins the one in flight and asks it to run once more
    // (so a window change made meanwhile is picked up).
    refresh() {
        this._loadPersisted();
        if (this._running && GLib.get_monotonic_time() - this._runStart < SCAN_TIMEOUT_US) {
            this._rerun = true;
            return this._running;
        }
        this._stopScan();
        const token = ++this._token;
        const running = this._scanLoop(token).finally(() => {
            if (this._running === running)
                this._running = null;
        });
        this._running = running;
        return running;
    }

    async _scanLoop(token) {
        do {
            this._rerun = false;
            this._runStart = GLib.get_monotonic_time();
            await this._scan();
        } while (this._rerun && token === this._token);
    }

    _scan() {
        const generation = this._generation;
        return new Promise(resolve => {
            let proc;
            try {
                proc = Gio.Subprocess.new([
                    'gjs', GLib.build_filenamev([Me.path, 'scan.js']), Me.path, this._provider,
                    String(Math.max(1, this._getWindowDays())), String(this._serial),
                    JSON.stringify(this._getPrices()),
                ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (e) {
                logError(e, `claude-usage: failed to start ${this._provider} scan`);
                resolve();
                return;
            }
            this._proc = proc;
            proc.communicate_utf8_async(null, null, (_p, res) => {
                if (this._proc === proc)
                    this._proc = null;
                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    if (proc.get_if_signaled()) {
                        // stopped by _stopScan
                    } else if (!proc.get_successful()) {
                        log(`claude-usage: ${this._provider} scan failed: ${stderr.trim()}`);
                    } else if (generation === this._generation) {
                        this._merge(JSON.parse(stdout));
                    }
                } catch (e) {
                    logError(e, `claude-usage: ${this._provider} scan failed`);
                }
                resolve();
            });
        });
    }

    _merge(out) {
        if (out.reset)
            this._cache.clear();
        for (const [path, entry] of Object.entries(out.files))
            this._cache.set(path, entry);
        this._serial = out.reset ? out.serial : Math.max(this._serial, out.serial);
        this._version++; // results changed; drop memoized aggregations
    }

    _stopScan() {
        if (this._proc) {
            this._proc.force_exit();
            this._proc = null;
        }
    }

    // [perModel, total] for a single day key (defaults to today).
    aggregateDay(dayKey = Format.dayKey(Date.now())) {
        const perModel = {};
        const total = Format.emptyTotals();
        for (const { byDay } of this._cache.values()) {
            const day = byDay[dayKey];
            if (!day)
                continue;
            for (const [model, t] of Object.entries(day)) {
                if (!perModel[model])
                    perModel[model] = Format.emptyTotals();
                Format.addTotals(perModel[model], t);
                Format.addTotals(total, t);
            }
        }
        return [perModel, total];
    }

    // Token count for a totals object under the chosen metric.
    static _metricTokens(t, metric) {
        switch (metric) {
        case 'output': return t.output;
        case 'no-cache': return t.input + t.output;
        case 'all':
        default: return t.input + t.output + t.cacheRead + t.cacheWrite;
        }
    }

    // Day keys for "all time" — earliest cached day through today (capped at a
    // year so the bars stay drawable).
    _allDayKeys() {
        let min = null;
        for (const { byDay } of this._cache.values())
            for (const day of Object.keys(byDay))
                if (min === null || day < min)
                    min = day;
        if (min === null)
            return Format.lastNDayKeys(1);
        const [y, mo, d] = min.split('-').map(Number);
        const earliest = new Date(y, mo - 1, d).getTime();
        const n = Math.round((Format.startOfTodayMs() - earliest) / 86400000) + 1;
        return Format.lastNDayKeys(Math.min(Math.max(n, 1), 365));
    }

    // [{ day, main, sub }] tokens per day, oldest first. `days === 0` means all
    // time. `main`/`sub` split session vs subagent usage for the stacked graph.
    dailyTokens(days, metric = 'no-cache') {
        const keys = days > 0 ? Format.lastNDayKeys(days) : this._allDayKeys();
        const main = Object.fromEntries(keys.map(k => [k, 0]));
        const sub = Object.fromEntries(keys.map(k => [k, 0]));
        for (const { byDay, isSub } of this._cache.values()) {
            const bucket = isSub ? sub : main;
            for (const [day, perModel] of Object.entries(byDay)) {
                if (!(day in main))
                    continue;
                for (const t of Object.values(perModel))
                    bucket[day] += TranscriptReader._metricTokens(t, metric);
            }
        }
        return keys.map(day => ({ day, main: main[day], sub: sub[day] }));
    }

    // Memoize an aggregation by (cache version, key); these run several times
    // per menu rebuild (summary + model-share + projects all share a period).
    _memoize(key, compute) {
        if (this._memo.v !== this._version)
            this._memo = { v: this._version };
        if (!(key in this._memo))
            this._memo[key] = compute();
        return this._memo[key];
    }

    // [perModel, total] for all days on/after the local day containing startMs.
    aggregatePeriod(startMs) {
        const startKey = Format.dayKey(startMs);
        return this._memoize(`p:${startKey}`, () => {
            const perModel = {};
            const total = Format.emptyTotals();
            for (const { byDay } of this._cache.values()) {
                for (const [day, dayModels] of Object.entries(byDay)) {
                    if (day < startKey) // YYYY-MM-DD sorts lexically by date
                        continue;
                    for (const [model, t] of Object.entries(dayModels)) {
                        if (!perModel[model])
                            perModel[model] = Format.emptyTotals();
                        Format.addTotals(perModel[model], t);
                        Format.addTotals(total, t);
                    }
                }
            }
            return [perModel, total];
        });
    }

    // [{ project, total }] for the period starting at startMs, sorted by output.
    aggregateProjectsPeriod(startMs) {
        const startKey = Format.dayKey(startMs);
        return this._memoize(`pr:${startKey}`, () => this._computeProjects(startKey));
    }

    _computeProjects(startKey) {
        const byProject = {};
        for (const { project, byDay } of this._cache.values()) {
            for (const [day, dayModels] of Object.entries(byDay)) {
                if (day < startKey)
                    continue;
                if (!byProject[project])
                    byProject[project] = Format.emptyTotals();
                for (const t of Object.values(dayModels))
                    Format.addTotals(byProject[project], t);
            }
        }
        return Object.entries(byProject)
            .map(([project, total]) => ({ project, total }))
            .filter(p => p.total.messages > 0)
            .sort((a, b) => b.total.output - a.total.output);
    }

    // { day: tokens of every kind } over all cached days (local days).
    tokensByDay() {
        return this._memoize('tbd', () => {
            const out = {};
            for (const { byDay } of this._cache.values()) {
                for (const [day, dayModels] of Object.entries(byDay)) {
                    for (const t of Object.values(dayModels))
                        out[day] = (out[day] || 0) + TranscriptReader._metricTokens(t, 'all');
                }
            }
            return out;
        });
    }

    // Utilization samples from the logs, oldest first, in UtilHistory's shape.
    limitSamples() {
        return this._memoize('limits', () => {
            const all = [];
            for (const { limits } of this._cache.values()) {
                if (limits)
                    all.push(...limits);
            }
            return all.sort((a, b) => a.t - b.t);
        });
    }

    // Drop the merged results after a price change; the next scan re-prices
    // the files still on disk and keeps the rest of the saved cache.
    invalidate() {
        this._token++;
        this._stopScan();
        this._running = null;
        this._cache.clear();
        this._serial = 0;
        this._version++;
        this._generation++;
    }

    destroy() {
        this._token++;
        this._generation++;
        this._stopScan();
        this._running = null;
    }
};
