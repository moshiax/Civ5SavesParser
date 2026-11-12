import {CIV5_UNIT_TYPES} from "./assets/civ5-unit-types.js";

function yieldToBrowser() {
  if (typeof globalThis.scheduler?.yield === "function") return globalThis.scheduler.yield();
  if (typeof MessageChannel !== "undefined") return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(0);
  });
  return new Promise((resolve) => setTimeout(resolve, 0));
}
const SCAN_CHUNK = 128 * 1024;
function reportProgress(onProgress, phase, percent) {
  onProgress?.({phase, percent});
}

async function findSerializedTeamIds(bytes, endOffset, statuses) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let best = null;
  let nextYieldAt = SCAN_CHUNK;
  for (let at = 0; at + 4 + 64 * 4 <= endOffset; at++) {
    if (at >= nextYieldAt) { await yieldToBrowser(); nextYieldAt += SCAN_CHUNK; }
    if (view.getUint32(at, true) !== 64) continue;
    const values = Array.from({length: 64}, (_, slot) =>
      view.getInt32(at + 4 + slot * 4, true),
    );
    if (!values.every((teamId) => teamId >= 0 && teamId < 64)) continue;

    // City states, barbarians, and the observer use their matching team IDs;
    // unused major slots are assigned to the observer team. Active major
    // slots may share a team, so those entries are intentionally unrestricted.
    if (values[21] !== 21) continue;
    let score = 1;
    for (let slot = 22; slot < 64; slot++) {
      if (values[slot] !== slot) break;
      score++;
    }
    for (let slot = 0; slot < 21; slot++) {
      if (!(statuses[slot] > 0 && statuses[slot] < 4) && values[slot] === 21)
        score++;
    }
    if (!best || score > best.score) best = {values, score};
  }
  return best?.values || [];
}

async function parseSave(bytes, filename, {recoverMap = true, onProgress, onSection, diagnostics = false} = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 64 ||
    String.fromCharCode(...bytes.subarray(0, 4)) !== "CIV5"
  )
    throw new Error("Invalid Civ5 save signature.");
  let p = 4;
  const u32 = () => {
    if (p + 4 > bytes.length) throw new Error("Truncated save header.");
    const n = view.getUint32(p, true);
    p += 4;
    return n;
  };
  const i32 = () => {
    if (p + 4 > bytes.length) throw new Error("Truncated save header.");
    const n = view.getInt32(p, true);
    p += 4;
    return n;
  };
  const decoder = new TextDecoder("utf-8");
  const str = () => {
    const n = u32();
    if (n > 1048576 || p + n > bytes.length)
      throw new Error("Invalid string length in save header.");
    const s = decoder.decode(bytes.subarray(p, p + n));
    p += n;
    return s;
  };
  const saveVersion = u32();
  let gameVersion = "",
    build = "";
  if (saveVersion >= 7) {
    gameVersion = str();
    build = str();
  }
  const turn = i32(),
    mode = bytes[p++],
    civ = str(),
    difficulty = str(),
    startingEra = str(),
    era = str(),
    speed = str(),
    worldSize = str(),
    mapScript = str();
  const delimiterOffsets = [];
  let cursor = p;
  while (cursor + 4 <= bytes.length && delimiterOffsets.length < 40) {
    if (
      bytes[cursor] === 64 &&
      bytes[cursor + 1] === 0 &&
      bytes[cursor + 2] === 0 &&
      bytes[cursor + 3] === 0
    ) {
      delimiterOffsets.push(cursor);
      cursor += 4;
    } else cursor++;
  }
  const candidates = [];
  reportProgress(onProgress, "Finding compressed data", 5);
  for (const magic of [
    [1, 0, 120, 156],
    [120, 156],
    [120, 218],
  ])
    for (let at = p; at < bytes.length - 4;) {
      at = indexOfBytes(bytes, magic, at);
      if (at < 0) break;
      candidates.push(at + (magic.length === 4 ? 2 : 0));
      at++;
    }
  let nextHeaderYieldAt = p + SCAN_CHUNK;
  for (let at = p; at + 1 < bytes.length; at++) {
    if (at >= nextHeaderYieldAt) { await yieldToBrowser(); nextHeaderYieldAt += SCAN_CHUNK; }
    const cmf = bytes[at],
      flg = bytes[at + 1];
    if ((cmf & 15) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0)
      candidates.push(at);
  }
  candidates.sort((a, b) => a - b);
  let z = -1,
    payload = null,
    lastError = "";
  for (const at of [...new Set(candidates)])
    try {
      const result = await inflateSyncFlush(bytes.subarray(at + 2));
      if (result.length > 1048576) {
        z = at;
        payload = result;
        break;
      }
    } catch (e) {
      lastError = e.message;
    }
  if (!payload)
    throw new Error(
      `Compressed game payload not found or invalid: ${lastError || "no full-sized data stream"}`,
    );
  onSection?.({type: "header", file: {name: filename, size: bytes.length}, header: {
    saveVersion, gameVersion, build, turn, mode, civ, difficulty, startingEra, era,
    speed, worldSize, mapScript,
  }});
  reportProgress(onProgress, "Parsing map blocks", 18);
  const saveMap = await parseSerializedMap(payload, {recoverMap, onProgress, onSection});
  const sections = [];
  for (let i = 0; i <= delimiterOffsets.length; i++) {
    const start = i === 0 ? 0 : delimiterOffsets[i - 1] + 4,
      end = i < delimiterOffsets.length ? delimiterOffsets[i] : z;
    if (end >= start) sections.push(bytes.subarray(start, end));
  }
  const getStrings = (index) => {
    const section = sections[index - 1];
    if (!section || section.length < 4) return [];
    const v = new DataView(
      section.buffer,
      section.byteOffset,
      section.byteLength,
    );
    let at = 0;
    const out = [];
    while (at + 4 <= section.length && out.length < 100) {
      const n = v.getUint32(at, true);
      at += 4;
      if (n > 65536 || at + n > section.length || !n) break;
      out.push(decoder.decode(section.subarray(at, at + n)));
      at += n;
    }
    return out;
  };
  const statusSection = sections[3],
    statuses = [];
  if (statusSection && statusSection.length >= 256) {
    const v = new DataView(
      statusSection.buffer,
      statusSection.byteOffset,
      statusSection.byteLength,
    );
    for (let i = 0; i < 64; i++) statuses.push(v.getInt32(i * 4, true));
  }
  reportProgress(onProgress, "Reading players", 48);
  const playerTeamIds = await findSerializedTeamIds(bytes, z, statuses);
  const playerCivs = getStrings(8),
    playerLeaders = getStrings(9),
    playerNames = getStrings(23),
    playerColors = getStrings(25);
  const players = statuses
    .map((status, i) => ({
      slot: i,
      mapOwnerId: i,
      teamId: playerTeamIds[i] ?? null,
      status,
      civilization: playerCivs[i] || "",
      leader: playerLeaders[i] || "",
      name: playerNames[i] || "",
      color: playerColors[i] || "",
    }))
    .filter((x) => x.status > 0 && x.status < 4 && x.civilization);
  onSection?.({type: "players", players});
  if (saveMap) {
    reportProgress(onProgress, "Matching units", 57);
    saveMap.unitArrayScan = diagnostics ? await scanSerializedUnitArrays(payload) : {candidates: []};
    saveMap.units = await extractSerializedUnits(payload, saveMap.tiles);
    const unitsById = new Map(saveMap.units.map((unit) => [`${unit.owner}:${unit.id}`, unit]));
    for (const tile of saveMap.tiles)
      tile.units = tile.units.map((unit) => ({...unit, type: unitsById.get(`${unit.owner}:${unit.id}`)?.type || ""}));
    saveMap.entities.units = saveMap.units.length;
    reportProgress(onProgress, "Matching cities", 76);
    const cities = await extractSerializedCities(payload, saveMap.mapWidth, saveMap.mapHeight, turn, players);
    saveMap.cities = cities;
    saveMap.entities.cities = cities.length;
    const byId = new Map(cities.map((city) => [`${city.owner}:${city.id}`, city]));
    for (const tile of saveMap.tiles) {
      const ref = tile.plotCity;
      if (!ref || ref.owner < 0 || ref.id < 0) continue;
      const city = byId.get(`${ref.owner}:${ref.id}`);
      if (city && city.x === tile.x && city.y === tile.y) tile.city = city;
    }
    onSection?.({type: "entities", units: saveMap.units.length, cities: cities.length});
  }
  const lobbyOptions = extractLobbyOptions(sections[29]);
  reportProgress(onProgress, "Finishing save data", 91);
  const metadata = await extractPayloadTextMetadata(payload, onProgress);
  const {cityStates} = metadata;
  let minorSlot = 0;
  for (const player of players) {
    if (player.civilization === "CIVILIZATION_MINOR" || player.civilization.startsWith("MINOR_CIV_")) {
      const cityState = cityStates?.[minorSlot++];
      if (cityState) player.displayCiv = cityState.replace(/^CITYSTATE_/, "").replace(/_CITY$/, "");
    }
  }
  const playedSeconds =
    payload.length >= 36
      ? (new DataView(
          payload.buffer,
          payload.byteOffset,
          payload.byteLength,
        ).getUint32(32, true) /
          10) |
        0
      : 0;
  return {
    file: { name: filename, size: bytes.length },
    header: {
      saveVersion,
      gameVersion,
      build,
      turn,
      mode,
      civ,
      difficulty,
      startingEra,
      era,
      speed,
      worldSize,
      mapScript,
      headerBytes: p,
      compressedOffset: z,
      sectionCount: delimiterOffsets.length,
      lobbyOptions,
      cityStates,
      players,
      mapWidth: saveMap?.mapWidth || 0,
      mapHeight: saveMap?.mapHeight || 0,
    },
    payload: {
      bytes: payload.length,
      playedSeconds,
      strings: metadata.strings,
      tokens: metadata.tokens,
    },
    saveMap,
  };
}

