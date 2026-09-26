// On the phone: the planner is kept in SQLite key-value storage.
import Storage from "expo-sqlite/kv-store";

export const storage = {
  get(key, fallback) {
    try {
      const raw = Storage.getItemSync(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    Storage.setItemSync(key, JSON.stringify(value));
  },
  remove(key) {
    Storage.removeItemSync(key);
  },
};
