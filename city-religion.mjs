class ParseError extends Error {}

class Reader {
  constructor(data, pos = 0) {
    this.data = data;
    this.pos = pos;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  take(count) {
    if (!Number.isInteger(count) || count < 0 || this.pos + count > this.data.length)
      throw new ParseError("truncated city religion structure");
    const value = this.data.subarray(this.pos, this.pos + count);
    this.pos += count;
    return value;
  }
  unpack(type) {
    const offset = this.pos;
    const size = type === "B" ? 1 : 4;
    this.take(size);
    if (type === "B") return this.view.getUint8(offset);
    if (type === "I") return this.view.getUint32(offset, true);
    return this.view.getInt32(offset, true);
  }
  count(limit) {
    const count = this.unpack("I");
    if (count > limit) throw new ParseError("city religion array too large");
    return count;
  }
}

const fail = (message) => { throw new ParseError(message); };
function boolean(reader) {
  const value = reader.unpack("B");
  if (value > 1) fail("invalid city-tail boolean");
  return value === 1;
}
function versionOne(reader) {
  if (reader.unpack("I") !== 1) fail("unsupported city-tail subobject version");
}
function hashedArray(reader, size, limit = 4096) {
  const count = reader.count(limit), hashes = [];
  for (let i = 0; i < count; i++) {
    const hash = reader.unpack("I");
    hashes.push(hash);
    if (hash !== 0) {
      if (size === 1) boolean(reader);
      else reader.take(size);
    }
  }
  return hashes;
}
function sameHashes(a, b) {
  if (a.length !== b.length || a.some((hash, i) => hash !== b[i]))
    fail("city-tail paired hash arrays disagree");
}
function citizens(reader, population) {
  versionOne(reader);
  boolean(reader);
  boolean(reader);
  const assignments = [reader.unpack("i"), reader.unpack("i"), reader.unpack("i")];
  if (assignments.some((value) => value < 0 || value > population))
    fail("invalid citizen assignment count");
  const focus = reader.unpack("i");
  if (focus < -1 || focus > 32) fail("invalid citizen focus");
  boolean(reader);
  for (let i = 0; i < 74; i++) boolean(reader);
  const defaults = [reader.unpack("i"), reader.unpack("i")];
  if (defaults.some((value) => value < 0 || value > population))
    fail("invalid default specialist count");
  const specialists = hashedArray(reader, 4, 128);
  sameHashes(specialists, hashedArray(reader, 4, 128));
  const buildings = hashedArray(reader, 4);
  sameHashes(buildings, hashedArray(reader, 4));
  sameHashes(specialists, hashedArray(reader, 4, 128));
}
function readReligionBlock(data, offset, population) {
  const reader = new Reader(data, offset), version = reader.unpack("I");
  if (![1, 2, 3].includes(version)) fail("unsupported city religion version");
  if (version >= 2) boolean(reader);
  if (version >= 3) reader.unpack("i");
  const count = reader.count(256), religions = [];
  for (let i = 0; i < count; i++) {
    const entryVersion = reader.unpack("I");
    if (![1, 2].includes(entryVersion)) fail("unsupported religion-in-city version");
    const religionId = reader.unpack("i"), holy = reader.unpack("B"),
      followers = reader.unpack("i"), pressure = reader.unpack("i");
    if (religionId < -1 || holy > 1 || followers < 0 || pressure < 0)
      fail("invalid religion-in-city record");
    const record = { religionId, holyCity: holy === 1, followers, pressure };
    if (entryVersion === 2) {
      record.tradeRoutesApplyingPressure = reader.unpack("i");
      if (record.tradeRoutesApplyingPressure < 0) fail("invalid religion trade route pressure");
    }
    religions.push(record);
  }
  const ids = new Set();
  for (const religion of religions) {
    if (ids.has(religion.religionId)) fail("duplicate city religion ID");
    ids.add(religion.religionId);
  }
  if (religions.reduce((sum, religion) => sum + religion.followers, 0) > population)
    fail("religion followers exceed city population");
  let majorityReligionId = -1, mostFollowers = -1, mostPressure = -1;
  for (const religion of religions) {
    if (religion.followers > mostFollowers ||
        (religion.followers === mostFollowers && religion.pressure > mostPressure)) {
      mostFollowers = religion.followers;
      mostPressure = religion.pressure;
      majorityReligionId = religion.religionId;
    }
  }
  const total = religions.reduce((sum, religion) => sum + religion.followers, 0);
  if (mostFollowers * 2 < total) majorityReligionId = -1;
  return { religions, majorityReligionId, endOffset: reader.pos };
}
function followingObjects(reader, yields) {
  versionOne(reader);
  for (let i = 0; i < 2 + yields; i++) {
    const count = reader.unpack("i");
    if (count < 0 || count > 256) fail("invalid city emphasis count");
  }
  hashedArray(reader, 1, 128);
  if (reader.unpack("I") !== 0) fail("unsupported city espionage version");
  let dimension;
  for (let i = 0; i < 9; i++) {
    const count = reader.count(64);
    if (count < 1 || (dimension !== undefined && count !== dimension))
      fail("city espionage dimensions disagree");
    dimension = count;
    reader.take(count * 4);
  }
  const hitPoints = reader.unpack("i");
  if (hitPoints < 0 || hitPoints > 100000) fail("invalid city extra hit points");
}

function locateCityReligion(data, city, limit, yields) {
  const text = new TextEncoder().encode(city.name),
    marker = new Uint8Array(4 + text.length);
  new DataView(marker.buffer).setUint32(0, text.length, true);
  marker.set(text, 4);
  const lower = city.evidence.nameEndOffset,
    upper = Math.min(limit, data.length, lower + 1_000_000),
    matches = [];
  for (let pos = lower; pos < upper;) {
    pos = data.indexOf(marker[0], pos);
    if (pos < 0 || pos + marker.length >= upper) break;
    const anchor = pos++;
    if (anchor < 14 || marker.some((value, i) => data[anchor + i] !== value)) continue;
    try {
      const before = new Reader(data, anchor - 14), expanded = before.unpack("i"),
        happiness = [before.unpack("i"), before.unpack("i")];
      if (expanded < -1 || happiness.some((value) => Math.abs(value) > 100000)) continue;
      const connectedToCapitalLastTurn = boolean(before),
        connectedToCapitalThisTurn = boolean(before);
      const reader = new Reader(data, anchor + marker.length);
      boolean(reader);
      versionOne(reader);
      const flavors = reader.count(128);
      if (!flavors) continue;
      reader.take(flavors * 4);
      const strategies = hashedArray(reader, 1, 256);
      sameHashes(strategies, hashedArray(reader, 4, 256));
      for (let i = 0; i < 2; i++) {
        const specialization = reader.unpack("i");
        if (specialization < -1 || specialization > 128) fail("invalid city specialization");
      }
      for (let i = 0; i < 2; i++) { versionOne(reader); hashedArray(reader, 4); }
      versionOne(reader);
      const projectsStart = reader.pos;
      for (let projectCount = 0; projectCount <= 256; projectCount++) {
        try {
          const tail = new Reader(data, projectsStart + projectCount * 4);
          versionOne(tail);
          const processes = tail.count(128);
          if (!processes) continue;
          tail.take(processes * 8);
          citizens(tail, city.population);
          const decoded = readReligionBlock(data, tail.pos, city.population);
          if (decoded.religions.length &&
              decoded.religions.reduce((sum, religion) => sum + religion.followers, 0) !== city.population)
            continue;
          tail.pos = decoded.endOffset;
          followingObjects(tail, yields);
          if (tail.pos <= upper)
            matches.push({ ...decoded, connectedToCapitalLastTurn, connectedToCapitalThisTurn, projectCount, nameAnchor: anchor });
        } catch (error) { if (!(error instanceof ParseError)) throw error; }
      }
    } catch (error) { if (!(error instanceof ParseError)) throw error; }
  }
  if (matches.length !== 1) fail(matches.length ? "ambiguous city religion structure" : "city religion structure unavailable");
  return matches[0];
}

export function extractCityReligions(data, cities) {
  const ordered = [...cities].sort((a, b) => a.evidence.offset - b.evidence.offset),
    profileMatches = [];
  for (const yields of [6, 7, 8]) {
    const decoded = new Map(), dimensions = new Set();
    for (let i = 0; i < ordered.length; i++) {
      try {
        const city = ordered[i], result = locateCityReligion(
          data, city, ordered[i + 1]?.evidence.offset ?? data.length, yields,
        );
        decoded.set(city, result);
        dimensions.add(result.projectCount);
      } catch (error) { if (!(error instanceof ParseError)) throw error; }
    }
    if (dimensions.size <= 1 && decoded.size)
      profileMatches.push({ yields, decoded });
  }
  const bestCount = Math.max(0, ...profileMatches.map(({ decoded }) => decoded.size)),
    best = profileMatches.filter(({ decoded }) => decoded.size === bestCount);
  if (best.length !== 1) {
    for (const city of cities) {
      city.religionKnown = false;
      city.religions = null;
      city.majorityReligionId = null;
      city.connectedToCapitalLastTurn = null;
      city.connectedToCapitalThisTurn = null;
    }
    return { known: 0, total: cities.length };
  }
  const decoded = best[0].decoded;
  for (const city of cities) {
    const result = decoded.get(city);
    city.religionKnown = Boolean(result);
    city.religions = result?.religions ?? null;
    city.majorityReligionId = result?.majorityReligionId ?? null;
    city.connectedToCapitalLastTurn = result?.connectedToCapitalLastTurn ?? null;
    city.connectedToCapitalThisTurn = result?.connectedToCapitalThisTurn ?? null;
  }
  return { known: decoded.size, total: cities.length };
}

export function extractReligionCatalog(data, plotOffset, cities, players) {
  if (!Number.isInteger(plotOffset) || plotOffset <= 0) return [];
  const prefix = data.subarray(0, plotOffset), holyCities = new Map();
  for (const city of cities)
    if (city.religionKnown)
      for (const religion of city.religions)
        if (religion.holyCity && religion.religionId > 0)
          holyCities.set(religion.religionId, city);
  if (!holyCities.size) return [];
  const majorPlayers = new Set(players
    .filter((player) => player.civilization !== "CIVILIZATION_MINOR" &&
      !player.civilization.startsWith("MINOR_CIV_"))
    .map((player) => player.slot));
  const catalogs = [];
  for (const beliefScalars of [26, 34]) {
    for (let pos = prefix.indexOf(4); pos >= 0; pos = prefix.indexOf(4, pos + 1)) {
      try {
        const reader = new Reader(prefix, pos);
        if (reader.unpack("I") !== 4) continue;
        const faith = reader.unpack("i"), count = reader.count(64);
        if (faith < 0 || faith > 100000 || count < 1) continue;
        const catalog = [], identities = new Set();
        let crossChecks = 0;
        for (let i = 0; i < count; i++) {
          if (reader.unpack("I") !== 4) fail("unsupported global religion version");
          const id = reader.unpack("i"), founder = reader.unpack("i"),
            x = reader.unpack("i"), y = reader.unpack("i"), founded = reader.unpack("i");
          if (id < 0 || !majorPlayers.has(founder) || founded < 0 || x < -1 || y < -1 ||
              (x === -1) !== (y === -1)) fail("invalid global religion identity");
          const pantheon = reader.unpack("B");
          if (pantheon > 1) fail("invalid global pantheon flag");
          boolean(reader);
          if (Boolean(pantheon) !== (id === 0)) fail("global religion pantheon mismatch");
          const identity = `${id}:${id === 0 ? founder : "founded"}`;
          if (identities.has(identity)) fail("duplicate global religion identity");
          identities.add(identity);
          const bytes = reader.take(128), terminator = bytes.indexOf(0);
          if (terminator < 0 || bytes.subarray(terminator).some((value) => value !== 0))
            fail("invalid custom religion name padding");
          const customName = new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, terminator));
          if (/[\u0000-\u001f\u007f]/.test(customName)) fail("invalid custom religion name");
          const beliefsVersion = reader.unpack("I");
          if (![1, 2].includes(beliefsVersion)) fail("unsupported religion beliefs version");
          reader.take((beliefsVersion === 2 ? beliefScalars : beliefScalars - 1) * 4);
          reader.take(reader.count(64) * 4);
          hashedArray(reader, 4);
          const city = holyCities.get(id);
          if (city) {
            if (city.x !== x || city.y !== y) fail("global holy city mismatch");
            crossChecks++;
          }
          if (id > 0) catalog.push({id, founder, holyCity: x === -1 ? null : {x, y}, customName: customName || null});
        }
        if (crossChecks === holyCities.size) catalogs.push(catalog);
      } catch (error) {
        if (!(error instanceof ParseError) && !(error instanceof TypeError)) throw error;
      }
    }
  }
  return catalogs.length === 1 ? catalogs[0] : [];
}
