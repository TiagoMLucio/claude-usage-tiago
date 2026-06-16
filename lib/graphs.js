/* Cairo-drawn graph widgets for the dropdown.
 *
 * Each builder returns a vertical St.BoxLayout (optional labels + an
 * St.DrawingArea) ready to drop into a PopupBaseMenuItem. Compact variants are
 * just the drawing area; labeled variants add St.Labels (drawing text in Cairo
 * needs font plumbing we don't want, and St.Labels inherit the theme color). */

const { St } = imports.gi;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Format = Me.imports.lib.format;

const COMPACT_H = 24;
const LABELED_H = 46;

// Muted, harmonious companions to the terracotta accent (index 0 = accent).
const PALETTE = [
    { r: 0.851, g: 0.467, b: 0.341 }, // terracotta (overridden by accent)
    { r: 0.42, g: 0.55, b: 0.65 },    // muted slate blue
    { r: 0.55, g: 0.66, b: 0.52 },    // sage green
    { r: 0.87, g: 0.73, b: 0.47 },    // warm sand
    { r: 0.64, g: 0.53, b: 0.62 },    // dusty mauve
    { r: 0.49, g: 0.62, b: 0.60 },    // soft teal
];

function paletteAt(i, accent) {
    return i === 0 ? accent : PALETTE[i % PALETTE.length];
}

function dimLabel(text) {
    const l = new St.Label({ text });
    l.add_style_class_name('claude-dim');
    l.opacity = 165;
    return l;
}

function makeArea(width, height, drawFn) {
    const area = new St.DrawingArea({ style: `width: ${width}px; height: ${height}px;` });
    area.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        try {
            drawFn(cr, w, h);
        } catch (e) {
            logError(e, 'claude-usage: graph draw failed');
        }
        cr.$dispose();
    });
    return area;
}

function vbox() {
    return new St.BoxLayout({ vertical: true, x_expand: true });
}

function headerRow(title, right) {
    const hb = new St.BoxLayout({ x_expand: true });
    const t = new St.Label({ text: title });
    t.add_style_class_name('claude-dim');
    t.opacity = 200;
    hb.add_child(t);
    hb.add_child(new St.Widget({ x_expand: true }));
    if (right != null)
        hb.add_child(dimLabel(right));
    return hb;
}

/* --- daily token usage (bars) --- */

function tokensGraph({ values, color, width, labeled }) {
    const box = vbox();
    const max = Math.max(1, ...values.map(v => v.tokens));
    const total = values.reduce((s, v) => s + v.tokens, 0);
    const sumLabel = `Σ ${Format.fmtTokens(total)}`;
    const h = labeled ? LABELED_H : COMPACT_H;

    if (labeled)
        box.add_child(headerRow(`Tokens · ${values.length}d`, sumLabel));

    box.add_child(makeArea(width, h, (cr, w, hh) => {
        const n = values.length;
        if (n === 0)
            return;
        const gap = n > 30 ? 1 : 2;
        const bw = Math.max(1, (w - gap * (n - 1)) / n);
        for (let i = 0; i < n; i++) {
            const frac = values[i].tokens / max;
            const bh = Math.max(values[i].tokens > 0 ? 1 : 0, frac * (hh - 1));
            const x = i * (bw + gap);
            // today (last bar) at full opacity, past days slightly faded
            const a = i === n - 1 ? 0.95 : 0.65;
            cr.setSourceRGBA(color.r, color.g, color.b, a);
            cr.rectangle(x, hh - bh, bw, bh);
            cr.fill();
        }
    }));

    if (!labeled)
        box.add_child(headerRow(`Tokens ${values.length}d`, sumLabel));
    return box;
}

/* --- utilization trend (lines) --- */

