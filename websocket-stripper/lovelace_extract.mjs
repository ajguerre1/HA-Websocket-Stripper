// lovelace_extract.mjs — extract the entity-id allowlist from a Lovelace config.
//
// Walks the card tree collecting entities from the standard keys, and expands
// `auto-entities` filter cards against the live entity list (and, when provided, the
// area/device/entity/label registries so `area`/`label`/`device`/`integration` filters
// resolve too — see issue #4).
//
// extractEntities(config, allStates, opts) -> { entities:[...], unsupported:[...] }
//   config     : the lovelace dashboard config (from `lovelace/config`)
//   allStates  : array of HA state objects [{entity_id, state, attributes}, ...]
//   opts.viewPath    : optional view `path` to restrict extraction to a single view
//   opts.registries  : { areas, devices, entities, labels } from HA's config/*_registry/list
//   opts.overInclude : when true (allowlist mode), don't let volatile conditions
//                      (state/attributes) shrink the set — an entity that doesn't match a
//                      `state:` filter right now must still be forwarded so the card can
//                      show it when it later does.

const ID_RE = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/;
export const isEntityId = (s) => typeof s === 'string' && ID_RE.test(s);

function globToRe(glob) {
  // HA auto-entities globs: * matches any run of chars.
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$');
}

const asArray = (v) => (Array.isArray(v) ? v : [v]);

// A filter value may be a plain string, an array, or — from the auto-entities visual
// editor — an object like `{ label: "1st_floor", active_choice: "label" }`. Pull the
// effective value(s) for filter key `key`.
function coerceVal(v, key) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap((x) => coerceVal(x, key));
  if (typeof v === 'object') return key in v ? coerceVal(v[key], key) : [];
  return [v];
}

// Build entity -> {area, labels, device, integration} lookups from the registries.
// area is inherited from the entity's device when the entity has no explicit area.
export function buildRegistryCtx(registries = {}) {
  const areas = registries.areas || [];
  const labels = registries.labels || [];
  const devices = registries.devices || [];
  const entities = registries.entities || [];
  const areaName = new Map(areas.map((a) => [a.area_id, a.name]));
  const labelName = new Map(labels.map((l) => [l.label_id, l.name]));
  const deviceArea = new Map(devices.map((d) => [d.id, d.area_id]));
  const deviceName = new Map(devices.map((d) => [d.id, d.name_by_user || d.name]));
  const ent = new Map();
  for (const e of entities) {
    const areaId = e.area_id || (e.device_id ? deviceArea.get(e.device_id) : null) || null;
    const labelIds = e.labels || [];
    ent.set(e.entity_id, {
      areaId,
      areaName: areaId ? areaName.get(areaId) ?? null : null,
      labelIds,
      labelNames: labelIds.map((id) => labelName.get(id)).filter(Boolean),
      deviceId: e.device_id || null,
      deviceName: e.device_id ? deviceName.get(e.device_id) ?? null : null,
      platform: e.platform || null,
    });
  }
  return { ent };
}

// Split one auto-entities condition into structural tests (domain/entity_id/area/label/
// device/integration — stable identity) and volatile tests (state/attributes — change at
// runtime). Callers decide which to apply. Registry-backed keys need `ctx`; without it
// they simply match nothing (degrades to pre-#4 behavior).
function condTests(cond, unsupported, ctx) {
  const structural = [];
  const volatile = [];
  const reg = (s) => ctx.ent && ctx.ent.get(s.entity_id);

  if (cond.domain != null) {
    const doms = asArray(cond.domain);
    structural.push((s) => doms.includes(s.entity_id.split('.')[0]));
  }
  if (cond.entity_id != null) {
    const res = asArray(cond.entity_id).map((g) => globToRe(String(g)));
    structural.push((s) => res.some((re) => re.test(s.entity_id)));
  }
  if (cond.area != null) {
    const want = new Set(coerceVal(cond.area, 'area').map(String));
    structural.push((s) => { const r = reg(s); return !!r && (want.has(r.areaId) || want.has(r.areaName)); });
  }
  if (cond.label != null) {
    const want = new Set(coerceVal(cond.label, 'label').map(String));
    structural.push((s) => { const r = reg(s); return !!r && (r.labelIds.some((id) => want.has(id)) || r.labelNames.some((n) => want.has(n))); });
  }
  if (cond.device != null) {
    const want = new Set(coerceVal(cond.device, 'device').map(String));
    structural.push((s) => { const r = reg(s); return !!r && (want.has(r.deviceId) || want.has(r.deviceName)); });
  }
  if (cond.integration != null) {
    const want = new Set(coerceVal(cond.integration, 'integration').map(String));
    structural.push((s) => { const r = reg(s); return !!r && want.has(r.platform); });
  }
  if (cond.state != null) volatile.push((s) => s.state === cond.state);
  if (cond.attributes && typeof cond.attributes === 'object') {
    for (const [k, v] of Object.entries(cond.attributes)) {
      volatile.push((s) => s.attributes && s.attributes[k] === v);
    }
  }

  // Flag conditions we don't evaluate (name/group/not/and/or/last_changed/templates/…).
  const known = ['domain', 'entity_id', 'area', 'label', 'device', 'integration',
    'state', 'attributes', 'options', 'type', 'active_choice'];
  for (const k of Object.keys(cond)) {
    if (!known.includes(k)) unsupported.push('auto-entities filter key: ' + k);
  }
  return { structural, volatile };
}

