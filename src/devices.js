// -----------------------------------------------------------------------------
// The Gladys device of the PiKVM (pure).
//
//   `ext:<selector>:pikvm:<address id>` (address id: the address typed,
//   small letters, digits and dashes, the port at the end; see config.js)
//     power LED, disk activity LED (read only, binary), PiKVM temperature;
//     Power on, Shut down, Force power off, Reset (buttons).
//
// Every reading is read only. The actions are `button`/`push` features, never
// a switch nor a binary: a "turn everything off" of a voice assistant, MCP or
// a `switch` scene action must not reach them.
//
// A device published again never loses a feature: the features of the device
// created in Gladys (`gladys.devices`) are added back when the blueprint
// lacks them.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { addressId } from './config.js';
import { DEVICE_TYPE, FEATURES } from './constants.js';
import { featureName } from './i18n.js';

export const pikvmIds = (gladys, address) => gladys.externalIds(DEVICE_TYPE, addressId(address));

const reading = (extra) => ({ read_only: true, has_feedback: false, keep_history: true, ...extra });
const binary = (history = true) =>
  reading({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1, keep_history: history });
const button = () => ({
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});

export const DEVICE_FEATURES = [
  [FEATURES.POWER, binary()],
  [FEATURES.HDD, binary(false)],
  [
    FEATURES.TEMPERATURE,
    reading({
      category: C.TEMPERATURE_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: U.CELSIUS,
      min: -40,
      max: 150,
    }),
  ],
  [FEATURES.POWER_ON, button()],
  [FEATURES.SHUTDOWN, button()],
  [FEATURES.FORCE_OFF, button()],
  [FEATURES.RESET, button()],
];

/** The features of the created device the blueprint lacks, appended (never fewer). */
export function withCreatedFeatures(device, devices) {
  const created = (devices ?? []).find((d) => d?.external_id === device.external_id);
  if (!created) return device;
  const known = new Set(device.features.map((f) => f.external_id));
  const extra = (created.features ?? []).filter(
    (f) => f && typeof f.external_id === 'string' && !known.has(f.external_id),
  );
  if (extra.length === 0) return device;
  return { ...device, features: [...device.features, ...extra] };
}

/** The device of the PiKVM at `address` (the key of config.js). */
export function buildDevice(gladys, { address, host, language, model }) {
  const ids = pikvmIds(gladys, address);
  return withCreatedFeatures(
    {
      name: `PiKVM ${host}`.slice(0, 80),
      external_id: ids.device,
      model: (model ? `PiKVM ${model}` : 'PiKVM').slice(0, 80),
      should_poll: false,
      features: DEVICE_FEATURES.map(([key, definition]) => ({
        name: featureName(key, language),
        external_id: ids.feature(key),
        ...definition,
      })),
    },
    gladys.devices,
  );
}

/** The feature key of an external id of this device, or null. */
export function featureOf(gladys, address, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300 || !address) return null;
  const ids = pikvmIds(gladys, address);
  for (const [key] of DEVICE_FEATURES) {
    if (ids.feature(key) === externalId) return key;
  }
  return null;
}
