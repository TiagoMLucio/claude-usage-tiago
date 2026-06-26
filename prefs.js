/* Preferences UI (GTK4 + libadwaita) for Claude Code Usage.
 *
 * Widgets bind to GSettings so changes apply live in the running shell.
 * Dependent options are nested in Adw.ExpanderRows whose enable-switch is the
 * parent toggle, so sub-options collapse/grey out when the parent is off. */

const { Adw, Gtk, Gdk, Gio, GObject, GLib } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const Settings = Me.imports.lib.settings;
const Pricing = Me.imports.lib.pricing;

const K = Settings.KEYS;
const FLAGS = Gio.SettingsBindFlags.DEFAULT;

const PANEL_FORMATS = [
    ['five-week', '5h% · week%'],
    ['five', '5h% only'],
    ['week', 'week% only'],
    ['cost', "today's cost"],
    ['five-week-cost', '5h% · week% · cost'],
];
const ICON_COLORS = [
    ['white', 'White'],
    ['orange', 'Original orange'],
    ['accent', 'Follow accent color'],
];
const TOKEN_METRICS = [
    ['no-cache', 'Input + output (no cache)'],
    ['all', 'All tokens (incl. cache)'],
    ['output', 'Output only'],
];

function init() {
}

/* --- row factories --- */

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({ title, subtitle: subtitle || null });
    const sw = new Gtk.Switch({ active: settings.get_boolean(key), valign: Gtk.Align.CENTER });
    settings.bind(key, sw, 'active', FLAGS);
    row.add_suffix(sw);
    row.activatable_widget = sw;
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.ActionRow({ title, subtitle: subtitle || null });
    const spin = new Gtk.SpinButton({
        valign: Gtk.Align.CENTER,
        adjustment: new Gtk.Adjustment({
            lower, upper, step_increment: step, page_increment: step * 10,
        }),
    });
    spin.set_value(settings.get_int(key));
    settings.bind(key, spin, 'value', FLAGS);
    row.add_suffix(spin);
    row.activatable_widget = spin;
    return row;
}

function entryRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({ title, subtitle: subtitle || null });
    const entry = new Gtk.Entry({
        valign: Gtk.Align.CENTER, width_chars: 10, text: settings.get_string(key),
    });
    settings.bind(key, entry, 'text', FLAGS);
    row.add_suffix(entry);
    row.activatable_widget = entry;
    return row;
}

function comboRow(settings, key, title, choices) {
    const model = new Gtk.StringList();
    for (const [, label] of choices)
        model.append(label);
    const row = new Adw.ComboRow({ title, model });
    const current = settings.get_string(key);
    row.selected = Math.max(0, choices.findIndex(([id]) => id === current));
    row.connect('notify::selected', () => settings.set_string(key, choices[row.selected][0]));
    return row;
}

// Combo bound to an integer setting via a list of values + a label function.
function intComboRow(settings, key, title, values, labelFn, subtitle) {
    const model = new Gtk.StringList();
    for (const v of values)
        model.append(labelFn(v));
    const row = new Adw.ComboRow({ title, subtitle: subtitle || null, model });
    const idx = values.indexOf(settings.get_int(key));
    row.selected = idx < 0 ? 0 : idx;
    row.connect('notify::selected', () => settings.set_int(key, values[row.selected]));
    return row;
}

function colorRow(settings, key, title) {
    const row = new Adw.ActionRow({ title });
    const btn = new Gtk.ColorButton({ valign: Gtk.Align.CENTER, use_alpha: false });
    const rgba = new Gdk.RGBA();
    if (rgba.parse(settings.get_string(key)))
        btn.set_rgba(rgba);
    btn.connect('color-set', () => {
        const c = btn.get_rgba();
        const hex = '#' + [c.red, c.green, c.blue]
            .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
        settings.set_string(key, hex);
    });
    row.add_suffix(btn);
    row.activatable_widget = btn;
    return row;
}

