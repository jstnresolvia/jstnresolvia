// Builds the profile card, the contribution graph, the buttons and README.md.
//
//   GH_TOKEN=... node scripts/build.mjs
//
// With a token it reads fresh numbers from GitHub and caches them in
// assets/stats.json; without one (or when GitHub fails) it reuses that cache,
// so the card always builds. Plain Node 20+, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
fs.mkdirSync(assets, { recursive: true });

const cfg = JSON.parse(fs.readFileSync(path.join(root, 'profile.config.json'), 'utf8'));
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

// ─── layout ──────────────────────────────────────────────────────────────────
const FONT = 14;
const CHAR = 8.45; // widest common monospace (Courier New) at 14px; Consolas is narrower
const LINE = 20;
const PAD = 24;
const COLS = 58; // characters per line in the info column
const GAP = 28;
// The portrait uses a smaller grid than the text, for more detail per pixel.
const ART_FONT = 9;
const ART_CHAR = 5.45;
const ART_LINE = 10.5;

const THEMES = {
  dark: {
    bg: '#0d1117', card: '#161b22', border: '#30363d', text: '#c9d1d9', art: '#b1bac4',
    key: '#58a6ff', value: '#a5d6ff', dots: '#484f58', accent: '#66b8ff',
    add: '#3fb950', del: '#f85149', muted: '#8b949e',
    heat: ['#21262d', '#0e3a5c', '#16609a', '#2b8ae0', '#66b8ff'],
  },
  light: {
    bg: '#ffffff', card: '#f6f8fa', border: '#d0d7de', text: '#24292f', art: '#57606a',
    key: '#0969da', value: '#0a3069', dots: '#afb8c1', accent: '#0969da',
    add: '#1a7f37', del: '#cf222e', muted: '#57606a',
    heat: ['#ebeef1', '#b6dcff', '#6cb6ff', '#2f81f7', '#0a58ca'],
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

// ─── stats ───────────────────────────────────────────────────────────────────
const statsPath = path.join(assets, 'stats.json');
const cached = fs.existsSync(statsPath) ? JSON.parse(fs.readFileSync(statsPath, 'utf8')) : null;

async function gh(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-readme-builder',
      ...init.headers,
    },
  });
  return res;
}

async function gql(query, variables = {}) {
  const res = await gh('https://api.github.com/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  const json = await res.json();
  if (json.errors || !json.data) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Additions/deletions per repo come from the contributor stats, which GitHub
// computes lazily: the first call answers 202 and the numbers arrive later.
async function linesFor(nameWithOwner, login) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await gh(`https://api.github.com/repos/${nameWithOwner}/stats/contributors`);
    if (res.status === 202) { await sleep(3000); continue; }
    if (res.status === 204) return { add: 0, del: 0 };
    if (!res.ok) return null;
    const list = await res.json();
    const me = Array.isArray(list) ? list.find((c) => c.author?.login?.toLowerCase() === login.toLowerCase()) : null;
    if (!me) return { add: 0, del: 0 };
    return me.weeks.reduce((acc, w) => ({ add: acc.add + w.a, del: acc.del + w.d, commits: acc.commits + w.c }), { add: 0, del: 0, commits: 0 });
  }
  return null;
}

