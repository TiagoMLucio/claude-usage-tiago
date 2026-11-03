/* Codex subscription utilization client.
 *
 * Reads the ChatGPT access token Codex keeps in ~/.codex/auth.json and GETs the
 * usage endpoint that Codex's own /status reads, over libsoup 2.4. The token is
 * only read, never refreshed: Codex refreshes it itself and its refresh token
 * rotates. The payload is mapped onto the Claude usage shape
 * ({ five_hour, seven_day: { utilization, resets_at } }) so the indicator,
 * the history and the graphs treat both the same. Two more reads ride along:
 * the apps the plan is shared with ("Sign in with ChatGPT" apps, which draw on
 * the same limit but report only a percentage) and the account's tokens per
 * day, which include runs no local log saw. */

const { GLib, Soup } = imports.gi;
const ByteArray = imports.byteArray;

const API = 'https://chatgpt.com/backend-api';
var USAGE_URL = `${API}/wham/usage`;
const APPS_URL = `${API}/wham/usage/chatpass/apps`;
const PROFILE_URL = `${API}/wham/profiles/me`;
const AUTH_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.codex', 'auth.json']);
const TIMEOUT_SECONDS = 10;

// Whether Codex is installed and signed in at all (decides the panel button).
function available() {
    return GLib.file_test(AUTH_PATH, GLib.FileTest.EXISTS);
}

function readAuth() {
    try {
        const [, bytes] = GLib.file_get_contents(AUTH_PATH);
        const auth = JSON.parse(ByteArray.toString(bytes));
        const t = auth.tokens;
        if (!t || !t.access_token || !t.account_id)
            return null;
        return { token: t.access_token, accountId: t.account_id };
    } catch (e) {
        return null;
    }
}

function bucket(w) {
    if (!w || typeof w.used_percent !== 'number')
        return null;
    const resets = typeof w.reset_at === 'number'
        ? new Date(w.reset_at * 1000).toISOString() : null;
    return { utilization: w.used_percent, resets_at: resets };
}

function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// The usage payload in the Claude shape, plus `reset_credits` (weekly-limit
// resets the account can still redeem), or null when it isn't one.
function normalize(body) {
    if (!body || !body.rate_limit)
        return null;
    const out = { five_hour: null, seven_day: null, reset_credits: null };
    for (const w of [body.rate_limit.primary_window, body.rate_limit.secondary_window]) {
        if (w)
            out[w.limit_window_seconds <= 86400 ? 'five_hour' : 'seven_day'] = bucket(w);
    }
    const credits = body.rate_limit_reset_credits;
    if (credits && typeof credits.available_count === 'number')
        out.reset_credits = credits.available_count;
    return out;
}

// Each app's weekly window, as { name, cap, utilization, resets_at }.
function apps(body) {
    if (!body || !Array.isArray(body.items))
        return null;
    const out = [];
    for (const app of body.items) {
        const week = (app.windows || []).find(w => w.limit_window_seconds > 86400);
        const b = bucket(week);
        if (b)
            out.push({ name: app.name || app.id, cap: app.allowed_usage_percent, ...b });
    }
    return out;
}

// { 'YYYY-MM-DD': tokens } from the profile's daily buckets (UTC days).
function daily(body) {
    const buckets = body && body.stats && body.stats.daily_usage_buckets;
    if (!Array.isArray(buckets))
        return null;
    const out = {};
    for (const b of buckets) {
        if (b.start_date && typeof b.tokens === 'number')
            out[b.start_date] = b.tokens;
    }
    return out;
}

var CodexUsageClient = class CodexUsageClient {
    constructor() {
        this._session = new Soup.Session();
        this._session.timeout = TIMEOUT_SECONDS;
    }

    // Resolves with { status, body }; body is null unless it parsed.
    _get(url, auth) {
        return new Promise(resolve => {
            let message;
            try {
                message = Soup.Message.new('GET', url);
            } catch (e) {
                resolve({ status: 0, body: null });
                return;
            }
            message.request_headers.append('Authorization', `Bearer ${auth.token}`);
            message.request_headers.append('chatgpt-account-id', auth.accountId);
            message.request_headers.append('Accept', 'application/json');
            this._session.queue_message(message, (_session, msg) => {
                let body = null;
                try {
                    const raw = msg.response_body ? msg.response_body.data : null;
                    if (raw)
                        body = JSON.parse(raw);
                } catch (e) {
                    body = null;
                }
                resolve({ status: msg.status_code, body });
            });
        });
    }

    // Resolves with { state, data, plan } like UsageClient.fetch(); data also
    // carries `apps` and `daily` (null when those reads failed).
    async fetch() {
        const auth = readAuth();
        if (!auth)
            return { state: 'error', data: null, plan: '' };
        const usage = await this._get(USAGE_URL, auth);
        const data = usage.status === 200 ? normalize(usage.body) : null;
        if (!data)
            return { state: usage.status === 429 ? 'ratelimited' : 'error', data: null, plan: '' };
        const [appsRes, profileRes] = await Promise.all(
            [this._get(APPS_URL, auth), this._get(PROFILE_URL, auth)]);
        data.apps = appsRes.status === 200 ? apps(appsRes.body) : null;
        data.daily = profileRes.status === 200 ? daily(profileRes.body) : null;
        return { state: 'ok', data, plan: cap(usage.body.plan_type) };
    }

    destroy() {
        try {
            this._session.abort();
        } catch (e) {
            // session already gone
        }
        this._session = null;
    }
};
