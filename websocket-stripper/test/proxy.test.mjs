// Integration tests: spawn the REAL proxy (ha_ws_trim_proxy.mjs) in dev mode against the
// mock HA, and drive it over real HTTP + websockets. Exercises buildAllow, the
// subscribe_entities injection, get_states trimming, X-Forwarded-For normalization, the
// non-/api/websocket upgrade passthrough, and live allowlist rebuild on lovelace_updated.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

function spawnProxy({ mock, dashPaths, port, extraEnv = {} }) {
  const proc = spawn(process.execPath, [PROXY], {
    cwd: path.join(DIR, '..'),
    env: {
      ...process.env,
      HA_BASE: mock.base,
      HA_TOKEN: 'test-token',
      DASH_PATHS: dashPaths,
      PORT: String(port),
      STRIP_ENTITIES: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const listeners = [];
  const onData = (b) => {
    out += b.toString();
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i].re.test(out)) { listeners[i].resolve(out); listeners.splice(i, 1); }
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const waitForLog = (re, ms = 8000) => new Promise((resolve, reject) => {
    if (re.test(out)) return resolve(out);
    const l = { re, resolve };
    listeners.push(l);
    setTimeout(() => { const i = listeners.indexOf(l); if (i >= 0) { listeners.splice(i, 1); reject(new Error(`timeout waiting for ${re}\n--- proxy output ---\n${out}`)); } }, ms);
  });
  return { proc, get out() { return out; }, waitForLog, kill: () => proc.kill() };
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = ''; res.on('data', (c) => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

describe('proxy integration (strip on)', () => {
  let mock, proxy, port;
  // test-dash: 6 explicit/text-scanned ids. auto-dash: a label:1st_floor filter that the
  // #4 registry resolver expands to light.living_room (already present) + light.bedroom.
  const EXPECTED = ['light.living_room', 'sensor.temperature', 'camera.front', 'binary_sensor.front_door', 'sensor.humidity', 'switch.fan', 'light.bedroom'];

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash,auto-dash', port });
    await proxy.waitForLog(/HA trim-proxy listening on/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('unions both dashboards; #4 registry resolver expands the auto-dash label filter', () => {
    const m = proxy.out.match(/union allowlist for \[[^\]]+\]: (\d+) entities/);
    assert.ok(m, 'allowlist log line present');
    assert.equal(Number(m[1]), EXPECTED.length);
  });

  it('HTTP passes through to HA and normalizes X-Forwarded-For to bare IPv4', async () => {
    const r = await httpGet(`http://127.0.0.1:${port}/some/path`);
    assert.equal(r.status, 200);
    assert.match(r.body, /MOCK_HA_BODY \/some\/path/);
    const xff = mock.lastXFF();
    assert.ok(xff, 'HA saw an X-Forwarded-For header');
    assert.ok(!xff.includes('::ffff:'), `XFF should be bare IPv4, got ${xff}`);
  });

  it('injects the allowlist into a no-filter subscribe_entities', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    await new Promise((r) => setTimeout(r, 300));
    const injected = mock.lastSubscribeEntities();
    assert.ok(Array.isArray(injected), 'entity_ids were injected');
    assert.deepEqual(new Set(injected), new Set(EXPECTED));
    assert.ok(!injected.includes('light.decoy'), 'decoy entity was trimmed');
    c.close();
  });

  it('trims the get_states result to the allowlist', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const res = await c.rpc({ type: 'get_states' });
    const ids = res.result.map((e) => e.entity_id);
    assert.deepEqual(new Set(ids), new Set(EXPECTED));
    assert.ok(!ids.includes('sensor.decoy_power'));
    c.close();
  });

  it('egress filter drops out-of-allowlist entities from subscribe_entities events (PR #1)', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const subId = c.send({ type: 'subscribe_entities' });
    await new Promise((r) => setTimeout(r, 200));
    const evP = c.waitFor((msg) => msg.type === 'event' && msg.id === subId);
    // Simulate a misbehaving HA that ignores entity_ids and streams a decoy anyway.
    mock.pushEntityEvent({
      a: {
        'light.living_room': { s: 'on' },   // allowlisted -> kept
        'light.decoy': { s: 'on' },          // NOT allowlisted -> must be stripped
      },
      r: ['sensor.decoy_power'],             // NOT allowlisted -> must be stripped
    });
    const ev = await evP;
    assert.ok(ev.event.a['light.living_room'], 'allowlisted entity passes through');
    assert.ok(!ev.event.a['light.decoy'], 'decoy entity stripped from added');
    assert.deepEqual(ev.event.r, [], 'decoy stripped from removed list');
    c.close();
  });

  it('passes non-/api/websocket ws upgrades straight through (e.g. /api/webrtc/ws)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/webrtc/ws`);
    const hello = await new Promise((resolve, reject) => {
      ws.on('message', (m) => resolve(JSON.parse(m.toString())));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('no passthrough hello')), 3000);
    });
    assert.equal(hello.type, 'echo_hello');
    assert.equal(hello.path, '/api/webrtc/ws');
    assert.match(proxy.out, /ws upgrade passthrough -> HA: \/api\/webrtc\/ws/);
    ws.close();
  });
});

describe('live allowlist rebuild on lovelace_updated', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(/HA trim-proxy listening on/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('rebuilds the allowlist when a dashboard is edited (no restart)', async () => {
    // Add an entity to the dashboard, then fire lovelace_updated.
    mock.setConfig('test-dash', { views: [{ path: 'main', cards: [
      { type: 'entities', entities: ['light.living_room', 'light.decoy'] },
    ] }] });
    mock.fireLovelaceUpdated('test-dash');
    // #7: the recompute logs the added/removed diff, not just the total. `-removed` is the
    // last line applyAllow emits, so waiting on it guarantees the whole diff was flushed.
    await proxy.waitForLog(/-removed:[^\n]*sensor\.temperature/, 6000);
    assert.match(proxy.out, /allowlist recomputed \(test-dash\): \d+ entities \(\+1 -5\)/);
    assert.match(proxy.out, /\+added:[^\n]*light\.decoy/);

    // A NEW connection now gets the updated list including the formerly-decoy entity.
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(mock.lastSubscribeEntities().includes('light.decoy'));
    c.close();
  });
});