async function fetchStats() {
  const base = await gql(`query {
    viewer {
      login createdAt
      followers { totalCount }
      owned: repositories(ownerAffiliations: OWNER, isFork: false, first: 100) { totalCount nodes { stargazerCount } }
      contributed: repositoriesContributedTo(first: 1, includeUserRepositories: false, contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY]) { totalCount }
      access: repositories(ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], isFork: false, first: 100) { nodes { nameWithOwner } }
      contributionsCollection {
        contributionCalendar { totalContributions weeks { contributionDays { date contributionCount weekday } } }
      }
    }
  }`);
  const v = base.viewer;

  // Commits for every year since the account exists (the API caps a range at one year).
  let commits = 0;
  const start = new Date(v.createdAt).getUTCFullYear();
  const now = new Date();
  for (let y = start; y <= now.getUTCFullYear(); y++) {
    const end = new Date(`${y}-12-31T23:59:59Z`);
    const d = await gql(`query($from: DateTime!, $to: DateTime!) {
      viewer { contributionsCollection(from: $from, to: $to) { totalCommitContributions } }
    }`, { from: `${y}-01-01T00:00:00Z`, to: (end > now ? now : end).toISOString() });
    commits += d.viewer.contributionsCollection.totalCommitContributions;
  }

  // Keyed by a hash: this file is public, and private repo names must not be.
  const key = (name) => createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 16);
  const perRepo = Object.fromEntries(Object.entries(cached?.perRepo ?? {}).filter(([k]) => /^[0-9a-f]{16}$/.test(k)));
  for (const { nameWithOwner } of v.access.nodes) {
    const lines = await linesFor(nameWithOwner, v.login);
    if (lines) perRepo[key(nameWithOwner)] = lines; // keep the cached value when GitHub is still computing
  }
  const add = Object.values(perRepo).reduce((s, r) => s + r.add, 0);
  const del = Object.values(perRepo).reduce((s, r) => s + r.del, 0);

  return {
    updatedAt: new Date().toISOString(),
    login: v.login,
    repos: v.owned.totalCount,
    contributed: v.contributed.totalCount,
    stars: v.owned.nodes.reduce((s, r) => s + r.stargazerCount, 0),
    // The contribution count skips commits made before the address was on the
    // account; the repo stats count them, so take whichever saw more.
    commits: Math.max(commits, Object.values(perRepo).reduce((s, r) => s + (r.commits ?? 0), 0)),
    followers: v.followers.totalCount,
    add, del, perRepo,
    calendar: v.contributionsCollection.contributionCalendar,
  };
}

let stats = cached;
if (TOKEN) {
  try {
    stats = await fetchStats();
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2) + '\n');
    console.log(`stats: ${stats.commits} commits, +${stats.add} / -${stats.del} lines across ${Object.keys(stats.perRepo).length} repos`);
  } catch (err) {
    console.warn(`GitHub request failed, using cached stats: ${err.message}`);
  }
} else {
  console.warn('No GH_TOKEN, using cached stats.');
}
stats ??= { repos: 0, contributed: 0, stars: 0, commits: 0, followers: 0, add: 0, del: 0, calendar: null };

// ─── uptime ──────────────────────────────────────────────────────────────────
function uptime(birthday) {
  const b = new Date(`${birthday}T00:00:00Z`);
  const now = new Date();
  let y = now.getUTCFullYear() - b.getUTCFullYear();
  let m = now.getUTCMonth() - b.getUTCMonth();
  let d = now.getUTCDate() - b.getUTCDate();
  if (d < 0) { m -= 1; d += new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate(); }
  if (m < 0) { y -= 1; m += 12; }
  const p = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return `${p(y, 'year')}, ${p(m, 'month')}, ${p(d, 'day')}`;
}

// ─── info lines ──────────────────────────────────────────────────────────────
// A line is a list of [text, class] runs; the renderer turns runs into tspans.
const resolve = (value) => {
  if (value == null) return null;
  if (value === '{uptime}') return cfg.birthday ? uptime(cfg.birthday) : null;
  return value;
};

function field(key, value, width = COLS) {
  // ". Key: ........ value"
  const parts = key.split('.');
  const keyRuns = parts.flatMap((p, i) => (i ? [['.', 'p'], [p, 'k']] : [[p, 'k']]));
  const valueRuns = Array.isArray(value) ? value : [[value, 'v']];
  const valueLen = valueRuns.reduce((n, [t]) => n + t.length, 0);
  const used = 2 + key.length + 1 + 1 + 1 + valueLen; // ". " key ":" " " dots " " value
  const dots = Math.max(2, width - used);
  return [['. ', 'p'], ...keyRuns, [':', 'p'], [' ', 'p'], ['.'.repeat(dots), 'd'], [' ', 'p'], ...valueRuns];
}

