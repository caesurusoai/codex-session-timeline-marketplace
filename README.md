# Codex Session Timeline Marketplace

This repository is a Codex plugin marketplace containing the `codex-session-timeline` plugin.

## Install

Add the marketplace:

```bash
codex plugin marketplace add caesurusoai/codex-session-timeline-marketplace --ref main
```

Install the plugin:

```bash
codex plugin add codex-session-timeline@codex-session-timeline
```

Start a new Codex thread after installing so the plugin skills are loaded.

## Update

Refresh the marketplace snapshot:

```bash
codex plugin marketplace upgrade codex-session-timeline
```

Reinstall the plugin:

```bash
codex plugin add codex-session-timeline@codex-session-timeline
```

Start a new Codex thread after reinstalling.