async function scanSerializedUnitArrays(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength), candidates = [];
  let nextYieldAt = SCAN_CHUNK;
  // FDataStream serializes sequentially without padding fields to DWORD
  // boundaries, so player arrays can start at any byte offset.
  for (let at = 0; at + 24 < payload.length; at++) {
    if (at >= nextYieldAt) { await yieldToBrowser(); nextYieldAt += SCAN_CHUNK; }
    const slots = view.getInt32(at, true);
    if (slots < 1 || slots > 8192 || (slots & (slots - 1))) continue;
    const last = view.getInt32(at + 4, true),
      freeHead = view.getInt32(at + 8, true),
      freeCount = view.getInt32(at + 12, true);
    // FFreeList uses -2 for an empty free list, and -1 for an invalid index.
    if (last < 0 || last >= slots || freeHead < -2 || freeHead > last || freeCount < 0 || freeCount > last + 1) continue;
    const count = last - freeCount + 1;
    if (count < 1 || count > slots) continue;
    const countAt = at + 20 + slots * 4;
    if (countAt + 8 > payload.length || view.getInt32(countAt, true) !== count) continue;
    let validFreeList = true;
    for (let i = 0; i < slots; i++) {
      const next = view.getInt32(at + 20 + i * 4, true);
      if (next < -1 || next > last) { validFreeList = false; break; }
    }
    if (!validFreeList) continue;
    const freeSlots = new Set();
    let freeIndex = freeHead;
    while (freeIndex >= 0 && freeSlots.size <= freeCount) {
      if (freeSlots.has(freeIndex)) { validFreeList = false; break; }
      freeSlots.add(freeIndex);
      freeIndex = view.getInt32(at + 20 + freeIndex * 4, true);
    }
    if (!validFreeList || freeSlots.size !== freeCount) continue;
    const firstVersion = view.getUint32(countAt + 4, true);
    if (firstVersion === 9) {
      const firstWords = Array.from({length: 12}, (_, i) => view.getInt32(countAt + 4 + i * 4, true));
      const currentID = view.getInt32(at + 16, true);
      const firstActiveSlot = Array.from({length: last + 1}, (_, i) => i).find((i) => !freeSlots.has(i));
      if (firstActiveSlot === undefined) continue;
      const nearbyTypeHashes = [];
      for (let scan = countAt + 4; scan + 4 <= Math.min(payload.length, countAt + 4096); scan++) {
        const type = CIV5_UNIT_TYPES[view.getUint32(scan, true)];
        if (type) nearbyTypeHashes.push({offset: scan - countAt - 4, type});
      }
      candidates.push({offset: at, recordStart: countAt + 4, slots, last, freeHead, freeCount, currentID, count, firstVersion, firstWords, firstActiveSlot, idMatchesGeneration: firstWords[1] === currentID + firstActiveSlot, nearbyTypeHashes: nearbyTypeHashes.slice(0, 12)});
    }
  }
  return {candidates};
}