function pair(k1, v1, k2, v2) {
  const left = 30;
  const a = field(k1, v1, left);
  const b = field(k2, v2, COLS - left - 1).slice(1); // " | " replaces the leading ". "
  return [...a, [' | ', 'p'], ...b];
}

function rule(title) {
  const head = title ? `- ${title} ` : '';
  return [[head, 'p'], ['─'.repeat(COLS - head.length), 'd']];
}

const blank = [];
const section = (rows) => rows.map(([k, v]) => [k, resolve(v)]).filter(([, v]) => v).map(([k, v]) => field(k, v));

const lines = [
  [[cfg.prompt, 'h'], [' ', 'p'], ['─'.repeat(COLS - cfg.prompt.length - 1), 'd']],
  ...section(cfg.system),
  blank,
  ...section(cfg.languages),
  blank,
  ...section(cfg.focus),
  blank,
  // Optional titled blocks, e.g. { "title": "Resolvia", "rows": [["Product", "…"]] }.
  ...(cfg.extra ?? []).flatMap((s) => [rule(s.title), ...section(s.rows), blank]),
  rule('Contact'),
  ...section(cfg.contact),
  blank,
  rule('GitHub Stats'),
  pair('Repos', [[fmt(stats.repos), 'v'], [' {', 'p'], ['Contributed', 'k'], [': ', 'p'], [fmt(stats.contributed), 'v'], ['}', 'p']], 'Stars', fmt(stats.stars)),
  pair('Commits', fmt(stats.commits), 'Followers', fmt(stats.followers)),
  field('Lines of Code', [
    [fmt(stats.add - stats.del), 'v'], [' ( ', 'p'], [`${fmt(stats.add)}++`, 'add'], [', ', 'p'], [`${fmt(stats.del)}--`, 'del'], [' )', 'p'],
  ]),
];

// ─── portrait ────────────────────────────────────────────────────────────────
const portraitPath = path.join(assets, 'portrait.txt');
const art = fs.existsSync(portraitPath) ? fs.readFileSync(portraitPath, 'utf8').replace(/\s+$/, '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')) : [];
const artCols = Math.max(0, ...art.map((l) => l.length));

