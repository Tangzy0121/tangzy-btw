# tangzy-btw

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![pi package](https://img.shields.io/badge/pi-package-brightgreen)](https://pi.dev/packages)
[![tests](https://img.shields.io/badge/node--test-12%2F12%20passing-success)](extensions/tangzy-btw/lib.test.ts)

A KimiCode-style `/btw` side-question extension for [pi](https://github.com/earendil-works/pi-coding-agent). Ask a quick side question without interrupting your main session — the answer streams into a bottom overlay panel with full markdown rendering, and nothing ever touches your main transcript.

## Why

Most `/btw` implementations either take over the whole terminal (and occasionally freeze the main TUI on exit) or render answers as plain text. `tangzy-btw` was built to keep three guarantees:

- **No terminal takeover** — the panel is a bottom-anchored overlay (`ctx.ui.custom({ overlay: true })`), so the main TUI is never suspended and cannot be left frozen.
- **Markdown rendering** — answers render with pi's own `Markdown` component, not raw text.
- **Multi-turn follow-ups in-panel** — an IME-friendly input box inside the panel lets you keep asking without leaving the overlay.

Design inspired by KimiCode's side-question feature ([MoonshotAI/kimi-cli PR #1743](https://github.com/MoonshotAI/kimi-cli/pull/1743)).

## Features

- `/btw <question>` — open the panel and ask; the answer streams in live (plain-text fast path while generating — no per-frame markdown re-parse — then markdown-polished on completion)
- Follow-up questions from the panel's own input (side-thread history is kept as context)
- Read-only snapshot of your main session (branch messages packed under a ~20k token budget) so the side answer knows what you're working on
- **Never pollutes the main transcript** — the side thread lives in process memory only and is gone on exit
- `/btw clear` — wipe the side-thread history
- `Esc` closes the panel (aborting any in-flight answer); `↑`/`↓` (and PgUp/PgDn) scroll long answers
- Live thinking progress (elapsed time + thinking volume) while reasoning models think — the panel never looks frozen
- Pure logic lives in `extensions/tangzy-btw/lib.ts` and is covered by `node --test` unit tests

## Install

```bash
pi install git:github.com/Tangzy0121/tangzy-btw
```

(or `pi install https://github.com/Tangzy0121/tangzy-btw`)

Restart pi, then type `/btw <your question>` in the main input.

## Usage

| Command / key | Action |
| --- | --- |
| `/btw <question>` | Ask a side question (opens the panel) |
| type + `Enter` in panel | Follow-up question with side-thread context |
| `↑` / `↓` / `PgUp` / `PgDn` | Scroll the answer |
| `Esc` | Close the panel (aborts any in-flight answer) |
| `/btw clear` | Clear side-thread history |

## Development

```bash
node --test extensions/tangzy-btw/lib.test.ts
```

## License

MIT — see [LICENSE](LICENSE).
