/* Claude Code transcripts (~/.claude/projects/**.jsonl), parsed by scan.js. */

const { GLib, Gio } = imports.gi;

const Pricing = imports.lib.pricing;
const Format = imports.lib.format;

var CACHE_FILE = 'transcripts-cache.json';
var CACHE_VERSION = 1;

const PROJECTS_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects']);

// Every *.jsonl under ~/.claude/projects, recursing into the nested
// <session>/subagents/ dirs that hold Task/workflow subagent transcripts.
// `project` is always the top-level project dir; `isSub` flags subagent files.
function listFiles() {
    const files = [];
    const root = Gio.File.new_for_path(PROJECTS_DIR);
    let topDirs;
    try {
        topDirs = root.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return files;
    }
    let dirInfo;
    while ((dirInfo = topDirs.next_file(null)) !== null) {
        if (dirInfo.get_file_type() !== Gio.FileType.DIRECTORY)
            continue;
        const project = dirInfo.get_name();
        collect(root.get_child(project), project, files, false);
    }
    topDirs.close(null);
    return files;
}

function collect(dir, project, files, inSub) {
    let entries;
    try {
        entries = dir.enumerate_children('standard::name,standard::type,time::modified,standard::size',
            Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return;
    }
    let info;
    while ((info = entries.next_file(null)) !== null) {
        const name = info.get_name();
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            collect(dir.get_child(name), project, files, inSub || name === 'subagents');
        } else if (info.get_file_type() === Gio.FileType.REGULAR && name.endsWith('.jsonl')) {
            files.push({
                path: dir.get_child(name).get_path(),
                project,
                isSub: inSub,
                mtime: info.get_attribute_uint64('time::modified'),
                size: info.get_size(),
            });
        }
    }
    entries.close(null);
}

function newState(file) {
    return { project: file.project, isSub: !!file.isSub, byDay: {}, last: null };
}

function restoreState(entry) {
    return {
        project: entry.project, isSub: !!entry.isSub,
        byDay: JSON.parse(JSON.stringify(entry.byDay)), last: entry.last || null,
    };
}

function saveState(state) {
    return { project: state.project, isSub: state.isSub, byDay: state.byDay, last: state.last };
}

// Folds assistant entries since windowStart into state.byDay. A streamed
// message repeats its id on consecutive usage lines (possibly across two
// scans), so state.last holds the previous one's totals and a repeat replaces
// them: the last occurrence wins.
function parseLines(text, windowStart, prices, state) {
    for (const line of text.split('\n')) {
        // Cheap pre-filter: every assistant usage entry has this key.
        if (!line.includes('"usage"'))
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
        const msg = o.message;
        const last = state.last;
        if (last && msg.id && last.id === msg.id)
            Format.applyTotals(state.byDay, last.day, last.model, last.t, -1);
        state.last = null;

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

        const t = {
            cost: Pricing.messageCost(prices, model,
                { input, output, cacheRead, write5m, write1h }),
            input,
            output,
            cacheRead,
            cacheWrite: write5m + write1h,
            messages: 1,
        };
        const day = Format.dayKey(ts);
        Format.applyTotals(state.byDay, day, model, t, 1);
        if (msg.id)
            state.last = { id: msg.id, day, model, t };
    }
}
