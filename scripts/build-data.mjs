// Builds data/site.json for usmoneywatch.blogspot.com. GitHub Actions runs it every 6 hours (.github/workflows/update-data.yml),
// so the site's numbers, news and videos stay fresh even when no computer is on.
//   node scripts/build-data.mjs
// Sources: FRED (official U.S. data), Google News RSS (headlines link to the publishers), The Capital Order's YouTube feed.
import fs from 'fs';
const OUT = new URL('../data/site.json', import.meta.url);
const CHANNEL = 'UCBKcPgdmL9C6Z_K8hCVibRA';
const log = (...a) => console.log(new Date().toISOString(), ...a);
const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

// ---------- FRED ----------
const cache = {};
async function fred(id) {
  if (cache[id]) return cache[id];
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: { 'user-agent': 'usmoneywatch-data/1.0' } });
      const t = await r.text();
      if (r.ok && t.startsWith('observation_date')) {
        return cache[id] = t.trim().split(/\r?\n/).slice(1).map(l => l.split(',')).filter(([, v]) => v && v != '.').map(([d, v]) => ({ d, v: +v }));
      }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('FRED ' + id);
}
// Same month one year earlier (never across a gap)
const yearAgo = (s, i) => s.find(x => x.d == (+s[i].d.slice(0, 4) - 1) + s[i].d.slice(4));
const yoySeries = s => s.map((x, i) => { const p = yearAgo(s, i); return p ? { d: x.d, v: (x.v / p.v - 1) * 100 } : null; }).filter(Boolean);
const diffSeries = s => s.slice(1).map((x, i) => ({ d: x.d, v: x.v - s[i].v }));
const monthly = s => { const m = new Map(); for (const x of s) { const k = x.d.slice(0, 7) + '-01'; (m.get(k) || m.set(k, []).get(k)).push(x.v); } return [...m].map(([d, v]) => ({ d, v: v.reduce((a, b) => a + b) / v.length })); };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const period = (d, f) => f == 'q' ? `Q${Math.floor(+d.slice(5, 7) / 3) + 1} ${d.slice(0, 4)}` : f == 'm' ? `${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}` : `${MON[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}`;
const short = (d, f) => f == 'q' ? `Q${Math.floor(+d.slice(5, 7) / 3) + 1}` : f == 'm' ? MON[+d.slice(5, 7) - 1] : `${MON[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}`;
const fmt = (v, u, dec) => u == '%' ? v.toFixed(dec) + '%' : u == '$' ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
  : u == '$T' ? '$' + (v / 1e6).toFixed(1) + 'T' : u == '$K' ? '$' + Math.round(v / 1000) + 'K' : u == 'K' ? (v > 0 ? '+' : '') + Math.round(v) + 'K' : u == 'M' ? (v / 1000).toFixed(1) + 'M' : v.toFixed(dec);
const sgn = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v);

// One indicator card: latest value, period, change vs. a year earlier (or vs. the prior reading), sparkline
async function indicator(c) {
  let s = await fred(c.id);
  if (c.monthly) s = monthly(s);
  if (c.t == 'yoy') s = yoySeries(s);
  if (c.t == 'diff') s = diffSeries(s);
  const i = s.length - 1, last = s[i];
  const points = c.u == '%' || c.t == 'yoy' || c.pts;  // rates: change in percentage points; levels: % change
  let change, delta;
  if (c.vs == 'prior') delta = last.v - s[i - 1].v;
  else {
    // a year earlier: the same month/quarter, or for weekly/daily data the reading closest to 365 days before
    const target = Date.parse(last.d) - 365 * 864e5;
    const p = c.f == 'm' || c.f == 'q' ? yearAgo(s, i) : s.reduce((a, b) => Math.abs(Date.parse(b.d) - target) < Math.abs(Date.parse(a.d) - target) ? b : a);
    if (!p) throw new Error('no year-earlier value for ' + c.id);
    delta = points ? last.v - p.v : (last.v / p.v - 1) * 100;
  }
  if (c.vs == 'prior') change = `${c.u == 'K' ? sgn(Math.round(delta)) + 'K' : sgn(+delta.toFixed(c.dec ?? 2)) + (c.u == '%' ? ' pts' : '')} vs. prior`;
  else change = points ? `${sgn(+delta.toFixed(2))} pts vs. a year ago` : `${sgn(+delta.toFixed(1))}% vs. a year ago`;
  const up = delta > 0.0001, down = delta < -0.0001;
  return { name: c.name, value: fmt(last.v, c.u, c.dec ?? 2), when: period(last.d, c.f), asOf: last.d, change,
    dir: up ? 'up' : down ? 'down' : 'flat', tone: !up && !down ? 'flat' : (up == !!c.badUp) ? 'bad' : 'good',
    spark: s.slice(-(c.f == 'w' ? 104 : c.f == 'd' ? 500 : c.f == 'q' ? 20 : 36)).filter((x, k, a) => c.f == 'd' ? k % 5 == 0 || k == a.length - 1 : true).map(x => +x.v.toFixed(3)), source: c.src };
}
async function chart(c) {
  let s = await fred(c.id);
  if (c.monthly) s = monthly(s);
  if (c.t == 'yoy') s = yoySeries(s);
  s = s.filter(x => x.d >= c.from);
  return { title: c.title, sub: c.sub, source: c.src, unit: c.u, points: s.map(x => [x.d, +x.v.toFixed(3)]) };
}

