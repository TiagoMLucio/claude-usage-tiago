/* Codex subscription utilization client.
 *
 * Reads the ChatGPT access token Codex keeps in ~/.codex/auth.json and GETs the
 * usage endpoint that Codex's own /status reads, over libsoup 2.4. The token is
 * only read, never refreshed: Codex refreshes it itself and its refresh token
 * rotates. The payload is mapped onto the Claude usage shape
 * ({ five_hour, seven_day: { utilization, resets_at } }) so the indicator,
 * the history and the graphs treat both the same. */

const { GLib, Soup } = imports.gi;
const ByteArray = imports.byteArray;

var USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
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

var CodexUsageClient = class CodexUsageClient {
    constructor() {
        this._session = new Soup.Session();
        this._session.timeout = TIMEOUT_SECONDS;
    }

    // Resolves with { state, data, plan } like UsageClient.fetch().
    fetch() {
        return new Promise(resolve => {
            const auth = readAuth();
            if (!auth) {
                resolve({ state: 'error', data: null, plan: '' });
                return;
            }
            let message;
            try {
                message = Soup.Message.new('GET', USAGE_URL);
            } catch (e) {
                resolve({ state: 'error', data: null, plan: '' });
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
                const data = msg.status_code === 200 ? normalize(body) : null;
                if (data)
                    resolve({ state: 'ok', data, plan: cap(body.plan_type) });
                else if (msg.status_code === 429)
                    resolve({ state: 'ratelimited', data: null, plan: '' });
                else
                    resolve({ state: 'error', data: null, plan: '' });
            });
        });
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
