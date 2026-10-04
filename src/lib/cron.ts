// Just enough cron for app schedules: five fields, `*`, numbers, lists,
// ranges and `*/n` steps, evaluated in UTC. Apps declare their own schedule in
// app.json; the runtime's hourly cron asks which are due.

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? parseInt(stepRaw, 10) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-");
      lo = parseInt(a, 10);
      hi = b === undefined ? (stepRaw ? max : lo) : parseInt(b, 10);
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || step < 1) throw new Error("bad cron field: " + field);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("cron needs five fields: " + expr);
  return {
    minute: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12),
    // 7 is Sunday too, as in most crons.
    dow: new Set([...parseField(f[4], 0, 7)].map((d) => d % 7)),
    domAny: f[2] === "*",
    dowAny: f[4] === "*",
  };
}

/** The first time strictly after `after` (ms, UTC) that matches `expr`. */
export function nextRun(expr: string, after: number): number {
  const c = parseCron(expr);
  const t = new Date(after);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after + 366 * 86400000;
  while (t.getTime() <= limit) {
    const dayOk = (() => {
      const dom = c.dom.has(t.getUTCDate());
      const dow = c.dow.has(t.getUTCDay());
      if (c.domAny && c.dowAny) return true;
      if (c.domAny) return dow;
      if (c.dowAny) return dom;
      return dom || dow;
    })();
    if (!c.month.has(t.getUTCMonth() + 1) || !dayOk) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return t.getTime();
  }
  throw new Error("no run within a year for " + expr);
}
