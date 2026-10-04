// Page chrome for the app's report. Template code. The runtime injects its
// approval bar at the top of <body> when this page is served as a preview.

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function renderPage({ title, body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --ink:#1b1d21; --muted:#5f6670; --line:#e3e5e8; --bg:#fbfbfa; --accent:#c2410c; --good:#15803d; }
  @media (prefers-color-scheme: dark) { :root { --ink:#eceef1; --muted:#9aa1ab; --line:#2c3036; --bg:#15171a; } }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .muted { color: var(--muted); }
  table { width:100%; border-collapse: collapse; margin-top: 16px; }
  th, td { text-align:left; padding: 8px 6px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  .tag { font-size: 12px; padding: 2px 8px; border-radius: 999px; border:1px solid var(--line); }
  .tag.new { color: var(--accent); border-color: currentColor; }
  .tag.up { color: var(--good); border-color: currentColor; }
</style></head>
<body><main>
<h1>${esc(title)}</h1>
${body}
</main></body></html>`;
}

export { esc };
