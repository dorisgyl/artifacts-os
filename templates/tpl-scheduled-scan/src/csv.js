// CSV reading for statement exports.
// Template code: a fix here is made in tpl-scheduled-scan and fans out to every
// app built from it.

export function splitLine(line, delimiter = ",") {
  return line.split(delimiter).map((cell) => cell.trim());
}

/** Rows as objects keyed by the (lower-cased) header line. */
export function parseCsv(text, opts = {}) {
  const delimiter = opts.delimiter || ",";
  const lines = String(text)
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  if (!lines.length) return { header: [], rows: [] };
  const header = splitLine(lines[0], delimiter).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cells = splitLine(line, delimiter);
    const row = {};
    header.forEach((h, i) => {
      row[h] = cells[i] === undefined ? "" : cells[i];
    });
    return row;
  });
  return { header, rows };
}
