import type Database from "better-sqlite3";
import type { DeviceRequestAuthenticator } from "./device-auth.js";

export const TEST_DEVICE = {
  deviceId: "test-device",
  childId: "default",
} as const;

export const testDeviceAuthenticator: DeviceRequestAuthenticator = {
  requireDevice: (_req, res, next) => {
    res.locals.device = TEST_DEVICE;
    next();
  },
};

export function seedTestDevice(db: Database.Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO paired_devices
       (device_id, child_id, credential_hash, device_name, created_at, last_seen_at)
     VALUES (?, ?, ?, 'test', 0, 0)`,
  ).run(TEST_DEVICE.deviceId, TEST_DEVICE.childId, "test-credential-hash");
}