// Adw.ExpanderRow whose built-in enable switch is the parent boolean setting.
function toggleExpander(settings, key, title, subtitle) {
    const exp = new Adw.ExpanderRow({
        title, subtitle: subtitle || null, show_enable_switch: true,
    });
    settings.bind(key, exp, 'enable-expansion', FLAGS);
    return exp;
}

// A plain switch usable as an ExpanderRow child suffix row.
function childSwitch(settings, key, title, subtitle) {
    return switchRow(settings, key, title, subtitle);
}

function childSpin(settings, key, title, subtitle, lo, hi, step) {
    return spinRow(settings, key, title, subtitle, lo, hi, step);
}

/* --- per-model pricing editor --- */

function pricingGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Pricing',
        description: 'Rates used for the API-equivalent cost estimate, in $ per ' +
            'million tokens. Model name is matched as a substring of the model id.',
    });

    // Working copy: [{ key, input, output }]. Seeded from settings (defaults if empty).
    let models = Pricing.parsePricing(settings.get_string(K.PRICING))
        .map(([key, input, output]) => ({ key, input, output }));
    let rows = [];

    const commit = () => {
        if (models.length === 0) {
            settings.set_string(K.PRICING, '');
            return;
        }
        const arr = models.map(m => [m.key, m.input, m.output]);
        settings.set_string(K.PRICING, JSON.stringify(arr));
    };

    const makeRow = (model, index) => {
        const row = new Adw.ActionRow();

        const name = new Gtk.Entry({
            valign: Gtk.Align.CENTER, width_chars: 10, text: model.key,
            tooltip_text: 'Model name substring',
        });
        name.connect('changed', () => { model.key = name.get_text(); commit(); });
        row.add_prefix(name);

        const mkSpin = (val, tip) => {
            const spin = new Gtk.SpinButton({
                valign: Gtk.Align.CENTER, digits: 2, tooltip_text: tip,
                adjustment: new Gtk.Adjustment({
                    lower: 0, upper: 1000, step_increment: 0.5, page_increment: 5,
                }),
            });
            spin.set_value(val);
            return spin;
        };
        const inSpin = mkSpin(model.input, 'Input $/MTok');
        const outSpin = mkSpin(model.output, 'Output $/MTok');
        inSpin.connect('value-changed', () => { model.input = inSpin.get_value(); commit(); });
        outSpin.connect('value-changed', () => { model.output = outSpin.get_value(); commit(); });
        row.add_suffix(new Gtk.Label({ label: 'in', css_classes: ['dim-label'] }));
        row.add_suffix(inSpin);
        row.add_suffix(new Gtk.Label({ label: 'out', css_classes: ['dim-label'] }));
        row.add_suffix(outSpin);

        const del = new Gtk.Button({
            valign: Gtk.Align.CENTER, icon_name: 'edit-delete-symbolic',
            css_classes: ['flat'], tooltip_text: 'Remove model',
        });
        del.connect('clicked', () => {
            const i = models.indexOf(model);
            if (i >= 0) {
                models.splice(i, 1);
                render();
                commit();
            }
        });
        row.add_suffix(del);
        return row;
    };

    const render = () => {
        for (const r of rows)
            group.remove(r);
        rows = models.map((m, i) => makeRow(m, i));
        for (const r of rows)
            group.add(r);
    };

    // Header buttons: Add + Reset.
    const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER,
    });
    const addBtn = new Gtk.Button({
        icon_name: 'list-add-symbolic', css_classes: ['flat'],
        valign: Gtk.Align.CENTER, tooltip_text: 'Add model',
    });
    addBtn.connect('clicked', () => {
        models.push({ key: 'model', input: 1, output: 5 });
        render();
        commit();
    });
    const resetBtn = new Gtk.Button({
        icon_name: 'edit-undo-symbolic', css_classes: ['flat'],
        valign: Gtk.Align.CENTER, tooltip_text: 'Reset to built-in defaults',
    });
    resetBtn.connect('clicked', () => {
        models = Pricing.DEFAULT_PRICES.map(([key, input, output]) => ({ key, input, output }));
        render();
        settings.set_string(K.PRICING, ''); // empty => use defaults
    });
    headerBox.append(resetBtn);
    headerBox.append(addBtn);
    group.set_header_suffix(headerBox);

    render();
    return group;
}