async function extractSerializedUnits(payload, tiles) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
    types = CIV5_UNIT_TYPES,
    references = new Set(tiles.flatMap((tile) => tile.units.map((unit) => `${unit.owner}:${unit.id}`))),
    recordsById = new Map(),
    recordStarts = [];
  const uint32 = (offset) => offset + 4 <= payload.length ? view.getUint32(offset, true) : 0,
    int32 = (offset) => offset + 4 <= payload.length ? view.getInt32(offset, true) : -1;
  let nextYieldAt = SCAN_CHUNK;

  // Unit records can be outside an array candidate. Anchor them by their
  // serialized owner/ID pair, then cross-check against plot unit references.
  for (let offset = 0; offset + 28 < payload.length; offset++) {
    if (offset >= nextYieldAt) { await yieldToBrowser(); nextYieldAt += SCAN_CHUNK; }
    if (uint32(offset) !== 9) continue;
    const owner = int32(offset + 4), id = int32(offset + 24), key = `${owner}:${id}`;
    if (owner >= 0 && owner <= 63 && id >= 0 && references.has(key))
      recordStarts.push({offset, owner, id});
  }
  recordStarts.sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < recordStarts.length; i++) {
    const record = recordStarts[i], key = `${record.owner}:${record.id}`;
    if (recordsById.has(key)) continue;
    const searchEnd = Math.min(payload.length, recordStarts[i + 1]?.offset || record.offset + 8192);
    let match = null;
    for (let at = record.offset + 28; at + 4 <= searchEnd; at++) {
      const hash = uint32(at), type = types[hash];
      if (type) { match = {type, typeHash: hash, typeHashOffset: at}; break; }
    }
    if (match) recordsById.set(key, {...record, ...match});
  }
  return [...recordsById.values()].sort((a, b) => a.owner - b.owner || a.id - b.id);
}

async function extractSerializedCities(payload, mapWidth, mapHeight, turn, players) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
    decoder = new TextDecoder("utf-8"),
    validOwners = new Set(players.map((player) => player.slot).concat(63)),
    cities = new Map(),
    scalarFields = `id x y rallyX rallyY founded acquired population highestPopulation greatPeople baseGreatPeopleRate greatPeopleRateModifier cultureStored cultureLevel cultureBuildings culturePolicies cultureSpecialists cultureReligion faithBuildings faithPolicies faithReligion cultureRateModifier worldWonders teamWonders nationalWonders wonderProductionModifier capturePlunderModifier plotCultureCostModifier plotBuyCostModifier maintenance healRate espionageModifier noOccupiedUnhappiness food foodKept maxFoodKept overflowProduction featureProduction militaryProductionModifier spaceProductionModifier freeExperience currentAirlift maxAirUnits airModifier nukeModifier tradeRouteTarget tradeRouteRecipient cultureTimer citySizeBoost specialistFreeExperience strength damage threat garrisoned`.split(" "),
    vectorFields = `seaPlot riverPlot lakePlot seaResource terrain buildings specialists misc religion yieldPerPop yieldPerReligion yieldModifier powerYieldModifier resourceYieldModifier extraSpecialist productionToYield domainFreeExperience domainProductionModifier`.split(" ");
  const int32 = (offset) => view.getInt32(offset, true),
    uint32 = (offset) => view.getUint32(offset, true);
  let nextYieldAt = SCAN_CHUNK;
  for (let start = 0; start + 16 < payload.length; start++) {
    if (start >= nextYieldAt) { await yieldToBrowser(); nextYieldAt += SCAN_CHUNK; }
    if (uint32(start) !== 6) continue;
    const id = int32(start + 4), x = int32(start + 8), y = int32(start + 12);
    if (id < 0 || id > 0x7fffffff || x < 0 || x >= mapWidth || y < 0 || y >= mapHeight) continue;
    try {
      let at = start + 4;
      const scalars = {};
      for (const field of scalarFields) { scalars[field] = int32(at); at += 4; }
      if (scalars.id !== id || scalars.x !== x || scalars.y !== y || scalars.population < 1 || scalars.population > 10000 || scalars.founded < 0 || scalars.founded > turn + 1) continue;
      at += 4; // hashed resource demanded
      const razingTurns = int32(at + 5 * 4);
      for (let i = 0; i < 11; i++) at += 4; // remaining city counters and operation ID
      if (at + 26 > payload.length) continue;
      let valid = true;
      for (let i = 0; i < 10; i++) if (payload[at + i] > 1) valid = false;
      if (!valid) continue;
      at += 10;
      const owner = int32(at); at += 16; // owner and three other player/religion enums
      if (!validOwners.has(owner)) continue;
      for (const field of vectorFields) {
        const count = int32(at); at += 4;
        if (count < 0 || count > 128 || at + count * 4 > payload.length) { valid = false; break; }
        if (field === "domainFreeExperience" || field === "domainProductionModifier") {
          if (count > 16) valid = false;
        } else if (count > 32) valid = false;
        at += count * 4;
      }
      if (!valid) continue;
      for (let i = 0; i < 2; i++) {
        const count = int32(at); at += 4;
        if (count < 0 || count > 128 || at + count > payload.length) { valid = false; break; }
        at += count;
      }
      if (!valid || at + 4 > payload.length) continue;
      const nameLength = int32(at); at += 4;
      if (nameLength <= 0 || nameLength > 512 || at + nameLength + 4 > payload.length) continue;
      const nameBytes = payload.subarray(at, at + nameLength),
        name = decoder.decode(nameBytes);
      if (!name.trim() || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(name)) continue;
      at += nameLength;
      const scriptLength = int32(at); at += 4;
      if (scriptLength < -1 || scriptLength > payload.length - at) continue;
      const city = {owner, id, x, y, name, population: scalars.population, founded: scalars.founded, razingTurns};
      const key = `${owner}:${id}`;
      if (!cities.has(key)) cities.set(key, city);
    } catch { /* most byte patterns are not city records */ }
  }
  return [...cities.values()].sort((a, b) => a.owner - b.owner || a.id - b.id);
}