const SECTIONS = {
  housing: {
    cards: [
      { id: 'MORTGAGE30US', name: '30-year mortgage rate', u: '%', f: 'w', badUp: true, src: 'Freddie Mac' },
      { id: 'MSPUS', name: 'Median new-home price', u: '$K', f: 'q', badUp: true, src: 'Census Bureau' },
      { id: 'CUSR0000SEHA', name: 'Rent inflation', t: 'yoy', u: '%', dec: 1, f: 'm', badUp: true, src: 'BLS' },
      { id: 'HOUST', name: 'Housing starts (annual rate)', u: 'M', f: 'm', badUp: false, pts: false, src: 'Census Bureau', k: true }],
    chart: { id: 'MORTGAGE30US', title: '30-year mortgage rate', sub: 'Weekly average, %', u: '%', from: '2016-01-01', src: 'Freddie Mac via FRED' } },
  inflation: {
    cards: [
      { id: 'CPIAUCNS', name: 'Inflation (CPI)', t: 'yoy', u: '%', dec: 1, f: 'm', badUp: true, src: 'BLS' },
      { id: 'CPILFESL', name: 'Core inflation', t: 'yoy', u: '%', dec: 1, f: 'm', badUp: true, src: 'BLS' },
      { id: 'APU000074714', name: 'Gas, regular, per gallon', u: '$', f: 'm', badUp: true, src: 'BLS' },
      { id: 'APU0000708111', name: 'Eggs, per dozen', u: '$', f: 'm', badUp: true, src: 'BLS' }],
    chart: { id: 'CPIAUCNS', t: 'yoy', title: 'Inflation', sub: 'Consumer prices, % change from a year earlier', u: '%', from: '2010-01-01', src: 'BLS via FRED' } },
  jobs: {
    cards: [
      { id: 'UNRATE', name: 'Unemployment rate', u: '%', dec: 1, f: 'm', badUp: true, src: 'BLS' },
      { id: 'PAYEMS', name: 'Jobs added last month', t: 'diff', u: 'K', f: 'm', vs: 'prior', badUp: false, src: 'BLS' },
      { id: 'CES0500000003', name: 'Average hourly pay', u: '$', f: 'm', badUp: false, src: 'BLS' },
      { id: 'JTSJOL', name: 'Job openings', u: 'M', f: 'm', badUp: false, src: 'BLS' }],
    chart: { id: 'UNRATE', title: 'Unemployment rate', sub: 'Monthly, %', u: '%', from: '2010-01-01', src: 'BLS via FRED' } },
  debt: {
    cards: [
      { id: 'GFDEBTN', name: 'Total public debt', u: '$T', f: 'q', badUp: true, src: 'U.S. Treasury' },
      { id: 'GFDEGDQ188S', name: 'Debt as % of GDP', u: '%', dec: 1, f: 'q', badUp: true, pts: true, src: 'OMB / FRED' },
      { id: 'A091RC1Q027SBEA', name: 'Federal interest (annual rate)', u: '$', dec: 0, f: 'q', badUp: true, src: 'BEA', bn: true },
      { id: 'DGS10', name: '10-year Treasury yield', u: '%', f: 'd', badUp: true, src: 'Federal Reserve' }],
    chart: { id: 'GFDEGDQ188S', title: 'Debt as a share of GDP', sub: 'Total public debt, % of GDP, quarterly', u: '%', from: '2000-01-01', src: 'OMB and FRED' } },
};

