/* Subscription utilization client.
 *
 * Reads the OAuth access token Claude Code keeps in ~/.claude/.credentials.json
 * and GETs Anthropic's usage endpoint over libsoup (2.4 — the version GNOME
 * Shell 42 itself uses). The previous implementation shelled out to curl;
 * libsoup keeps everything in-process and off the argv. */

const { GLib, Gio, Soup } = imports.gi;
const ByteArray = imports.byteArray;

var USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const TIMEOUT_SECONDS = 10;

// Read { token, plan } from the credentials file, or null on any failure.
function readCredentials() {
    try {
        const [, bytes] = GLib.file_get_contents(CREDS_PATH);
        const creds = JSON.parse(ByteArray.toString(bytes)).claudeAiOauth;
        if (!creds || !creds.accessToken)
            return null;
        let plan = '';
        if (creds.subscriptionType) {
            plan = creds.subscriptionType.charAt(0).toUpperCase() +
                creds.subscriptionType.slice(1);
        }
        return { token: creds.accessToken, plan };
    } catch (e) {
        return null;
    }
}

var UsageClient = class UsageClient {
    constructor() {
        this._session = new Soup.Session();
        this._session.timeout = TIMEOUT_SECONDS;
    }

    // Resolves with { state, data, plan }:
    //   state: 'ok' | 'ratelimited' | 'error'
    //   data:  parsed usage payload when state === 'ok', else null
    //   plan:  subscription name from credentials, '' if unknown
    fetch() {
        return new Promise(resolve => {
            const creds = readCredentials();
            if (!creds) {
                resolve({ state: 'error', data: null, plan: '' });
                return;
            }
            const plan = creds.plan;

            let message;
            try {
                message = Soup.Message.new('GET', USAGE_URL);
            } catch (e) {
                resolve({ state: 'error', data: null, plan });
                return;
            }
            message.request_headers.append('Authorization', `Bearer ${creds.token}`);
            message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

            this._session.queue_message(message, (_session, msg) => {
                let body = null;
                try {
                    const raw = msg.response_body ? msg.response_body.data : null;
                    if (raw)
                        body = JSON.parse(raw);
                } catch (e) {
                    body = null;
                }

                // five_hour comes back null since the 5h window was removed.
                if (body && ('five_hour' in body || 'seven_day' in body)) {
                    resolve({ state: 'ok', data: body, plan });
                } else if (body && body.error &&
                           body.error.type === 'rate_limit_error') {
                    resolve({ state: 'ratelimited', data: null, plan });
                } else if (msg.status_code === 429) {
                    resolve({ state: 'ratelimited', data: null, plan });
                } else {
                    resolve({ state: 'error', data: null, plan });
                }
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