function utilGraph({ samples, color, width, labeled, days }) {
    const box = vbox();
    const h = labeled ? LABELED_H : COMPACT_H;
    const now = Math.floor(Date.now() / 1000);
    const start = now - days * 86400;
    const span = Math.max(1, now - start);

    if (labeled)
        box.add_child(headerRow(`Utilization · ${days}d`, null));

    box.add_child(makeArea(width, h, (cr, w, hh) => {
        // faint 100% baseline
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.18);
        cr.setLineWidth(1);
        cr.moveTo(0, 1.5);
        cr.lineTo(w, 1.5);
        cr.stroke();

        const pts = samples.filter(s => s.t >= start);
        const xOf = t => ((t - start) / span) * w;
        const yOf = p => hh - 1 - (Math.max(0, Math.min(100, p)) / 100) * (hh - 2);

        // A rate-limit window holds its value until resets_at, then drops to 0;
        // a new window then climbs from 0. So between two samples in *different*
        // windows we don't interpolate — we hold to the reset, drop to 0, stay
        // flat until the new window starts, then ramp to the new value.
        //
        // With a stored reset (`resetKey`) this is exact (and catches a reset
        // even when the new window already climbed past the old value). Older
        // samples lack it, so we infer a reset from physics: utilization only
        // rises within a window, so any *decrease* is a reset; and a gap longer
        // than the window must contain one. The reset time is then estimated as
        // min(B.t, A.t + win) — it can't be later than B, nor outlive the window.
        const resetBetween = (A, B, key, resetKey, win) => {
            const rA = A[resetKey];
            if (rA != null)
                return rA <= B.t
                    ? { reset: rA, newStart: B[resetKey] != null
                        ? Math.max(rA, B[resetKey] - win) : rA }
                    : null;
            if (B[key] < A[key] - 0.5 || B.t - A.t > win) {
                const reset = Math.min(B.t, A.t + win);
                return { reset, newStart: reset };
            }
            return null;
        };

        const series = (key, resetKey, win, r, g, b, a, lw) => {
            const vals = pts.filter(s => s[key] != null);
            if (vals.length === 0)
                return;
            cr.setSourceRGBA(r, g, b, a);
            cr.setLineWidth(lw);
            if (vals.length === 1) {
                cr.arc(xOf(vals[0].t), yOf(vals[0][key]), 1.5, 0, 2 * Math.PI);
                cr.fill();
                return;
            }
            const path = [[vals[0].t, vals[0][key]]];
            for (let i = 1; i < vals.length; i++) {
                const A = vals[i - 1], B = vals[i];
                const info = resetBetween(A, B, key, resetKey, win);
                if (info) {
                    path.push([info.reset, A[key]]);     // hold A's value to its reset
                    path.push([info.reset, 0]);          // drop to 0
                    if (info.newStart > info.reset)
                        path.push([info.newStart, 0]);   // flat 0 until the new window
                    path.push([B.t, B[key]]);            // ramp up to B
                } else {
                    path.push([B.t, B[key]]);            // same window: interpolate
                }
            }
            path.forEach(([t, p], i) => {
                const x = xOf(t), y = yOf(p);
                if (i === 0)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            });
            cr.stroke();
        };

        const FIVE_WIN = 5 * 3600, WEEK_WIN = 7 * 86400;
        series('week', 'wr', WEEK_WIN, color.r, color.g, color.b, 0.4, 1);   // weekly, faint
        series('five', 'fr', FIVE_WIN, color.r, color.g, color.b, 0.95, 1.5); // 5h, prominent
    }));

    if (!labeled)
        box.add_child(headerRow(`Util ${days}d`, null));
    return box;
}

/* --- per-model token share (stacked bar) --- */

function modelGraph({ segments, accent, width, labeled }) {
    const box = vbox();
    const total = segments.reduce((s, x) => s + x.value, 0);
    const colored = segments.map((s, i) => ({ ...s, color: paletteAt(i, accent) }));
    const h = labeled ? 14 : 10;

    if (labeled)
        box.add_child(headerRow('Model share (output)', null));

    box.add_child(makeArea(width, h, (cr, w, hh) => {
        if (total <= 0) {
            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.2);
            cr.rectangle(0, 0, w, hh);
            cr.fill();
            return;
        }
        let x = 0;
        for (const seg of colored) {
            const sw = (seg.value / total) * w;
            cr.setSourceRGBA(seg.color.r, seg.color.g, seg.color.b, 0.9);
            cr.rectangle(x, 0, Math.max(0, sw - 0.5), hh);
            cr.fill();
            x += sw;
        }
    }));

    if (labeled) {
        const legend = new St.BoxLayout({ x_expand: true, style: 'spacing: 10px;' });
        for (const seg of colored) {
            if (total > 0 && seg.value / total < 0.02)
                continue;
            const pct = total > 0 ? Math.round((seg.value / total) * 100) : 0;
            legend.add_child(dimLabel(`${seg.label} ${pct}%`));
        }
        box.add_child(legend);
    }
    return box;
}

/* --- current 5h window burn-down --- */

function burndownGraph({ five, resetsAt, color, width, labeled }) {
    const WINDOW = 5 * 3600 * 1000;
    const box = vbox();
    const h = labeled ? 14 : 10;

    const resetTs = Date.parse(resetsAt || '');
    let elapsed = null;
    if (!isNaN(resetTs)) {
        const remaining = resetTs - Date.now();
        elapsed = Math.max(0, Math.min(1, (WINDOW - remaining) / WINDOW));
    }
    const util = five == null ? null : Math.max(0, Math.min(1, five / 100));

    if (labeled) {
        const pace = (elapsed != null && util != null)
            ? (util <= elapsed ? 'on/ahead of pace' : 'ahead of budget')
            : '';
        box.add_child(headerRow('5h window', pace));
    }

    box.add_child(makeArea(width, h, (cr, w, hh) => {
        // track
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.22);
        cr.rectangle(0, 0, w, hh);
        cr.fill();
        // utilization fill
        if (util != null) {
            cr.setSourceRGBA(color.r, color.g, color.b, 0.9);
            cr.rectangle(0, 0, util * w, hh);
            cr.fill();
        }
        // time-elapsed marker
        if (elapsed != null) {
            cr.setSourceRGBA(0.95, 0.95, 0.95, 0.8);
            cr.setLineWidth(1.5);
            cr.moveTo(elapsed * w, 0);
            cr.lineTo(elapsed * w, hh);
            cr.stroke();
        }
    }));

    if (!labeled) {
        const u = util == null ? '–' : `${Math.round(util * 100)}%`;
        const e = elapsed == null ? '' : ` · ${Math.round(elapsed * 100)}% elapsed`;
        box.add_child(headerRow('5h burn-down', `${u}${e}`));
    }
    return box;
}