// ---------- Google News ----------
const NEWS = {
  top: 'US economy OR "Federal Reserve" OR inflation OR "stock market"',
  housing: '"mortgage rates" OR "housing market" OR "home prices"',
  inflation: 'inflation OR CPI OR "consumer prices" OR "gas prices"',
  jobs: '"jobs report" OR unemployment OR "job market" OR layoffs',
  debt: '"national debt" OR "federal deficit" OR "Treasury yields" OR "debt ceiling"',
};
const unesc = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
async function news(q) {
  const r = await fetch('https://news.google.com/rss/search?' + new URLSearchParams({ q: q + ' when:2d', hl: 'en-US', gl: 'US', ceid: 'US:en' }));
  const xml = await r.text();
  const seen = new Set(), out = [];
  for (const it of xml.split('<item>').slice(1)) {
    const g = t => unesc((it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '').trim();
    const source = g('source'); let title = g('title');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    const key = title.toLowerCase().slice(0, 60);
    if (!title || seen.has(key)) continue;
    seen.add(key);
    out.push({ title, source, link: g('link'), at: new Date(g('pubDate')).toISOString() });
  }
  // Established newsrooms first; promotional and low-quality sources are dropped
  const good = out.filter(n => TRUSTED.test(n.source)), rest = out.filter(n => !TRUSTED.test(n.source) && !BLOCKED.test(n.source));
  return [...good, ...(good.length >= 6 ? [] : rest)].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
}
const TRUSTED = /^(Reuters|AP News|Associated Press|CNBC|Bloomberg|The Wall Street Journal|WSJ|MarketWatch|Yahoo Finance|CNN|CNN Business|NPR|The New York Times|The Washington Post|Fox Business|CBS News|NBC News|ABC News|Axios|Barron's|Forbes|Business Insider|Fortune|USA Today|USA TODAY|The Hill|Politico|POLITICO|Financial Times|The Economist|Bankrate|Investopedia|Kiplinger|Los Angeles Times|The Guardian|BBC|Morningstar|Realtor\.com|Redfin|Zillow|Federal Reserve|U\.S\. Bureau of Labor Statistics|NerdWallet|Time|TIME|Newsweek|Quartz|Marketplace|PBS|The Atlantic|Vox|Semafor)$/i;
const BLOCKED = /bullion|stocktwits|simply wall|motley fool|norada|benzinga|zacks|seeking alpha|investorplace|gurufocus|marketbeat|tipranks|coincentral|crypto|press release|prnewswire|globenewswire|business wire|accesswire|ein presswire/i;

// ---------- YouTube (public uploads; Shorts are skipped) ----------
async function videos() {
  const xml = await (await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`)).text();
  const list = [...(old.videos || [])];
  for (const e of xml.split('<entry>').slice(1)) {
    const id = (e.match(/<yt:videoId>([^<]+)/) || [])[1], title = unesc((e.match(/<title>([^<]+)/) || [])[1] || ''), at = (e.match(/<published>([^<]+)/) || [])[1];
    if (!id || list.some(v => v.id == id)) continue;
    const r = await fetch(`https://www.youtube.com/shorts/${id}`, { redirect: 'manual' });
    if (r.status == 200) continue;  // a Short (long videos redirect to /watch)
    list.push({ id, title, publishAt: new Date(at).toISOString() });
  }
  return list.sort((a, b) => a.publishAt.localeCompare(b.publishAt));
}

// ---------- build ----------
const site = { ...old, updated: new Date().toISOString() };
try {
  const t = [
    { ...(await indicator({ id: 'MORTGAGE30US', name: 'Mortgage, 30-yr', u: '%', f: 'w', vs: 'prior', badUp: true })) },
    { ...(await indicator({ id: 'APU000074714', name: 'Gas, regular', u: '$', f: 'm', vs: 'prior', badUp: true })) },
    { ...(await indicator({ id: 'CPIAUCNS', name: 'Inflation, CPI', t: 'yoy', u: '%', dec: 1, f: 'm', vs: 'prior', badUp: true })) },
    { ...(await indicator({ id: 'UNRATE', name: 'Unemployment', u: '%', dec: 1, f: 'm', vs: 'prior', badUp: true })) },
    { ...(await indicator({ id: 'DGS10', name: '10-yr Treasury', u: '%', f: 'd', vs: 'prior', badUp: true })) },
  ];
  site.ticker = t.map(x => ({ name: x.name, value: x.value, dir: x.dir, asOf: x.asOf, when: short(x.asOf, x.asOf.endsWith('-01') && x.name != 'Mortgage, 30-yr' && x.name != '10-yr Treasury' ? 'm' : 'd') }));
} catch (e) { log('ticker kept:', e.message); }

site.sections = site.sections || {};
for (const [k, s] of Object.entries(SECTIONS)) {
  try {
    const cards = [];
    for (const c of s.cards) {
      const ind = await indicator(c);
      if (c.bn) ind.value = '$' + Math.round(+ind.value.replace(/[$,]/g, '')).toLocaleString('en-US') + 'B';
      cards.push(ind);
    }
    site.sections[k] = { cards, chart: await chart(s.chart) };
  } catch (e) { log(`section ${k} kept:`, e.message); }
}

site.news = site.news || {};
for (const [k, q] of Object.entries(NEWS)) {
  try { const n = await news(q); if (n.length) site.news[k] = n; } catch (e) { log(`news ${k} kept:`, e.message); }
}

try { site.videos = await videos(); } catch (e) { log('videos kept:', e.message); }

fs.writeFileSync(OUT, JSON.stringify(site, null, 1) + '\n');
log('ticker:', (site.ticker || []).map(t => `${t.name} ${t.value} (${t.when})`).join(' | '));
for (const [k, s] of Object.entries(site.sections)) log(k + ':', s.cards.map(c => `${c.name} ${c.value} ${c.when} [${c.change}]`).join(' | '));
log('news:', Object.entries(site.news).map(([k, v]) => `${k} ${v.length}`).join(', '), '| videos:', site.videos?.length);
