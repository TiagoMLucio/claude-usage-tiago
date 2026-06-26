/* Settings access + key-name constants, shared by extension.js and prefs.js. */

const ExtensionUtils = imports.misc.extensionUtils;

var SCHEMA_ID = 'org.gnome.shell.extensions.claude-usage';

// Every key declared in the gschema, grouped for readability. Using constants
// here means a typo fails loudly at import rather than silently reading the
// wrong key.
var KEYS = {
    REFRESH_SECONDS: 'refresh-seconds',
    USAGE_REFRESH_SECONDS: 'usage-refresh-seconds',
    SHOW_ICON: 'show-icon',
    ICON_COLOR: 'icon-color',
    SHOW_PANEL_TEXT: 'show-panel-text',
    PANEL_FORMAT: 'panel-format',
    STATUS_LOADING: 'status-loading',
    STATUS_ERROR: 'status-error',
    STATUS_RATELIMITED: 'status-throttled',
    SHOW_USAGE_SECTION: 'show-usage-section',
    SHOW_MODEL_USAGE_BARS: 'show-model-usage-bars',
    SHOW_TODAY_SECTION: 'show-today-section',
    SHOW_MODEL_BREAKDOWN: 'show-model-breakdown',
    SHOW_TOKEN_DETAILS: 'show-token-details',
    SHOW_COST: 'show-cost',
    SHOW_PROJECTS_SECTION: 'show-projects-section',
    PROJECTS_MAX: 'projects-max',
    PERIOD: 'period',
    SHOW_GRAPH_COST: 'show-graph-cost',
    COST_HISTORY_DAYS: 'cost-history-days',
    TOKEN_METRIC: 'token-metric',
    SHOW_GRAPH_UTIL: 'show-graph-util',
    UTIL_TREND_DAYS: 'util-trend-days',
    SHOW_GRAPH_MODELS: 'show-graph-models',
    SHOW_GRAPH_BURNDOWN: 'show-graph-burndown',
    SECTION_ORDER: 'section-order',
    BAR_WIDTH: 'bar-width',
    ACCENT_COLOR: 'accent-color',
    PRICING: 'pricing',
};

// Orderable dropdown blocks. `kind` controls separator placement: a separator
// is drawn between adjacent rendered blocks except between two 'graph' blocks.
var BLOCKS = [
    { id: 'usage', label: 'Subscription usage bars', kind: 'section' },
    { id: 'today', label: 'Summary (day/week/month/year)', kind: 'section' },
    { id: 'projects', label: 'Per-project breakdown', kind: 'section' },
    { id: 'graph-cost', label: 'Daily tokens graph', kind: 'graph' },
    { id: 'graph-util', label: 'Utilization graph', kind: 'graph' },
    { id: 'graph-models', label: 'Model-share graph', kind: 'graph' },
    { id: 'graph-burndown', label: 'Burn-down graph', kind: 'graph' },
];

// Normalize a stored order: keep known ids in their stored order, drop unknown
// ones, and append any known ids that are missing (e.g. added in an update).
function normalizeOrder(stored) {
    const known = BLOCKS.map(b => b.id);
    const seen = new Set();
    const out = [];
    for (const id of stored || []) {
        if (known.includes(id) && !seen.has(id)) {
            out.push(id);
            seen.add(id);
        }
    }
    for (const id of known) {
        if (!seen.has(id))
            out.push(id);
    }
    return out;
}

function getSettings() {
    return ExtensionUtils.getSettings(SCHEMA_ID);
}

// Click-to-cycle ranges (days; 0 = all time) for the two graphs.
var TOKEN_RANGES = [7, 14, 30, 90, 0];
var UTIL_RANGES = [1, 2, 3, 5, 7, 14];

// Short label for a day count (graph headers): 7->1w, 30->1mo, 0->all.
function rangeLabel(days) {
    if (days === 0) return 'all';
    if (days >= 30 && days % 30 === 0) return `${days / 30}mo`;
    if (days % 7 === 0) return `${days / 7}w`;
    return `${days}d`;
}

// Long label for the prefs dropdown.
function rangeLabelLong(days) {
    if (days === 0) return 'All time';
    if (days >= 30 && days % 30 === 0) return `${days / 30} month${days > 30 ? 's' : ''}`;
    if (days % 7 === 0) return `${days / 7} week${days > 7 ? 's' : ''}`;
    return `${days} day${days > 1 ? 's' : ''}`;
}

function cycleRange(ranges, current, delta) {
    let i = ranges.indexOf(current);
    if (i < 0) i = 0;
    return ranges[(i + delta + ranges.length) % ranges.length];
}
