/* Token/cost accounting from ~/.claude transcripts.
 *
 * Files are loaded asynchronously (Gio load_contents_async) so disk I/O never
 * blocks the shell's main loop, and parsed results are cached per file by
 * (mtime, size). Each file is parsed into per-calendar-day, per-model totals
 * for the configured window, so the same cache serves both today's breakdown
 * and the multi-day cost-history graph.
 *
 * The whole cache is also persisted to disk: transcripts are append-only and
 * historic files never change, so on a restart we load the saved summaries and
 * only re-parse files whose (mtime, size) changed — usually just the active
 * session file. This keeps menu-open fast even on a cold shell. */

const { GLib, Gio } = imports.gi;
const ByteArray = imports.byteArray;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Pricing = Me.imports.lib.pricing;
const Format = Me.imports.lib.format;

const PROJECTS_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects']);
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'claude-usage']);
const CACHE_PATH = GLib.build_filenamev([CACHE_DIR, 'transcripts-cache.json']);
const CACHE_VERSION = 1;

var TranscriptReader = class TranscriptReader {
    // getPrices:      () => prices table (live from settings)
    // getWindowDays:  () => how many days back to keep/parse
    constructor(getPrices, getWindowDays) {
        this._getPrices = getPrices;
        this._getWindowDays = getWindowDays;
        this._cache = new Map(); // path -> { mtime, size, project, byDay }
        // Grow-only coverage: the oldest day currently parsed into the cache.
        // We never shrink it, so switching to a *shorter* period (year → day)
        // needs no re-parse — aggregations just slice the data already cached.
        this._coverageStart = null; // ms, or null when nothing parsed yet
        // Bumped on every refresh; invalidates the aggregation memo below.
        this._version = 0;
        this._memo = { v: -1 };
        // Persistent on-disk cache.
        this._loaded = false; // have we tried to load the saved cache yet?
        this._dirty = false;  // does the on-disk cache need rewriting?
    }

    // Prices are baked into each cached entry's cost; tag the saved cache with
    // them so a price change (made while disabled) doesn't load stale costs.
    _pricingKey() {
        return JSON.stringify(this._getPrices());
    }

    _loadPersisted() {
        if (this._loaded)
            return;
        this._loaded = true;
        let data;
        try {
            const [, bytes] = GLib.file_get_contents(CACHE_PATH);
            data = JSON.parse(ByteArray.toString(bytes));
        } catch (e) {
            return; // no cache yet, or unreadable
        }
        if (!data || data.version !== CACHE_VERSION ||
            data.pricingKey !== this._pricingKey())
            return; // incompatible — re-parse from scratch
        if (typeof data.coverageStart === 'number')
            this._coverageStart = data.coverageStart;
        for (const [path, entry] of Object.entries(data.files || {}))
            this._cache.set(path, entry);
    }

    _savePersisted() {
        const files = {};
        for (const [path, entry] of this._cache)
            files[path] = entry;
        const data = {
            version: CACHE_VERSION,
            pricingKey: this._pricingKey(),
            coverageStart: this._coverageStart,
            files,
        };
        try {
            GLib.mkdir_with_parents(CACHE_DIR, 0o755);
            GLib.file_set_contents(CACHE_PATH, JSON.stringify(data));
        } catch (e) {
            logError(e, 'claude-usage: failed to save transcript cache');
        }
    }

    _listFiles() {
        const files = [];
        const root = Gio.File.new_for_path(PROJECTS_DIR);
        let dirs;
        try {
            dirs = root.enumerate_children('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            return files;
        }
        let dirInfo;
        while ((dirInfo = dirs.next_file(null)) !== null) {
            if (dirInfo.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            const sub = root.get_child(dirInfo.get_name());
            let entries;
            try {
                entries = sub.enumerate_children('standard::name,time::modified,standard::size',
                    Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                continue;
            }
            let info;
            while ((info = entries.next_file(null)) !== null) {
                const name = info.get_name();
                if (!name.endsWith('.jsonl'))
                    continue;
                files.push({
                    path: sub.get_child(name).get_path(),
                    project: dirInfo.get_name(),
                    mtime: info.get_attribute_uint64('time::modified'),
                    size: info.get_size(),
                });
            }
            entries.close(null);
        }
        dirs.close(null);
        return files;
    }

    _loadAndParse(file, windowStart) {
        return new Promise(resolve => {
            const gfile = Gio.File.new_for_path(file.path);
            gfile.load_contents_async(null, (obj, res) => {
                let text;
                try {
                    const [, contents] = gfile.load_contents_finish(res);
                    text = ByteArray.toString(contents);
                } catch (e) {
                    resolve();
                    return;
                }
                this._cache.set(file.path, {
                    mtime: file.mtime,
                    size: file.size,
                    project: file.project,
                    byDay: this._parse(text, windowStart),
                });
                this._dirty = true;
                resolve();
            });
        });
    }

    // Returns { dayKey: { model: totals } } for assistant entries since windowStart.
    _parse(text, windowStart) {
        const prices = this._getPrices();
        // Transcripts can repeat an assistant message (streaming rewrites) under
        // the same id — keep the last occurrence per id, with its timestamp.
        const byId = new Map();
        let anon = 0;
        for (const line of text.split('\n')) {
            if (!line)
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
            const id = o.message.id || `anon-${anon++}`;
            byId.set(id, { msg: o.message, ts });
        }

        const byDay = {};
        for (const { msg, ts } of byId.values()) {
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

            const key = Format.dayKey(ts);
            if (!byDay[key])
                byDay[key] = {};
            const perModel = byDay[key];
            if (!perModel[model])
                perModel[model] = Format.emptyTotals();
            const t = perModel[model];
            t.input += input;
            t.output += output;
            t.cacheRead += cacheRead;
            t.cacheWrite += write5m + write1h;
            t.messages += 1;
            t.cost += Pricing.messageCost(prices, model,
                { input, output, cacheRead, write5m, write1h });
        }
        return byDay;
    }

    async refresh() {
        this._loadPersisted();

        const days = Math.max(1, this._getWindowDays());
        const desired = Format.windowStartMs(days);

        // Only grow coverage. If we need older data than we have, re-parse every
        // in-window file at the new (older) start; existing entries stay visible
        // until each file's fresh parse overwrites them (no blank flash).
        const grow = this._coverageStart === null || desired < this._coverageStart;
        if (grow) {
            this._coverageStart = desired;
            this._dirty = true;
        }
        const start = this._coverageStart;

        const seen = new Set();
        const jobs = [];
        for (const f of this._listFiles()) {
            seen.add(f.path);
            if (f.mtime * 1000 < start) {
                if (this._cache.delete(f.path))
                    this._dirty = true;
                continue;
            }
            const cached = this._cache.get(f.path);
            if (!grow && cached && cached.mtime === f.mtime && cached.size === f.size)
                continue;
            jobs.push(this._loadAndParse(f, start));
        }
        for (const path of [...this._cache.keys()]) {
            if (!seen.has(path)) {
                this._cache.delete(path);
                this._dirty = true;
            }
        }
        await Promise.all(jobs);
        this._version++; // results changed; drop memoized aggregations
        if (this._dirty) {
            this._dirty = false;
            this._savePersisted();
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

    // [{ day, tokens }] for the last `days` days, oldest first.
    dailyTokens(days, metric = 'no-cache') {
        const keys = Format.lastNDayKeys(days);
        const sums = Object.fromEntries(keys.map(k => [k, 0]));
        for (const { byDay } of this._cache.values()) {
            for (const [day, perModel] of Object.entries(byDay)) {
                if (!(day in sums))
                    continue;
                for (const t of Object.values(perModel))
                    sums[day] += TranscriptReader._metricTokens(t, metric);
            }
        }
        return keys.map(day => ({ day, tokens: sums[day] }));
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

    // Force a full re-parse on next refresh (e.g. after a pricing change, which
    // changes the cost baked into every cached entry).
    invalidate() {
        this._cache.clear();
        this._coverageStart = null;
        this._version++;
        this._dirty = false;
        try {
            Gio.File.new_for_path(CACHE_PATH).delete(null);
        } catch (e) {
            // no cache file to remove
        }
    }
};