// Turn a condition into a predicate. `role` + `overInclude` decide how volatile tests are
// treated (see extractEntities opts.overInclude):
//   include, overInclude : structural only (fall back to volatile if there are no
//                          structural tests, so a bare `state:` filter still matches).
//   exclude, overInclude : structural only, and never exclude on a volatile-only condition
//                          (dropping an entity we might need later is the harmful direction).
//   otherwise            : all tests (exact, current-state semantics).
function makeMatcher(cond, unsupported, ctx, role, overInclude) {
  const { structural, volatile } = condTests(cond, unsupported, ctx);
  let tests;
  if (overInclude && role === 'exclude') {
    if (!structural.length) return () => false;
    tests = structural;
  } else if (overInclude) {
    tests = structural.length ? structural : volatile;
  } else {
    tests = [...structural, ...volatile];
  }
  if (!tests.length) return () => false;
  return (s) => tests.every((t) => t(s));
}

function expandAutoEntities(node, allStates, add, unsupported, ctx, overInclude) {
  const f = node.filter || {};
  const inc = Array.isArray(f.include) ? f.include : [];
  const exc = Array.isArray(f.exclude) ? f.exclude : [];
  const excMatchers = exc.map((c) => makeMatcher(c, unsupported, ctx, 'exclude', overInclude));
  for (const cond of inc) {
    // An include entry can be an explicit entity rather than a filter.
    if (cond && isEntityId(cond.entity_id) && !String(cond.entity_id).includes('*')) {
      if (!excMatchers.some((m) => m({ entity_id: cond.entity_id, state: '', attributes: {} }))) add(cond.entity_id);
      continue;
    }
    const match = makeMatcher(cond, unsupported, ctx, 'include', overInclude);
    for (const s of allStates) {
      if (match(s) && !excMatchers.some((m) => m(s))) add(s.entity_id);
    }
  }
}

export function extractEntities(config, allStates = [], opts = {}) {
  const found = new Set();
  const unsupported = [];
  const add = (id) => { if (isEntityId(id)) found.add(id); };
  const ctx = buildRegistryCtx(opts.registries);
  const overInclude = !!opts.overInclude;

  function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;

    // auto-entities (and similar filter cards) need live expansion.
    if (typeof node.type === 'string' && node.type.includes('auto-entities') && node.filter) {
      expandAutoEntities(node, allStates, add, unsupported, ctx, overInclude);
    }

    // Standard entity-bearing keys.
    if (typeof node.entity === 'string') add(node.entity);
    if (typeof node.camera_image === 'string') add(node.camera_image);
    if (typeof node.camera_entity === 'string') add(node.camera_entity);
    if (typeof node.entity_id === 'string') add(node.entity_id);
    else if (Array.isArray(node.entity_id)) node.entity_id.forEach(add);

    if (Array.isArray(node.entities)) {
      for (const it of node.entities) {
        if (typeof it === 'string') add(it);
        // objects fall through to generic recursion below (covers {entity:...},
        // fold-entity-row {head, entities:[...]}, etc.)
      }
    }

    // Generic recursion over every value (covers cards/card/elements/head/stack/badges/…).
    // Skip `filter`: it holds auto-entities match conditions (incl. `exclude`), not
    // entity widgets — recursing would re-add excluded entities.
    for (const [k, v] of Object.entries(node)) {
      if (k === 'filter') continue;
      if (v && typeof v === 'object') walk(v);
    }
  }

  let views = Array.isArray(config?.views) ? config.views : [];
  if (opts.viewPath) views = views.filter((v) => v.path === opts.viewPath);
  views.forEach(walk);

  return { entities: [...found].sort(), unsupported: [...new Set(unsupported)] };
}