async function parseSerializedMap(payload, {recoverMap = true, onProgress, onSection} = {}) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const u32 = (p) => view.getUint32(p, true),
    i32 = (p) => view.getInt32(p, true);
  let mapAt = -1, mapWidth = 0, mapHeight = 0;
  const mapResourceTotals = [new Map(), new Map()];
  let nextMapYieldAt = SCAN_CHUNK;
  for (let p = 0; p + 64 < payload.length; p += 1) {
    if (p >= nextMapYieldAt) { await yieldToBrowser(); nextMapYieldAt += SCAN_CHUNK; }
    if (payload[p] !== 1 || payload[p + 1] || payload[p + 2] || payload[p + 3]) continue;
    if (u32(p) !== 1) continue;
    const w = i32(p + 4), h = i32(p + 8), land = i32(p + 12);
    if (w < 20 || w > 160 || h < 15 || h > 100 || land < 0 || land > w * h) continue;
    const top = i32(p + 24), bottom = i32(p + 28);
    if (top < -90 || top > 90 || bottom < -90 || bottom > 90) continue;
    const resourceCountAt = p + 50;
    if (resourceCountAt + 4 > payload.length) continue;
    const n = u32(resourceCountAt);
    if (n < 1 || n > 512) continue;
    let at = resourceCountAt;
    const totals = [new Map(), new Map()];
    let arraysValid = true;
    for (let array = 0; array < 2; array++) {
      if (at + 4 > payload.length || u32(at) !== n) { arraysValid = false; break; }
      at += 4;
      for (let i = 0; i < n; i++) {
        if (at + 4 > payload.length) { arraysValid = false; break; }
        const hash = u32(at); at += 4;
        if (hash) { if (at + 4 > payload.length) { arraysValid = false; break; } totals[array].set(hash, i32(at)); at += 4; }
      }
      if (!arraysValid) break;
    }
    if (!arraysValid || at + 4 > payload.length) continue;
    const firstVersion = u32(at);
    if (firstVersion > 7) continue;
    mapAt = at; mapWidth = w; mapHeight = h;
    totals.forEach((source, index) => source.forEach((value, hash) => mapResourceTotals[index].set(hash, value)));
    break;
  }
  if (mapAt < 0) return null;
  onSection?.({type: "map-start", mapWidth, mapHeight});
  const tiles = [], total = mapWidth * mapHeight;
  let at = mapAt;
  const need = (n) => { if (n < 0 || at + n > payload.length) throw new Error("Truncated plot data"); };
  const skip = (n) => { need(n); at += n; };
  const read8 = () => { need(1); return view.getInt8(at++); };
  const read16 = () => { need(2); const x = view.getInt16(at, true); at += 2; return x; };
  const read32 = () => { need(4); const x = view.getInt32(at, true); at += 4; return x; };
  const readU32 = () => { need(4); const x = view.getUint32(at, true); at += 4; return x; };
  const readBool = () => read8() !== 0;
  let decodeIssue = null;
  const decodeIssues = [];
  let lastDecodedTile = null;
  let recoveryActive = false;
  let currentTileStart = -1, currentTileCoordinates = null, currentField = "map header", currentTileTrace = [];
  const trace = (field, value) => currentTileTrace.push({field, offset: at, value});
  // Build the expensive recovery index only if sequential tile parsing fails.
  let plotStarts = null;
  const buildPlotStarts = async () => {
    if (plotStarts) return;
    plotStarts = new Map();
    let nextPlotYieldAt = mapAt + SCAN_CHUNK;
    for (let p = mapAt; p + 8 <= payload.length; p++) {
      if (p >= nextPlotYieldAt) { await yieldToBrowser(); nextPlotYieldAt += SCAN_CHUNK; }
      const version = u32(p);
      if (version !== 7) continue;
      const x = view.getInt16(p + 4, true), y = view.getInt16(p + 6, true);
      if (x < 0 || x >= mapWidth || y < 0 || y >= mapHeight) continue;
      const index = y * mapWidth + x;
      if (index < 1 || index >= total) continue;
      const starts = plotStarts.get(index) || [];
      starts.push(p);
      plotStarts.set(index, starts);
    }
  };
  let emittedTileCount = 0;
  const findLaterPlotStart = (from, afterIndex) => {
    for (let index = afterIndex + 1; index < total; index++) {
      for (const p of plotStarts.get(index) || []) {
        if (p < from) continue;
        let confirmed = 1, previous = p;
        for (let nextIndex = index + 1; nextIndex < Math.min(total, index + 4); nextIndex++) {
          const next = (plotStarts.get(nextIndex) || []).find((candidate) => candidate > previous);
          if (next == null) break;
          previous = next;
          confirmed++;
        }
        if (confirmed >= 4) return {index, offset: p, confirmed};
      }
    }
    return null;
  };
  for (let i = 0; i < total; i++) {
    if (i && i % 32 === 0) {
      if (onSection && tiles.length > emittedTileCount) {
        onSection?.({type: "map-tiles", start: emittedTileCount, tiles: tiles.slice(emittedTileCount)});
        emittedTileCount = tiles.length;
      }
      reportProgress(onProgress, "Parsing map blocks", 18 + Math.floor(25 * i / total));
      await yieldToBrowser();
    }
    currentTileStart = at;
    currentTileTrace = [];
    currentField = "plot version";
    try {
      const version = readU32();
      if (version > 7) throw new Error(`Unsupported plot version ${version}`);
      currentField = "plot coordinates";
      const x = read16(), y = read16();
      currentTileCoordinates = {x, y};
      if (x !== i % mapWidth || y !== Math.floor(i / mapWidth))
        throw new Error(`Invalid plot coordinate sequence (${x},${y}; expected ${i % mapWidth},${Math.floor(i / mapWidth)})`);
      skip(4); // area ID
      read8(); // feature variety
      const ownershipDuration = read16(), improvementDuration = read16(), upgradeProgress = read16(), culture = read16();
      skip(4); // reveal, city-radius, recon, river-crossing counters
      const resourceAmount = read8();
      skip(1); // builder scratch player
      skip(4); // scratch turn/value
      skip(4); // RouteTypes scratch enum
      const landmassId = read32();
      skip(4); // trade flags
      const plotFlags = Array.from({length: 12}, readBool);
      const owner = read8(), plotTypeId = read8(), typeId = read8();
      const featureHash = version >= 3 ? readU32() : 0,
        legacyFeatureId = version < 3 ? read8() : -1,
        featureId = version >= 3 ? saveFeatureId(featureHash) : legacyFeatureId,
        featureName = version >= 3 ? saveFeatureName(featureHash) : saveFeatureNames[legacyFeatureId] || "",
        resourceHash = readU32(),
        legacyImprovementId = version < 5 ? read8() : -1,
        improvementHash = version >= 5 ? readU32() : legacyImprovementId >= 0 ? (0x80000000 | legacyImprovementId) >>> 0 : 0,
        improvementName = version >= 5 ? saveImprovementName(improvementHash) : legacyImprovementId >= 0 ? `Legacy improvement #${legacyImprovementId}` : "",
        underConstructionHash = version >= 7 ? readU32() : 0;
      const playerBuiltImprovement = version >= 2 ? read8() : -1;
      skip(3); // responsible players
      const routeId = read8(), worldAnchor = read8(); skip(1 + 3); // anchor data and river flow directions
      const readCityRef = () => ({owner: read32(), id: read32()});
      const cityRefs = {
        plot: readCityRef(),
        working: readCityRef(),
        workingOverride: readCityRef(),
        resourceLinked: readCityRef(),
        purchase: readCityRef(),
      };
      const plotCity = cityRefs.plot;
      const yields = Array.from({length: 6}, read16);
      currentField = "player and visibility arrays";
      const foundValue = Array.from({length: 80}, read32);
      const playerCityRadiusCount = Array.from({length: 80}, read8);
      const visibilityCount = Array.from({length: 80}, read16);
      const revealedOwner = Array.from({length: 80}, read8);
      const riverCrossing = read8();
      const revealedFlags = Array.from({length: 4}, readU32);
      const resourceForceReveal = Array.from({length: 80}, readBool);
      const revealedImprovement = Array.from({length: 80}, version >= 6 ? readU32 : read16);
      const revealedRoute = Array.from({length: 80}, read16);
      const noSettling = Array.from({length: 22}, readBool);
      currentField = "script data flag";
      const hasScriptData = readBool();
      trace("script data flag", hasScriptData);
      if (hasScriptData) {
        currentField = "script data length";
        const lengthOffset = at;
        const len = read32();
        trace("script data length", {offset: lengthOffset, length: len});
        // FDataStream's std::string reader uses -1 for an empty string.
        if (len < -1 || len > payload.length - at) throw new Error(`Invalid plot script data length ${len}`);
        if (len > 0) skip(len);
      }
      currentField = "build array length";
      const buildsOffset = at;
      const builds = read32();
      const buildProgress = [];
      trace("build array length", {
        offset: buildsOffset,
        count: builds,
        nearbyWords: Array.from({length: 9}, (_, index) => ({
          offset: buildsOffset + index * 4,
          value: buildsOffset + index * 4 + 4 <= payload.length ? i32(buildsOffset + index * 4) : null,
        })),
      });
      // CvPlot::read only allocates and reads build progress when iCount > 0;
      // zero and negative values both leave the array absent.
      if (builds > 4096) throw new Error("Invalid build array");
      if (builds > 0) {
        const entriesOffset = at;
        const entries = read32();
        trace("build entries", {offset: entriesOffset, count: entries});
        if (entries > 4096) throw new Error("Invalid build entries");
        for (let b = 0; b < Math.max(0, entries); b++) {
          const entryOffset = at;
          const hash = readU32();
          // BuildArrayHelpers::Read consumes only the zero hash for an empty
          // slot. A nonzero, known build hash is followed by a short progress
          // value; unknown nonzero hashes use a 32-bit compatibility value.
          if (hash && saveBuildHashes.has(hash)) {
            buildProgress.push({build: saveBuildHashes.get(hash), progress: read16()});
          } else if (hash) {
            skip(4);
            trace("unknown build hash", {offset: entryOffset, hash: hash.toString(16).padStart(8, "0")});
          }
        }
      }
      trace("invisible visibility array", {offset: at, bytes: 80 * 2});
      skip(80 * 2); // invisible visibility counts
      currentField = "unit list length";
      const unitCountOffset = at;
      const unitCount = readU32();
      trace("unit list length", {
        offset: unitCountOffset,
        count: unitCount,
        signedCount: unitCount | 0,
        nearbyBytes: [...payload.subarray(Math.max(0, unitCountOffset - 8), Math.min(payload.length, unitCountOffset + 12))]
          .map((byte) => byte.toString(16).padStart(2, "0")).join(" "),
      });
      if (unitCount > 512) throw new Error(`Invalid plot unit count ${unitCount} (signed ${unitCount | 0})`);
      const units = Array.from({length: unitCount}, () => ({owner: read32(), id: read32()}));
      const continent = read8(), archaeologyVersion = readU32();
      // CvArchaeologyData::operator>> always reads artifact, era, and both
      // players, even for version 0/1. Version 2 adds the great-work field.
      const archaeology = Array.from({length: 4}, read32);
      if (archaeologyVersion >= 2) archaeology.push(read32());
      const riverMask = (plotFlags[4] ? 0x02 : 0) | (plotFlags[3] ? 0x04 : 0) | (plotFlags[2] ? 0x08 : 0);
      tiles.push({x, y, typeId, plotTypeId, landmassId, featureHash, featureId, featureName, resourceHash, resourceAmount, improvementHash, improvementName, underConstructionHash, buildProgress, routeId, routeName: routeId === 0 ? "ROAD" : routeId === 1 ? "RAILROAD" : "", riverMask, owner, playerBuiltImprovement, worldAnchor, yields, units, plotCity, cityRefs, improvementPillaged: plotFlags[6], routePillaged: plotFlags[7], startingPlot: plotFlags[0], hills: plotFlags[1], potentialCityWork: plotFlags[5], barbCampNotConverting: plotFlags[8], resourceLinkedCityActive: plotFlags[10], improvedByGiftFromMajor: plotFlags[11], foundValue, playerCityRadiusCount, visibilityCount, revealedOwner, riverCrossing, revealedFlags, resourceForceReveal, revealedImprovement, revealedRoute, noSettling, ownershipDuration, improvementDuration, upgradeProgress, culture, continent, archaeology, recovered: recoveryActive, plotVersion: version});
      lastDecodedTile = {
        tileIndex: i,
        offset: currentTileStart,
        endOffset: at,
        trace: currentTileTrace,
      };
    } catch (error) {
      const issue = {
        tileIndex: i,
        offset: at,
        tileStart: currentTileStart,
        nearbyBytes: [...payload.subarray(Math.max(0, currentTileStart - 8), Math.min(payload.length, currentTileStart + 24))]
          .map((byte) => byte.toString(16).padStart(2, "0")).join(" "),
        nextNonzeroPayloadOffset: (() => {
          let p = currentTileStart;
          while (p < payload.length && payload[p] === 0) p++;
          return p;
        })(),
        lastDecodedTile,
        plausibleExpectedTileOffsets: [],
        coordinates: currentTileCoordinates,
        field: currentField,
        trace: currentTileTrace,
        message: error.message,
      };
      decodeIssues.push(issue);
      if (!decodeIssue) decodeIssue = issue;
      tiles.push({x: i % mapWidth, y: Math.floor(i / mapWidth), typeId: 6, plotTypeId: 3, units: [], dataUnavailable: true});
      if (i + 1 < total) {
        if (!recoverMap) {
          for (let rest = i + 1; rest < total; rest++) tiles.push({x: rest % mapWidth, y: Math.floor(rest / mapWidth), typeId: 6, plotTypeId: 3, units: [], dataUnavailable: true});
          break;
        }
        // A field-size mismatch can advance `at` past the next record, so
        // resync from this plot's start rather than from the failing cursor.
        await buildPlotStarts();
        issue.plausibleExpectedTileOffsets = (plotStarts.get(i) || []).filter((offset) => Math.abs(offset - currentTileStart) <= 8192).slice(0, 16);
        const recovery = findLaterPlotStart(currentTileStart + 4, i);
        if (!recovery) {
          for (let rest = i + 1; rest < total; rest++) tiles.push({x: rest % mapWidth, y: Math.floor(rest / mapWidth), typeId: 6, plotTypeId: 3, units: [], dataUnavailable: true});
          break;
        }
        issue.recoveredAtTile = recovery.index;
        issue.recoveredAtOffset = recovery.offset;
        issue.confirmedPlotHeaders = recovery.confirmed;
        recoveryActive = true;
        for (let skipped = i + 1; skipped < recovery.index; skipped++)
          tiles.push({x: skipped % mapWidth, y: Math.floor(skipped / mapWidth), typeId: 6, plotTypeId: 3, units: [], dataUnavailable: true});
        i = recovery.index - 1;
        at = recovery.offset;
      }
    }
  }
  if (onSection && tiles.length > emittedTileCount)
    onSection?.({type: "map-tiles", start: emittedTileCount, tiles: tiles.slice(emittedTileCount)});
  const firstErrorTile = decodeIssue?.tileIndex ?? tiles.length;
  const integrityTiles = tiles.slice(0, firstErrorTile);
  const resourceSetting = inferSaveResourceSetting(integrityTiles);
  const complete = tiles.every((tile) => !tile.dataUnavailable);
  // Civ5 defines a lake as a water landmass of at most LAKE_MAX_AREA_SIZE
  // plots. The stock GlobalDefines.xml sets this threshold to 9.
  const landmasses = new Map(), uncertainLandmasses = new Set();
  for (const tile of tiles) {
    if (tile.dataUnavailable || !Number.isInteger(tile.landmassId) || tile.landmassId < 0) continue;
    const landmass = landmasses.get(tile.landmassId) || {size: 0, water: true};
    landmass.size++;
    if (tile.plotTypeId !== 3) landmass.water = false;
    landmasses.set(tile.landmassId, landmass);
    if (!complete) {
      // A partial parse can still identify a lake when its entire landmass is
      // surrounded by decoded plots. Groups touching the map edge are kept
      // uncertain because the map may wrap there.
      const diagonalXs = tile.y & 1 ? [tile.x, tile.x + 1] : [tile.x - 1, tile.x];
      const neighbors = [
        [tile.x - 1, tile.y], [tile.x + 1, tile.y],
        [diagonalXs[0], tile.y - 1], [diagonalXs[1], tile.y - 1],
        [diagonalXs[0], tile.y + 1], [diagonalXs[1], tile.y + 1],
      ];
      if (tile.x === 0 || tile.x === mapWidth - 1 || tile.y === 0 || tile.y === mapHeight - 1 ||
        neighbors.some(([x, y]) => x >= 0 && x < mapWidth && y >= 0 && y < mapHeight &&
          tiles[y * mapWidth + x]?.dataUnavailable))
        uncertainLandmasses.add(tile.landmassId);
    }
  }
  for (const tile of tiles) {
    const landmass = landmasses.get(tile.landmassId);
    if (tile.plotTypeId === 3 && landmass?.water && landmass.size <= 9 && // 9 lake max area size
      (complete || !uncertainLandmasses.has(tile.landmassId)))
      tile.isLake = true;
  }
  for (const tile of tiles) {
    if (tile.dataUnavailable || !tile.resourceHash) continue;
    const name = saveResourceName(tile.resourceHash),
      options = saveAllowedResourceQuantities(resourceSetting.setting, name, tile.typeId);
    tile.allowedResourceQuantities = options;
    const isStrategicResource = name === "Oil" || Object.hasOwn(saveResourceQuantityRules.Standard, name);
    tile.quantityOutsideRules = !isStrategicResource ? false : options
      ? !options.includes(tile.resourceAmount)
      : !saveAnySettingAllowsResourceQuantity(name, tile.typeId, tile.resourceAmount);
  }
  const anomalies = tiles.filter((tile) => !tile.dataUnavailable && (
    (tile.resourceHash && tile.quantityOutsideRules) ||
    (tile.resourceHash && tile.resourceAmount <= 0) ||
    (!tile.resourceHash && tile.resourceAmount !== 0)
  )).map((tile) => ({x: tile.x, y: tile.y, resourceHash: tile.resourceHash, resource: saveResourceName(tile.resourceHash), quantity: tile.resourceAmount, allowed: tile.allowedResourceQuantities, type: tile.quantityOutsideRules ? "resource-quantity-outside-exact-mapgen-values" : "resource-quantity-inconsistent"}));
  for (const issue of decodeIssues) anomalies.push({type: "plot-record-decode-error", ...issue});
  {
    const observed = new Map();
    for (const tile of tiles) if (!tile.dataUnavailable && tile.resourceHash) observed.set(tile.resourceHash, (observed.get(tile.resourceHash) || 0) + 1);
    for (const [hash, count] of mapResourceTotals[0]) {
      const actual = observed.get(hash) || 0;
      if (actual > count || (complete && actual !== count)) anomalies.push({type: "resource-tile-count-mismatch", resourceHash: hash, resource: saveResourceName(hash), expected: count, actual, partial: !complete});
    }
    for (const [hash, actual] of observed) if (!mapResourceTotals[0].has(hash)) anomalies.push({type: "resource-missing-from-map-totals", resourceHash: hash, resource: saveResourceName(hash), actual});
  }
  const integrityFindings = anomalies.filter((item) => {
    if (item.type === "plot-record-decode-error") return false;
    if (Number.isInteger(item.x) && Number.isInteger(item.y))
      return item.y * mapWidth + item.x < firstErrorTile;
    return complete;
  });
  const inventory = new Map();
  for (const tile of tiles) if (!tile.dataUnavailable && tile.resourceHash) {
    const entry = inventory.get(tile.resourceHash) || {hash: tile.resourceHash, name: saveResourceName(tile.resourceHash), tiles: 0, quantity: 0};
    entry.tiles++; entry.quantity += tile.resourceAmount; inventory.set(tile.resourceHash, entry);
  }
  const resourceInventory = [...inventory.values()].map((entry) => ({...entry, declaredTiles: mapResourceTotals[0].get(entry.hash) ?? null, declaredLandTiles: mapResourceTotals[1].get(entry.hash) ?? null})).sort((a,b) => a.name.localeCompare(b.name));
  return {mapWidth, mapHeight, tiles, parsedTiles: tiles.filter((tile) => !tile.dataUnavailable).length, complete, recoveryEnabled: recoverMap, decodeIssue, resourceSetting, resourceInventory, resourceTotals: mapResourceTotals.map((entries) => [...entries].map(([hash, count]) => ({hash, count, resource: saveResourceName(hash)}))), anomalies, integrityFindings, entities: {units: tiles.reduce((n, tile) => n + tile.units.length, 0), cities: new Set(tiles.filter((tile) => tile.plotCity?.owner >= 0 && tile.plotCity?.id >= 0).map((tile) => `${tile.plotCity.owner}:${tile.plotCity.id}`)).size}};
}
const crc32Table = new Uint32Array(256);
for (let n = 0; n < crc32Table.length; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crc32Table[n] = value >>> 0;
}
function crc32(text) {
  let value = 0xffffffff;
  for (const byte of new TextEncoder().encode(text))
    value = crc32Table[(value ^ byte) & 255] ^ (value >>> 8);
  return value >>> 0;
}
function gameNameHashes(names, prefix, valueForName = (name) => name) {
  return new Map(names.map((name) => [crc32(`${prefix}_${name}`), valueForName(name)]));
}
const saveResourceHashes = gameNameHashes(
  "IRON HORSE COAL OIL ALUMINUM URANIUM STONE WHEAT COW SHEEP DEER BANANA FISH WHALE PEARLS GOLD SILVER GEMS MARBLE SPICES SUGAR COTTON DYE FUR INCENSE IVORY SILK WINE SALT CRAB BISON TRUFFLES CITRUS COPPER COCOA CLOVES NUTMEG PEPPER TEA TOBACCO COFFEE JADE AMBER JEWELRY PORCELAIN ARTIFACTS HIDDEN_ARTIFACTS".split(" "),
  "RESOURCE",
  (name) => name[0] + name.slice(1).toLowerCase(),
);
function saveResourceName(hash) { return saveResourceHashes.get(hash) || (hash ? `Unknown resource ${hash.toString(16).padStart(8, "0")}` : ""); }
const saveResourceQuantityRules = {
  Sparse: {Horse:[1,4], Iron:[1,4], Uranium:[1,2], OilLand:[2,5], OilWater:[4], Coal:[2,5], Aluminum:[2,5]},
  Standard: {Horse:[2,4], Iron:[2,6], Uranium:[2,4], OilLand:[3,7], OilWater:[4], Coal:[3,7], Aluminum:[3,8]},
  Abundant: {Horse:[3,6], Iron:[3,9], Uranium:[3,4], OilLand:[3,9], OilWater:[6], Coal:[3,10], Aluminum:[3,10]},
};
function saveAllowedResourceQuantities(setting, name, terrainId) {
  const rules = saveResourceQuantityRules[setting];
  if (!rules) return null;
  if (name === "Oil") return rules[terrainId === 5 || terrainId === 6 ? "OilWater" : "OilLand"];
  return rules[name] || null;
}
function saveAnySettingAllowsResourceQuantity(name, terrainId, quantity) {
  return Object.keys(saveResourceQuantityRules).some((setting) => saveAllowedResourceQuantities(setting, name, terrainId)?.includes(quantity));
}
function inferSaveResourceSetting(tiles) {
  const observed = tiles.filter((tile) => !tile.dataUnavailable &&
    ["Horse", "Iron", "Uranium", "Oil", "Coal", "Aluminum"].includes(saveResourceName(tile.resourceHash)));
  const scores = Object.keys(saveResourceQuantityRules).map((setting) => ({
    setting,
    matched: observed.filter((tile) => saveAllowedResourceQuantities(setting, saveResourceName(tile.resourceHash), tile.typeId)?.includes(tile.resourceAmount)).length,
  })).sort((a,b) => b.matched - a.matched);
  const best = scores[0], runnerUp = scores[1];
  if (!best || observed.length < 4 || best.matched / observed.length < 0.8 || best.matched - runnerUp.matched < 2)
    return {setting:null, samples:observed.length, scores};
  return {setting:best.setting, samples:observed.length, scores};
}
const saveFeatureNames = ["ICE","JUNGLE","MARSH","OASIS","FLOOD_PLAINS","FOREST","FALLOUT","CRATER","FUJI","MESA","REEF","VOLCANO","GIBRALTAR","GEYSER","FOUNTAIN_YOUTH","POTOSI","EL_DORADO","ATOLL","LAKE","RIVER","SRI_PADA","ULURU","KILIMANJARO","LAKE_VICTORIA","MT_KAILASH","MT_SINAI","SOLOMONS_MINES"];
const saveFeatureHashes = gameNameHashes(saveFeatureNames, "FEATURE", (name) => saveFeatureNames.indexOf(name));
function saveFeatureId(hash) { return saveFeatureHashes.get(hash) ?? -1; }
function saveFeatureName(hash) { return saveFeatureNames[saveFeatureId(hash)] || ""; }
const saveImprovementHashes = gameNameHashes(
  "CITY_RUINS BARBARIAN_CAMP GOODY_HUT FARM MINE QUARRY TRADING_POST LUMBERMILL PASTURE FISHING_BOATS PLANTATION CAMP WELL OFFSHORE_PLATFORM FORT LANDMARK ACADEMY CUSTOMS_HOUSE MANUFACTORY CITADEL ARCHAEOLOGICAL_DIG BRAZILWOOD_CAMP CHATEAU FEITORIA HOLY_SITE KASBAH MOAI POLDER TERRACE_FARM".split(" "),
  "IMPROVEMENT",
);
function saveImprovementName(hash) { return saveImprovementHashes.get(hash) || ""; }
const saveBuildHashes = gameNameHashes(
  "ACADEMY ARCHAEOLOGY_DIG BRAZILWOOD_CAMP CAMP CHATEAU CITADEL CUSTOMS_HOUSE FARM FEITORIA FISHING_BOATS FISHING_BOATS_NO_KILL FORT HOLY_SITE KASBAH LANDMARK LUMBERMILL MANUFACTORY MINE MOAI MOTTE_BAILEY OFFSHORE_PLATFORM PASTURE PLANTATION POLDER PONTOON_BRIDGE QUARRY RAILROAD REMOVE_FOREST REMOVE_JUNGLE REMOVE_MARSH REMOVE_ROUTE REPAIR ROAD SCRUB_FALLOUT TERRACE_FARM TIPI TRADING_POST WAJO WELL".split(" "),
  "BUILD",
);
function extractLobbyOptions(section) {
  if (!section) return [];
  const decoder = new TextDecoder("utf-8"),
    found = new Map(),
    view = new DataView(section.buffer, section.byteOffset, section.byteLength),
    text = decoder.decode(section),
    encoder = new TextEncoder();
  const pattern = /GAMEOPTION_[A-Z0-9_]+/g;
  for (const match of text.matchAll(pattern)) {
    const byteIndex = encoder.encode(text.slice(0, match.index)).length;
    if (byteIndex < 4) continue;
    const keyLength = view.getUint32(byteIndex - 4, true),
      valueAt = byteIndex + match[0].length;
    if (keyLength !== match[0].length || valueAt + 4 > section.length) continue;
    const raw = view.getInt32(valueAt, true);
    if (raw === 0 || raw === 1) found.set(match[0], Boolean(raw));
  }
  return [...found].map(([key, enabled]) => ({ key, enabled }));
}
async function extractPayloadTextMetadata(payload, onProgress) {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const found = new Map(), strings = new Set(), tokens = new Set();
  const blockSize = 256 * 1024, overlap = 256, decoder = new TextDecoder("latin1");
  for (let start = 0; start < payload.length; start += blockSize) {
    const end = Math.min(payload.length, start + blockSize),
      text = decoder.decode(payload.subarray(start, Math.min(payload.length, end + overlap)));
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_ .'-]{3,80}/g)) {
      if (match.index >= end - start) continue;
      const value = match[0].replace(/[\0-\x1f\x7f-\xff]+/g, "").trim();
      if (value.length >= 4 && /[A-Za-z]/.test(value)) strings.add(value);
    }
    for (const match of text.matchAll(/[A-Z][A-Z0-9_]{3,64}/g)) {
      if (match.index < end - start) tokens.add(match[0]);
    }
    for (const match of text.matchAll(/TXT_KEY_CITYSTATE_([A-Z0-9_]+)/g)) {
      if (match.index >= end - start || match[1].endsWith("_ADJ") || match[1].endsWith("_DESC")) continue;
      const absoluteOffset = start + match.index,
        lengthPrefixed = absoluteOffset >= 4 && view.getUint32(absoluteOffset - 4, true) === match[0].length,
        entry = found.get(match[1]) || {count: 0, lengthPrefixed: false};
      entry.count++;
      entry.lengthPrefixed ||= lengthPrefixed;
      found.set(match[1], entry);
    }
    reportProgress(onProgress, "Finishing save data", 91 + Math.floor(8 * end / payload.length));
    await yieldToBrowser();
  }
  return {
    cityStates: [...found].filter(([, entry]) => entry.lengthPrefixed || entry.count > 1).map(([key]) => key),
    strings: [...strings].slice(0, 500),
    tokens: [...tokens].slice(0, 5000),
  };
}


function indexOfBytes(haystack, needle, start) {
  outer: for (let i = start; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
async function inflateSyncFlush(raw) {
  if (typeof DecompressionStream === "undefined")
    throw new Error("Browser decompression is unavailable");
  const input = new Uint8Array(raw.length + 5);
  input.set(raw);
  input.set([1, 0, 0, 255, 255], raw.length);
  const stream = new DecompressionStream("deflate-raw"),
    writer = stream.writable.getWriter(),
    reader = stream.readable.getReader();
  let chunks = [],
    size = 0,
    failure = null;
  const reading = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
    } catch (e) {
      failure = e;
    }
  })();
  await writer.write(input).catch((e) => {
    failure = failure || e;
  });
  await writer.close().catch((e) => {
    failure = failure || e;
  });
  await reading;
  if (failure) throw failure;
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export {
  parseSave,
  parseSerializedMap,
  saveFeatureName,
  saveImprovementName,
  saveResourceName,
};
