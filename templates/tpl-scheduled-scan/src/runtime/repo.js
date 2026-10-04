// The app's only door to the world: the REPO capability the runtime passes in.
// It reads this repository at the commit being run, reads the memory repository,
// and hands snapshots back for the runtime to commit. There is nothing else --
// no network, no token, no write access to Git.
// Template code.

export function openRepo(env) {
  const cap = env.REPO;
  if (!cap) throw new Error("REPO capability missing: this app must run under Artifacts-OS");
  return {
    readFile: (path) => cap.readFile(path),
    list: (dir) => cap.list(dir),
    memory: (path) => cap.memory(path),
    writeSnapshot: (name, value) => cap.writeSnapshot(name, value),
    log: (event) => cap.log(event),
    async readJson(path) {
      const text = await cap.readFile(path);
      if (text === null || text === undefined) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    async memoryJson(path) {
      const text = await cap.memory(path);
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
  };
}
