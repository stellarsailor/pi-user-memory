/**
 * Optional local OpenAI-compatible embeddings for semantic memory lookup.
 * No network calls unless embeddings.enabled is explicitly set.
 */
export function embeddingSettings(config = {}) {
  const raw = config.embeddings && typeof config.embeddings === 'object' ? config.embeddings : {};
  return {
    enabled: raw.enabled === true,
    baseUrl: raw.baseUrl || 'http://127.0.0.1:11434/v1',
    model: raw.model || 'qwen3-embedding:0.6b',
  };
}

function endpointFor(baseUrl, localOnly) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Embedding endpoint must use HTTP(S)');
  if (localOnly && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('localOnly blocks non-loopback embedding endpoints');
  }
  if (url.username || url.password) throw new Error('Embedding URLs must not contain credentials');
  // Preserve already-specified /embeddings and strip query/hash from endpoint URLs.
  url.search = '';
  url.hash = '';
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/embeddings') ? pathname : pathname + '/embeddings';
  return url.href;
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

async function parseBoundedJSON(response) {
  if (typeof response.body?.getReader !== 'function') {
    // Supports non-streaming test adapters as well as custom fetch implementations.
    const data = await response.json();
    if (JSON.stringify(data).length > MAX_RESPONSE_BYTES) throw new Error('Embedding response too large');
    return data;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Embedding response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function embedTexts(texts, config, fetchImpl = fetch, { timeoutMs = 15000 } = {}) {
  if (!Array.isArray(texts) || !texts.length || texts.some((t) => typeof t !== 'string')) {
    throw new Error('Embedding inputs must be nonempty text array');
  }
  const settings = embeddingSettings(config);
  if (!settings.enabled) return [];
  const response = await fetchImpl(endpointFor(settings.baseUrl, config.localOnly !== false), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Do not allow a loopback server to redirect private text to a remote host.
    redirect: 'error',
    body: JSON.stringify({ model: settings.model, input: texts }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('Embedding server returned HTTP ' + response.status);
  const payload = await parseBoundedJSON(response);
  if (!Array.isArray(payload?.data) || payload.data.length !== texts.length) {
    throw new Error('Embedding server returned an unexpected result count');
  }
  const ordered = [...payload.data].sort((a, b) => a.index - b.index);
  const vectors = ordered.map((item, i) => {
    const vector = item.embedding;
    if (item.index !== i || !Array.isArray(vector) || !vector.length || vector.length > 8192 ||
        !vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error('Embedding server returned an invalid vector');
    }
    return vector;
  });
  if (!vectors.every((v) => v.length === vectors[0].length)) {
    throw new Error('Embedding dimensions differ across results');
  }
  return vectors;
}

export async function indexPendingFacts(store, config, limit = 24, fetchImpl = fetch) {
  const settings = embeddingSettings(config);
  if (!settings.enabled) return 0;
  const facts = store.pendingVectors(settings.model, limit);
  if (!facts.length) return 0;
  const inputs = facts.map((f) => '[' + f.category + '/' + f.key + '] ' + f.value);
  const vectors = await embedTexts(inputs, config, fetchImpl);
  let indexed = 0;
  for (let i = 0; i < facts.length; i++) {
    if (store.saveVector(facts[i].id, facts[i].value, settings.model, vectors[i])) indexed++;
  }
  return indexed;
}

export async function queryEmbedding(query, config, fetchImpl = fetch, timeoutMs = 2500) {
  if (!embeddingSettings(config).enabled || !String(query).trim()) return null;
  return (await embedTexts([String(query).slice(0, 2000)], config, fetchImpl, { timeoutMs }))[0];
}

/**
 * One short semantic-lookup attempt, then lexical-only recall for 60s on failure.
 * A config/model change resets the cooldown. Indexing retains its 15s budget.
 */
export function createResilientRecall({
  fetchImpl = fetch, now = () => Date.now(), cooldownMs = 60000, recallTimeoutMs = 2500,
} = {}) {
  let blockedUntil = 0;
  let configKey = '';
  return async function recall(query, config) {
    const settings = embeddingSettings(config);
    if (!settings.enabled || !String(query).trim()) return null;
    const key = JSON.stringify([settings.baseUrl, settings.model, config.localOnly !== false]);
    if (key !== configKey) { configKey = key; blockedUntil = 0; }
    if (now() < blockedUntil) return null;
    try {
      const vector = await queryEmbedding(query, config, fetchImpl, recallTimeoutMs);
      blockedUntil = 0;
      return vector;
    } catch {
      blockedUntil = now() + cooldownMs;
      return null;
    }
  };
}
