/* Cairo-drawn graph widgets for the dropdown.
 *
 * Each builder returns a vertical St.BoxLayout (optional labels + an
 * St.DrawingArea) ready to drop into a PopupBaseMenuItem. Compact variants are
 * just the drawing area; labeled variants add St.Labels (drawing text in Cairo
 * needs font plumbing we don't want, and St.Labels inherit the theme color). */

const { St, Clutter } = imports.gi;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Format = Me.imports.lib.format;

// Make a graph box clickable to cycle its range: left-click forward, right-click
// back. Returns the box. EVENT_STOP keeps the click from closing the menu.
function makeCyclable(box, onCycle) {
    if (!onCycle)
        return box;
    box.reactive = true;
    box.connect('button-press-event', (_a, event) => {
        onCycle(event.get_button() === 3 ? -1 : 1);
        return Clutter.EVENT_STOP;
    });
    return box;
}

function swatch(c) {
    return new St.Widget({
        y_align: Clutter.ActorAlign.CENTER,
        style: `background-color: rgba(${Math.round(c.r * 255)},` +
            `${Math.round(c.g * 255)},${Math.round(c.b * 255)},0.9);` +
            ' width: 9px; height: 9px; border-radius: 2px;',
    });
}

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

/* --- daily token usage (bars: session + subagents stacked) --- */

function tokensGraph({ values, color, subColor, width, labeled, label, onCycle }) {
    const box = vbox();
    const totals = values.map(v => v.main + v.sub);
    const max = Math.max(1, ...totals);
    const grand = totals.reduce((s, x) => s + x, 0);
    const hasSub = values.some(v => v.sub > 0);
    const sumLabel = `Σ ${Format.fmtTokens(grand)}`;
    const title = `Tokens · ${label}`;
    const h = labeled ? LABELED_H : COMPACT_H;

    if (labeled)
        box.add_child(headerRow(title, sumLabel));

    box.add_child(makeArea(width, h, (cr, w, hh) => {
        const n = values.length;
        if (n === 0)
            return;
        const gap = n > 30 ? 1 : 2;
        const bw = Math.max(1, (w - gap * (n - 1)) / n);
        for (let i = 0; i < n; i++) {
            const v = values[i];
            const x = i * (bw + gap);
            const a = i === n - 1 ? 0.95 : 0.7; // highlight today
            const mh = (v.main / max) * (hh - 1);
            const sh = (v.sub / max) * (hh - 1);
            if (v.main > 0) {                    // session usage (accent), bottom
                cr.setSourceRGBA(color.r, color.g, color.b, a);
                cr.rectangle(x, hh - mh, bw, Math.max(1, mh));
                cr.fill();
            }
            if (v.sub > 0) {                     // subagent usage, stacked on top
                cr.setSourceRGBA(subColor.r, subColor.g, subColor.b, a);
                cr.rectangle(x, hh - mh - sh, bw, Math.max(1, sh));
                cr.fill();
            }
        }
    }));

    if (!labeled)
        box.add_child(headerRow(title, sumLabel));

    if (labeled && hasSub) {                     // legend only when subagents present
        const legend = new St.BoxLayout({ x_expand: true, style: 'spacing: 5px;' });
        legend.add_child(swatch(color));
        legend.add_child(dimLabel('session'));
        legend.add_child(new St.Widget({ width: 8 }));
        legend.add_child(swatch(subColor));
        legend.add_child(dimLabel('subagents'));
        box.add_child(legend);
    }
    return makeCyclable(box, onCycle);
}

/* --- utilization trend (lines) --- */

function utilGraph({ samples, color, width, labeled, days, label, onCycle }) {
    const box = vbox();
    const h = labeled ? LABELED_H : COMPACT_H;
    const now = Math.floor(Date.now() / 1000);
    const start = now - days * 86400;
    const span = Math.max(1, now - start);

    if (labeled)
        box.add_child(headerRow(`Utilization · ${label}`, null));

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

        // A rate-limit window holds its value until it resets, then drops to 0
        // and a new window climbs from 0 — so we never interpolate across a
        // reset. Utilization only rises within a window, so ANY decrease is a
        // reset (true for both the 5h and the 7-day window). A stored resets_at
        // (`resetKey`) additionally catches a reset the new window already
        // climbed past, and a gap longer than the window must contain one. The
        // reset time is the stored one when it applies, else min(B.t, A.t+win).
        const resetBetween = (A, B, key, resetKey, win) => {
            const rA = A[resetKey];
            const stored = rA != null && rA <= B.t;
            if (!stored && !(B[key] < A[key] - 0.5) && !(B.t - A.t > win))
                return null;
            const reset = stored ? rA : Math.min(B.t, A.t + win);
            const rB = B[resetKey];
            return { reset, newStart: rB != null ? Math.max(reset, rB - win) : reset };
        };

        const series = (key, resetKey, win, r, g, b, a, lw) => {
            const vals = pts.filter(s => s[key] != null);
            if (vals.length === 0)
                return;
            cr.setSourceRGBA(r, g, b, a);
            cr.setLineWidth(lw);
            // Anchor the line at 0 on the left edge so the empty region before
            // the first sample shows a 0 baseline rather than nothing.
            const path = [[start, 0], [vals[0].t, 0], [vals[0].t, vals[0][key]]];
            if (vals.length === 1) {
                cr.arc(xOf(vals[0].t), yOf(vals[0][key]), 1.5, 0, 2 * Math.PI);
                cr.fill();
            }
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
        box.add_child(headerRow(`Util · ${label}`, null));
    return makeCyclable(box, onCycle);
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

/* --- window burn-down (utilization fill vs time-elapsed marker) --- */

function burndownGraph({ pct, resetsAt, windowMs, title, color, width }) {
    const box = vbox();
    const h = 10;

    const resetTs = Date.parse(resetsAt || '');
    let elapsed = null;
    if (!isNaN(resetTs)) {
        const remaining = resetTs - Date.now();
        elapsed = Math.max(0, Math.min(1, (windowMs - remaining) / windowMs));
    }
    const util = pct == null ? null : Math.max(0, Math.min(1, pct / 100));

    box.add_child(makeArea(width, h, (cr, w, hh) => {
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.22); // track
        cr.rectangle(0, 0, w, hh);
        cr.fill();
        if (util != null) {                    // utilization fill
            cr.setSourceRGBA(color.r, color.g, color.b, 0.9);
            cr.rectangle(0, 0, util * w, hh);
            cr.fill();
        }
        if (elapsed != null) {                 // time-elapsed marker
            cr.setSourceRGBA(0.95, 0.95, 0.95, 0.8);
            cr.setLineWidth(1.5);
            cr.moveTo(elapsed * w, 0);
            cr.lineTo(elapsed * w, hh);
            cr.stroke();
        }
    }));

    const u = util == null ? '–' : `${Math.round(util * 100)}%`;
    const e = elapsed == null ? '' : ` · ${Math.round(elapsed * 100)}% elapsed`;
    box.add_child(headerRow(`${title} burn-down`, `${u}${e}`));
    return box;
}
