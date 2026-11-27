// MCP server (Streamable HTTP, stateless JSON responses) at /mcp.
// AI apps sign in with OAuth (see oauth.js), then read and edit the person's timeline with these plain tools.

import { json, UserError } from './lib.js';
import { cors, bearerUser } from './oauth.js';
import * as store from './store.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const INSTRUCTIONS = `Big Picture shows one person's whole life on a single printable calendar: one row per year, one column per day, with the days fading out across the estimated life expectancy. The website is read-only; everything is edited through these tools. The tools are plain storage: they save exactly what you give them.
Dates are YYYY-MM-DD.
Data is organized in TRACKS, each with a kind:
- span: things with a start and optional end (school, college, jobs, places lived). Overlaps are fine. Leave end out if it is still going.
- event: a single date (graduation, a move, a trip, a birth in the family).
- series: one number per day (weight, height, steps, "did the thing" counts, mood). Use save_points.
Items on span/event tracks have a label, an optional color (#rrggbb) and free-form attrs (e.g. {"employer":"Acme","title":"Engineer","salary":90000}) that show when hovering. Items without a color use the track's color in alternating shades.
Track config hints the page understands: unit (text, e.g. "lb"), min and max (scale for one day's value in heatmaps, and for charts; weekly totals scale themselves), chart ("line" or "bars"), hidden (true = starts switched off), agg ("sum", "avg" or "max": how a week's days combine in a heatmap; default sum for counts, i.e. chart "bars", otherwise avg), scale ("sqrt" to soften big values), hold (days a reading carries forward), grain ("week" when you store one number per week instead of per day: to keep data small, save weekly totals dated at the first day of each 7-day square, i.e. Jan 1 + 7n days within each year, and set grain "week"). Count series show in five levels with zero left empty, and the top level starts at the 95th percentile unless max is set. To import something like GitHub contribution history: save_track {key:"github", kind:"series", name:"GitHub contributions", color:"#2da44e", config:{chart:"bars", unit:"contributions"}}, then save_points with one {date, value} per day (batches of 1000, mode "set").
Start with get_timeline to see what exists. Prefer batching: save_items takes up to 200 items and save_points up to 1000 points per call.`;

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const DATE = (d) => S('string', d || 'Date like 1990-04-23.');
const KEY = S('string', 'Track key, e.g. "jobs".');

const TOOLS = [
  { name: 'get_timeline', title: 'Get the timeline overview', description: 'Profile (name, birth date, life expectancy settings), every track with its kind, color, config, item or point count and first/last date. Start here.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'set_profile', title: 'Set profile', description: 'Change name, birth date or life expectancy. life.expectancy is the expected age at death from birth (default 80); life.spread is how many years the fade covers (default 10). Only the fields you give change.', inputSchema: { type: 'object', properties: { name: S('string'), birth: DATE('Birth date.'), life: { type: 'object', properties: { expectancy: S('number'), spread: S('number') } } } } },
  { name: 'save_track', title: 'Create or change a track', description: 'Create a track, or change one that exists (only the fields you give change; kind can\'t change). config is a free-form object; hints the page uses: unit, min, max, chart ("line"|"bars"), agg ("sum"|"avg"|"max"), scale ("sqrt"), hold, hidden.', inputSchema: { type: 'object', properties: { key: S('string', 'Short lowercase id: jobs, places, school, weight, ...'), kind: S('string', 'span, event or series (needed when creating).', { enum: ['span', 'event', 'series'] }), name: S('string'), color: S('string', '#rrggbb'), sort: S('number', 'Lower comes first in lists.'), config: { type: 'object' } }, required: ['key'] } },
  { name: 'delete_track', title: 'Delete a track', description: 'Delete a track and every item and point on it. Cannot be undone.', inputSchema: { type: 'object', properties: { key: KEY }, required: ['key'] }, annotations: { destructiveHint: true } },
  { name: 'list_items', title: 'List items on a track', description: 'Items (span or event) on a track that overlap the optional from–to window, oldest first.', inputSchema: { type: 'object', properties: { track: KEY, from: DATE(), to: DATE(), limit: S('number', 'Default 200, max 500.') }, required: ['track'] }, annotations: { readOnlyHint: true } },
  { name: 'save_items', title: 'Add or change items', description: 'Add or change span/event items. An item without id is created; with id it replaces that item. Each item: {start, end?, label, color?, attrs?}. Events ignore end. Up to 200 per call.', inputSchema: { type: 'object', properties: { track: KEY, items: { type: 'array', items: { type: 'object', properties: { id: S('number', 'Include to change an existing item.'), start: DATE(), end: DATE('Leave out if still going.'), label: S('string'), color: S('string', '#rrggbb'), attrs: { type: 'object', description: 'Anything: {"employer":"Acme","salary":90000}.' } }, required: ['start'] } } }, required: ['track', 'items'] } },
  { name: 'delete_items', title: 'Delete items', description: 'Delete items by id.', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: S('number') } }, required: ['ids'] }, annotations: { destructiveHint: true } },
  { name: 'list_points', title: 'List numbers on a series track', description: 'The [date, value] pairs of a series track in an optional window (default up to 1000, max 2000).', inputSchema: { type: 'object', properties: { track: KEY, from: DATE(), to: DATE(), limit: S('number') }, required: ['track'] }, annotations: { readOnlyHint: true } },
  { name: 'save_points', title: 'Save numbers on a series track', description: 'Save one number per day: points is [{date, value}]. mode "set" (default) replaces that day\'s value; "add" adds to it (handy for daily counts). Up to 1000 per call.', inputSchema: { type: 'object', properties: { track: KEY, points: { type: 'array', items: { type: 'object', properties: { date: DATE(), value: S('number') }, required: ['date', 'value'] } }, mode: S('string', 'set or add', { enum: ['set', 'add'] }) }, required: ['track', 'points'] } },
  { name: 'delete_points', title: 'Delete numbers', description: 'Delete a series track\'s values for the given dates, or for everything from..to.', inputSchema: { type: 'object', properties: { track: KEY, dates: { type: 'array', items: DATE() }, from: DATE(), to: DATE() }, required: ['track'] }, annotations: { destructiveHint: true } },
];

async function callTool(name, a, env, me) {
  switch (name) {
    case 'get_timeline': return store.summary(env, me);
    case 'set_profile': return store.setProfile(env, me, a);
    case 'save_track': return store.saveTrack(env, me, a);
    case 'delete_track': return store.deleteTrack(env, me, a.key);
    case 'list_items': return { items: await store.listItems(env, me, a) };
    case 'save_items': return store.saveItems(env, me, a);
    case 'delete_items': return store.deleteItems(env, me, a);
    case 'list_points': return store.listPoints(env, me, a);
    case 'save_points': return store.savePoints(env, me, a);
    case 'delete_points': return store.deletePoints(env, me, a);
  }
  throw new UserError(`Unknown tool ${name}.`);
}

async function handle(msg, env, me) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
  if (msg.id === undefined) return null; // notification
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize': {
      const want = msg.params?.protocolVersion;
      return ok({ protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'bigpicture', title: 'Big Picture', version: '1.0.0', websiteUrl: 'https://bigpicture.io27.com' }, instructions: INSTRUCTIONS });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name, args = msg.params?.arguments || {};
      if (!TOOLS.some((t) => t.name === name)) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      try {
        const out = await callTool(name, args, env, me);
        return ok({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
      } catch (e) {
        if (!(e instanceof UserError)) console.error(e);
        return ok({ content: [{ type: 'text', text: e instanceof UserError ? e.message : 'Something went wrong on the server. Try again.' }], isError: true });
      }
    }
    case 'resources/list': return ok({ resources: [] });
    case 'prompts/list': return ok({ prompts: [] });
    default: return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

export async function mcp(req, env, url) {
  if (req.method !== 'POST') return cors(new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS' } }));
  const me = await bearerUser(req, env);
  if (!me) {
    return cors(json({ error: 'invalid_token', error_description: 'Sign in to Big Picture to use these tools.' }, 401, {
      'www-authenticate': `Bearer realm="bigpicture", resource_metadata="${url.origin}/.well-known/oauth-protected-resource", scope="timeline"`,
    }));
  }
  let body;
  try { const text = await req.text(); if (text.length > 512 * 1024) throw 0; body = JSON.parse(text); }
  catch { return cors(json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)); }
  const batch = Array.isArray(body);
  const out = [];
  for (const msg of batch ? body.slice(0, 20) : [body]) { const r = await handle(msg, env, me); if (r) out.push(r); }
  if (!out.length) return cors(new Response(null, { status: 202 }));
  return cors(json(batch ? out : out[0]));
}
