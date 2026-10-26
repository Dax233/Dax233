#!/usr/bin/env node
/**
 * Starweave stats panel — Dax233
 * --------------------------------------------------------------
 * Fetches public GitHub data for one profile and renders two
 * transparent, self-contained SVG panels:
 *
 *   assets/stats-dark.svg   (for GitHub dark #0d1117)
 *   assets/stats-light.svg  (for GitHub light #ffffff)
 *
 * Node 24 built-ins only (global fetch). No npm, no third-party
 * image service, no runtime dependency on github-readme-stats.
 *
 * Usage
 *   node scripts/update-stats.mjs             fetch live, render, cache
 *   node scripts/update-stats.mjs --offline   render from cache only
 *   node scripts/update-stats.mjs --verbose   log every request
 *
 * Data sources
 *   GET https://api.github.com/users/Dax233                          followers, public_repos
 *   GET https://api.github.com/users/Dax233/repos?type=owner        star sum over non-forks
 *   GET https://api.github.com/repos/Dax233/<repo>/languages        bytes per language (x27)
 *   GET https://github.com/users/Dax233/contributions               public contribution calendar HTML
 *
 * Auth: GITHUB_TOKEN (or GH_TOKEN) is sent as "Authorization: Bearer …" when
 * set; unauthenticated requests use the 60/h public quota. Every successful
 * response is cached in scripts/stats-data.json. If a request fails, the
 * cached value for that block is reused and the run still renders — the panel
 * never shows NaN, zeros-on-error, or invented numbers.
 *
 * scripts/stats-data.json only changes when the underlying numbers change, so
 * the daily workflow commits only on real movement. The SVG contains no
 * timestamp for the same reason (stable output, clean history).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- constants

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
const DATA_PATH = path.join(HERE, 'stats-data.json');

const OWNER = 'Dax233';
const API = 'https://api.github.com';
const CONTRIBUTIONS_URL = 'https://github.com/users/' + OWNER + '/contributions';
const USER_AGENT = 'Dax233-starweave-stats (+https://github.com/Dax233/Dax233)';
const TOKEN = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const CONCURRENCY = 4;
const MAX_REPO_PAGES = 5;
const OFFLINE = process.argv.includes('--offline');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

const log = (...args) => console.log('[stats]', ...args);
const warn = (...args) => console.warn('[stats]', ...args);
const detail = (...args) => { if (VERBOSE) console.log('[stats]', ...args); };

// ---------------------------------------------------------------- utilities

function apiHeaders(extra = {}) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  return headers;
}

async function getJson(url) {
  detail('GET', url, TOKEN ? '(token)' : '(anonymous)');
  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ' ' + res.statusText + ' — ' + url);
  }
  return { body: await res.json(), remaining: res.headers.get('x-ratelimit-remaining') };
}

async function getText(url) {
  detail('GET', url);
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ' ' + res.statusText + ' — ' + url);
  }
  return res.text();
}

/** Run fn over items with a fixed concurrency; keeps input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function toCount(value, label) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('refusing to render ' + label + ': got ' + JSON.stringify(value));
  }
  return n;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function formatCount(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error('cannot read ' + file + ': ' + error.message);
  }
}

/** Write only when the content actually changes; returns true when written. */
async function writeIfChanged(file, content) {
  let previous = null;
  try {
    previous = await readFile(file, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (previous === content) {
    detail('unchanged', path.relative(REPO_ROOT, file));
    return false;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  log('wrote', path.relative(REPO_ROOT, file), '(' + content.length + ' bytes)');
  return true;
}

// ------------------------------------------------------- contributions HTML

const CELL_RE = /<td\b[^>]*\bdata-date="(\d{4}-\d{2}-\d{2})"[^>]*>/g;
const TIP_RE = /<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g;
const COUNT_RE = /^(\d+|no)\s+contributions?\b/i;

/**
 * Parse the public contribution calendar HTML (github.com/users/:login/contributions).
 * GitHub renders one <td data-date data-level id> per day plus a sibling
 * <tool-tip for="<id>">No contributions on …</tool-tip> / "3 contributions on …".
 * Returns Map<'YYYY-MM-DD', count>.
 */
export function parseContributionCalendar(html) {
  const byCellId = new Map();
  for (const match of html.matchAll(CELL_RE)) {
    const tag = match[0];
    const id = /\bid="([^"]+)"/.exec(tag);
    if (id) byCellId.set(id[1], match[1]);
  }
  const days = new Map();
  for (const match of html.matchAll(TIP_RE)) {
    const date = byCellId.get(match[1]);
    if (!date) continue;
    const countMatch = COUNT_RE.exec(match[2].trim());
    if (!countMatch) continue;
    days.set(date, countMatch[1].toLowerCase() === 'no' ? 0 : Number(countMatch[1]));
  }
  return days;
}

/**
 * Summarise the contribution calendar for the requested year: total, current
 * streak (a today with no contribution does not break yesterday's streak) and
 * the longest run inside the calendar window.
 */
export function summarizeContributions(days, requestedYear, today = new Date()) {
  const counts = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (!counts.length) throw new Error('contribution calendar parsed to zero days');

  let year = requestedYear;
  let yearDays = counts.filter(([date]) => date.startsWith(String(year)));
  if (!yearDays.length) {
    const tally = new Map();
    for (const [date] of counts) {
      const y = date.slice(0, 4);
      tally.set(y, (tally.get(y) || 0) + 1);
    }
    year = Number([...tally.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    yearDays = counts.filter(([date]) => date.startsWith(String(year)));
  }

  const total = yearDays.reduce((sum, [, count]) => sum + count, 0);
  const activeDays = yearDays.filter(([, count]) => count > 0).length;

  const activeDates = counts.filter(([, count]) => count > 0).map(([date]) => date);
  const activeSet = new Set(activeDates);
  const dayKey = (d) => d.toISOString().slice(0, 10);
  const dayMs = 86400000;

  // longest run anywhere in the parsed window
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const date of activeDates) {
    if (previous && new Date(date) - new Date(previous) === dayMs) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
    previous = date;
  }

  // current streak: walk back from today (or yesterday when today is still 0)
  let cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (!(days.get(dayKey(cursor)) > 0)) cursor = new Date(cursor.getTime() - dayMs);
  let currentStreak = 0;
  while (activeSet.has(dayKey(cursor))) {
    currentStreak += 1;
    cursor = new Date(cursor.getTime() - dayMs);
  }

  return {
    year,
    total,
    activeDays,
    currentStreak,
    longestStreak: longest,
    firstDay: yearDays[0] ? yearDays[0][0] : null,
    lastDay: yearDays.length ? yearDays[yearDays.length - 1][0] : null,
  };
}

// ---------------------------------------------------------- language + data

export function aggregateLanguages(languageBytesByRepo) {
  const totals = new Map();
  for (const bytes of Object.values(languageBytesByRepo || {})) {
    if (!bytes || typeof bytes !== 'object') continue;
    for (const [language, count] of Object.entries(bytes)) {
      const n = Number(count);
      if (!Number.isFinite(n) || n <= 0) continue;
      totals.set(language, (totals.get(language) || 0) + n);
    }
  }
  const items = [...totals.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  return { totalBytes, items };
}

export function languageRows(languages, topN = 5) {
  const items = (languages && languages.items) || [];
  const total = languages && languages.totalBytes;
  if (!items.length || !total) return [];
  const rows = items.slice(0, topN).map((item) => ({
    name: item.name,
    pct: round1((item.bytes / total) * 100),
  }));
  const rest = items.slice(topN);
  if (rest.length) {
    const restBytes = rest.reduce((sum, item) => sum + item.bytes, 0);
    const shown = rows.reduce((sum, row) => sum + row.pct, 0);
    const other = round1(Math.max(100 - shown, round1((restBytes / total) * 100)));
    if (other > 0) rows.push({ name: '其他', pct: other });
  }
  return rows;
}

function starsOf(repos) {
  return repos.filter((repo) => repo && repo.fork === false).reduce((sum, repo) => {
    const stars = Number(repo.stargazers_count);
    return sum + (Number.isFinite(stars) && stars > 0 ? stars : 0);
  }, 0);
}

function previousMetric(previous, key) {
  const value = previous && previous.metrics && previous.metrics[key];
  if (Number.isInteger(value) && value >= 0) return value;
  throw new Error('no live value and no cached value for metric "' + key + '"');
}

function previousLanguages(previous) {
  const languages = previous && previous.languages;
  if (languages && Array.isArray(languages.items) && Number.isInteger(languages.totalBytes) && languages.totalBytes > 0) {
    return languages;
  }
  throw new Error('no live languages and no cached languages snapshot');
}

/** Assemble the cached snapshot from whichever sources were resolved. */
export function assembleStats(input) {
  const { user, repos, languages, contributions, previous, sources } = input;
  const today = new Date();
  const year = contributions ? contributions.year : (previous && previous.year) || today.getUTCFullYear();

  const metrics = {
    stars: repos ? toCount(starsOf(repos), 'stars') : previousMetric(previous, 'stars'),
    followers: user ? toCount(user.followers, 'followers') : previousMetric(previous, 'followers'),
    repos: user ? toCount(user.public_repos, 'public_repos') : previousMetric(previous, 'repos'),
    contributions: contributions ? toCount(contributions.total, 'contributions') : previousMetric(previous, 'contributions'),
  };

  const languageAggregate = languages ? languages : previousLanguages(previous);
  const streak = contributions
    ? { current: contributions.currentStreak, longest: contributions.longestStreak }
    : (previous && previous.streak) || { current: 0, longest: 0 };

  const data = {
    schema: 1,
    owner: OWNER,
    updated: (previous && previous.updated) || today.toISOString(),
    year,
    metrics,
    streak,
    activeDays: contributions ? contributions.activeDays : (previous && previous.activeDays) || null,
    languages: {
      totalBytes: languageAggregate.totalBytes,
      items: languageAggregate.items.map((item) => ({
        name: item.name,
        bytes: item.bytes,
        pct: round1((item.bytes / languageAggregate.totalBytes) * 100),
      })),
    },
    sources,
  };
  return data;
}

// ------------------------------------------------------------------ fetching

export async function fetchUser() {
  const { body } = await getJson(API + '/users/' + OWNER);
  return body;
}

export async function fetchRepos() {
  const repos = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
    const { body } = await getJson(
      API + '/users/' + OWNER + '/repos?per_page=100&type=owner&sort=updated&page=' + page,
    );
    if (!Array.isArray(body)) throw new Error('unexpected repos payload');
    repos.push(...body);
    if (body.length < 100) break;
  }
  return repos;
}

export async function fetchLanguagesByRepo(repos) {
  const targets = repos.filter((repo) => !repo.fork && repo.name).map((repo) => repo.name);
  const failures = [];
  const pairs = await mapLimit(targets, CONCURRENCY, async (name) => {
    try {
      const { body } = await getJson(API + '/repos/' + OWNER + '/' + encodeURIComponent(name) + '/languages');
      return [name, body];
    } catch (error) {
      failures.push(name + ': ' + error.message);
      return null;
    }
  });
  if (failures.length) {
    throw new Error('languages failed for ' + failures.length + '/' + targets.length + ' repos (' + failures.slice(0, 3).join('; ') + ')');
  }
  const byRepo = {};
  for (const pair of pairs) if (pair) byRepo[pair[0]] = pair[1];
  return byRepo;
}

export async function fetchContributions() {
  const html = await getText(CONTRIBUTIONS_URL);
  const days = parseContributionCalendar(html);
  if (days.size < 300) {
    throw new Error('contribution calendar parsed only ' + days.size + ' days — page shape changed?');
  }
  return summarizeContributions(days, new Date().getUTCFullYear());
}

// ------------------------------------------------------------------ renderer

const FONTS = {
  serif: '"Noto Serif SC","Source Han Serif SC","Songti SC","SimSun",Georgia,serif',
  sans: '"Segoe UI",-apple-system,"PingFang SC","Microsoft YaHei","Helvetica Neue",Arial,sans-serif',
};

const PAPER = {
  dark: {
    ink: '#F4EDDF',
    muted: '#93A3BF',
    gold: '#E8C67A',
    line: '#16233F',
    bar: '#93A3BF',
    seam: '#93A3BF',
    label: 'GitHub dark #0d1117',
  },
  light: {
    ink: '#17223B',
    muted: '#5B6B88',
    gold: '#8A5F19',
    line: '#E7EEFA',
    bar: '#5B6B88',
    seam: '#24365C',
    label: 'GitHub light #ffffff',
  },
};

export const PANEL = {
  width: 846,
  height: 320,
  marginLeft: 40,
  marginRight: 806,
  seamX: 394,
  seamTop: 52,
  seamBottom: 276,
  knotY: 164,
  metricCols: [40, 236],
  metricLabelY: [72, 198],
  metricNumberY: [142, 268],
  languageX: 440,
  languageHeadY: 72,
  barX: 584,
  barWidth: 136,
  barHeight: 5.5,
  pctX: 806,
  rowY: 104,
  rowStep: 34,
};

function sparklePath(cx, cy, radius) {
  const r = radius;
  return 'M' + cx + ' ' + (cy - r) +
    'Q' + cx + ' ' + cy + ' ' + (cx + r) + ' ' + cy +
    'Q' + cx + ' ' + cy + ' ' + cx + ' ' + (cy + r) +
    'Q' + cx + ' ' + cy + ' ' + (cx - r) + ' ' + cy +
    'Q' + cx + ' ' + cy + ' ' + cx + ' ' + (cy - r) + 'Z';
}

/**
 * Desktop composition (displayed at its 1:1 846px width): 2 × 2 metrics on the
 * left, six language rows on the right, one stitched thread between them.
 */
function renderDesktopPanel(stats, p, rows, contributionLabel) {
  const metrics = [
    { label: '星标', value: formatCount(stats.metrics.stars), accent: false, col: 0, row: 0 },
    { label: '关注', value: formatCount(stats.metrics.followers), accent: false, col: 1, row: 0 },
    { label: '仓库', value: formatCount(stats.metrics.repos), accent: false, col: 0, row: 1 },
    { label: contributionLabel, value: formatCount(stats.metrics.contributions), accent: true, col: 1, row: 1 },
  ];

  const metricMarkup = metrics.map((metric) => {
    const x = PANEL.metricCols[metric.col];
    const labelY = PANEL.metricLabelY[metric.row];
    const numberY = PANEL.metricNumberY[metric.row];
    const color = metric.accent ? p.gold : p.ink;
    return [
      '    <text x="' + x + '" y="' + labelY + '" fill="' + p.muted + '" font-family=\'' + FONTS.sans + '\' font-size="26" letter-spacing="1.2">' + metric.label + '</text>',
      '    <text x="' + x + '" y="' + numberY + '" fill="' + color + '" font-family=\'' + FONTS.serif + '\' font-size="64">' + metric.value + '</text>',
    ].join('\n');
  }).join('\n');

  const rowMarkup = rows.map((row, index) => {
    const y = PANEL.rowY + index * PANEL.rowStep;
    const barWidth = Math.max(5, Math.round((row.pct / 100) * PANEL.barWidth * 10) / 10);
    const barTop = Math.round((y - 8 - PANEL.barHeight / 2) * 10) / 10;
    const trackTop = Math.round((y - 8.75) * 10) / 10;
    return [
      '    <text x="' + PANEL.languageX + '" y="' + y + '" fill="' + p.muted + '" font-size="24.5">' + escapeXml(row.name) + '</text>',
      '    <rect x="' + PANEL.barX + '" y="' + trackTop + '" width="' + PANEL.barWidth + '" height="1.5" fill="' + p.muted + '" opacity="0.16"/>',
      '    <rect x="' + PANEL.barX + '" y="' + barTop + '" width="' + barWidth + '" height="' + PANEL.barHeight + '" rx="' + (PANEL.barHeight / 2) + '" fill="' + p.bar + '"/>',
      '    <text x="' + PANEL.pctX + '" y="' + y + '" text-anchor="end" fill="' + p.muted + '" font-size="24.5">' + row.pct.toFixed(1) + '%</text>',
    ].join('\n');
  }).join('\n');

  return [
    '    <!-- the four numbers carry their own labels; one gold accent marks the current year -->',
    '    <g font-variant-numeric="tabular-nums">',
    metricMarkup,
    '    </g>',
    '',
    '    <!-- a single thread of light stitched between the two halves -->',
    '    <path d="M' + PANEL.seamX + ' ' + PANEL.seamTop + ' C' + (PANEL.seamX - 7) + ' 96 ' + (PANEL.seamX + 7) + ' 136 ' + PANEL.seamX + ' 176 C' + (PANEL.seamX - 7) + ' 216 ' + (PANEL.seamX + 7) + ' 244 ' + PANEL.seamX + ' ' + PANEL.seamBottom + '" fill="none" stroke="url(#seam)" stroke-width="2" stroke-linecap="round"/>',
    '    <path d="' + sparklePath(PANEL.seamX, PANEL.knotY, 5.5) + '" fill="' + p.ink + '" opacity="0.5"/>',
    '',
    '    <!-- languages: each bar is a short cut of the same thread -->',
    '    <g font-family=\'' + FONTS.sans + '\' font-variant-numeric="tabular-nums">',
    '      <text x="' + PANEL.languageX + '" y="' + PANEL.languageHeadY + '" fill="' + p.muted + '" font-size="24" letter-spacing="2.4">语言构成</text>',
    rowMarkup,
    '    </g>',
  ].join('\n');
}

/**
 * Mobile composition (switched in by @media max-width: 520px on the displayed
 * width, i.e. the phone's 298 px): four metrics in one row with much larger
 * type, then the three biggest languages as short bars. Everything stays above
 * ~9 px at 298 px display.
 */
function renderMobilePanel(stats, p, rows, contributionLabel) {
  const metrics = [
    { label: '星标', value: formatCount(stats.metrics.stars), accent: false },
    { label: '关注', value: formatCount(stats.metrics.followers), accent: false },
    { label: '仓库', value: formatCount(stats.metrics.repos), accent: false },
    { label: contributionLabel, value: formatCount(stats.metrics.contributions), accent: true },
  ];
  const metricX = [40, 232, 423, 615];
  const metricMarkup = metrics.map((metric, index) => {
    const color = metric.accent ? p.gold : p.ink;
    return [
      '    <text x="' + metricX[index] + '" y="82" fill="' + p.muted + '" font-family=\'' + FONTS.sans + '\' font-size="30" letter-spacing="1.4">' + metric.label + '</text>',
      '    <text x="' + metricX[index] + '" y="178" fill="' + color + '" font-family=\'' + FONTS.serif + '\' font-size="84">' + metric.value + '</text>',
    ].join('\n');
  }).join('\n');

  const columnWidth = 224;
  const topLanguages = rows.slice(0, 3);
  const languageMarkup = topLanguages.map((row, index) => {
    const x = 40 + index * 256;
    const fill = Math.max(7, Math.round((row.pct / 100) * columnWidth * 10) / 10);
    return [
      '    <text x="' + x + '" y="246" fill="' + p.muted + '" font-size="26">' + escapeXml(row.name) + '</text>',
      '    <text x="' + (x + columnWidth) + '" y="246" text-anchor="end" fill="' + p.muted + '" font-size="26">' + row.pct.toFixed(1) + '%</text>',
      '    <rect x="' + x + '" y="261.5" width="' + columnWidth + '" height="1.5" fill="' + p.muted + '" opacity="0.16"/>',
      '    <rect x="' + x + '" y="258.5" width="' + fill + '" height="7" rx="3.5" fill="' + p.bar + '"/>',
    ].join('\n');
  }).join('\n');

  return [
    '    <g font-family=\'' + FONTS.sans + '\' font-variant-numeric="tabular-nums">',
    metricMarkup,
    '    </g>',
    '',
    '    <!-- on mobile the seam lies down: one horizontal thread, then three language bars -->',
    '    <path d="M40 212 C200 206 320 218 423 212 C526 206 646 218 806 212" fill="none" stroke="url(#seamH)" stroke-width="2" stroke-linecap="round"/>',
    '    <path d="' + sparklePath(423, 212, 4.5) + '" fill="' + p.ink + '" opacity="0.5"/>',
    '',
    '    <g font-family=\'' + FONTS.sans + '\' font-variant-numeric="tabular-nums">',
    languageMarkup,
    '    </g>',
  ].join('\n');
}

export function renderPanel(stats, mode) {
  const p = PAPER[mode];
  const rows = languageRows(stats.languages, 5);
  const year = stats.year;
  const isCurrentYear = year === new Date().getUTCFullYear();
  const contributionLabel = isCurrentYear ? '今年贡献' : year + ' 年贡献';

  const languageSummary = rows.map((row) => row.name + ' ' + row.pct.toFixed(1) + '%').join(', ');
  const title = 'Dax233 — 星织 · 数据面板 / Starweave stats';
  const desc = 'Public GitHub data for Dax233. ' +
    formatCount(stats.metrics.stars) + ' stars across public non-fork repositories, ' +
    formatCount(stats.metrics.followers) + ' followers, ' +
    formatCount(stats.metrics.repos) + ' public repositories, ' +
    formatCount(stats.metrics.contributions) + ' contributions in ' + year +
    ' (' + (stats.streak.current || 0) + '-day current streak). Languages (by bytes): ' +
    languageSummary + '. 数据来自 GitHub 公开数据 · 每日自动更新 (public GitHub data, refreshed daily).';

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + PANEL.width + ' ' + PANEL.height + '" width="' + PANEL.width + '" height="' + PANEL.height + '" role="img" aria-labelledby="statsTitle statsDesc">',
    '  <title id="statsTitle">' + escapeXml(title) + '</title>',
    '  <desc id="statsDesc">' + escapeXml(desc) + '</desc>',
    '  <style>',
    '    /* Desktop is the default. When the image is displayed at 520 CSS px or narrower',
    '       (the phone width measured for the GitHub profile README), switch to',
    '       the mobile composition with larger type and no dense language list.',
    '       Browsers that ignore media queries inside SVG images fall back to',
    '       the desktop layout. */',
    '    .only-mobile { display: none; }',
    '    @media (max-width: 520px) {',
    '      .only-desktop { display: none; }',
    '      .only-mobile { display: inline; }',
    '    }',
    '  </style>',
    '  <defs>',
    '    <linearGradient id="seam" gradientUnits="userSpaceOnUse" x1="0" y1="' + PANEL.seamTop + '" x2="0" y2="' + PANEL.seamBottom + '">',
    '      <stop offset="0" stop-color="' + p.seam + '" stop-opacity="0"/>',
    '      <stop offset="0.18" stop-color="' + p.seam + '" stop-opacity="0.2"/>',
    '      <stop offset="0.5" stop-color="' + p.seam + '" stop-opacity="0.34"/>',
    '      <stop offset="0.82" stop-color="' + p.seam + '" stop-opacity="0.2"/>',
    '      <stop offset="1" stop-color="' + p.seam + '" stop-opacity="0"/>',
    '    </linearGradient>',
    '    <linearGradient id="seamH" gradientUnits="userSpaceOnUse" x1="40" y1="0" x2="806" y2="0">',
    '      <stop offset="0" stop-color="' + p.seam + '" stop-opacity="0"/>',
    '      <stop offset="0.14" stop-color="' + p.seam + '" stop-opacity="0.2"/>',
    '      <stop offset="0.5" stop-color="' + p.seam + '" stop-opacity="0.34"/>',
    '      <stop offset="0.86" stop-color="' + p.seam + '" stop-opacity="0.2"/>',
    '      <stop offset="1" stop-color="' + p.seam + '" stop-opacity="0"/>',
    '    </linearGradient>',
    '  </defs>',
    '',
    '  <g class="only-desktop">',
    renderDesktopPanel(stats, p, rows, contributionLabel),
    '  </g>',
    '',
    '  <g class="only-mobile">',
    renderMobilePanel(stats, p, rows, contributionLabel),
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

// --------------------------------------------------------------------- main

async function main() {
  const previous = await readJsonFile(DATA_PATH);
  if (OFFLINE && !previous) {
    throw new Error('--offline requires an existing ' + path.relative(REPO_ROOT, DATA_PATH));
  }

  let user = null;
  let repos = null;
  let languages = null;
  let contributions = null;
  const sources = {};

  if (OFFLINE) {
    log('offline: rendering from', path.relative(REPO_ROOT, DATA_PATH));
    sources.user = sources.repos = sources.languages = sources.contributions = 'cache';
  } else {
    log('fetching public GitHub data for', OWNER, TOKEN ? '(token)' : '(anonymous)');

    try {
      user = await fetchUser();
      sources.user = 'api';
    } catch (error) {
      warn('user lookup failed — using cache:', error.message);
      sources.user = 'cache';
    }

    try {
      repos = await fetchRepos();
      sources.repos = 'api';
    } catch (error) {
      warn('repo list failed — using cache:', error.message);
      sources.repos = 'cache';
    }

    if (repos) {
      try {
        languages = aggregateLanguages(await fetchLanguagesByRepo(repos));
        sources.languages = 'api';
      } catch (error) {
        warn('per-repo languages failed — using whole cached language snapshot:', error.message);
        sources.languages = 'cache';
      }
    } else {
      sources.languages = 'cache';
    }

    try {
      contributions = await fetchContributions();
      sources.contributions = 'html';
    } catch (error) {
      warn('contribution calendar failed — using cache:', error.message);
      sources.contributions = 'cache';
    }
  }

  const data = assembleStats({ user, repos, languages, contributions, previous, sources });

  // Snapshot: only move "updated" / "sources" when the numbers actually move,
  // so a quiet day (or a rate-limited fallback run) produces no commit at all.
  const fingerprint = (value) => JSON.stringify({
    metrics: value.metrics,
    year: value.year,
    streak: value.streak,
    activeDays: value.activeDays,
    languages: value.languages,
  });
  if (previous && fingerprint(previous) === fingerprint(data)) {
    data.updated = previous.updated;
    data.sources = previous.sources;
  } else {
    data.updated = new Date().toISOString();
  }

  // --offline is a render-only mode: never rewrite the snapshot's provenance.
  if (!OFFLINE) {
    const payload = JSON.stringify(data, null, 1) + '\n';
    await writeIfChanged(DATA_PATH, payload);
  }

  await writeIfChanged(path.join(ASSETS_DIR, 'stats-dark.svg'), renderPanel(data, 'dark'));
  await writeIfChanged(path.join(ASSETS_DIR, 'stats-light.svg'), renderPanel(data, 'light'));

  const rows = languageRows(data.languages, 5);
  log('stars', data.metrics.stars, '| followers', data.metrics.followers, '| repos', data.metrics.repos,
    '| ' + data.year + ' contributions', data.metrics.contributions,
    '| streak', data.streak.current + 'd');
  log('languages:', rows.map((row) => row.name + ' ' + row.pct.toFixed(1) + '%').join(' · '));
  log('sources:', JSON.stringify(sources));
  log('done');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[stats] fatal:', error.message);
    process.exitCode = 1;
  });
}
