const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();

function run(context, callback) {
  return storage.run(context, callback);
}

function getStore() {
  return storage.getStore() || null;
}

function get(key, fallback = null) {
  const store = storage.getStore();
  return store && key in store ? store[key] : fallback;
}

function set(key, value) {
  const store = storage.getStore();
  if (!store) return false;
  store[key] = value;
  return true;
}

module.exports = { run, getStore, get, set };
