"use strict";
const playerColors = window.CIV5_PLAYER_COLORS || {};
const civilizationColors = window.CIV5_REPLAY_CIV_COLORS || {};
const replayCivAssets = window.CIV5_REPLAY_CIV_ASSETS || [];
const $ = (s) => document.querySelector(s);
const drop = $("#dropzone"),
  input = $("#fileInput");
let current = null,
  activeTab = "summary";
let dragDepth = 0;
function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function humanBytes(n) {
  return n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${(n / 1024).toFixed(1)} KB`;
}
function slotStatus(status) {
  if (status === undefined || status === null) return "Replay player";
  return (
    ["Unassigned", "AI", "Dead", "Human", "Closed"][status] ||
    `Unknown (${status})`
  );
}
function saveVersionLabel(version) {
  const releases = {
    4: "Civ V 1.0.0–1.0.0.17",
    5: "Civ V 1.0.0.62–1.0.1.221",
    7: "Civ V 1.0.1.332–1.0.1.383",
    8: "Civ V 1.0.1.511 and newer",
  };
  return releases[version]
    ? `Format ${version} · ${releases[version]}`
    : `Unknown format (${version})`;
}
function gameModeLabel(mode) {
  return (
    ["Single player", "Multiplayer", "Hotseat", "Email multiplayer"][mode] ??
    `Unknown (${mode})`
  );
}
function gameEnumLabel(value, prefix) {
  const text = String(value ?? "");
  if (!text.startsWith(prefix)) return text;
  return text.slice(prefix.length).replaceAll("_", " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
function civHue(value) {
  let hash = 0;
  for (const c of value) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}
function steamProfileId(value) {
  const text = String(value || "").trim();
  const suffix = text.match(/@(?:7656119)?(\d{10})$/);
  if (suffix) {
    const id = suffix[0].slice(1);
    return id.length === 17 ? id : `7656119${id}`;
  }
  const match = text.match(
    /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/(\d{17})\/?$/i,
  );
  if (match) return match[1];
  return /^\d{17}$/.test(text) ? text : "";
}
function setStatus(s, error = false) {
  const status = $("#status");
  status.hidden = false;
  status.innerHTML = error
    ? `<span style="color:var(--orange)">${esc(s)}</span>`
    : esc(s);
}
drop.addEventListener("click", (e) => {
  if (e.target !== input) input.click();
});
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    input.click();
  }
});
input.addEventListener("change", () => {
  if (input.files[0]) inspect(input.files[0]);
});
document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("page-dragging");
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("page-dragging");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("page-dragging");
  const file = [...e.dataTransfer.files].find((f) =>
    /\.civ5(save|replay)$/i.test(f.name),
  );
  if (file) inspect(file);
  else setStatus("Drop a .Civ5Save or .Civ5Replay file.", true);
});
async function inspect(file) {
  const isReplay = file.name.toLowerCase().endsWith(".civ5replay");
  if (!isReplay && !file.name.toLowerCase().endsWith(".civ5save"))
    return setStatus("Choose a .Civ5Save or .Civ5Replay file.", true);
  $("#dropTitle").textContent = file.name;
  $("#dropHint").hidden = false;
  $("#dropHint").textContent = `${humanBytes(file.size)} · Reading ${isReplay ? "replay data" : "save header and compressed payload"}…`;
  setStatus(isReplay ? "Reading replay…" : "Reading save…");
  $("#result").hidden = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = isReplay ? parseReplay(bytes, file.name) : await parseSave(bytes, file.name);
    current = data;
    render(data);
    $("#result").hidden = false;
    $("#dropHint").hidden = true;
    $("#status").hidden = true;
  } catch (e) {
    setStatus(e.message || "Save decode failed.", true);
  }
}

async function parseSave(bytes, filename) {
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
  for (let at = p; at + 1 < bytes.length; at++) {
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
      const result = await inflateSyncFlushInBrowser(bytes.subarray(at + 2));
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
  const playerCivs = getStrings(8),
    playerLeaders = getStrings(9),
    playerNames = getStrings(23),
    playerColors = getStrings(25);
  const players = statuses
    .map((status, i) => ({
      slot: i,
      status,
      civilization: playerCivs[i] || "",
      leader: playerLeaders[i] || "",
      name: playerNames[i] || "",
      color: playerColors[i] || "",
    }))
    .filter((x) => x.status > 0 && x.status < 4 && x.civilization);
  const lobbyOptions = extractLobbyOptions(sections[29]);
  const cityStates = extractCityStates(payload);
  const text = new TextDecoder("latin1").decode(payload),
    strings = new Set();
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_ .'-]{3,80}/g)) {
    const value = m[0].replace(/[\0-\x1f\x7f-\xff]+/g, "").trim();
    if (value.length >= 4 && /[A-Za-z]/.test(value)) strings.add(value);
  }
  const tokens = [...new Set(text.match(/[A-Z][A-Z0-9_]{3,64}/g) || [])];
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
    },
    payload: {
      bytes: payload.length,
      playedSeconds,
      strings: [...strings].slice(0, 500),
      tokens: tokens.slice(0, 5000),
    },
  };
}
function extractLobbyOptions(section) {
  if (!section) return [];
  const decoder = new TextDecoder("utf-8"), found = new Map();
  const pattern = /GAMEOPTION_[A-Z0-9_]+/g;
  for (const match of decoder.decode(section).matchAll(pattern)) {
    const byteIndex = new TextEncoder().encode(decoder.decode(section).slice(0, match.index)).length;
    if (byteIndex < 4) continue;
    const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
    const keyLength = view.getUint32(byteIndex - 4, true), valueAt = byteIndex + match[0].length;
    if (keyLength !== match[0].length || valueAt + 4 > section.length) continue;
    const raw = view.getInt32(valueAt, true);
    if (raw === 0 || raw === 1) found.set(match[0], Boolean(raw));
  }
  return [...found].map(([key, enabled]) => ({key, enabled}));
}
function extractCityStates(payload) {
  if (!payload) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const raw = new TextDecoder("latin1").decode(payload), found = new Map();
  for (const match of raw.matchAll(/TXT_KEY_CITYSTATE_([A-Z0-9_]+)/g)) {
    const start = match.index;
    if (match[1].endsWith("_ADJ") || match[1].endsWith("_DESC")) continue;
    const lengthPrefixed = start >= 4 && view.getUint32(start - 4, true) === match[0].length;
    const entry = found.get(match[1]) || { count: 0, lengthPrefixed: false };
    entry.count++;
    entry.lengthPrefixed ||= lengthPrefixed;
    found.set(match[1], entry);
  }
  // Some save payload records repeat valid city-state keys without the usual length prefix.
  return [...found].filter(([, entry]) => entry.lengthPrefixed || entry.count > 1).map(([key]) => key);
}
function parseReplay(bytes, filename) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n) => { if (n < 0 || at + n > bytes.length) throw new Error("Truncated Civ5Replay file at byte " + at); };
  const i32 = () => { need(4); const n = view.getInt32(at, true); at += 4; return n; };
  const i16 = () => { need(2); const n = view.getInt16(at, true); at += 2; return n; };
  const i8 = () => { need(1); return view.getInt8(at++); };
  const decoder = new TextDecoder("utf-8");
  const str = (n) => { need(n); const v = decoder.decode(bytes.subarray(at, at + n)).replace(/\0+$/, ""); at += n; return v; };
  const varstr = () => { const n = i32(); if (n < 0 || n > 4_000_000) throw new Error("Invalid Civ5Replay string size " + n); return str(n); };
  const count = (label, max = 2_000_000) => { const n = i32(); if (n < 0 || n > max) throw new Error("Invalid " + label + " count: " + n); return n; };
  const array = (label, fn, max) => Array.from({length: count(label, max)}, (_, i) => fn(i));
  if (str(4) !== "CIV5") throw new Error("Invalid Civ5Replay signature.");
  const format = i32(), version = varstr(), build = varstr();
  need(5); at += 5;
  const playerCiv = varstr(), difficulty = varstr(), eraStart = varstr(), eraEnd = varstr(), gameSpeed = varstr(), worldSize = varstr(), mapScript = varstr();
  const dlc = array("DLC", () => { need(16); const id=[...bytes.subarray(at,at+16)].map(b=>b.toString(16).padStart(2,"0")).join(""); at+=16; return {id, enabled:i32(), name:varstr()}; }, 1000);
  const mods = array("mod", () => ({id: varstr(), version: i32(), name: varstr()}), 1000);
  varstr();
  varstr();
  const playerColor = varstr();
  need(8); at += 8;
  const mapScript2 = varstr();
  const timelineAt = findReplayTimeline(bytes, view, at, decoder);
  if (timelineAt < 0) throw new Error("Could not locate the replay timeline block.");
  at = timelineAt;
  const startTurn = i32(), startYear = i32(), endTurn = i32(), endYear = varstr();
  i32();
  i32();
  const civs = array("civilization", () => { const raw = [i32(), i32(), i32(), i32()]; return {raw, leader: varstr(), longName: varstr(), name: varstr(), demonym: varstr()}; }, 128);
  const players=civs.map((c,slot)=>{const asset=replayCivAssets[c.raw[0]],civilization=c.raw[0]===18?"CIVILIZATION_MINOR":c.raw[0]===19?"CIVILIZATION_BARBARIAN":"";const displayCiv=c.name||c.longName||(civilization==="CIVILIZATION_MINOR"?"Minor civilization":"");const color=asset||playerColors[String(c.raw[2])]||[];return {slot,civilization,displayCiv,leader:c.leader,name:c.longName,shortName:c.name,demonym:c.demonym,color:color.color||color[0]||"#777777",secondaryColor:color.secondaryColor||color[1]||"#eeeeee",iconKey:asset?.icon||"",iconAvailable:Boolean(asset),raw:c.raw};});
  const datasetKeys = array("dataset", () => varstr(), 1000);
  const datasetValues = array("dataset values", () => array("civilization values", () => array("metric value", () => ({turn:i32(), value:i32()}), 100000), 128), 1000);
  const metricData = datasetKeys.map((key, index) => ({key, byPlayer: datasetValues.map((player) => player[index] || [])}));
  i32();
  const events = array("event", () => { const turn = i32(), typeId = i32(), tiles = array("event tile", () => ({x:i16(), y:i16()}), 100000), civId = i32(), text = varstr(); return {turn, typeId, tiles, civId, text}; }, 2_000_000);
  const mapWidth = i32(), mapHeight = i32();
  if (mapWidth < 1 || mapHeight < 1 || mapWidth * mapHeight > 2_000_000) throw new Error("Invalid replay map dimensions.");
  const tiles = array("map tile", () => { const junk1 = i32(), junk2 = i32(); return {junk1, junk2, elevationId:i8(), typeId:i8(), featureId:i8(), junk3:i8()}; }, mapWidth * mapHeight);
  const typeNames = ["MESSAGE","CITY_FOUNDED","TILES_CLAIMED","CITIES_TRANSFERRED","CITY_RAZED","RELIGION_FOUNDED","PANTHEON_SELECTED"];
  const parsedEvents = events.map((event) => {
    const civ = players[event.civId]?.shortName || civs[event.civId]?.name || "";
    const type = typeNames[event.typeId] || `EVENT_${event.typeId}`;
    const [tile] = event.tiles;
    return {...event, civ, type, ...tile};
  });
  parsedEvents.sort((a,b)=>a.turn-b.turn);
  return {kind:"replay", file:{name:filename,size:bytes.length}, header:{format, version, build, playerCiv, difficulty, startingEra:eraStart, era:eraEnd, speed:gameSpeed, worldSize, mapScript, mapScript2, playerColor, startTurn, startYear, endTurn, endYear, players, dlc, mods}, replay:{mapWidth,mapHeight,tiles,events:parsedEvents,metrics:metricData}};
}
function findReplayTimeline(bytes, view, start, decoder) {
  const limit=Math.min(bytes.length-48,start+65536);
  const readString=(offset)=>{if(offset+4>bytes.length)return null;const n=view.getInt32(offset,true);if(n<0||n>1024||offset+4+n>bytes.length)return null;const value=decoder.decode(bytes.subarray(offset+4,offset+4+n));if(value.includes("\ufffd")||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))return null;return {value,next:offset+4+n};};
  for(let pos=start;pos<limit;pos++){
    const turn=view.getInt32(pos,true),year=view.getInt32(pos+4,true),endTurn=view.getInt32(pos+8,true);
    if(turn< -1||turn>100000||Math.abs(year)>100000||endTurn<turn||endTurn>100000)continue;
    const endYear=readString(pos+12);if(!endYear||!/\d/.test(endYear.value))continue;
    let cursor=endYear.next+8;if(cursor+4>bytes.length)continue;
    const civCount=view.getInt32(cursor,true);cursor+=4;
    if(civCount<1||civCount>128)continue;
    let valid=true;
    for(let civ=0;civ<civCount&&valid;civ++){
      if(cursor+16>bytes.length){valid=false;break;}cursor+=16;
      const names=[];
      for(let field=0;field<4;field++){const item=readString(cursor);if(!item){valid=false;break;}names.push(item.value);cursor=item.next;}
      if(valid&&(!names[2]||!names[3]))valid=false;
    }
    if(!valid||cursor+4>bytes.length)continue;
    const datasets=view.getInt32(cursor,true);cursor+=4;
    if(datasets<1||datasets>1000)continue;
    for(let dataset=0;dataset<datasets&&valid;dataset++){const item=readString(cursor);if(!item||!item.value){valid=false;break;}cursor=item.next;}
    if(valid)return pos;
  }
  return -1;
}
function indexOfBytes(haystack, needle, start) {
  outer: for (let i = start; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
async function inflateSyncFlushInBrowser(raw) {
  if (typeof DecompressionStream === "undefined")
    throw new Error("Browser decompression is unavailable");
  // Civ5 ends this raw DEFLATE stream at a Z_SYNC_FLUSH boundary. Add an empty final stored block so the browser inflater can finish normally.
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
function render(d) {
  if (d.kind === "replay") return renderReplay(d);
  setAvailableTabs(["summary", "players", "metadata", "strings"]);
  const h = d.header,
    p = d.payload;
  $("#saveTitle").textContent = gameEnumLabel(h.civ, "CIVILIZATION_") || "Civ V save";
  $("#savePath").textContent = d.file.name;
  $("#turn").textContent = h.turn;
  $("#dimensions").textContent = h.worldSize.replace(/^WORLDSIZE_/, "");
  $("#playtime").textContent = p.playedSeconds
    ? `${Math.floor(p.playedSeconds / 3600)}h ${Math.floor((p.playedSeconds % 3600) / 60)}m`
    : "—";
  $("#payloadSize").textContent = humanBytes(p.bytes);
  const fields = [
    ["Save version", saveVersionLabel(h.saveVersion)],
    ["Game version", h.gameVersion],
    ["Build", h.build],
    ["Turn", h.turn],
    ["Game mode", gameModeLabel(h.mode)],
    ["Player civilization", gameEnumLabel(h.civ, "CIVILIZATION_")],
    ["Difficulty", gameEnumLabel(h.difficulty, "HANDICAP_")],
    ["Starting era", gameEnumLabel(h.startingEra, "ERA_")],
    ["Current era", gameEnumLabel(h.era, "ERA_")],
    ["Game speed", gameEnumLabel(h.speed, "GAMESPEED_")],
    ["World size", h.worldSize],
    ["Map script", h.mapScript],
    ["Header bytes", h.headerBytes],
    ["Compressed payload offset", h.compressedOffset],
    ["Compressed size", humanBytes(d.file.size - h.compressedOffset)],
    ["Decompressed size", humanBytes(p.bytes)],
  ];
  $("#facts").innerHTML = fields
    .map(
      ([k, v]) =>
        `<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`,
    )
    .join("");
  renderLobbyOptions(h.lobbyOptions || []);
  $("#dlcRecords").hidden=true;
  $("#dlcRecords").innerHTML="";
  drawPlayers(h.players || [], h.cityStates);
  renderTab(activeTab);
}
function renderReplay(d) {
  setAvailableTabs(["summary", "history", "events", "map", "players", "metadata", "strings"]);
  const h = d.header, r = d.replay;
  const enabledDlc=h.dlc.filter(item=>item.enabled);
  $("#saveTitle").textContent = gameEnumLabel(h.playerCiv, "CIVILIZATION_") || h.players[0]?.name || "Civ V replay";
  $("#savePath").textContent = d.file.name;
  $("#turn").textContent = h.endTurn;
  $("#dimensions").textContent = `${r.mapWidth} × ${r.mapHeight}`;
  $("#playtime").textContent = `${h.startYear} → ${h.endYear}`;
  $("#payloadSize").textContent = humanBytes(d.file.size);
  const fields = [["Replay version",h.version],["Build",h.build],["Turn range",`${h.startTurn}–${h.endTurn}`],["Year range",`${h.startYear}–${h.endYear}`],["Difficulty",gameEnumLabel(h.difficulty,"HANDICAP_")],["Starting era",gameEnumLabel(h.startingEra,"ERA_")],["Ending era",gameEnumLabel(h.era,"ERA_")],["Game speed",gameEnumLabel(h.speed,"GAMESPEED_")],["World size",gameEnumLabel(h.worldSize,"WORLDSIZE_")],["Map script",h.mapScript],["DLC",enabledDlc.length],["Mods",h.mods.length],["Map",`${r.mapWidth} × ${r.mapHeight} · ${r.tiles.length} tiles`],["Events",r.events.length]];
  $("#facts").innerHTML=fields.map(([k,v])=>`<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
  renderLobbyOptions([]);
  const dlcWrap=$("#dlcRecords");
  dlcWrap.hidden=!enabledDlc.some(item=>item.name);
  dlcWrap.innerHTML=enabledDlc.filter(item=>item.name).map(item=>`<div class="slot-group minor-civ">${esc(item.name)}</div>`).join("");
  drawPlayers(h.players.map((p,i)=>({...p,slot:i})));
  renderTab(activeTab);
}
function setAvailableTabs(available) {
  const allowed = new Set(available);
  document.querySelectorAll(".tabs button").forEach((button) => {
    button.hidden = !allowed.has(button.dataset.tab);
  });
  if (!allowed.has(activeTab)) activeTab = "summary";
}
function renderLobbyOptions(options) {
  const wrap=$("#lobbyOptions"), enabled=options.filter(option=>option.enabled);
  wrap.hidden=!enabled.length;
  wrap.innerHTML=enabled.map(option=>`<div class="lobby-option">${esc(gameEnumLabel(option.key,"GAMEOPTION_").toUpperCase())}</div>`).join("");
}
function drawPlayers(players, cityStates = null) {
  const wrap = $("#playerOverview"),
    isReplay = current?.kind === "replay",
    major = players.filter(
      (p) =>
        p.civilization !== "CIVILIZATION_MINOR" && !(p.civilization || "").startsWith("MINOR_CIV_") &&
        p.civilization !== "CIVILIZATION_BARBARIAN",
    ),
    minor = players.filter((p) => p.civilization === "CIVILIZATION_MINOR" || (p.civilization || "").startsWith("MINOR_CIV_")),
    barbarian = players.filter(
      (p) => p.civilization === "CIVILIZATION_BARBARIAN",
    );
  const listedCityStates = cityStates ?? minor.map((p) => p.displayCiv || p.shortName || p.name || "Minor civilization");
  if (!players.length) {
    wrap.innerHTML =
      '<div class="map-empty">Player slots were not found in the save header.</div>';
    return;
  }
  wrap.innerHTML = `<div class="player-list">${major
    .map((p) => {
      const civ = p.civilization || "",
        label = civ === "CIVILIZATION_MINOR" ? (p.displayCiv || p.shortName || p.name || "Minor") : civ ? (civ.startsWith("MINOR_CIV_") ? civ.slice("MINOR_CIV_".length).replaceAll("_", " ") : gameEnumLabel(civ, "CIVILIZATION_")) : (p.displayCiv || p.shortName || p.name || "UNKNOWN CIV"),
        short = label.slice(0, 2),
        playerName = p.displayCiv || p.name || label,
        steamId = steamProfileId(playerName),
        playerLabel = steamId
          ? `<a class="steam-profile" href="https://steamcommunity.com/profiles/${steamId}" target="_blank" rel="noopener noreferrer">${esc(playerName)}</a>`
          : esc(playerName),
        hue = civHue(civ || String(p.raw?.[0] ?? label)),
        civKey = p.iconKey || civ.replace(/^CIVILIZATION_/, "").toLowerCase();
      const [badgeColor,badgeSecondary]=civBadgeColors(p);
      const badgeStyle=`--civ-hue:${hue};--civ-color:${badgeColor};--civ-secondary:${badgeSecondary}`;
      const mark = p.iconAvailable === false || civ.startsWith("MINOR_CIV_") ? `<span class="civ-mark civ-mark-fallback" style="${badgeStyle}" aria-label="${esc(label)}">${esc(short)}</span>` : `<img class="civ-mark civ-mark-image" style="${badgeStyle}" src="./assets/civ-icons/${esc(civKey)}.png" alt="${esc(label)} emblem" title="${esc(label)}"><span hidden class="civ-mark civ-mark-fallback" style="${badgeStyle}" aria-label="${esc(label)}">${esc(short)}</span>`;
      const subtitle = isReplay ? (p.leader || civ || label) : (civ || p.displayCiv || label);
      return `<div class="player-row${p.status === 3 ? " human" : ""}"><span class="player-slot">${String(p.slot).padStart(2, "0")}</span>${mark}<span class="player-info"><strong>${playerLabel}</strong><small>${esc(subtitle)}</small></span><span class="player-status">${slotStatus(p.status)}</span></div>`;
    })
    .join(
      "",
    )}</div><div class="slot-groups">${listedCityStates.length ? `<div class="slot-group">MINOR CIVILIZATIONS <b>${listedCityStates.length}</b></div>${listedCityStates.map(name=>`<div class="slot-group minor-civ">${esc(typeof name === "string" ? name : name.displayCiv||name.shortName||name.name||"Minor civilization")}</div>`).join("")}` : ""}${barbarian.length ? `<div class="slot-group">BARBARIANS <b>${barbarian.length}</b></div>` : ""}</div>`;
  wrap.querySelectorAll(".civ-mark-image").forEach((image) =>
    image.addEventListener(
      "error",
      () => {
        image.hidden = true;
        image.nextElementSibling.hidden = false;
      },
      { once: true },
    ),
  );
}
function civBadgeColors(player) {
  const validColor=value=>/^#[\da-f]{6}$/i.test(String(value||""));
  const [civColor,civSecondary]=civilizationColors[player.civilization]||[];
  return [
    validColor(player.color)?player.color:(civColor||"#777777"),
    validColor(player.secondaryColor)?player.secondaryColor:(civSecondary||"#dddddd"),
  ];
}
function renderTab(tab) {
  activeTab = tab;
  $("#tabContent").classList.toggle("map-tab", tab === "map");
  const tabCard=$("#tabContent").closest(".card"),isWideMap=current?.kind==="replay"&&tab==="map";
  tabCard?.classList.toggle("wide-map",isWideMap);
  if(!isWideMap)tabCard?.style.removeProperty("width");
  document
    .querySelectorAll(".tabs button")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (!current) return;
  const h = current.header, box = $("#tabContent");
  if (current.kind === "replay") { renderReplayTab(tab, current, box); return; }
  const p = current.payload;
  const setLines = (lines) => (box.textContent = lines.join("\n"));
  if (tab === "summary")
    setLines([
      `File: ${current.file.name}`,
      `File size: ${current.file.size} bytes`,
      `Save version: ${saveVersionLabel(h.saveVersion)}`,
      `Game build: ${h.gameVersion} (${h.build})`,
      `Game mode: ${gameModeLabel(h.mode)}`,
      `Turn: ${h.turn}`,
      `Civilization: ${gameEnumLabel(h.civ, "CIVILIZATION_")}`,
      `Difficulty: ${gameEnumLabel(h.difficulty, "HANDICAP_")}`,
      `Era: ${gameEnumLabel(h.era, "ERA_")}`,
      `Game speed: ${gameEnumLabel(h.speed, "GAMESPEED_")}`,
      `World: ${h.worldSize} / ${h.mapScript}`,
      `Decompressed game data: ${humanBytes(p.bytes)}`,
      `Extracted tokens: ${p.tokens.length}`,
      `Readable strings: ${p.strings.length}`,
    ]);
  if (tab === "strings")
    setLines([...p.tokens, ...p.strings].length
      ? [...p.tokens, ...p.strings]
      : ["No readable strings found in payload."]);
  if (tab === "players") {
    let minorIndex = 0;
    const playerLines = (h.players || []).map((p) => {
      const isMinor = p.civilization === "CIVILIZATION_MINOR" || (p.civilization || "").startsWith("MINOR_CIV_");
      const cityState = isMinor ? h.cityStates?.[minorIndex++] : "";
      const civilization = isMinor
        ? cityState ? gameEnumLabel(`CITYSTATE_${cityState}`, "CITYSTATE_") : "Minor"
        : gameEnumLabel(p.civilization, "CIVILIZATION_") || "(no civilization id)";
      return `Slot ${String(p.slot).padStart(2, "0")} · ${slotStatus(p.status)} · ${civilization}${p.leader ? ` · Leader: ${gameEnumLabel(p.leader, "LEADER_")}` : ""}${p.name ? ` · Player: ${p.name}` : ""}${p.color ? ` · Color: ${p.color}` : ""}`;
    });
    setLines(playerLines.length ? playerLines : ["No player slots found."]);
  }
  if (tab === "metadata")
    setLines([
      `Save format: ${saveVersionLabel(h.saveVersion)}`,
      `Game version: ${h.gameVersion || "Not recorded"}`,
      `Build: ${h.build || "Not recorded"}`,
      `Game mode: ${gameModeLabel(h.mode)}`,
      `Civilization: ${gameEnumLabel(h.civ, "CIVILIZATION_")}`,
      `Difficulty: ${gameEnumLabel(h.difficulty, "HANDICAP_")}`,
      `Starting era: ${gameEnumLabel(h.startingEra, "ERA_")}`,
      `Current era: ${gameEnumLabel(h.era, "ERA_")}`,
      `Game speed: ${gameEnumLabel(h.speed, "GAMESPEED_")}`,
      `World size: ${h.worldSize}`,
      `Map script: ${h.mapScript}`,
      `Header sections: ${h.sectionCount}`,
      `Compressed payload: ${humanBytes(p.bytes)} decompressed`,
    ]);
}
function replayTable(headers, rows) {
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map(x=>`<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(x=>`<td>${x?.trustedHtml ? x.value : esc(x ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function flattenMetricValues(value, player = null, out = []) {
  if (Array.isArray(value)) value.forEach((v,i)=>flattenMetricValues(v, player === null ? i : player, out));
  else if (value && Number.isFinite(value.turn) && Number.isFinite(value.value)) out.push({...value,player});
  return out;
}
function renderEventText(value) {
  return esc(value||"").replace(/\[ICON_([A-Z0-9_]+)\]/g,(token,name)=>`<img class="game-icon" src="assets/civ5-icons/ICON_${name}.png" alt="${token}" title="${name.toLowerCase()}">`);
}
function renderReplayTab(tab, d, box) {
  const {header:h,replay:r}=d;
  const text = (value) => { box.textContent=value; };
  if (tab === "summary") return text([`Replay: ${d.file.name}`,`Player civilization: ${gameEnumLabel(h.playerCiv,"CIVILIZATION_")}`,`Difficulty: ${gameEnumLabel(h.difficulty,"HANDICAP_")}`,`Turn range: ${h.startTurn}–${h.endTurn}`,`Year range: ${h.startYear}–${h.endYear}`,`Map: ${r.mapWidth} × ${r.mapHeight}`,`Players: ${h.players.length}`,`Replay events: ${r.events.length}`,`Metrics: ${r.metrics.length}`,...(h.dlc.some(x=>x.enabled)?[`DLC: ${h.dlc.filter(x=>x.enabled).map(x=>x.name).join(", ")}`]:[]),...(h.mods.length?[`Mods: ${h.mods.map(x=>x.name).join(", ")}`]:[])].join("\n"));
  if (tab === "metadata") {const fields=[["Replay version",h.version],["Build",h.build],["Player civilization",gameEnumLabel(h.playerCiv,"CIVILIZATION_")],["Player color",h.playerColor],["Difficulty",h.difficulty],["Starting era",h.startingEra],["Ending era",h.era],["Game speed",h.speed],["World size",h.worldSize],["Map script",h.mapScript]];if(h.mapScript2&&h.mapScript2!==h.mapScript)fields.push(["Secondary map script",h.mapScript2]);const enabledDlc=h.dlc.filter(x=>x.enabled);if(enabledDlc.length)fields.push(["DLC",enabledDlc.map(x=>x.name).join("\n")]);if(h.mods.length)fields.push(["Mods",h.mods.map(x=>`${x.name} · ${x.version} · ${x.id}`).join("\n")]);return text(fields.map(([k,v])=>`${k}: ${v||"—"}`).join("\n"));}
  if (tab === "players") return box.innerHTML=replayTable(["#","Civilization","Leader","Formal name","Demonym"],h.players.map((p,i)=>[i+1,p.displayCiv||p.shortName,p.leader,p.displayCiv||p.name,p.demonym]));
  if (tab === "events") {box.innerHTML=replayTable(["Turn","Year","Type","Civilization","Location","Event"],r.events.map(e=>[e.turn, replayYear(h,e.turn),e.type,e.civ,e.x===undefined?"":`${e.x}, ${e.y}`,{trustedHtml:true,value:renderEventText(e.text)}]).sort((a,b)=>a[0]-b[0]));box.querySelectorAll(".game-icon").forEach(icon=>icon.addEventListener("error",()=>icon.replaceWith(document.createTextNode(icon.alt)),{once:true}));return;}
  if (tab === "history") {
    const metrics=r.metrics.map(m=>({key:m.key,rows:flattenMetricValues(m.byPlayer).filter(row=>row.value!==0)}));
    const usable=metrics.filter(m=>m.rows.length);
    if (!usable.length) return text("This replay contains no turn metric samples.");
    box.innerHTML=`<label class="metric-picker">Metric <select id="metricSelect">${usable.map((m,i)=>`<option value="${i}">${esc(m.key)}</option>`).join("")}</select></label><div id="metricRows"></div>`;
    const select=box.querySelector("#metricSelect"), target=box.querySelector("#metricRows");
    const draw=()=>{const rows=usable[Number(select.value)].rows.sort((a,b)=>a.turn-b.turn||a.player-b.player);target.innerHTML=replayTable(["Turn","Year","Civilization","Value"],rows.slice(0,3000).map(x=>[x.turn,replayYear(h,x.turn),h.players[x.player]?.name||`Player ${x.player+1}`,x.value]));};
    select.addEventListener("change",draw); draw(); return;
  }
  if (tab === "map") {
    const radius=9,hexW=Math.sqrt(3)*radius,canvasWidth=Math.ceil(radius*2+hexW*r.mapWidth),canvasHeight=Math.ceil(radius*2+radius*1.5*(r.mapHeight-1));
    box.closest(".card").style.width=`min(${canvasWidth+36}px,calc(100vw - 24px))`;
    const terrainLegend=[["GRASSLAND","Grassland"],["PLAINS","Plains"],["DESERT","Desert"],["TUNDRA","Tundra"],["SNOW","Snow"],["COAST","Coast"],["OCEAN","Ocean"]];
    const opacityKey="civ5ReplayTerritoryOpacity";let initialTerritoryOpacity=55;try{const stored=Number(localStorage.getItem(opacityKey));if(localStorage.getItem(opacityKey)!==null&&Number.isFinite(stored))initialTerritoryOpacity=Math.max(0,Math.min(100,stored));}catch{}
    box.innerHTML=`<label class="metric-picker">Turn <input id="mapTurn" type="range" min="${h.startTurn}" max="${Math.max(h.startTurn,h.endTurn)}" value="${h.endTurn}"><b id="mapTurnLabel">${h.endTurn}</b></label><div class="replay-map-wrap"><div id="mapWorld" class="map-world" style="width:min(${canvasWidth}px,100%);aspect-ratio:${canvasWidth}/${canvasHeight}"><canvas class="map-layer-canvas" data-map-layer="terrain" width="${canvasWidth}" height="${canvasHeight}"></canvas><canvas class="map-layer-canvas" data-map-layer="elevation" width="${canvasWidth}" height="${canvasHeight}"></canvas><canvas class="map-layer-canvas" data-map-layer="features" width="${canvasWidth}" height="${canvasHeight}"></canvas><canvas class="map-layer-canvas" data-map-layer="grid" width="${canvasWidth}" height="${canvasHeight}"></canvas><canvas class="map-layer-canvas" data-map-layer="territory" width="${canvasWidth}" height="${canvasHeight}"></div><div id="mapTileTooltip" class="map-tile-tooltip" hidden></div><div class="map-zoom-controls"><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="reset" aria-label="Reset zoom">100%</button><button type="button" data-zoom="in" aria-label="Zoom in">+</button></div></div><div class="map-layer-controls"><span>Layers</span>${[["terrain","Terrain"],["elevation","Elevation"],["features","Features"],["territory","Territory"],["grid","Grid"]].map(([key,label])=>`<label><input type="checkbox" data-map-layer="${key}" checked>${label}</label>`).join("")}</div><label class="metric-picker map-opacity-control">Territory overlay <input id="territoryOpacity" type="range" min="0" max="100" value="${initialTerritoryOpacity}"><b id="territoryOpacityLabel">${initialTerritoryOpacity}%</b></label><div class="map-legend" style="width:min(${canvasWidth}px,100%);max-width:100%;margin-inline:auto">${terrainLegend.map(([asset,name])=>`<span><i style="background-image:url('assets/terrain/${asset}.png')"></i>${name}</span>`).join("")}${h.players.map(p=>`<span><i style="background:${p.secondaryColor||p.color}"></i>${esc(p.displayCiv||p.shortName)}</span>`).join("")}</div>`;
    const world=box.querySelector("#mapWorld"),viewport=world.parentElement,range=box.querySelector("#mapTurn"),opacityRange=box.querySelector("#territoryOpacity"),tooltip=box.querySelector("#mapTileTooltip"),zoomReadout=box.querySelector('[data-zoom="reset"]'),layers=Object.fromEntries([...box.querySelectorAll(".map-layer-canvas")].map(canvas=>[canvas.dataset.mapLayer,{canvas,ctx:canvas.getContext("2d")}])) ;
    let territoryOpacity=Number(opacityRange.value),currentOwners=new Map(),zoom=1,zoomTarget=1,zoomAnimation=null,zoomFrame=0,panX=0,panY=0,drag=null,pointers=new Map(),pinch=null;
    layers.territory.canvas.style.opacity=String(territoryOpacity/100);
    const clampPan=()=>{const baseX=Math.max(0,(viewport.clientWidth-world.clientWidth)/2);if(world.clientWidth*zoom<=viewport.clientWidth)panX=0;else panX=Math.min(-baseX,Math.max(viewport.clientWidth-world.clientWidth*zoom-baseX,panX));panY=Math.min(0,Math.max(viewport.clientHeight-world.clientHeight*zoom,panY));};
    const applyZoom=()=>{clampPan();world.style.transform=`translate(${panX}px,${panY}px) scale(${zoom})`;zoomReadout.textContent=`${Math.round(zoom*100)}%`;};
    const animateZoom=(next,x,y)=>{zoomTarget=Math.max(1,Math.min(5,next));const baseX=Math.max(0,(viewport.clientWidth-world.clientWidth)/2);zoomAnimation={startZoom:zoom,targetZoom:zoomTarget,startTime:performance.now(),duration:150,baseX,mapX:(x-baseX-panX)/zoom,mapY:(y-panY)/zoom,x,y};if(!zoomFrame)zoomFrame=requestAnimationFrame(function tick(now){const a=zoomAnimation;if(!a){zoomFrame=0;return;}const t=Math.min(1,(now-a.startTime)/a.duration),ease=1-Math.pow(1-t,3);zoom=a.startZoom+(a.targetZoom-a.startZoom)*ease;panX=a.x-a.baseX-a.mapX*zoom;panY=a.y-a.mapY*zoom;applyZoom();if(t<1)zoomFrame=requestAnimationFrame(tick);else{zoom=a.targetZoom;zoomAnimation=null;zoomFrame=0;applyZoom();}});};
    const zoomBy=(factor,x,y)=>animateZoom(zoomTarget*factor,x,y);
    box.querySelectorAll(".map-zoom-controls button").forEach(button=>button.addEventListener("click",()=>{if(button.dataset.zoom==="reset"){if(zoomFrame)cancelAnimationFrame(zoomFrame);zoomFrame=0;zoomAnimation=null;zoom=zoomTarget=1;panX=panY=0;applyZoom();return;}zoomBy(button.dataset.zoom==="in"?1.2:1/1.2,viewport.clientWidth/2,viewport.clientHeight/2);}));
    viewport.addEventListener("wheel",event=>{event.preventDefault();const rect=viewport.getBoundingClientRect(),factor=Math.exp(-event.deltaY*.0012);zoomBy(factor,event.clientX-rect.left,event.clientY-rect.top);},{passive:false});
    viewport.addEventListener("dblclick",event=>{if(event.target.closest(".map-zoom-controls"))return;event.preventDefault();const rect=viewport.getBoundingClientRect();zoomBy(1.5,event.clientX-rect.left,event.clientY-rect.top);});
    viewport.addEventListener("pointerdown",event=>{if(event.target.closest(".map-zoom-controls"))return;if(zoomFrame){cancelAnimationFrame(zoomFrame);zoomFrame=0;zoomAnimation=null;zoomTarget=zoom;}viewport.setPointerCapture(event.pointerId);const rect=viewport.getBoundingClientRect(),point={x:event.clientX-rect.left,y:event.clientY-rect.top};pointers.set(event.pointerId,point);if(pointers.size===1)drag={point,panX,panY};else if(pointers.size===2){const pts=[...pointers.values()],dx=pts[0].x-pts[1].x,dy=pts[0].y-pts[1].y,center={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2},baseX=Math.max(0,(viewport.clientWidth-world.clientWidth)/2);pinch={distance:Math.hypot(dx,dy),zoom,mapX:(center.x-baseX-panX)/zoom,mapY:(center.y-panY)/zoom};}viewport.classList.add("is-panning");});
    viewport.addEventListener("pointermove",event=>{if(!pointers.has(event.pointerId))return;const rect=viewport.getBoundingClientRect();pointers.set(event.pointerId,{x:event.clientX-rect.left,y:event.clientY-rect.top});if(pointers.size>=2&&pinch){if(zoomFrame)cancelAnimationFrame(zoomFrame);zoomFrame=0;zoomAnimation=null;const pts=[...pointers.values()],dx=pts[0].x-pts[1].x,dy=pts[0].y-pts[1].y,center={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2},baseX=Math.max(0,(viewport.clientWidth-world.clientWidth)/2);zoom=Math.max(1,Math.min(5,pinch.zoom*Math.hypot(dx,dy)/Math.max(1,pinch.distance)));zoomTarget=zoom;panX=center.x-baseX-pinch.mapX*zoom;panY=center.y-pinch.mapY*zoom;applyZoom();}else if(drag){panX=drag.panX+(pointers.get(event.pointerId).x-drag.point.x);panY=drag.panY+(pointers.get(event.pointerId).y-drag.point.y);applyZoom();}});
    const endPan=event=>{pointers.delete(event.pointerId);pinch=null;if(pointers.size===1){const [point]=pointers.values();drag={point,panX,panY};}else{drag=null;viewport.classList.remove("is-panning");}};
    viewport.addEventListener("pointerup",endPan);viewport.addEventListener("pointercancel",endPan);viewport.addEventListener("lostpointercapture",endPan);
    const drawStaticLayers=()=>{for(const layer of ["terrain","elevation","features","grid"])layers[layer].ctx.clearRect(0,0,canvasWidth,canvasHeight);r.tiles.forEach((tile,i)=>{const x=i%r.mapWidth,y=Math.floor(i/r.mapWidth),cx=radius+hexW*(x+.5*(y&1)),cy=radius+radius*1.5*y,left=cx-hexW/2,top=cy-radius;traceReplayHex(layers.terrain.ctx,cx,cy,radius);layers.terrain.ctx.save();layers.terrain.ctx.clip();const base=terrainImages[replayTerrainName(tile.typeId)];if(base)layers.terrain.ctx.drawImage(base,left,top,hexW,radius*2);else{layers.terrain.ctx.fillStyle=terrainColor(tile.typeId);layers.terrain.ctx.fill();}layers.terrain.ctx.restore();for(const [layer,name] of [["elevation",replayElevationName(tile.elevationId)],["features",replayFeatureName(tile.featureId)]]){const image=terrainImages[name];if(!image)continue;const ctx=layers[layer].ctx;traceReplayHex(ctx,cx,cy,radius);ctx.save();ctx.clip();ctx.drawImage(image,left,top,hexW,radius*2);ctx.restore();}traceReplayHex(layers.grid.ctx,cx,cy,radius);layers.grid.ctx.strokeStyle="rgba(20,24,22,.16)";layers.grid.ctx.lineWidth=.5;layers.grid.ctx.stroke();});};
    const terrainImages=loadReplayTerrainImages();drawStaticLayers();terrainImages.ready.then(()=>{if(box.contains(world))drawStaticLayers();});
    const drawTerritory=()=>{const ctx=layers.territory.ctx;ctx.clearRect(0,0,canvasWidth,canvasHeight);const owners=new Map(),turn=Number(range.value);for(const e of r.events){if(e.turn>turn)break;if(e.type==="CITY_FOUNDED"&&e.x!==undefined)owners.set(`${e.x},${e.y}`,e.civ||"");else if(e.type==="TILES_CLAIMED"||e.type==="CITIES_TRANSFERRED")for(const t of e.tiles)owners.set(`${t.x},${t.y}`,e.civ||"");}currentOwners=owners;r.tiles.forEach((tile,i)=>{const x=i%r.mapWidth,y=Math.floor(i/r.mapWidth),owner=owners.get(`${x},${y}`),player=h.players.find(p=>p.shortName===owner||p.name===owner);if(!player)return;const cx=radius+hexW*(x+.5*(y&1)),cy=radius+radius*1.5*y;traceReplayHex(ctx,cx,cy,radius);ctx.fillStyle=player.secondaryColor||player.color;ctx.fill();ctx.strokeStyle=player.color;ctx.lineWidth=1.5;ctx.stroke();});box.querySelector("#mapTurnLabel").textContent=turn;};
    viewport.addEventListener("mousemove",event=>{const rect=world.getBoundingClientRect(),px=(event.clientX-rect.left)*canvasWidth/rect.width,py=(event.clientY-rect.top)*canvasHeight/rect.height,tileIndex=locateReplayTile(px,py,r.mapWidth,r.mapHeight,radius,hexW),tile=tileIndex<0?null:r.tiles[tileIndex];if(!tile){tooltip.hidden=true;return;}const x=tileIndex%r.mapWidth,y=Math.floor(tileIndex/r.mapWidth),owner=currentOwners.get(`${x},${y}`),player=h.players.find(p=>p.shortName===owner||p.name===owner),details=[`Tile ${x+1}, ${y+1}`,replayTerrainLabel(tile.typeId),replayElevationLabel(tile.elevationId),replayFeatureLabel(tile.featureId),player?(player.displayCiv||player.shortName):(owner||"Unclaimed")],viewportRect=viewport.getBoundingClientRect();tooltip.textContent=details.filter(Boolean).join(" · ");tooltip.hidden=false;tooltip.style.left=`${Math.max(8,Math.min(event.clientX-viewportRect.left+14,viewport.clientWidth-tooltip.offsetWidth-8))}px`;tooltip.style.top=`${Math.max(8,Math.min(event.clientY-viewportRect.top+14,viewport.clientHeight-tooltip.offsetHeight-8))}px`;});
    viewport.addEventListener("mouseleave",()=>{tooltip.hidden=true;});
    box.querySelectorAll("[data-map-layer]").forEach(input=>input.addEventListener("change",()=>{layers[input.dataset.mapLayer].canvas.hidden=!input.checked;}));
    opacityRange.addEventListener("input",()=>{territoryOpacity=Number(opacityRange.value);box.querySelector("#territoryOpacityLabel").textContent=`${territoryOpacity}%`;layers.territory.canvas.style.opacity=String(territoryOpacity/100);try{localStorage.setItem(opacityKey,String(territoryOpacity));}catch{}});
    range.addEventListener("input",()=>{tooltip.hidden=true;drawTerritory();});drawTerritory();return;
  }
  if (tab === "strings") return text(`Parsed replay records: ${r.events.length} events, ${r.metrics.length} metrics, ${r.tiles.length} tiles. The replay contains binary records rather than the save payload's string/token pool.`);
}
function replayYear(h, turn) {
  const span=Math.max(1,h.endTurn-h.startTurn), y0=Number.parseInt(h.startYear,10), y1=Number.parseInt(h.endYear,10);
  return Number.isFinite(y0)&&Number.isFinite(y1)?Math.round(y0+(y1-y0)*(turn-h.startTurn)/span):"";
}
function terrainColor(id) { return ["#73863a","#92844b","#c6a65c","#76766c","#e8e7dc","#5a9997","#315167"][id]||"#a58aa8"; }
function traceReplayHex(ctx,cx,cy,radius) {
  ctx.beginPath();
  for(let side=0;side<6;side++){const angle=(Math.PI/180)*(60*side-30),x=cx+radius*Math.cos(angle),y=cy+radius*Math.sin(angle);if(side===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}
  ctx.closePath();
}
function loadReplayTerrainImages() {
  const images={};
  const names=["GRASSLAND","PLAINS","DESERT","TUNDRA","SNOW","COAST","OCEAN","MOUNTAIN","HILLS","ICE","JUNGLE","FOREST"];
  images.ready=Promise.all(names.map(name=>new Promise(resolve=>{const image=new Image();image.onload=()=>{images[name]=image;resolve();};image.onerror=resolve;image.src=`assets/terrain/${name}.png`;})));
  return images;
}
function locateReplayTile(px,py,width,height,radius,hexW) {
  const rowGuess=Math.round((py-radius)/(radius*1.5));
  for(let y=Math.max(0,rowGuess-1);y<=Math.min(height-1,rowGuess+1);y++){
    const colGuess=Math.round((px-radius)/hexW-.5*(y&1));
    for(let x=Math.max(0,colGuess-1);x<=Math.min(width-1,colGuess+1);x++){
      const cx=radius+hexW*(x+.5*(y&1)),cy=radius+radius*1.5*y,dx=Math.abs(px-cx),dy=Math.abs(py-cy);
      if(dx<=hexW/2&&dy<=radius&&dy+dx/Math.sqrt(3)<=radius)return y*width+x;
    }
  }
  return -1;
}
function replayTerrainName(id) { return ["GRASSLAND","PLAINS","DESERT","TUNDRA","SNOW","COAST","OCEAN"][id]; }
function replayElevationName(id) { return ["MOUNTAIN","HILLS"][id]; }
function replayFeatureName(id) { return ({0:"ICE",1:"JUNGLE",5:"FOREST"})[id]; }
function replayTerrainLabel(id) { return ["Grassland","Plains","Desert","Tundra","Snow","Coast","Ocean"][id]||`Terrain ${id}`; }
function replayElevationLabel(id) { return ({0:"Mountain",1:"Hills"})[id]||"Flat"; }
function replayFeatureLabel(id) { return ({0:"Ice",1:"Jungle",2:"Marsh",3:"Oasis",4:"Flood plains",5:"Forest",15:"Cerro de Potosí",17:"Atoll",18:"Sri Pada",19:"Mount Sinai"})[id]||""; }
document
  .querySelectorAll(".tabs button")
  .forEach((b) => b.addEventListener("click", () => renderTab(b.dataset.tab)));
