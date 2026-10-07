// Offline only: the entire userscript runs in a VM with fake storage/DOM/fetch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'NexusLegacy_Exact_Discord_Notifications_v2.0.0.user.js'), 'utf8');
const exportNames = ['runtime', 'STORAGE', 'normalizedAutoScoutMode', 'autoScoutModeLabel',
  'autoScoutAvailableCampUnits', 'autoScoutAvailableResourceUnits', 'autoScoutAvailableStealthUnits',
  'autoScoutCandidateCamps', 'autoScoutCandidateFields', 'autoScoutCandidateSystems',
  'reconcileCampScoutDispatches', 'loadAutoScoutSnapshot', 'dispatchAutoScoutMissions',
  'ensureAutoScoutPanel', 'changeAutoScoutMode'];
const instrumented = source.replace(/  start\(\);\s*\}\)\(\);\s*$/, `  globalThis.testApi = { ${exportNames.join(',')} };\n})();`);
assert.notEqual(instrumented, source, 'Disable live startup before tests');
function element(tag) {
  return { tag, style: {}, dataset: {}, children: [], isConnected: true,
    setAttribute(k, v) { this[k] = v; }, addEventListener() {},
    append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); },
    replaceChildren(...items) { this.children = items; } };
}
function harness() {
  const storage = new Map();
  const context = { URL, console, setTimeout: () => 0, clearTimeout() {},
    GM_getValue: (k, d) => storage.has(k) ? storage.get(k) : d,
    GM_setValue: (k, v) => storage.set(k, v),
    location: { origin: 'http://example.invalid', pathname: '/galaxy' },
    document: { body: element('body'), createElement: element },
    unsafeWindow: { localStorage: { getItem: () => JSON.stringify({ sessionToken: 'offline-test', currentPlanetId: 1 }) },
      fetch: async () => { throw new Error('Unexpected unmocked request'); } } };
  vm.runInNewContext(instrumented, context);
  return { api: context.testApi, storage, context };
}
const planet = { id: 1, isHomeworld: true, systemId: 10, systemX: 0, systemY: 0 };
const mapData = { systems: [
  { id: 10, name: 'Home', x: 0, y: 0, visibility: 'full' },
  { id: 20, name: 'Near', x: 3, y: 4, visibility: 'full' },
  { id: 30, name: 'Far', x: 20, y: 0, visibility: 'full' }
] };
const camp = (id, extra = {}) => ({ id, name: `Camp ${id}`, systemId: 20, systemName: 'Near',
  currentHpPercent: 100, hasFleetIntel: false, intelStatus: 'unknown', failedScoutAttempts: 0, ...extra });
function candidates(api, camps, missions = [], extra = {}) {
  return api.autoScoutCandidateCamps({ planet, mapData, pirateData: { camps }, missionData: { missions }, ...extra });
}
const catalog = { ships: [{ id: 1, key: 'probe' }, { id: 2, key: 'spy_probe' },
  { id: 3, key: 'stealth_ship' }, { id: 4, key: 'fighter' }, { id: 5, key: 'ew_ship' }] };
const fleet = { fleet: [{ shipDefId: 1, quantity: 99 }, { shipDefId: 2, quantity: 3, damagedQuantity: 1 },
  { shipDefId: 3, quantity: 9, availableQuantity: 1 }, { shipDefId: 4, quantity: 50 }, { shipDefId: 5, quantity: 2 }] };

