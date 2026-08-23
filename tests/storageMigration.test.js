import assert from "node:assert/strict";
import test from "node:test";
import { migrateNamespacedStorage } from "../src/storageMigration.js";

class MemoryStorage {
  #entries = new Map();

  get length() {
    return this.#entries.size;
  }

  key(index) {
    return [...this.#entries.keys()][index] ?? null;
  }

  getItem(key) {
    return this.#entries.has(key) ? this.#entries.get(key) : null;
  }

  setItem(key, value) {
    this.#entries.set(String(key), String(value));
  }
}

test("migrates prior tenant-prefixed Hermes storage without embedding a tenant name", () => {
  const storage = new MemoryStorage();
  storage.setItem("previous-tenant-hermes-meetings", "[{\"id\":\"meeting-1\"}]");
  storage.setItem("unrelated-key", "keep");

  const migrated = migrateNamespacedStorage(storage);

  assert.deepEqual(migrated, [{
    from: "previous-tenant-hermes-meetings",
    to: "hermes-office-meetings",
  }]);
  assert.equal(storage.getItem("hermes-office-meetings"), "[{\"id\":\"meeting-1\"}]");
  assert.equal(storage.getItem("previous-tenant-hermes-meetings"), "[{\"id\":\"meeting-1\"}]");
  assert.equal(storage.getItem("unrelated-key"), "keep");
});

test("never overwrites a current Hermes Office value", () => {
  const storage = new MemoryStorage();
  storage.setItem("previous-tenant-hermes-chat-selection", "legacy");
  storage.setItem("hermes-office-chat-selection", "current");

  assert.deepEqual(migrateNamespacedStorage(storage), []);
  assert.equal(storage.getItem("hermes-office-chat-selection"), "current");
});
