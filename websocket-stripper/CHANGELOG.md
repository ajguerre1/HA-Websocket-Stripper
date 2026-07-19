# Changelog

## 0.2.1 — 2026-07-19

- Remove the inert `ports:` / `ports_description` mapping from `config.yaml`. Under
  `host_network` a Docker port map does nothing, so it only duplicated (and could drift
  from) the functional `port` option. The `port` option is now the single source of truth
  for the listen port. No behavior change — the add-on still binds `8099` by default.

## 0.2.0 — 2026-07-18

- **auto-entities `area` / `label` / `device` / `integration` filters now resolve** (#4).
  The proxy fetches the area/device/entity/label registries and expands these filters the
  way HA's frontend does, instead of silently forwarding nothing — so cards filtered by
  label/area no longer show entities as "unavailable" and you don't have to hand-list them
  in `always_forward`. Volatile filters (`state` / `attributes`) now over-include (an
  entity that doesn't match right now is still forwarded so the card can show it when it
  does). The allowlist also rebuilds on registry changes, not just dashboard edits.
- **Configurable `port` option** (#6) — move the add-on off `8099` when it collides with
  another add-on (e.g. Zigbee2MQTT). Needed because `host_network` makes the Network tab
  unable to remap the port.
- **Allowlist recompute now logs the added/removed entity diff** (#7), not just the total,
  so you can see exactly what a dashboard edit changed.
- **Defensive egress filter** (PR #1): `subscribe_entities` event payloads (`a`/`c`/`r`)
  are re-filtered to the allowlist on the way to the browser — a no-op today, but a
  guarantee the firehose can't leak if a future HA ignored the `entity_ids` subscription.
- Added a test suite (`npm test`, `node --test`): unit tests for the extractor + registry
  resolver, and integration tests that spawn the real proxy against a mock HA.

## 0.0.1 — 2026-06-19

Initial public release.

- Reverse proxy that serves the real Home Assistant frontend but trims the entity
  websocket (`subscribe_entities` / `get_states`) to each dashboard's allowlist, so
  kiosk / wall-panel dashboards load fast on large instances — with full fidelity.
- Runs with `host_network: true` so trusted-network (password-less) kiosk login works
  through the proxy; `X-Forwarded-For` is normalized to plain IPv4 (strips IPv4-mapped
  IPv6 `::ffff:` so it matches IPv4 `trusted_networks` subnets).
- Options: `dashboards`, `always_forward`, `never_forward`, `strip_entities`, plus
  `ha_base` / `allow_ws_url` to pin the HA / supervisor URLs to IPs if host networking
  breaks the internal DNS names.