// ─── card ────────────────────────────────────────────────────────────────────
function card(t) {
  const infoX = Math.round(PAD + (artCols ? artCols * ART_CHAR + GAP : 0));
  const width = Math.ceil(infoX + COLS * CHAR + PAD);
  const textRows = lines.length + 2; // + empty line + prompt cursor
  const height = Math.ceil(PAD * 2 + Math.max(textRows * LINE, art.length * ART_LINE));
  const firstBase = PAD + FONT;
  const artTop = Math.round(PAD + ART_FONT + Math.max(0, (height - PAD * 2 - art.length * ART_LINE) / 2));

  const tspans = (runs) => runs.map(([text, cls]) => `<tspan class="${cls}">${esc(text)}</tspan>`).join('');
  const info = lines
    .map((runs, i) => `<text x="${infoX}" y="${firstBase + i * LINE}">${tspans(runs)}</text>`)
    .join('\n    ');
  const cursorY = firstBase + (lines.length + 1) * LINE;
  const artText = art
    .map((l, i) => `<text x="${PAD}" y="${artTop + i * ART_LINE}" class="a">${esc(l)}</text>`)
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', 'Courier New', monospace" font-size="${FONT}px">
  <style>
    text { white-space: pre; }
    .a { fill: ${t.art}; font-size: ${ART_FONT}px; }
    .h { fill: ${t.accent}; font-weight: 700; }
    .k { fill: ${t.key}; }
    .v { fill: ${t.value}; }
    .p { fill: ${t.text}; }
    .d { fill: ${t.dots}; }
    .add { fill: ${t.add}; }
    .del { fill: ${t.del}; }
    .c { fill: ${t.accent}; }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${t.card}" stroke="${t.border}"/>
  <g xml:space="preserve">
    ${artText}
    ${info}
    <text x="${infoX}" y="${cursorY}" class="c">&gt;</text>
    <rect x="${infoX + 2 * CHAR}" y="${cursorY - FONT + 2}" width="${CHAR}" height="${FONT + 1}" fill="${t.accent}"><animate attributeName="opacity" values="1;0" dur="1.1s" calcMode="discrete" repeatCount="indefinite"/></rect>
  </g>
</svg>
`;
}

// ─── contribution graph ──────────────────────────────────────────────────────
function contributions(t, width) {
  const cal = stats.calendar;
  if (!cal) return null;
  const weeks = cal.weeks;
  const left = 36, top = 54, right = 20;
  const step = Math.min(16, (width - left - right) / weeks.length);
  const size = Math.round(step * 0.78 * 10) / 10;
  const height = top + 7 * step + 46;
  const max = Math.max(1, ...weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount)));
  const level = (n) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor((n / max) * 3.999)));

  const cycle = 9; // seconds for one sweep across the year
  const cells = [];
  const sweep = [];
  const months = [];
  let lastMonth = -1;
  weeks.forEach((w, wi) => {
    const x = left + wi * step;
    const first = new Date(`${w.contributionDays[0].date}T00:00:00Z`);
    if (first.getUTCMonth() !== lastMonth && first.getUTCDate() <= 7 && wi < weeks.length - 2) {
      lastMonth = first.getUTCMonth();
      months.push(`<text x="${x}" y="${top - 10}" class="m">${first.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}</text>`);
    }
    for (const d of w.contributionDays) {
      const y = top + d.weekday * step;
      cells.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${size}" height="${size}" rx="2" fill="${t.heat[level(d.contributionCount)]}"><title>${d.date}: ${d.contributionCount}</title></rect>`);
    }
    // A soft light that runs across the weeks, brightest where you committed.
    const k = wi / weeks.length;
    const k0 = Math.max(0, k - 0.02).toFixed(3), k1 = k.toFixed(3), k2 = Math.min(1, k + 0.04).toFixed(3);
    sweep.push(`<rect x="${(x - 1).toFixed(1)}" y="${top - 1}" width="${(size + 2).toFixed(1)}" height="${(7 * step).toFixed(1)}" rx="3" fill="${t.accent}" opacity="0"><animate attributeName="opacity" dur="${cycle}s" repeatCount="indefinite" values="0;0;0.28;0;0" keyTimes="0;${k0};${k1};${k2};1"/></rect>`);
  });

  const days = ['Mon', 'Wed', 'Fri'].map((d, i) => `<text x="${PAD - 4}" y="${top + (1 + i * 2) * step + size - 2}" class="m">${d}</text>`);
  const legendX = width - right - 5 * step - 70;
  const legend = t.heat.map((c, i) => `<rect x="${legendX + 36 + i * step}" y="${height - 28}" width="${size}" height="${size}" rx="2" fill="${c}"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', 'Courier New', monospace">
  <style>
    .t { fill: ${t.text}; font-size: 13px; }
    .m { fill: ${t.muted}; font-size: 11px; }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${t.card}" stroke="${t.border}"/>
  <text x="${PAD - 4}" y="28" class="t">${fmt(cal.totalContributions)} contribution${cal.totalContributions === 1 ? '' : 's'} in the last year</text>
  ${months.join('\n  ')}
  ${days.join('\n  ')}
  ${cells.join('\n  ')}
  <g>${sweep.join('')}</g>
  <text x="${legendX}" y="${height - 18}" class="m">Less</text>
  ${legend.join('\n  ')}
  <text x="${legendX + 40 + 5 * step}" y="${height - 18}" class="m">More</text>
</svg>
`;
}

