// Shared fixtures for the test suite: a small "instance" of states, optional
// registries (entity/device/area/label) for auto-entities area/label/device/integration
// filters, and a couple of lovelace configs.

// A deliberately small instance. `light.decoy` / `sensor.decoy_*` exist only to prove the
// proxy TRIMS entities the dashboards don't use.
export const STATES = [
  { entity_id: 'light.living_room', state: 'on', attributes: { friendly_name: 'Living Room' } },
  { entity_id: 'light.kitchen', state: 'off', attributes: { friendly_name: 'Kitchen' } },
  { entity_id: 'light.bedroom', state: 'on', attributes: { friendly_name: 'Bedroom' } },
  { entity_id: 'binary_sensor.front_door', state: 'off', attributes: { device_class: 'door' } },
  { entity_id: 'binary_sensor.back_door', state: 'on', attributes: { device_class: 'door' } },
  { entity_id: 'sensor.temperature', state: '72', attributes: { unit_of_measurement: '°F' } },
  { entity_id: 'sensor.humidity', state: '40', attributes: { unit_of_measurement: '%' } },
  { entity_id: 'switch.fan', state: 'on', attributes: {} },
  { entity_id: 'camera.front', state: 'streaming', attributes: {} },
  // decoys — used by NO dashboard, must be trimmed away
  { entity_id: 'light.decoy', state: 'on', attributes: {} },
  { entity_id: 'sensor.decoy_power', state: '5', attributes: {} },
  { entity_id: 'sensor.decoy_energy', state: '9', attributes: {} },
];

// Registries mirror HA's config/*_registry/list shape (only the fields we use).
// living_room + bedroom lights sit in "1st_floor" via label; kitchen light is on the
// "kitchen" area via its device; switch.fan comes from the "esphome" integration.
export const AREAS = [
  { area_id: 'kitchen', name: 'Kitchen' },
  { area_id: 'living_room', name: 'Living Room' },
];
export const LABELS = [
  { label_id: 'lbl_1st', name: '1st_floor' },
];
export const DEVICES = [
  { id: 'dev_kitchen_light', area_id: 'kitchen' },
  { id: 'dev_thermo', area_id: 'living_room' },
];
export const ENTITY_REGISTRY = [
  { entity_id: 'light.living_room', device_id: null, area_id: 'living_room', labels: ['lbl_1st'], platform: 'hue' },
  { entity_id: 'light.bedroom', device_id: null, area_id: null, labels: ['lbl_1st'], platform: 'hue' },
  { entity_id: 'light.kitchen', device_id: 'dev_kitchen_light', area_id: null, labels: [], platform: 'hue' },
  { entity_id: 'sensor.temperature', device_id: 'dev_thermo', area_id: null, labels: [], platform: 'template' },
  { entity_id: 'switch.fan', device_id: null, area_id: null, labels: [], platform: 'esphome' },
];

export const REGISTRIES = {
  areas: AREAS, labels: LABELS, devices: DEVICES, entities: ENTITY_REGISTRY,
};

// "test-dash": explicit cards + a picture card + a button-card whose template only
// references switch.fan in TEXT (structural walk can't see it — proves the text-scan pass).
export const DASH_TEST = {
  title: 'Test',
  views: [
    {
      path: 'main',
      cards: [
        { type: 'entities', entities: ['light.living_room', 'sensor.temperature'] },
        {
          type: 'vertical-stack',
          cards: [
            { type: 'picture-glance', camera_image: 'camera.front', entities: [{ entity: 'binary_sensor.front_door' }] },
            { type: 'custom:button-card', name: 'Fan', template: 'states["switch.fan"].state' },
          ],
        },
      ],
    },
    {
      path: 'second',
      cards: [
        { type: 'sensor', entity: 'sensor.humidity' },
      ],
    },
  ],
};

// "auto-dash": an auto-entities card filtered by label (the #4 repro). Under the current
// code this resolves to NOTHING (label unsupported); with the registry resolver it should
// yield the two 1st_floor lights.
export const DASH_AUTO = {
  title: 'Auto',
  views: [
    {
      path: 'main',
      cards: [
        {
          type: 'custom:auto-entities',
          card: { type: 'entities' },
          filter: {
            include: [{ options: {}, label: { label: '1st_floor', active_choice: 'label' } }],
            exclude: [],
          },
        },
      ],
    },
  ],
};