/* --- dropdown block ordering (drag and drop) --- */

function orderGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Order',
        description: 'Drag the rows to reorder the dropdown blocks. Hidden blocks keep ' +
            'their place and simply do not render.',
    });
    const labelOf = Object.fromEntries(Settings.BLOCKS.map(b => [b.id, b.label]));
    let order = Settings.normalizeOrder(settings.get_strv(K.SECTION_ORDER));
    let rows = [];

    // Move `fromId` to just before/after `toId`, then re-render. Deferred to
    // idle so we don't destroy the drop target row while its 'drop' is running.
    const reorder = (fromId, toId, after) => {
        if (fromId === toId)
            return;
        order = order.filter(id => id !== fromId);
        let to = order.indexOf(toId);
        if (to < 0)
            to = order.length;
        else if (after)
            to += 1;
        order.splice(to, 0, fromId);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            settings.set_strv(K.SECTION_ORDER, order);
            render();
            return GLib.SOURCE_REMOVE;
        });
    };

    const makeRow = id => {
        const row = new Adw.ActionRow({ title: labelOf[id] || id });
        row._blockId = id;

        const handle = new Gtk.Image({ icon_name: 'list-drag-handle-symbolic' });
        handle.add_css_class('dim-label');
        row.add_prefix(handle);

        // Drag source: carries the dragged row (as a GValue) to the drop target.
        const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        source.connect('prepare', () => {
            const v = new GObject.Value();
            v.init(Adw.ActionRow.$gtype);
            v.set_object(row);
            return Gdk.ContentProvider.new_for_value(v);
        });
        source.connect('drag-begin', (_s, drag) => {
            Gtk.DragIcon.get_for_drag(drag).set_child(new Gtk.Label({
                label: labelOf[id] || id,
                margin_start: 12, margin_end: 12, margin_top: 6, margin_bottom: 6,
            }));
        });
        row.add_controller(source);

        // Drop target: insert the dragged row before/after this one.
        const target = new Gtk.DropTarget({ actions: Gdk.DragAction.MOVE });
        target.set_gtypes([Adw.ActionRow.$gtype]);
        target.connect('drop', (_t, value, _x, y) => {
            if (!value || !value._blockId)
                return false;
            reorder(value._blockId, id, y > row.get_height() / 2);
            return true;
        });
        row.add_controller(target);
        return row;
    };

    const render = () => {
        for (const r of rows)
            group.remove(r);
        rows = order.map(makeRow);
        for (const r of rows)
            group.add(r);
    };

    render();
    return group;
}

/* --- page assembly --- */

