/* Claude Code & Codex Usage — GNOME Shell 42 extension (legacy, non-ESM).
 *
 * One top-bar button per provider (Claude, and Codex when ~/.codex is signed
 * in), sharing one set of preferences. Each: optional icon (recolorable) +
 * configurable text. Dropdown: subscription utilization bars (with a
 * time-elapsed marker), tokens per model, and optional Cairo graphs (daily
 * tokens, utilization trend, model share). Every visible element is toggleable
 * from preferences.
 *
 * This file is just the indicator UI + orchestration; data sources live in
 * lib/ (usage.js, codexUsage.js, transcripts.js, history.js, graphs.js,
 * pricing/format, settings.js). */

const { GLib, Gio, St, Clutter, GObject, Graphene, Pango } = imports.gi;
const ByteArray = imports.byteArray;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const Settings = Me.imports.lib.settings;
const Pricing = Me.imports.lib.pricing;
const Format = Me.imports.lib.format;
const Graphs = Me.imports.lib.graphs;
const { UsageClient } = Me.imports.lib.usage;
const CodexUsage = Me.imports.lib.codexUsage;
const { TranscriptReader } = Me.imports.lib.transcripts;
const { UtilHistory } = Me.imports.lib.history;

const K = Settings.KEYS;
const ICON_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'claude-usage', 'icons']);
const ICON_BASE_FILL = '#eeeeec'; // fill in the provider svgs we recolor
const SUB_COLOR = { r: 0.42, g: 0.55, b: 0.65 }; // subagent bars (muted slate)
const ALL_DAYS = 36500; // cost-history-days = 0 means "all time"

const PROVIDERS = [
    {
        id: 'claude', name: 'Claude', role: 'claude-usage', icon: 'claude.svg',
        historyFile: 'util-history.jsonl', Client: UsageClient,
    },
    {
        id: 'codex', name: 'Codex', role: 'codex-usage', icon: 'codex.svg',
        historyFile: 'codex-util-history.jsonl', Client: CodexUsage.CodexUsageClient,
        available: CodexUsage.available, limitsInLogs: true,
    },
];

// Theme-neutral "dim" text: smaller font via CSS, faded via actor opacity.
function dim(label) {
    label.add_style_class_name('claude-dim');
    label.opacity = 165;
    return label;
}

const Indicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(settings, provider) {
        super._init(0.0, `${provider.name} Usage`);
        this._settings = settings;
        this._provider = provider;

        // --- panel button ---
        this._box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
        this._icon = new St.Icon({
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 5px;',
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._box.add_child(this._icon);
        this._box.add_child(this._label);
        this.add_child(this._box);

        // --- data sources ---
        this._usageClient = new provider.Client();
        this._history = new UtilHistory(provider.historyFile);
        this._history.load();
        this._transcripts = new TranscriptReader(provider.id,
            () => Pricing.parsePricing(this._settings.get_string(K.PRICING)),
            // Parse enough days for the cost graph and the selected summary period.
            () => {
                const ch = this._settings.get_int(K.COST_HISTORY_DAYS);
                return Math.max(ch === 0 ? ALL_DAYS : ch,
                    Format.periodLookbackDays(this._settings.get_string(K.PERIOD)));
            });
        this._pricingKey = this._transcripts.pricingKey();

        // --- state ---
        this._timeoutId = 0;
        this._usage = null;
        this._usageState = 'pending'; // pending | ok | ratelimited | error
        this._lastUsageAttempt = 0;
        this._lastUsageOk = 0;
        this._lastTranscriptRefresh = 0;
        this._plan = '';
        this._destroyed = false;
        this._openFamilies = new Set(); // model families expanded in the summary

        this._settingsChangedId = this._settings.connect('changed',
            (_s, key) => this._onSettingChanged(key));
        // The dropdown (graphs, per-model rows, transcript parsing) is rebuilt
        // only while it's open — see _updateUi / _onMenuOpen.
        this._openStateId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._onMenuOpen();
            else
                this._openFamilies.clear();
        });

        this._applyIcon();
        this._applyPanelVisibility();
        this._refresh();
        this._startTimer();
    }

    /* --- icon --- */

    _iconColor() {
        switch (this._settings.get_string(K.ICON_COLOR)) {
        case 'orange': return '#D97757';
        case 'accent': return this._settings.get_string(K.ACCENT_COLOR) || '#D97757';
        case 'white':
        default:        return '#ffffff';
        }
    }

    // Recolor the provider's svg to the chosen color, write it under the state dir, and
    // point the panel icon at it. The filename embeds the color so St doesn't
    // serve a stale cached texture when the color changes.
    _applyIcon() {
        const color = this._iconColor();
        const slug = color.replace(/[^0-9a-zA-Z]/g, '');
        const svgPath = `${Me.path}/${this._provider.icon}`;
        const outPath = GLib.build_filenamev([ICON_DIR, `${this._provider.id}-${slug}.svg`]);
        try {
            if (!Gio.File.new_for_path(outPath).query_exists(null)) {
                try {
                    Gio.File.new_for_path(ICON_DIR).make_directory_with_parents(null);
                } catch (e) {
                    // directory already exists — fine
                }
                const [, bytes] = GLib.file_get_contents(svgPath);
                const svg = ByteArray.toString(bytes).split(ICON_BASE_FILL).join(color);
                GLib.file_set_contents(outPath, svg);
            }
            this._icon.gicon = Gio.icon_new_for_string(outPath);
        } catch (e) {
            logError(e, 'claude-usage: icon recolor failed');
            this._icon.gicon = Gio.icon_new_for_string(svgPath);
        }
    }

    /* --- settings reactions --- */

    _startTimer() {
        this._stopTimer();
        const seconds = this._settings.get_int(K.REFRESH_SECONDS);
        this._lastTick = GLib.get_monotonic_time();
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, seconds, () => {
                this._lastTick = GLib.get_monotonic_time();
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    // GJS 1.72 can drop a callback during GC with an undefined return value,
    // which may remove the source; its id is then stale.
    _stopTimer() {
        if (this._timeoutId && GLib.MainContext.default().find_source_by_id(this._timeoutId))
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }

    _ensureTimer() {
        const seconds = this._settings.get_int(K.REFRESH_SECONDS);
        if (GLib.get_monotonic_time() - this._lastTick > 2 * seconds * 1000000)
            this._startTimer();
    }

    _onSettingChanged(key) {
        switch (key) {
        case K.REFRESH_SECONDS:
            this._startTimer();
            break;
        case K.PRICING: {
            // Cost is baked into the cache; re-parse when this provider's prices changed.
            const pricingKey = this._transcripts.pricingKey();
            if (pricingKey === this._pricingKey)
                return;
            this._pricingKey = pricingKey;
            this._transcripts.invalidate();
            this._refreshTranscripts().then(() => this._updateUi());
            return;
        }
        case K.COST_HISTORY_DAYS:
        case K.PERIOD:
            // Grow-only cache: shrinking is instant, growing re-parses only the
            // extra days. No full invalidate.
            this._refreshTranscripts().then(() => this._updateUi());
            return;
        case K.ICON_COLOR:
            this._applyIcon();
            return;
        case K.ACCENT_COLOR:
            this._applyIcon(); // matters when icon-color = accent
            break;
        case K.SHOW_ICON:
        case K.SHOW_PANEL_TEXT:
            this._applyPanelVisibility();
            break;
        }
        this._updateUi();
    }

    _applyPanelVisibility() {
        this._icon.visible = this._settings.get_boolean(K.SHOW_ICON);
        this._label.visible = this._settings.get_boolean(K.SHOW_PANEL_TEXT);
    }

    /* --- refresh orchestration --- */

    // The panel text only needs transcripts when it shows cost.
    _panelNeedsCost() {
        const f = this._settings.get_string(K.PANEL_FORMAT);
        return f === 'cost' || f === 'five-week-cost';
    }

    // Periodic tick. Keeps usage current; parses transcripts only when the menu
    // is open or the panel shows cost (and then no faster than the usage
    // cadence). While the menu is closed and idle this does almost nothing.
    _refresh(force = false) {
        const now = Date.now() / 1000;
        const cadence = this._settings.get_int(K.USAGE_REFRESH_SECONDS);

        if (force || this._lastUsageAttempt === 0 || now - this._lastUsageAttempt >= cadence)
            this._fetchUsage();

        const transcriptsDue = this.menu.isOpen ||
            (this._panelNeedsCost() && now - this._lastTranscriptRefresh >= cadence);
        if (force || transcriptsDue) {
            this._lastTranscriptRefresh = now;
            this._refreshTranscripts().then(() => this._updateUi());
        } else {
            this._updateUi();
        }
    }

    // Pull fresh data when the user opens the menu, then rebuild it.
    _onMenuOpen() {
        this._ensureTimer();
        this._lastTranscriptRefresh = Date.now() / 1000;
        // Starting the refresh first loads the saved cache synchronously.
        const refreshed = this._refreshTranscripts();
        this._updateUi(); // show immediately with whatever is cached
        refreshed.then(() => this._updateUi());
    }

    async _refreshTranscripts() {
        try {
            await this._transcripts.refresh();
        } catch (e) {
            logError(e, `claude-usage: ${this._provider.id} log refresh failed`);
        }
    }

    _fetchUsage() {
        this._lastUsageAttempt = Date.now() / 1000;
        this._usageClient.fetch().then(({ state, data, plan }) => {
            if (this._destroyed)
                return;
            if (plan)
                this._plan = plan;
            this._usageState = state;
            if (state === 'ok' && data) {
                this._usage = data;
                this._lastUsageOk = Date.now() / 1000;
                this._history.record(data);
                this._updateUi();
            } else if (!this._usage && this._provider.limitsInLogs) {
                // The log fallback (_usageView) needs the cache loaded.
                this._refreshTranscripts().then(() => this._updateUi());
            } else {
                this._updateUi();
            }
        });
    }

    // The live usage payload, else one built from the newest utilization
    // sample in the logs (Codex logs record them), with its time: [data, t].
    _usageView() {
        if (this._usage)
            return [this._usage, this._lastUsageOk];
        const samples = this._transcripts.limitSamples();
        const last = samples[samples.length - 1];
        if (!last)
            return [null, 0];
        const now = Date.now() / 1000;
        const bucket = (pct, reset) => (pct === null ? null : {
            utilization: reset && reset < now ? null : pct,
            resets_at: reset ? new Date(reset * 1000).toISOString() : null,
        });
        return [{ five_hour: bucket(last.five, last.fr), seven_day: bucket(last.week, last.wr) }, last.t];
    }

    /* --- shared helpers --- */

    _accent() {
        return this._settings.get_string(K.ACCENT_COLOR) || '#D97757';
    }

    _accentRgb() {
        return Format.parseColor(this._accent());
    }

    _barWidth() {
        return this._settings.get_int(K.BAR_WIDTH);
    }

    _statusGlyph() {
        return this._usageState === 'error'
            ? this._settings.get_string(K.STATUS_ERROR)
            : this._settings.get_string(K.STATUS_LOADING);
    }

    /* --- UI building blocks --- */

    _row(opts = {}) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: true, activate: false, hover: false, can_focus: false,
            ...opts,
        });
        this.menu.addMenuItem(item);
        return item;
    }

    _graphRow(widget) {
        const item = this._row();
        item.add_child(widget);
        return item;
    }

    _twoColRow(leftText, rightText, { leftClass, rightClass } = {}) {
        const item = this._row();
        const left = new St.Label({
            text: leftText, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        if (leftClass)
            left.add_style_class_name(leftClass);
        const right = new St.Label({ text: rightText, y_align: Clutter.ActorAlign.CENTER });
        if (rightClass)
            right.add_style_class_name(rightClass);
        else
            dim(right);
        item.add_child(left);
        item.add_child(right);
        return item;
    }

    // Row with a leading chevron slot (invisible when nested), so family and
    // version labels line up. Returns [item, chevron].
    _treeRow(text, rightText, nested) {
        const item = this._row({ hover: !nested });
        // Ubuntu has no '⌄', so "open" is the same '›' turned down.
        const arrow = new St.Label({
            text: '›', y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            opacity: nested ? 0 : 165,
        });
        item.add_child(arrow);
        item.add_child(new St.Label({
            text, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style: nested ? 'padding-left: 16px;' : '',
        }));
        item.add_child(dim(new St.Label({ text: rightText, y_align: Clutter.ActorAlign.CENTER })));
        return [item, arrow];
    }

    // A family row whose version rows stay hidden until it is clicked. Open
    // families survive menu rebuilds and collapse when the menu closes.
    _familyRows(family, rightText, versions) {
        const [item, arrow] = this._treeRow(family, rightText, false);
        const rows = versions.map(([name, text]) => this._treeRow(name, text, true)[0]);
        if (rows.length === 0) {
            arrow.opacity = 0;
            return;
        }
        const show = open => {
            arrow.rotation_angle_z = open ? 90 : 0;
            for (const row of rows)
                row.visible = open;
        };
        show(this._openFamilies.has(family));
        item.connect('button-release-event', () => {
            const open = !this._openFamilies.has(family);
            if (open)
                this._openFamilies.add(family);
            else
                this._openFamilies.delete(family);
            show(open);
            return Clutter.EVENT_STOP;
        });
    }

    // `elapsed` (0..1), when given, draws a time-elapsed marker on the bar and
    // shows the elapsed % next to the utilization % (merged-in burn-down).
    _barRow(title, subtitle, pct, elapsed = null) {
        const item = this._row();
        const vbox = new St.BoxLayout({ vertical: true, x_expand: true });

        const hbox = new St.BoxLayout({ x_expand: true });
        hbox.add_child(new St.Label({ text: title }));
        if (subtitle) {
            const sub = new St.Label({ text: `  ${subtitle}`, y_align: Clutter.ActorAlign.END });
            dim(sub);
            hbox.add_child(sub);
        }
        hbox.add_child(new St.Widget({ x_expand: true }));
        const pctLabel = new St.Label({ text: pct === null ? '–' : `${Math.round(pct)}%` });
        pctLabel.add_style_class_name('claude-pct');
        hbox.add_child(pctLabel);
        if (elapsed !== null) {
            const el = new St.Label({ text: ` · ${Math.round(elapsed * 100)}%` });
            dim(el);
            hbox.add_child(el);
        }
        vbox.add_child(hbox);

        vbox.add_child(Graphs.usageBar({
            pct, elapsed, color: this._accentRgb(), width: this._barWidth(),
        }));
        item.add_child(vbox);
        return item;
    }

    _separator() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    /* --- panel text --- */

    _panelText() {
        const [u] = this._usageView();
        const five = u ? Format.pctOf(u.five_hour) : null;
        const week = u ? Format.pctOf(u.seven_day) : null;
        const fStr = five === null ? '–' : `${Math.round(five)}%`;
        const wStr = week === null ? '–' : `${Math.round(week)}%`;

        const [, total] = this._transcripts.aggregateDay();
        const costStr = `$${total.cost.toFixed(2)}`;

        const haveUsage = five !== null || week !== null;
        const fiveWeek = five === null ? wStr : `${fStr} · ${wStr}`;
        const ph = this._statusGlyph();
        const format = this._settings.get_string(K.PANEL_FORMAT);

        switch (format) {
        case 'cost':
            return costStr;
        case 'five':
            return haveUsage ? (five === null ? wStr : fStr) : ph;
        case 'week':
            return haveUsage ? wStr : ph;
        case 'five-week-cost':
            return haveUsage ? `${fiveWeek} · ${costStr}` : `${ph} · ${costStr}`;
        case 'five-week':
        default:
            return haveUsage ? fiveWeek : ph;
        }
    }

    /* --- UI --- */

    _updateUi() {
        if (this._destroyed)
            return;
        const text = this._panelText();
        if (this._label.text !== text) // avoid needless panel relayout
            this._label.text = text;
        // Rebuilding allocates many actors (incl. Cairo graphs), so on the idle
        // timer we skip it. But the menu must never be left empty — GNOME won't
        // open an empty PopupMenu — so (re)build when open OR currently empty.
        if (this.menu.isOpen || this.menu.isEmpty())
            this._rebuildMenu();
    }

    /* --- dropdown blocks (rendered in the configured order) --- */

    _blockWillRender(id) {
        const s = this._settings;
        switch (id) {
        case 'usage': return s.get_boolean(K.SHOW_USAGE_SECTION);
        case 'today': return s.get_boolean(K.SHOW_TODAY_SECTION);
        case 'projects':
            return s.get_boolean(K.SHOW_PROJECTS_SECTION) &&
                this._transcripts.aggregateProjectsPeriod(this._periodStart()).length > 0;
        case 'graph-cost': return s.get_boolean(K.SHOW_GRAPH_COST);
        case 'graph-util': return s.get_boolean(K.SHOW_GRAPH_UTIL);
        case 'graph-models': return s.get_boolean(K.SHOW_GRAPH_MODELS);
        }
        return false;
    }

    _renderBlock(id) {
        switch (id) {
        case 'usage': this._renderUsage(); break;
        case 'today': this._renderSummary(); break;
        case 'projects': this._renderProjects(); break;
        case 'graph-cost': this._renderGraphCost(); break;
        case 'graph-util': this._renderGraphUtil(); break;
        case 'graph-models': this._renderGraphModels(); break;
        }
    }

    // Fraction of a window elapsed, from its resets_at and length (ms).
    _elapsed(bucket, windowMs) {
        const ts = Date.parse(bucket?.resets_at || '');
        if (isNaN(ts))
            return null;
        return Math.max(0, Math.min(1, (windowMs - (ts - Date.now())) / windowMs));
    }

    _renderUsage() {
        const [u] = this._usageView();
        if (u) {
            if (u.five_hour) {
                this._barRow('Session (5h)',
                    `resets ${Format.fmtReset(u.five_hour.resets_at)}`,
                    Format.pctOf(u.five_hour), this._elapsed(u.five_hour, 5 * 3600 * 1000));
            }
            this._barRow('Week',
                `resets ${Format.fmtReset(u.seven_day?.resets_at)}`,
                Format.pctOf(u.seven_day), this._elapsed(u.seven_day, 7 * 24 * 3600 * 1000));
            if (typeof u.reset_credits === 'number')
                this._twoColRow('Limit resets available', `${u.reset_credits}`);
            if (this._settings.get_boolean(K.SHOW_MODEL_USAGE_BARS))
                this._renderModelUsageBars(u);
        } else {
            this._twoColRow({
                ratelimited: 'Usage API rate-limited',
                error: 'Usage unavailable',
                pending: 'Fetching usage…',
                ok: 'Fetching usage…',
            }[this._usageState], '');
        }
    }

    // Per-model weekly usage. The API moved these into the `limits` array as
    // model-scoped weekly entries (e.g. Fable); the old seven_day_opus/sonnet
    // buckets are now null. Fall back to those buckets for the older shape.
    _renderModelUsageBars(u) {
        const WEEK = 7 * 24 * 3600 * 1000;
        const bars = [];
        if (Array.isArray(u.limits)) {
            for (const lim of u.limits) {
                const model = lim.scope && lim.scope.model && lim.scope.model.display_name;
                if (model && lim.group === 'weekly' && lim.percent != null)
                    bars.push([`Week · ${model}`, Math.max(0, Math.min(100, lim.percent)),
                        this._elapsed(lim, WEEK)]);
            }
        }
        if (bars.length === 0) {
            for (const [key, name] of [['seven_day_opus', 'Week · Opus'],
                                       ['seven_day_sonnet', 'Week · Sonnet']]) {
                const pct = Format.pctOf(u[key]);
                if (pct !== null)
                    bars.push([name, pct, this._elapsed(u[key], WEEK)]);
            }
        }
        for (const [name, pct, elapsed] of bars)
            this._barRow(name, '', pct, elapsed);
    }

    /* --- selectable period (day/week/month/year) --- */

    _period() {
        return this._settings.get_string(K.PERIOD);
    }

    _periodStart() {
        return Format.periodStartMs(this._period());
    }

    // Any block that the period affects (used to decide if the header selector
    // is worth showing).
    _periodInUse() {
        const s = this._settings;
        return s.get_boolean(K.SHOW_TODAY_SECTION) ||
            s.get_boolean(K.SHOW_PROJECTS_SECTION) ||
            s.get_boolean(K.SHOW_GRAPH_MODELS);
    }

    // Single header button showing the current period letter (D/W/M/Y).
    // Left-click advances to the next period, right-click goes back; both wrap.
    _periodButton() {
        const order = ['day', 'week', 'month', 'year', 'all'];
        const labels = { day: 'D', week: 'W', month: 'M', year: 'Y', all: 'A' };
        const cur = this._period();
        const btn = new St.Button({
            label: labels[cur] || 'D',
            style_class: 'claude-seg claude-seg-active',
            style: 'margin-left: 8px;',
            y_align: Clutter.ActorAlign.CENTER,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        });
        btn.connect('clicked', (_b, clickedButton) => {
            const i = Math.max(0, order.indexOf(this._period()));
            const delta = clickedButton === 3 ? -1 : 1; // right-click = back
            this._settings.set_string(K.PERIOD, order[(i + delta + order.length) % order.length]);
        });
        return btn;
    }

    _renderSummary() {
        const s = this._settings;
        const [perModel, total] = this._transcripts.aggregatePeriod(this._periodStart());
        this._twoColRow(Format.periodLabel(this._period()), `${total.messages} messages`,
            { leftClass: 'claude-header' });

        if (total.messages === 0) {
            this._twoColRow('', 'no activity yet');
            return;
        }
        if (s.get_boolean(K.SHOW_MODEL_BREAKDOWN)) {
            const usage = t => `out ${Format.fmtTokens(t.output)} · ${t.messages} msgs`;
            for (const { family, total: ft, models } of Format.groupByFamily(perModel)) {
                this._familyRows(family, usage(ft), models
                    .map(([model, t]) => [Format.prettyModel(model), usage(t)])
                    .filter(([name]) => name !== family));
            }
        }
        if (s.get_boolean(K.SHOW_TOKEN_DETAILS)) {
            this._twoColRow('', `in ${Format.fmtTokens(total.input)} · cache ` +
                `${Format.fmtTokens(total.cacheRead)}r / ${Format.fmtTokens(total.cacheWrite)}w`);
        }
        if (s.get_boolean(K.SHOW_COST))
            this._twoColRow('', `≈ $${total.cost.toFixed(2)} at API prices`);
    }

    _renderProjects() {
        const projects = this._transcripts.aggregateProjectsPeriod(this._periodStart());
        const max = this._settings.get_int(K.PROJECTS_MAX);
        this._twoColRow('Projects', `${projects.length}`, { leftClass: 'claude-header' });
        for (const { project, total } of projects.slice(0, max)) {
            this._twoColRow(`  ${Format.prettyProject(project)}`,
                `out ${Format.fmtTokens(total.output)} · ${total.messages} msgs`);
        }
    }

    _renderGraphCost() {
        const s = this._settings;
        const days = s.get_int(K.COST_HISTORY_DAYS);
        const metric = s.get_string(K.TOKEN_METRIC);
        this._graphRow(Graphs.tokensGraph({
            values: this._transcripts.dailyTokens(days, metric),
            color: this._accentRgb(), subColor: SUB_COLOR, width: this._barWidth(),
            labeled: true, label: Settings.rangeLabel(days),
            onCycle: delta => s.set_int(K.COST_HISTORY_DAYS,
                Settings.cycleRange(Settings.TOKEN_RANGES, days, delta)),
        }));
    }

    _renderGraphUtil() {
        const s = this._settings;
        const days = s.get_int(K.UTIL_TREND_DAYS);
        const cutoff = days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
        const samples = this._history.samples(days)
            .concat(this._transcripts.limitSamples().filter(x => x.t >= cutoff))
            .sort((a, b) => a.t - b.t);
        this._graphRow(Graphs.utilGraph({
            samples, days,
            color: this._accentRgb(), width: this._barWidth(), labeled: true,
            label: Settings.rangeLabel(days),
            onCycle: delta => s.set_int(K.UTIL_TREND_DAYS,
                Settings.cycleRange(Settings.UTIL_RANGES, days, delta)),
        }));
    }

    _renderGraphModels() {
        const [perModel] = this._transcripts.aggregatePeriod(this._periodStart());
        const segments = Format.groupByFamily(perModel)
            .map(({ family, total }) => ({ label: family, value: total.output }))
            .filter(seg => seg.value > 0);
        this._graphRow(Graphs.modelGraph({
            segments, accent: this._accentRgb(), width: this._barWidth(), labeled: true,
        }));
    }

    _rebuildMenu() {
        this.menu.removeAll();
        const s = this._settings;

        // Header: title + last-updated + refresh + settings buttons.
        const header = this._row();
        const name = this._provider.name;
        const title = new St.Label({
            text: this._plan ? `${name} · ${this._plan}` : name,
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        title.add_style_class_name('claude-header');
        header.add_child(title);
        const updatedParts = [];
        const [, usageTime] = this._usageView();
        if (usageTime) {
            const t = GLib.DateTime.new_from_unix_local(Math.floor(usageTime));
            const fmt = Date.now() / 1000 - usageTime < 86400 ? '%H:%M' : '%b %d %H:%M';
            updatedParts.push(this._usage ? t.format(fmt) : `logs ${t.format(fmt)}`);
        }
        if (this._usageState === 'ratelimited')
            updatedParts.push(s.get_string(K.STATUS_RATELIMITED));
        const updated = new St.Label({ text: updatedParts.join(' '), y_align: Clutter.ActorAlign.CENTER });
        dim(updated);
        header.add_child(updated);

        const iconBtn = name => {
            const btn = new St.Button({
                style_class: 'claude-refresh-button',
                child: new St.Icon({ icon_name: name, icon_size: 14 }),
            });
            header.add_child(btn);
            return btn;
        };
        // Order: refresh · period · settings.
        iconBtn('view-refresh-symbolic').connect('clicked', () => this._refresh(true));
        if (this._periodInUse())
            header.add_child(this._periodButton());
        iconBtn('emblem-system-symbolic').connect('clicked', () => {
            this.menu.close();
            ExtensionUtils.openPrefs();
        });

        // Ordered blocks, with separators between adjacent rendered blocks
        // (but not between two consecutive graphs).
        const kindOf = Object.fromEntries(Settings.BLOCKS.map(b => [b.id, b.kind]));
        const order = Settings.normalizeOrder(s.get_strv(K.SECTION_ORDER));
        let prevKind = null;
        for (const id of order) {
            if (!this._blockWillRender(id))
                continue;
            const kind = kindOf[id];
            if (prevKind !== null && !(prevKind === 'graph' && kind === 'graph'))
                this._separator();
            this._renderBlock(id);
            prevKind = kind;
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._openStateId) {
            this.menu.disconnect(this._openStateId);
            this._openStateId = 0;
        }
        this._stopTimer();
        this._transcripts.destroy();
        if (this._usageClient) {
            this._usageClient.destroy();
            this._usageClient = null;
        }
        super.destroy();
    }
});

class Extension {
    enable() {
        this._settings = Settings.getSettings();
        this._indicators = [];
        // Each one goes in at the same panel slot, so the last added sits leftmost.
        for (const provider of PROVIDERS.slice().reverse()) {
            if (provider.available && !provider.available())
                continue;
            const indicator = new Indicator(this._settings, provider);
            Main.panel.addToStatusArea(provider.role, indicator);
            this._indicators.push(indicator);
        }
    }

    disable() {
        for (const indicator of this._indicators)
            indicator.destroy();
        this._indicators = [];
        this._settings = null;
    }
}

function init() {
    return new Extension();
}
