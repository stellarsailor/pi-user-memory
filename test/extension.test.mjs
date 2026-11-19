import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../src/store.mjs';

const dir = mkdtempSync(join(tmpdir(), 'pi-user-memory-'));
process.env.PI_USER_MEMORY_DIR = dir;
const { default: extension } = await import('../index.ts');

function harness({ modelUrl = 'http://127.0.0.1:1234/v1', response = null } = {}) {
  const callbacks = new Map();
  const commands = new Map();
  const notifications = [];
  const calls = [];
  const pi = {
    on(event, handler) { callbacks.set(event, handler); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  const branch = [{type: 'message', id: 'entry-1', message: {role: 'user', content: 'I prefer light-colored minimalist interiors and dislike carpets.'}}];
  const model = { provider: 'local', id: 'example-model', baseUrl: modelUrl };
  const ctx = {
    hasUI: true,
    ui: {
      notify(message) { notifications.push(message); },
      async confirm() { return true; },
      async editor(_title, value) { return value; },
    },
    model,
    modelRegistry: {
      find() { return model; },
      async complete(_model, prompt) {
        calls.push(prompt);
        return { stopReason: 'stop', content: [{type: 'text', text: response || JSON.stringify({ operations: [{
          action: 'upsert', category: 'preferences', key: 'interior_style', value: 'Prefers light minimalist interiors without carpeting',
          confidence: 0.95, importance: 'high', sensitive: false, source_entry: 'entry-1',
        }]})}] };
      },
    },
    sessionManager: { getSessionId() { return 'demo-session'; }, getBranch() { return branch; } },
  };
  extension(pi);
  return { callbacks, commands, notifications, calls, ctx, branch };
}

const invoke = (h, event, ...args) => h.callbacks.get(event)(...args);
const command = (h, text) => h.commands.get('user-memory').handler(text, h.ctx);

test('extracts user fact in one session, injects it in a new session, and avoids duplicates', async () => {
  const h = harness();
  await invoke(h, 'agent_settled', { aborted: false }, h.ctx);
  assert.equal(h.calls.length, 1);
  assert.match(JSON.stringify(h.calls[0]), /minimalist interiors/);
  const memory = new MemoryStore(join(dir, 'memory.sqlite'));
  assert.equal(memory.count(), 1);
  assert.equal(statSync(join(dir, 'memory.sqlite')).mode & 0o777, 0o600);
  memory.close();
  await invoke(h, 'agent_settled', { aborted: false }, h.ctx);
  assert.equal(h.calls.length, 1, 'seen entries should not be repeatedly extracted');
  const fresh = harness();
  const event = { messageType: 'user', prompt: 'How should I furnish my new apartment?', systemPromptOptions: { sections: {} } };
  invoke(fresh, 'before_agent_start', event, fresh.ctx);
  assert.match(event.systemPromptOptions.sections.pi_user_memory, /light minimalist interiors/);
  await invoke(h, 'session_shutdown');
  await invoke(fresh, 'session_shutdown');
});

test('pause/resume and forget work through commands; no raw transcript included in export', async () => {
  const h = harness();
  await command(h, 'pause');
  const event = { messageType: 'user', prompt: 'furniture', systemPromptOptions: {sections:{}}};
  invoke(h, 'before_agent_start', event, h.ctx);
  assert.equal(event.systemPromptOptions.sections.pi_user_memory, undefined);
  await command(h, 'resume');
  await command(h, 'forget preferences/interior_style');
  const memory = new MemoryStore(join(dir, 'memory.sqlite'));
  assert.equal(memory.count(), 0);
  memory.close();
  await command(h, 'export');
  const exportedPath = h.notifications.find((n) => n.startsWith('Memory exported: '))?.split('Memory exported: ')[1];
  assert.ok(exportedPath && existsSync(exportedPath));
  assert.equal(statSync(exportedPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(exportedPath, 'utf8')).facts.length, 0);
  await invoke(h, 'session_shutdown');
});

test('does not transmit user messages when localOnly blocks a remote model', async () => {
  const h = harness({modelUrl: 'https://api.example.com/v1'});
  await invoke(h, 'agent_settled', {aborted: false}, h.ctx);
  assert.equal(h.calls.length, 0);
  await invoke(h, 'session_shutdown');
});

test.after(() => { rmSync(dir, { recursive: true, force: true }); });