function fillPreferencesWindow(window) {
    const settings = Settings.getSettings();
    const page = new Adw.PreferencesPage({
        title: 'Claude Usage', icon_name: 'utilities-system-monitor-symbolic',
    });

    // Panel
    const panel = new Adw.PreferencesGroup({ title: 'Panel' });
    const iconExp = toggleExpander(settings, K.SHOW_ICON, 'Show icon');
    iconExp.add_row(comboRow(settings, K.ICON_COLOR, 'Icon color', ICON_COLORS));
    panel.add(iconExp);
    const textExp = toggleExpander(settings, K.SHOW_PANEL_TEXT, 'Show text');
    textExp.add_row(comboRow(settings, K.PANEL_FORMAT, 'Panel text', PANEL_FORMATS));
    // Status glyphs shown while there's no usage data (loading/error in the
    // panel text; rate-limited in the dropdown header).
    textExp.add_row(entryRow(settings, K.STATUS_LOADING, 'Loading glyph'));
    textExp.add_row(entryRow(settings, K.STATUS_ERROR, 'Error glyph'));
    textExp.add_row(entryRow(settings, K.STATUS_RATELIMITED, 'Rate-limited glyph'));
    panel.add(textExp);
    page.add(panel);

    // Refresh
    const refresh = new Adw.PreferencesGroup({ title: 'Refresh' });
    refresh.add(spinRow(settings, K.REFRESH_SECONDS, 'Transcript interval (s)',
        "How often local transcripts are re-read.", 15, 3600, 5));
    refresh.add(spinRow(settings, K.USAGE_REFRESH_SECONDS, 'Usage API interval (s)',
        'The usage endpoint rate-limits frequent polling; ≥120s recommended.', 60, 3600, 30));
    page.add(refresh);

    // Dropdown sections (nested toggles)
    const sections = new Adw.PreferencesGroup({
        title: 'Dropdown sections', description: 'Sub-options collapse when their section is off.',
    });
    const usageExp = toggleExpander(settings, K.SHOW_USAGE_SECTION, 'Subscription usage bars');
    usageExp.add_row(childSwitch(settings, K.SHOW_MODEL_USAGE_BARS, 'Per-model weekly bars',
        'Opus / Sonnet weekly limits, when present.'));
    sections.add(usageExp);

    const todayExp = toggleExpander(settings, K.SHOW_TODAY_SECTION, 'Summary',
        'Totals + per-model breakdown for the selected period (switch day/week/' +
        'month/year from the dropdown arrows).');
    todayExp.add_row(childSwitch(settings, K.SHOW_MODEL_BREAKDOWN, 'Per-model breakdown'));
    todayExp.add_row(childSwitch(settings, K.SHOW_TOKEN_DETAILS, 'Input / cache totals'));
    todayExp.add_row(childSwitch(settings, K.SHOW_COST, 'Estimated cost'));
    sections.add(todayExp);
    const projectsExp = toggleExpander(settings, K.SHOW_PROJECTS_SECTION, 'Per-project breakdown',
        'Tokens grouped by ~/.claude project for the selected period.');
    projectsExp.add_row(childSpin(settings, K.PROJECTS_MAX, 'Max projects shown', null, 1, 50, 1));
    sections.add(projectsExp);
    page.add(sections);

    // Graphs
    const graphs = new Adw.PreferencesGroup({
        title: 'Graphs',
        description: 'In-dropdown graphs. Tip: click a graph to change its range ' +
            '(right-click to go back); this dropdown sets the default.',
    });

    const costExp = toggleExpander(settings, K.SHOW_GRAPH_COST, 'Daily token usage');
    costExp.add_row(comboRow(settings, K.TOKEN_METRIC, 'Count', TOKEN_METRICS));
    costExp.add_row(intComboRow(settings, K.COST_HISTORY_DAYS, 'Range',
        Settings.TOKEN_RANGES, Settings.rangeLabelLong));
    graphs.add(costExp);

    const utilExp = toggleExpander(settings, K.SHOW_GRAPH_UTIL, 'Utilization trend');
    utilExp.add_row(intComboRow(settings, K.UTIL_TREND_DAYS, 'Range',
        Settings.UTIL_RANGES, Settings.rangeLabelLong,
        'All samples are kept on disk; this only sets the visible window.'));
    graphs.add(utilExp);

    graphs.add(switchRow(settings, K.SHOW_GRAPH_MODELS, 'Per-model token share'));
    graphs.add(switchRow(settings, K.SHOW_GRAPH_BURNDOWN, '5h + weekly burn-down'));
    page.add(graphs);

    // Order
    page.add(orderGroup(settings));

    // Appearance
    const appearance = new Adw.PreferencesGroup({ title: 'Appearance' });
    appearance.add(spinRow(settings, K.BAR_WIDTH, 'Bar / graph width (px)', null, 80, 600, 10));
    appearance.add(colorRow(settings, K.ACCENT_COLOR, 'Accent color'));
    page.add(appearance);

    // Pricing
    page.add(pricingGroup(settings));

    window.add(page);
    window.set_default_size(560, 820);
}
