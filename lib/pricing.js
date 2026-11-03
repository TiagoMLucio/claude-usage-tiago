/* Model pricing + cost math. Pure module (no GI), safe to import anywhere. */

// $/MTok: [substring, input, output, cached input?]. Cached input defaults to
// 0.1x input; cache write = 1.25x (5m TTL) or 2x (1h TTL) input. The first
// matching substring wins, so an id goes before any shorter id it contains.
var DEFAULT_PRICES = [
    ['fable', 10, 50],
    ['mythos', 10, 50],
    ['opus', 5, 25],
    ['sonnet', 3, 15],
    ['haiku', 1, 5],
    ['gpt-6-astra', 10, 50],
    ['gpt-6.1-sol', 2, 10, 0.1],
    ['gpt-6.1-terra', 1, 5, 0.05],
    ['gpt-6-sol', 2, 10],
    ['gpt-6-luna', 0.1, 0.5],
    ['gpt-5.6-sol', 4, 20],
    ['gpt-5.6-terra', 2, 12],
    ['gpt-5.6-luna', 0.2, 1.2],
    ['gpt-5.5-pro', 30, 180],
    ['gpt-5.5', 5, 30],
    ['gpt-5.3-codex', 1.75, 14],
];

// OpenAI bills a request whose input exceeds this at 2x input and 1.5x output.
var LONG_CONTEXT_TOKENS = 272000;

// Parse the user's pricing override. Accepts the same [key, in, out, cached?]
// shape as DEFAULT_PRICES. Anything malformed falls back to the defaults so a
// bad entry in prefs can never break the indicator.
function parsePricing(jsonStr) {
    if (!jsonStr || !jsonStr.trim())
        return DEFAULT_PRICES;
    try {
        const arr = JSON.parse(jsonStr);
        if (Array.isArray(arr) && arr.length > 0 &&
            arr.every(r => Array.isArray(r) && r.length >= 3 &&
                typeof r[0] === 'string' &&
                typeof r[1] === 'number' && typeof r[2] === 'number' &&
                (r.length < 4 || typeof r[3] === 'number')))
            return arr;
    } catch (e) {
        // fall through
    }
    return DEFAULT_PRICES;
}

function ratesFor(prices, model) {
    if (!model)
        return null;
    for (const [key, input, output, cached] of prices) {
        if (model.includes(key))
            return { input, output, cached: typeof cached === 'number' ? cached : input * 0.1 };
    }
    return null;
}

// API-equivalent cost in $ for one message's token usage.
function messageCost(prices, model, { input, output, cacheRead, write5m, write1h }, longContext = false) {
    const r = ratesFor(prices, model);
    if (!r)
        return 0;
    const inMul = longContext ? 2 : 1;
    const outMul = longContext ? 1.5 : 1;
    return ((input * r.input
        + cacheRead * r.cached
        + write5m * r.input * 1.25
        + write1h * r.input * 2) * inMul
        + output * r.output * outMul) / 1e6;
}

// What a provider's cache is tagged with. Claude's leaves out the gpt- rows, so
// editing Codex prices never resets the Claude cache (which keeps the totals of
// transcripts Claude Code has since deleted).
function pricingKey(provider, prices) {
    return JSON.stringify(provider === 'claude' ? prices.filter(r => !r[0].startsWith('gpt-')) : prices);
}
