# pi-user-memory

Local-first, user-centered **automatic long-term memory** for [Pi](https://github.com/earendil-works/pi). A ChatGPT-style *experience* for Pi: talk normally, and the extension learns durable facts, updates them when corrected, recalls relevant history in new sessions, and lets you review or erase memories. This is an independent implementation, not OpenAI's private memory system.

> **Status: v0.1 MVP / PR preview.** The SQLite store and end-to-end extension lifecycle are tested with a mocked Pi runtime. Real-provider integration, memory quality, and broader privacy/security audits still need live validation before a stable release.

## Features

- **Automatic extraction:** observes user-authored messages after Pi completes a run; a separately configured or current Pi model classifies durable memories. No `remember` command needed.
- **Cross-session recall:** compact global facts are ranked by keywords and, optionally, local semantic vectors, then injected into the next Pi prompt.
- **Automatic updates:** stable category/key pairs replace superseded values; capture keeps source session and entry IDs. Stored facts retain provenance; `/user-memory sources` shows current and earlier session/entry IDs. Injecting verbose source IDs into the prompt is opt-in.
- **User controls:** inspect, export, pause, resume, forget individual facts, or clear active memories.
- **Optional vector search:** opt-in local OpenAI-compatible embedding endpoint (for example Ollama) with vectors stored in SQLite. No additional npm dependencies; lexical search still works when the embedding server is down.
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
| `includeSourcesInContext` | `false` | Add full session/entry references to each injected memory fact; off by default to save tokens |
| `maxBatchesPerRun` | `8` | Extraction batches of up to six user messages per settled run |
| `notifyOnWrite` | `false` | Show non-error memory update notifications |
| `embeddings.enabled` | `false` | Enable semantic ranking and background-on-turn indexing |
| `embeddings.baseUrl` | `http://127.0.0.1:11434/v1` | OpenAI-compatible local embeddings base URL |
| `embeddings.model` | `qwen3-embedding:0.6b` | Installed embedding model name |

### Optional local semantic search

Requires an embedding service implementing the OpenAI-compatible `POST /v1/embeddings` endpoint.
For example, with Ollama (installed separately):

```bash
ollama pull qwen3-embedding:0.6b
```

Add this to `~/.pi/agent/user-memory/config.json` (alongside your existing settings):

```json
"embeddings": {
  "enabled": true,
  "baseUrl": "http://127.0.0.1:11434/v1",
  "model": "qwen3-embedding:0.6b"
}
```

When enabled, new facts are embedded after extraction (up to 24 facts per settled turn).
Use `/user-memory index` to backfill old facts, repeating for additional batches.
A question is embedded only at recall time. Vector scores are combined with keyword
matching and the stable preference/identity/goal shortlist. A slow recall request times out
in 2.5 seconds. After an embedding failure, Pi skips semantic calls for 60 seconds,
using lexical recall immediately; changing the model/endpoint resets the cooldown. Model changes cause lazy reindexing, and updates/forget
invalidate or remove old vectors. The endpoint is limited to loopback when
`localOnly=true`; redirects are blocked and responses are size-limited. Requests are sent
without an `Authorization` header, and any query string or fragment in `baseUrl` is stripped,
so endpoints that need a key in the URL are not supported. Indexing at agent settle time
retains its separate 15-second request timeout. No document/PDF ingest yet.

## User commands

```text
/user-memory                    # status
/user-memory profile            # grouped profile summary
/user-memory show               # individual saved facts
/user-memory sources goals/home  # current source and earlier session/entry references
/user-memory index              # embed up to 24 existing facts
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

- Semantic search is **optional**, disabled by default, and searches saved memory facts only (not PDF/document contents). Source IDs are pointers into Pi transcripts, not verified quotations or clickable links. `/user-memory sources` is available without adding ID overhead to every model prompt.
- Deduplication depends on the extractor choosing the same stable key. Similar facts with different keys may coexist; inspect memory periodically.
- Memory is personal, global and machine-local. It does not sync across devices. A remote embedding endpoint is only permitted if `localOnly=false`, which may transmit private memories to that endpoint.
- Forgetting clears the saved memory and its evidence, **not original Pi session transcripts**, exported backups, external model logs, or provider retention. Manual transcript deletion is separate. Deleting every historical mention from another source is not done by this plugin.
- Do not enable cloud extraction unless you accept the provider's data policies. `allowSensitive` is not a substitute for a privacy review; detection is best effort.
- Extraction is performed at settle time and can add latency/compute cost. It is not a background daemon.
- Imported package code executes with Pi's OS permissions; review before installation.
- A message's text is truncated to 4,000 characters, and extraction uses bounded batches. Non-text attachments (images, voice) are not analyzed.

## Next work (not included in this PR)

1. **Document RAG:** ingest PDFs, images/OCR and Markdown with chunking, citations, per-document permissions, and hybrid retrieval.
2. **Web UI:** local dashboard to review/edit memories, inspect provenance, control indexed documents, and manage privacy settings.

## Development

```bash
npm run check
npm test
```

Tests use Node's built-in test runner and an in-memory / temporary SQLite database. They cover upsert, dedup, updates, provenance, semantic vector ranking/invalidation, tombstones, sensitive/credential guardrails, seen entries, local-only policy, mocked model extraction, injection and session handoff.

License: MIT.