test('modes preserve old stored values and add camp', () => {
  const { api } = harness();
  for (const mode of ['resource', 'pirate', 'camp']) assert.equal(api.normalizedAutoScoutMode(mode), mode);
  assert.equal(api.normalizedAutoScoutMode('unknown'), 'pirate');
  assert.equal(api.autoScoutModeLabel('camp'), '營地兵力偵查');
});
test('camp allows only spy and stealth, excludes damaged/unavailable/ordinary probes', () => {
  const { api } = harness();
  const ships = api.autoScoutAvailableCampUnits(fleet, catalog);
  assert.equal(ships.length, 3);
  assert.deepEqual(Array.from(ships, (s) => s.shipKey), ['spy_probe', 'spy_probe', 'stealth_ship']);
  assert.equal(api.autoScoutAvailableResourceUnits(fleet, catalog).length, 101);
  assert.equal(api.autoScoutAvailableStealthUnits(fleet, catalog).length, 1);
});
test('two camps in one system remain separate; sort strictly near to far', () => {
  const { api } = harness();
  assert.deepEqual(Array.from(candidates(api, [camp(3, { systemId: 30 }), camp(2), camp(1)]).targets, c => c.campId), [1, 2, 3]);
});
test('cargo.campId blocks only that camp, including returning scouts', () => {
  const { api } = harness();
  const result = candidates(api, [camp(1), camp(2)], [
    { missionType: 'pirate_scout', status: 'returning', targetSystemId: 20, cargo: { campId: 1 } }
  ]);
  assert.deepEqual(Array.from(result.targets, c => c.campId), [2]);
  assert.equal(result.activeCampIds.size, 1);
});
test('completed scout does not block a partial-intel retry', () => {
  const { api } = harness();
  assert.equal(candidates(api, [camp(1, { intelStatus: 'partial' })], [
    { missionType: 'pirate_scout', status: 'completed', cargo: { campId: 1 } }
  ]).targets.length, 1);
});
test('skip full intel, destroyed, zero HP, cleanup, expired, duplicate and unmapped camps', () => {
  const { api } = harness();
  const rows = [camp(1, { hasFleetIntel: true }), camp(2, { destroyedAt: '2026-01-01' }),
    camp(3, { currentHpPercent: 0 }), camp(4, { cleanupInProgress: true }),
    camp(5, { expiresAt: '2000-01-01' }), camp(6, { systemId: 999 }), camp(7), camp(7)];
  const result = candidates(api, rows);
  assert.deepEqual(Array.from(result.targets, c => c.campId), [7]);
  assert.equal(result.knownCamps, 1);
});
test('refreshed API hasFleetIntel=false re-enables previously known camp', () => {
  const { api } = harness();
  assert.equal(candidates(api, [camp(1, { hasFleetIntel: true })]).targets.length, 0);
  assert.equal(candidates(api, [camp(1, { hasFleetIntel: false, intelRevision: 2 })]).targets.length, 1);
});
test('missing coordinates or unknown active target fail safely', () => {
  const { api } = harness();
  assert.equal(candidates(api, [camp(1)], [], { planet: { ...planet, systemX: null } }).targets.length, 0);
  assert.equal(candidates(api, [camp(1)], [{ missionType: 'pirate_scout', status: 'outbound', targetSystemId: 20 }]).targets.length, 0);
  assert.throws(() => candidates(api, [camp(1)], [{ missionType: 'pirate_scout', status: 'outbound' }]), /缺少/);
});
test('dispatch guard survives absent missions and reload; clears after observed completion', () => {
  const { api, storage } = harness();
  const key = api.STORAGE.campScoutDispatches;
  storage.set(key, JSON.stringify({ '1:1': { sourcePlanetId: 1, campId: 1, failedScoutAttempts: 0, seenActive: false } }));
  assert.equal(api.reconcileCampScoutDispatches(planet, { missions: [] }, { camps: [camp(1)] }).size, 1);
  const mission = { missionType: 'pirate_scout', status: 'returning', cargo: { campId: 1 } };
  api.reconcileCampScoutDispatches(planet, { missions: [mission] }, { camps: [camp(1)] });
  assert.equal(api.reconcileCampScoutDispatches(planet, { missions: [] }, { camps: [camp(1)] }).size, 0);
});
test('old completed missions cannot release uncertain request; new failed count can', () => {
  const { api, storage } = harness();
  storage.set(api.STORAGE.campScoutDispatches, JSON.stringify({ '1:1': { sourcePlanetId: 1, campId: 1, failedScoutAttempts: 0 } }));
  const mission = { missionType: 'pirate_scout', status: 'completed', cargo: { campId: 1 } };
  assert.equal(api.reconcileCampScoutDispatches(planet, { missions: [mission] }, { camps: [camp(1)] }).size, 1);
  assert.equal(api.reconcileCampScoutDispatches(planet, { missions: [] }, { camps: [camp(1, { failedScoutAttempts: 1 })] }).size, 0);
});

