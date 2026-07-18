// Registry-backed auto-entities resolution — the #4 fix (area/label/device/integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities } from '../lovelace_extract.mjs';
import { STATES, REGISTRIES } from './fixtures.mjs';

const view = (cards) => ({ views: [{ path: 'main', cards }] });
const auto = (filter) => view([{ type: 'custom:auto-entities', card: { type: 'entities' }, filter }]);
const setOf = (filter) => new Set(extractEntities(auto(filter), STATES, { registries: REGISTRIES, overInclude: true }).entities);

test('label filter (the #4 repro: visual-editor object form) resolves to labeled entities', () => {
  // {label: {label: "1st_floor", active_choice: "label"}} — living_room + bedroom carry it.
  const got = setOf({ include: [{ options: {}, label: { label: '1st_floor', active_choice: 'label' } }] });
  assert.deepEqual(got, new Set(['light.living_room', 'light.bedroom']));
});

test('label filter accepts a plain string value and the label id', () => {
  assert.deepEqual(setOf({ include: [{ label: '1st_floor' }] }), new Set(['light.living_room', 'light.bedroom']));
  assert.deepEqual(setOf({ include: [{ label: 'lbl_1st' }] }), new Set(['light.living_room', 'light.bedroom']));
});

test('area filter resolves by area name and area id', () => {
  // living_room area: light.living_room (explicit) + sensor.temperature (via its device).
  assert.deepEqual(setOf({ include: [{ area: 'Living Room' }] }), new Set(['light.living_room', 'sensor.temperature']));
  assert.deepEqual(setOf({ include: [{ area: 'living_room' }] }), new Set(['light.living_room', 'sensor.temperature']));
});

test('area is inherited from the entity device when the entity has no explicit area', () => {
  // light.kitchen has no area_id but its device dev_kitchen_light is in the kitchen area.
  assert.deepEqual(setOf({ include: [{ area: 'kitchen' }] }), new Set(['light.kitchen']));
});

test('integration filter resolves by platform', () => {
  assert.deepEqual(setOf({ include: [{ integration: 'esphome' }] }), new Set(['switch.fan']));
  assert.deepEqual(setOf({ include: [{ integration: 'hue' }] }), new Set(['light.living_room', 'light.kitchen', 'light.bedroom']));
});

test('device filter resolves by device id', () => {
  assert.deepEqual(setOf({ include: [{ device: 'dev_thermo' }] }), new Set(['sensor.temperature']));
});

test('exclude by area removes structural matches', () => {
  const got = setOf({ include: [{ integration: 'hue' }], exclude: [{ area: 'kitchen' }] });
  assert.ok(got.has('light.living_room'));
  assert.ok(!got.has('light.kitchen'));   // excluded by area
});

test('label + state together: overInclude keeps the label set regardless of state', () => {
  // include entities labeled 1st_floor AND currently on -> overInclude drops the state test.
  const got = setOf({ include: [{ label: '1st_floor', state: 'on' }] });
  assert.deepEqual(got, new Set(['light.living_room', 'light.bedroom']));   // bedroom on, living_room on; state ignored anyway
});

test('unresolvable filters (no registry) yield nothing but do not throw', () => {
  const res = extractEntities(auto({ include: [{ area: 'Living Room' }] }), STATES, { overInclude: true });
  assert.deepEqual(res.entities, []);
});
