/* Model pricing + cost math. Pure module (no GI), safe to import anywhere. */

// $/MTok: [substring, input, output]. Cache read = 0.1x input,
// cache write = 1.25x (5m TTL) or 2x (1h TTL) input.
var DEFAULT_PRICES = [
    ['fable', 10, 50],
    ['mythos', 10, 50],
    ['opus', 5, 25],
    ['sonnet', 3, 15],
    ['haiku', 1, 5],
];

// Parse the user's pricing override. Accepts the same [key, in, out] shape as
// DEFAULT_PRICES. Anything malformed falls back to the defaults so a bad entry
// in prefs can never break the indicator.
function parsePricing(jsonStr) {
    if (!jsonStr || !jsonStr.trim())
        return DEFAULT_PRICES;
    try {
        const arr = JSON.parse(jsonStr);
        if (Array.isArray(arr) && arr.length > 0 &&
            arr.every(r => Array.isArray(r) && r.length >= 3 &&
                typeof r[0] === 'string' &&
                typeof r[1] === 'number' && typeof r[2] === 'number'))
            return arr;
    } catch (e) {
        // fall through
    }
    return DEFAULT_PRICES;
}

function ratesFor(prices, model) {
    if (!model)
        return null;
    for (const [key, input, output] of prices) {
        if (model.includes(key))
            return { input, output };
    }
    return null;
}

// API-equivalent cost in $ for one message's token usage.
function messageCost(prices, model, { input, output, cacheRead, write5m, write1h }) {
    const r = ratesFor(prices, model);
    if (!r)
        return 0;
    return (input * r.input
        + output * r.output
        + cacheRead * r.input * 0.1
        + write5m * r.input * 1.25
        + write1h * r.input * 2) / 1e6;
}
