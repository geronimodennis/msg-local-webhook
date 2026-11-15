import { readFile, writeFile } from "node:fs/promises";

export function createStateStore(path = ".watcher-state.json") {
  let state = { messages: {} };

  async function load() {
    try {
      state = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return state;
  }

  async function save() {
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  function get(id) {
    return state.messages[id];
  }

  function set(id, value) {
    state.messages[id] = { ...(state.messages[id] || {}), ...value };
  }

  function markReplied(id, repliedAt) {
    state.messages[id] = { ...(state.messages[id] || {}), repliedAt };
  }

  return { load, save, get, set, markReplied };
}
