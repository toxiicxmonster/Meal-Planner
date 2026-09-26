// In a browser (used for testing the app on a computer): browser storage.
export const storage = {
  get(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    window.localStorage.setItem(key, JSON.stringify(value));
  },
  remove(key) {
    window.localStorage.removeItem(key);
  },
};
