// A test harness small enough to read in one go, so apps need no dependencies.
// Template code.

const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error((message ? message + ": " : "") + "expected " + e + ", got " + a);
}

export function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

/** A REPO capability backed by an in-memory file map, for tests. */
export function fakeRepo(files, memory = {}) {
  const snapshots = {};
  const read = (path) => (path in files ? files[path] : null);
  return {
    snapshots,
    readFile: async (p) => read(p),
    list: async (dir) => Object.keys(files).filter((p) => p.startsWith(dir)).sort(),
    memory: async (p) => (p in memory ? memory[p] : null),
    writeSnapshot: async (name, value) => {
      snapshots[name] = value;
    },
    log: async () => {},
    readJson: async (p) => (read(p) === null ? null : JSON.parse(read(p))),
    memoryJson: async (p) => (p in memory ? JSON.parse(memory[p]) : null),
  };
}

export async function runAll() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log("ok   " + t.name);
    } catch (e) {
      failed++;
      console.log("FAIL " + t.name + "\n     " + (e && e.message ? e.message : e));
    }
  }
  console.log(tests.length - failed + "/" + tests.length + " passed");
  return failed;
}