function server(options = {}) {
  const h = harness();
  const requests = [];
  const missions = options.missions || [];
  const fleetRows = options.fleetRows || [{ shipDefId: 2, quantity: 1 }, { shipDefId: 3, quantity: 1 }];
  const camps = options.camps || [camp(1), camp(2)];
  h.api.runtime.autoScoutMode = 'camp';
  h.api.runtime.autoScoutEnabled = true;
  h.context.unsafeWindow.fetch = async (url, request) => {
    const endpoint = new URL(url).pathname;
    const body = request.body ? JSON.parse(request.body) : null;
    requests.push({ endpoint, method: request.method, body });
    let data;
    if (endpoint === '/api/auth/me') data = { planets: [planet] };
    else if (endpoint === '/api/fleet/missions') data = { maxFleetSlots: options.slots ?? 2, missions };
    else if (endpoint === '/api/catalog/ships') data = catalog;
    else if (endpoint === '/api/planets/1/fleet') data = { fleet: fleetRows };
    else if (endpoint === '/api/fleet/pirate-camps') data = { camps };
    else if (endpoint === '/api/galaxy/map') data = mapData;
    else if (endpoint === '/api/fleet/fuel-estimate') {
      if (options.stopAtEstimate) h.api.runtime.autoScoutEnabled = false;
      if (options.changeModeAtEstimate) h.api.runtime.autoScoutMode = 'resource';
      data = options.fuel ?? { sufficient: true, companions: [{ shipKey: 'ew_ship', quantity: 2 }] };
    } else if (endpoint === '/api/fleet/scout-camp') {
      if (options.error) {
        if (options.error === 'network') throw new Error('Offline simulated network failure');
        return { ok: false, status: options.error, text: async () => JSON.stringify({ message: 'Rejected' }) };
      }
      missions.push({ id: 100 + missions.length, missionType: 'pirate_scout', status: 'outbound',
        cargo: { campId: body.campId }, targetSystemId: 20 });
      fleetRows.find(s => s.shipDefId === body.ships[0].shipDefId).quantity -= 1;
      data = { mission: missions.at(-1) };
    } else throw new Error(`Unexpected endpoint ${endpoint}`);
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)), text: async () => JSON.stringify(data) };
  };
  return { ...h, requests, missions, fleetRows, camps };
}
async function runServer(h) {
  const snapshot = await h.api.loadAutoScoutSnapshot(true);
  const result = await h.api.dispatchAutoScoutMissions(snapshot);
  return { result, posts: h.requests.filter(r => r.endpoint === '/api/fleet/scout-camp') };
}
test('dispatch distinct camp IDs in same system, one allowed ship each, no explicit escorts', async () => {
  const h = server();
  const { result, posts } = await runServer(h);
  assert.equal(result.dispatched, 2);
  assert.deepEqual(posts.map(r => r.body.campId), [1, 2]);
  assert.deepEqual(posts.map(r => r.body.ships), [[{ shipDefId: 2, quantity: 1 }], [{ shipDefId: 3, quantity: 1 }]]);
  for (const p of posts) assert.deepEqual(Object.keys(p.body).sort(), ['campId', 'ships', 'sourcePlanetId']);
  const fuel = h.requests.filter(r => r.endpoint.endsWith('fuel-estimate'));
  assert.ok(fuel.every(r => r.body.missionType === 'pirate_scout' && r.body.targetSystemId === 20 && !('campId' in r.body)));
  assert.equal(h.api.runtime.autoScoutSnapshot.freeFleetSlots, 0);
  assert.equal(h.api.runtime.autoScoutSnapshot.availableCampScouts, 0);
  assert.equal((await runServer(h)).posts.length, 2, 'No duplicate POST on next tick');
});
test('one free slot allows one camp only; no-slot-consuming missions excluded', async () => {
  const h = server({ slots: 2, missions: [
    { missionType: 'mining', status: 'mining' },
    { missionType: 'patrol', status: 'outbound', doesNotConsumeFleetSlot: true }
  ] });
  assert.equal((await runServer(h)).result.dispatched, 1);
});
test('only ordinary probes: no camp dispatch and no fuel estimate', async () => {
  const h = server({ fleetRows: [{ shipDefId: 1, quantity: 100 }] });
  assert.equal((await runServer(h)).result.dispatched, 0);
  assert.ok(h.requests.every(r => r.method === 'GET'));
});
for (const [label, options] of [
  ['no slots', { slots: 0 }], ['fuel insufficient', { fuel: { sufficient: false } }],
  ['invalid fleet', { fuel: { sufficient: false, fleetAvailable: false } }],
  ['malformed estimate', { fuel: {} }], ['stop while estimating', { stopAtEstimate: true }],
  ['mode change while estimating', { changeModeAtEstimate: true }]
]) test(label + ' never sends camp POST', async () => {
  const h = server(options);
  assert.equal((await runServer(h)).posts.length, 0);
});
for (const error of ['network', 500, 409]) test(`dispatch ${error} stops automatic work without retry`, async () => {
  const h = server({ error });
  const result = await runServer(h);
  assert.equal(result.posts.length, 1);
  assert.equal(h.api.runtime.autoScoutEnabled, false);
  const guards = JSON.parse(h.storage.get(h.api.STORAGE.campScoutDispatches));
  assert.equal(Object.keys(guards).length, error === 409 ? 0 : 1);
  assert.equal(h.storage.get(h.api.STORAGE.autoScoutEnabled), false);
});
test('render third option and counts; mode switch stops running work', async () => {
  const h = server();
  await h.api.loadAutoScoutSnapshot(true);
  const panel = h.api.ensureAutoScoutPanel();
  assert.equal(panel.dataset.nexusVersion, '2.8.1');
  assert.deepEqual(Array.from(h.api.runtime.autoScoutModeSelect.children, x => x.value), ['resource', 'pirate', 'camp']);
  const text = h.api.runtime.autoScoutStatusNode.children.map(x => x.textContent).join('\n');
  assert.match(text, /可用間諜：1｜隱形艦：1/);
  assert.match(text, /待偵查營地：2/);
  h.api.changeAutoScoutMode({ target: { value: 'resource' } });
  assert.equal(h.api.runtime.autoScoutEnabled, false);
  assert.equal(h.api.runtime.autoScoutMode, 'resource');
});
test('resource and survey candidate behavior remains intact', () => {
  const { api } = harness();
  const fields = api.autoScoutCandidateFields({ planet, missionData: { missions: [] }, fieldIndexData: { fields: [
    { id: 11, fieldType: 'ore', isScanned: false, systemId: 20, systemX: 3, systemY: 4 },
    { id: 12, fieldType: 'gas', isScanned: false, systemId: 20, systemX: 3, systemY: 4 }
  ] } });
  assert.equal(fields.targets.length, 2);
  const survey = api.autoScoutCandidateSystems({ planet, mapData, missionData: { missions: [] },
    cooldownData: { availableSystemIds: [20, 30], cooldowns: [] }, pirateData: { camps: [camp(1)] } });
  assert.deepEqual(Array.from(survey.targets, s => s.systemId), [20, 30]);
});
test('survey respects server availability, cooldown and active scans even when camps exist', () => {
  const { api } = harness();
  const snapshot = { planet, mapData, missionData: { missions: [] },
    cooldownData: { availableSystemIds: [20, 30], cooldowns: [] },
    pirateData: { camps: [camp(1), camp(2, { systemId: 30 })] } };
  const ids = () => Array.from(api.autoScoutCandidateSystems(snapshot).targets, s => s.systemId);
  assert.deepEqual(ids(), [20, 30]);
  snapshot.cooldownData.availableSystemIds = [30];
  assert.deepEqual(ids(), [30]);
  snapshot.cooldownData.availableSystemIds = [20, 30];
  snapshot.cooldownData.cooldowns = [{ systemId: 20, cooldownEndsAt: '2999-01-01T00:00:00Z' }];
  assert.deepEqual(ids(), [30]);
  snapshot.cooldownData.cooldowns = [{ systemId: 20, cooldownEndsAt: '2000-01-01T00:00:00Z' }];
  snapshot.missionData.missions = [{ missionType: 'survey', status: 'returning', targetSystemId: 30 }];
  assert.deepEqual(ids(), [20]);
  snapshot.missionData.missions[0].status = 'completed';
  assert.deepEqual(ids(), [20, 30]);
});
for (const mode of ['resource', 'pirate']) test(`${mode} retains its dispatch endpoint and stops after mode switch`, async () => {
  const h = harness();
  h.api.runtime.autoScoutEnabled = true;
  h.api.runtime.autoScoutMode = mode;
  const requests = [];
  let changeMode = false;
  h.context.unsafeWindow.fetch = async (url, request) => {
    const endpoint = new URL(url).pathname;
    requests.push({ endpoint, body: JSON.parse(request.body) });
    if (endpoint.endsWith('fuel-estimate') && changeMode) h.api.runtime.autoScoutMode = 'camp';
    return { ok: true, status: 200, text: async () => JSON.stringify({ sufficient: true }) };
  };
  const snapshot = { mode, planet, freeFleetSlots: 1, availableUnits: [{ shipDefId: mode === 'resource' ? 2 : 3 }],
    candidateResult: { targets: [{ fieldId: 11, fieldType: 'ore', systemId: 20, systemName: 'Near' }] } };
  assert.equal((await h.api.dispatchAutoScoutMissions(snapshot)).dispatched, 1);
  const dispatch = requests.at(-1);
  assert.equal(dispatch.endpoint, mode === 'resource' ? '/api/fleet/field-scan' : '/api/fleet/survey');
  assert.equal(dispatch.body[mode === 'resource' ? 'targetFieldId' : 'targetSystemId'], mode === 'resource' ? 11 : 20);
  requests.length = 0;
  changeMode = true;
  assert.equal((await h.api.dispatchAutoScoutMissions(snapshot)).dispatched, 0);
  assert.equal(requests.length, 1);
});
