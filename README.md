# Claude Code Usage

GNOME Shell panel indicator for your Claude subscription rate‑limit utilization
and your Claude Code token usage / estimated API‑equivalent cost.

<p align="center">
  <img src="screenshot.png" alt="Claude Code Usage dropdown" width="332">
</p>

> **Unofficial** — not affiliated with or endorsed by Anthropic. "Claude" and
> the Claude logo are trademarks of Anthropic, used here only to identify the
> service the extension reports on.

## ⚠️ GNOME Shell 42 only

This is built in the **legacy (pre‑45) extension format** and imports
**libsoup 2.4**, so it runs on **GNOME Shell 42** (tested on 42.9) and will
**not** load on GNOME 45+ (which require the ESM module format) or where only
libsoup 3 is present. No newer‑GNOME port is provided.

## Features

- Panel readout: 5‑hour and weekly utilization, and/or today's cost.
- Dropdown: utilization bars, a Day/Week/Month/Year summary with per‑model
  breakdown and cost, optional per‑project totals, and optional graphs (daily
  tokens, utilization trend, model share, 5‑hour burn‑down).
- Everything is toggleable and reorderable in Preferences.

## Privacy

Reads locally, sends nothing but the one request below:

- `~/.claude/.credentials.json` — the OAuth access token only, sent over HTTPS
  to `https://api.anthropic.com/api/oauth/usage` to fetch your utilization.
- `~/.claude/projects/**/*.jsonl` — transcripts, parsed locally for token/cost
  totals; their contents never leave your machine.

No telemetry, no other network access.

## Install

```sh
git clone <this-repo> claude-usage@tiago
cp -r claude-usage@tiago ~/.local/share/gnome-shell/extensions/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/claude-usage@tiago/schemas/
# Reload: Alt+F2 → "r" → Enter (X11), then:
gnome-extensions enable claude-usage@tiago
```

## License

GPL‑2.0‑or‑later — see [LICENSE](LICENSE).
