# pi-user-memory

Local-first, user-centered **automatic long-term memory** for [Pi](https://github.com/earendil-works/pi). A ChatGPT-style *experience* for Pi: talk normally, and the extension learns durable facts, updates them when corrected, recalls relevant history in new sessions, and lets you review or erase memories. This is an independent implementation, not OpenAI's private memory system.

> **Status: v0.1 MVP / PR preview.** The SQLite store and end-to-end extension lifecycle are tested with a mocked Pi runtime. Real-provider integration, memory quality, and broader privacy/security audits still need live validation before a stable release.

## Features

- **Automatic extraction:** observes user-authored messages after Pi completes a run; a separately configured or current Pi model classifies durable memories. No `remember` command needed.
- **Cross-session recall:** compact global facts are injected into the next Pi prompt, ranked using simple keyword matching and a stable user-profile shortlist.
- **Automatic updates:** stable category/key pairs replace superseded values; capture keeps source session and entry IDs.
- **User controls:** inspect, export, pause, resume, forget individual facts, or clear active memories.
- **Local-first:** SQLite using Node.js built-in `node:sqlite`; global path `~/.pi/agent/user-memory/memory.sqlite`, outside any git repository. No server, telemetry or third-party database.
- **Privacy defaults:** `localOnly: true` prevents sending data to a non-loopback model; sensitive memories are off by default; common credential strings are rejected. SQLite and exports use owner-only file permissions where the OS supports them.
- **Does not replace Pi compaction** or alter transcripts, project files or `AGENTS.md`.

## Install

Requires **Node.js 22.13+** (for `node:sqlite`) and a Pi build implementing `before_agent_start`, `agent_settled`, and `modelRegistry.complete` (verified against the `earendil-works/pi` extension API).

```bash
pi install git:github.com/stellarsailor/pi-user-memory
/reload
```

For local development:

```bash
git clone https://github.com/stellarsailor/pi-user-memory.git
cd pi-user-memory
npm test
pi -e ./index.ts
```

### Configure the memory model

Create `~/.pi/agent/user-memory/config.json` based on [`config.example.json`](config.example.json). Set `memoryModel.provider` and `memoryModel.id` to a model **already configured in Pi**, such as a local oMLX/OpenAI-compatible provider. The model's `baseUrl` must use `localhost`, `127.0.0.1` or `::1` when `localOnly` is enabled.

If `memoryModel` is omitted, the current Pi model is used. **If that model is remote, no extraction occurs with the default `localOnly: true`.** To explicitly permit a cloud model, set `"localOnly": false`; this sends snippets of user messages and prior saved facts to the configured provider. A memory worker may create additional model usage/charges.

Configuration options:

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Enable automatic memory and injection |
| `memoryModel` | `null` | `{ "provider": "...", "id": "..." }`, or use current Pi model |
| `localOnly` | `true` | Block non-loopback model endpoints |
| `allowSensitive` | `false` | Allow explicitly requested sensitive facts marked by extractor |
| `maxContextChars` | `5000` | Injected memory character budget (300–16,000) |
| `maxBatchesPerRun` | `8` | Extraction batches of up to six user messages per settled run |
| `notifyOnWrite` | `false` | Show non-error memory update notifications |

## User commands

```text
/user-memory                    # status
/user-memory profile            # grouped profile summary
/user-memory show               # individual saved facts
/user-memory forget cats        # remove matching remembered facts
/user-memory forget preferences/pets
/user-memory pause              # suspend extraction and injection
/user-memory resume
/user-memory export             # owner-readable JSON file in memory directory
/user-memory clear              # clear facts after confirmation
```

Users can also naturally say “forget that I like cats” or “I prefer dogs now”: the extractor is instructed to turn explicit forget/correction statements into memory operations. As with all model-based extraction, these are **best-effort**; use `/user-memory show` and `/user-memory forget` when a guaranteed correction is important.

## How it works

```text
Pi user messages ──(agent_settled)──► memory classifier (separate Pi model call)
                                            │
                                            ▼
                           validated upsert/forget operations
                                            │
                                            ▼
                      SQLite facts + evidence + tombstones + seen IDs
                                            │
              new prompt ──► ranked user-profile facts ──► Pi system section
```

Only user-authored message text is fed to extraction; assistant/tool output is not treated as first-person user fact. Records use stable keys to enable correction, and deleted keys are tombstoned against unrequested restoration. Model JSON is untrusted: the implementation validates category, confidence, key, operation and originating entry ID before writing. Extractor failures do **not** mark entries as processed, so they can be retried.

## Limitations and security

- This is **not semantic/vector search**. Retrieval uses bounded lexical matching plus global identity/preferences/goals; a later version can add embeddings or hybrid search.
- Deduplication depends on the extractor choosing the same stable key. Similar facts with different keys may coexist; inspect memory periodically.
- Memory is personal, global and machine-local. It does not sync across devices.
- Forgetting clears the saved memory and its evidence, **not original Pi session transcripts**, exported backups, external model logs, or provider retention. Manual transcript deletion is separate. Deleting every historical mention from another source is not done by this plugin.
- Do not enable cloud extraction unless you accept the provider's data policies. `allowSensitive` is not a substitute for a privacy review; detection is best effort.
- Extraction is performed at settle time and can add latency/compute cost. It is not a background daemon.
- Imported package code executes with Pi's OS permissions; review before installation.
- A message's text is truncated to 4,000 characters, and extraction uses bounded batches. Non-text attachments (images, voice) are not analyzed.

## Development

```bash
npm run check
npm test
```

Tests use Node's built-in test runner and an in-memory / temporary SQLite database. They cover upsert, dedup, updates, provenance, tombstones, sensitive/credential guardrails, seen entries, local-only policy, mocked model extraction, injection and session handoff.

License: MIT.