// ─── buttons ─────────────────────────────────────────────────────────────────
const ICONS = {
  monitor: (c) => `<rect x="2" y="3" width="20" height="14" rx="2" fill="none" stroke="${c}" stroke-width="2"/><path d="M8 21h8M12 17v4M6 8l3 2-3 2M11 12h5" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  mail: (c) => `<rect x="2" y="4" width="20" height="16" rx="2" fill="none" stroke="${c}" stroke-width="2"/><path d="M3 6l9 7 9-7" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>`,
  linkedin: (c) => `<rect x="2" y="2" width="20" height="20" rx="4" fill="${c}"/><path d="M7 10v7M7 7v.01M11 17v-7M11 13a3 3 0 0 1 6 0v4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`,
};

function button(t, b, width) {
  const h = 46;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" font-family="ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', 'Courier New', monospace">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${h - 1}" rx="8" fill="${t.card}" stroke="${t.border}"/>
  <rect x="10" y="${h - 3}" width="${width - 20}" height="2" rx="1" fill="${t.accent}"/>
  <g transform="translate(${width / 2 - 62} ${h / 2 - 12})">${ICONS[b.icon]?.(t.accent) ?? ''}</g>
  <text x="${width / 2 - 30}" y="${h / 2 + 5}" font-size="14px" letter-spacing="1" fill="${t.text}">${esc(b.label.toUpperCase())}</text>
</svg>
`;
}

// ─── write everything ────────────────────────────────────────────────────────
// Every image is written under a name that carries a hash of its content
// (card-dark.3f9a1c2b7e.svg). GitHub's image CDN caches by path and ignores
// query strings, so a changed card under the same name stays stale for a
// while; a new name is fetched at once. Old versions are removed first.
for (const f of fs.readdirSync(assets)) if (/\.svg$/.test(f)) fs.rmSync(path.join(assets, f));
const files = {};
const write = (name, content) => {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 10);
  const file = name.replace(/\.svg$/, `.${hash}.svg`);
  fs.writeFileSync(path.join(assets, file), content);
  files[name] = file;
};
const buttons = cfg.buttons.filter((b) => b.href);
let cardWidth = 0;

for (const [mode, t] of Object.entries(THEMES)) {
  const svg = card(t);
  cardWidth = Number(svg.match(/width="(\d+)"/)[1]);
  write(`card-${mode}.svg`, svg);
  const graph = contributions(t, cardWidth);
  if (graph) write(`contributions-${mode}.svg`, graph);
  const bw = Math.floor((cardWidth - (buttons.length - 1) * 12) / Math.max(1, buttons.length));
  buttons.forEach((b, i) => write(`button-${i}-${mode}.svg`, button(t, b, bw)));
}

const picture = (name, alt, attrs = '') => `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/${files[`${name}-dark.svg`]}">
  <img alt="${esc(alt)}" src="assets/${files[`${name}-light.svg`]}"${attrs}>
</picture>`;

const readme = `<!-- Generated by scripts/build.mjs from profile.config.json; edit those, not this file. -->
<p align="center">
${picture('card', `${cfg.prompt}: ${lines.slice(1).map((r) => r.map(([s]) => s).join('')).filter(Boolean).slice(0, 4).join(' | ')}`)}
</p>

<p align="center">
${buttons.map((b, i) => `<a href="${esc(b.href)}">${picture(`button-${i}`, b.label)}</a>`).join('\n')}
</p>
${stats.calendar ? `\n<p align="center">\n${picture('contributions', 'Contribution graph')}\n</p>\n` : ''}`;

fs.writeFileSync(path.join(root, 'README.md'), readme);
console.log(`card ${cardWidth}px wide, ${lines.length} lines, portrait ${artCols}x${art.length}, ${buttons.length} buttons`);
