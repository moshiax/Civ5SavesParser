"use strict";
function showNotification(message) {
  const notification = document.getElementById("notification");
  notification.querySelector("p").innerText = message;
  notification.style.display = "block";
  notification.style.animation = "fadeIn 0.5s";
  setTimeout(() => {
    notification.style.animation = "fadeOut 0.5s";
    setTimeout(() => { notification.style.display = "none"; }, 500);
  }, 2300);
}
const playerColors = window.CIV5_PLAYER_COLORS || {};
const civilizationColors = window.CIV5_REPLAY_CIV_COLORS || {};
const replayCivAssets = window.CIV5_REPLAY_CIV_ASSETS || [];
const normalizeReplayName = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const cityStateTraits = Object.fromEntries(
  Object.entries(window.CIV5_CITY_STATE_TRAITS || {}).map(([name, trait]) => [
    normalizeReplayName(name),
    trait,
  ]),
);
const $ = (s) => document.querySelector(s);
const metricLabel = (key) => key.replace(/^(?:REPLAYDATASET|INFOADDICTDATASET)_/, "");
const cssColor = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const replayPalette = {
  player: cssColor("--color-player-default"),
  playerSecondary: cssColor("--color-player-secondary-default"),
  playerSecondaryNeutral: cssColor("--color-player-secondary-neutral"),
  replayFallback: cssColor("--color-replay-fallback"),
  unclaimedMinor: cssColor("--map-citystate-unclaimed"),
  cityMarker: cssColor("--map-city-marker"),
  cityMarkerStroke: cssColor("--map-city-marker-stroke"),
  cityMarkerDetail: cssColor("--map-city-marker-detail"),
  riverShadow: cssColor("--map-river-shadow"),
  riverWater: cssColor("--map-river-water"),
  riverHighlight: cssColor("--map-river-highlight"),
  mapGrid: cssColor("--map-grid-line"),
  terrain: [
    "--terrain-color-0", "--terrain-color-1", "--terrain-color-2",
    "--terrain-color-3", "--terrain-color-4", "--terrain-color-5",
    "--terrain-color-6",
  ].map(cssColor),
  terrainFallback: cssColor("--terrain-color-fallback"),
};
const drop = $("#dropzone"),
  input = $("#fileInput");
let current = null,
  activeTab = "summary";
let replaySectionsOwner = null;
const replaySections = new Map();
const replaySectionContents = new Map();
const replaySectionsRendered = new Set();
let replayBuildGeneration = 0;
let eventReturnScrollY = null;
let replayMapNavigator = null;
let dragDepth = 0;
const themeToggle = $("#themeToggle"),
  themePreference = window.matchMedia?.("(prefers-color-scheme: dark)");
const readThemeChoice = () => {
  try {
    return localStorage.getItem("civ5-parser-theme");
  } catch {
    return null;
  }
};
const applyTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  replayPalette.mapGrid = cssColor("--map-grid-line");
  themeToggle?.setAttribute(
    "title",
    theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
  );
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    cssColor("--theme-color"),
  );
};
const savedTheme = readThemeChoice();
applyTheme(
  savedTheme === "dark" || savedTheme === "light"
    ? savedTheme
    : themePreference?.matches
      ? "dark"
      : "light",
);
themeToggle?.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
  try {
    localStorage.setItem("civ5-parser-theme", nextTheme);
  } catch {
  }
});
themePreference?.addEventListener("change", (event) => {
  const choice = readThemeChoice();
  if (choice !== "dark" && choice !== "light")
    applyTheme(event.matches ? "dark" : "light");
});
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
  return text
    .slice(prefix.length)
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
  $("#dropHint").textContent =
    `${humanBytes(file.size)} · Reading ${isReplay ? "replay data" : "save header and compressed payload"}…`;
  setStatus(isReplay ? "Reading replay…" : "Reading save…");
  $("#result").hidden = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = isReplay
      ? parseReplay(bytes, file.name)
      : await parseSave(bytes, file.name);
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
  const decoder = new TextDecoder("utf-8"),
    found = new Map();
  const pattern = /GAMEOPTION_[A-Z0-9_]+/g;
  for (const match of decoder.decode(section).matchAll(pattern)) {
    const byteIndex = new TextEncoder().encode(
      decoder.decode(section).slice(0, match.index),
    ).length;
    if (byteIndex < 4) continue;
    const view = new DataView(
      section.buffer,
      section.byteOffset,
      section.byteLength,
    );
    const keyLength = view.getUint32(byteIndex - 4, true),
      valueAt = byteIndex + match[0].length;
    if (keyLength !== match[0].length || valueAt + 4 > section.length) continue;
    const raw = view.getInt32(valueAt, true);
    if (raw === 0 || raw === 1) found.set(match[0], Boolean(raw));
  }
  return [...found].map(([key, enabled]) => ({ key, enabled }));
}
function extractCityStates(payload) {
  if (!payload) return null;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const raw = new TextDecoder("latin1").decode(payload),
    found = new Map();
  for (const match of raw.matchAll(/TXT_KEY_CITYSTATE_([A-Z0-9_]+)/g)) {
    const start = match.index;
    if (match[1].endsWith("_ADJ") || match[1].endsWith("_DESC")) continue;
    const lengthPrefixed =
      start >= 4 && view.getUint32(start - 4, true) === match[0].length;
    const entry = found.get(match[1]) || { count: 0, lengthPrefixed: false };
    entry.count++;
    entry.lengthPrefixed ||= lengthPrefixed;
    found.set(match[1], entry);
  }
  // Some save payload records repeat valid city-state keys without the usual length prefix.
  return [...found]
    .filter(([, entry]) => entry.lengthPrefixed || entry.count > 1)
    .map(([key]) => key);
}
function parseReplay(bytes, filename) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n) => {
    if (n < 0 || at + n > bytes.length)
      throw new Error("Truncated Civ5Replay file at byte " + at);
  };
  const i32 = () => {
    need(4);
    const n = view.getInt32(at, true);
    at += 4;
    return n;
  };
  const i16 = () => {
    need(2);
    const n = view.getInt16(at, true);
    at += 2;
    return n;
  };
  const i8 = () => {
    need(1);
    return view.getInt8(at++);
  };
  const decoder = new TextDecoder("utf-8");
  const str = (n) => {
    need(n);
    const v = decoder.decode(bytes.subarray(at, at + n)).replace(/\0+$/, "");
    at += n;
    return v;
  };
  const varstr = () => {
    const n = i32();
    if (n < 0 || n > 4_000_000)
      throw new Error("Invalid Civ5Replay string size " + n);
    return str(n);
  };
  const count = (label, max = 2_000_000) => {
    const n = i32();
    if (n < 0 || n > max) throw new Error("Invalid " + label + " count: " + n);
    return n;
  };
  const array = (label, fn, max) =>
    Array.from({ length: count(label, max) }, (_, i) => fn(i));
  if (str(4) !== "CIV5") throw new Error("Invalid Civ5Replay signature.");
  const format = i32(),
    version = varstr(),
    build = varstr();
  need(5);
  at += 5;
  const playerCiv = varstr(),
    difficulty = varstr(),
    eraStart = varstr(),
    eraEnd = varstr(),
    gameSpeed = varstr(),
    worldSize = varstr(),
    mapScript = varstr();
  const dlc = array(
    "DLC",
    () => {
      need(16);
      const id = [...bytes.subarray(at, at + 16)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      at += 16;
      return { id, enabled: i32(), name: varstr() };
    },
    1000,
  );
  const mods = array(
    "mod",
    () => ({ id: varstr(), version: i32(), name: varstr() }),
    1000,
  );
  varstr();
  varstr();
  const playerColor = varstr();
  need(8);
  at += 8;
  const mapScript2 = varstr();
  const timelineAt = findReplayTimeline(bytes, view, at, decoder);
  if (timelineAt < 0)
    throw new Error("Could not locate the replay timeline block.");
  at = timelineAt;
  const startTurn = i32(),
    startYear = i32(),
    endTurn = i32(),
    endYear = varstr();
  i32();
  i32();
  const civs = array(
    "civilization",
    () => {
      const raw = [i32(), i32(), i32(), i32()];
      return {
        raw,
        leader: varstr(),
        longName: varstr(),
        name: varstr(),
        demonym: varstr(),
      };
    },
    128,
  );
  const players = civs.map((c, slot) => {
    const asset = replayCivAssets[c.raw[0]],
      civilization =
        c.raw[0] === 18
          ? "CIVILIZATION_MINOR"
          : c.raw[0] === 19
            ? "CIVILIZATION_BARBARIAN"
            : "";
    const displayCiv =
      c.name ||
      c.longName ||
      (civilization === "CIVILIZATION_MINOR" ? "Minor civilization" : "");
    const color = asset || playerColors[String(c.raw[2])] || [];
    return {
      slot,
      civilization,
      displayCiv,
      leader: c.leader,
      name: c.longName,
      shortName: c.name,
      demonym: c.demonym,
      color: color.color || color[0] || replayPalette.player,
      secondaryColor: color.secondaryColor || color[1] || replayPalette.playerSecondary,
      iconKey: asset?.icon || "",
      iconAvailable: Boolean(asset),
      raw: c.raw,
    };
  });
  const datasetKeys = array("dataset", () => varstr(), 1000);
  const datasetValues = array(
    "dataset values",
    () =>
      array(
        "civilization values",
        () =>
          array("metric value", () => ({ turn: i32(), value: i32() }), 100000),
        128,
      ),
    1000,
  );
  const metricData = datasetKeys.map((key, index) => ({
    key,
    byPlayer: datasetValues.map((player) =>
      (player[index] || []).map((sample) => ({
        ...sample,
        turn: sample.turn + startTurn,
      })),
    ),
  }));
  i32();
  const events = array(
    "event",
    () => {
      const turn = i32(),
        typeId = i32(),
        tiles = array("event tile", () => ({ x: i16(), y: i16() }), 100000),
        civId = i32(),
        text = varstr();
      return { turn, typeId, tiles, civId, text };
    },
    2_000_000,
  );
  const mapWidth = i32(),
    mapHeight = i32();
  if (mapWidth < 1 || mapHeight < 1 || mapWidth * mapHeight > 2_000_000)
    throw new Error("Invalid replay map dimensions.");
  const tiles = array(
    "map tile",
    () => {
      const junk1 = i32(),
        junk2 = i32();
      return {
        stateCount: junk1,
        stateTurn: junk2,
        plotTypeId: i8(),
        typeId: i8(),
        featureId: i8(),
        riverMask: i8(),
      };
    },
    mapWidth * mapHeight,
  );
  const typeNames = [
    "MAJOR_EVENT",
    "CITY_FOUNDED",
    "TILES_CLAIMED",
    "CITIES_TRANSFERRED",
    "CITY_RAZED",
    "RELIGION_FOUNDED",
    "PANTHEON_SELECTED",
  ];
  const parsedEvents = events.map((event) => {
    const civ =
      players[event.civId]?.shortName || civs[event.civId]?.name || "";
    const type = typeNames[event.typeId] || `EVENT_${event.typeId}`;
    const [tile] = event.tiles;
    return { ...event, civ, type, ...tile };
  });
  parsedEvents.sort((a, b) => a.turn - b.turn);
  return {
    kind: "replay",
    file: { name: filename, size: bytes.length },
    header: {
      format,
      version,
      build,
      playerCiv,
      difficulty,
      startingEra: eraStart,
      era: eraEnd,
      speed: gameSpeed,
      worldSize,
      mapScript,
      mapScript2,
      playerColor,
      startTurn,
      startYear,
      endTurn,
      endYear,
      players,
      dlc,
      mods,
    },
    replay: {
      mapWidth,
      mapHeight,
      tiles,
      events: parsedEvents,
      metrics: metricData,
    },
  };
}
function findReplayTimeline(bytes, view, start, decoder) {
  const limit = Math.min(bytes.length - 48, start + 65536);
  const readString = (offset) => {
    if (offset + 4 > bytes.length) return null;
    const n = view.getInt32(offset, true);
    if (n < 0 || n > 1024 || offset + 4 + n > bytes.length) return null;
    const value = decoder.decode(bytes.subarray(offset + 4, offset + 4 + n));
    if (value.includes("\ufffd") || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
      return null;
    return { value, next: offset + 4 + n };
  };
  for (let pos = start; pos < limit; pos++) {
    const turn = view.getInt32(pos, true),
      year = view.getInt32(pos + 4, true),
      endTurn = view.getInt32(pos + 8, true);
    if (
      turn < -1 ||
      turn > 100000 ||
      Math.abs(year) > 100000 ||
      endTurn < turn ||
      endTurn > 100000
    )
      continue;
    const endYear = readString(pos + 12);
    if (!endYear || !/\d/.test(endYear.value)) continue;
    let cursor = endYear.next + 8;
    if (cursor + 4 > bytes.length) continue;
    const civCount = view.getInt32(cursor, true);
    cursor += 4;
    if (civCount < 1 || civCount > 128) continue;
    let valid = true;
    for (let civ = 0; civ < civCount && valid; civ++) {
      if (cursor + 16 > bytes.length) {
        valid = false;
        break;
      }
      cursor += 16;
      const names = [];
      for (let field = 0; field < 4; field++) {
        const item = readString(cursor);
        if (!item) {
          valid = false;
          break;
        }
        names.push(item.value);
        cursor = item.next;
      }
      if (valid && (!names[2] || !names[3])) valid = false;
    }
    if (!valid || cursor + 4 > bytes.length) continue;
    const datasets = view.getInt32(cursor, true);
    cursor += 4;
    if (datasets < 1 || datasets > 1000) continue;
    for (let dataset = 0; dataset < datasets && valid; dataset++) {
      const item = readString(cursor);
      if (!item || !item.value) {
        valid = false;
        break;
      }
      cursor = item.next;
    }
    if (valid) return pos;
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
  $("#saveTitle").textContent =
    gameEnumLabel(h.civ, "CIVILIZATION_") || "Civ V save";
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
  $("#dlcRecords").hidden = true;
  $("#dlcRecords").innerHTML = "";
  drawPlayers(h.players || [], h.cityStates);
  renderTab(activeTab);
}
function renderReplay(d) {
  setAvailableTabs([
    "summary",
    "history",
    "events",
    "map",
    "players",
    "metadata",
  ]);
  const h = d.header,
    r = d.replay;
  const enabledDlc = h.dlc.filter((item) => item.enabled);
  $("#saveTitle").textContent =
    gameEnumLabel(h.playerCiv, "CIVILIZATION_") ||
    h.players[0]?.name ||
    "Civ V replay";
  $("#savePath").textContent = d.file.name;
  $("#turn").textContent = h.endTurn;
  $("#dimensions").textContent = `${r.mapWidth} × ${r.mapHeight}`;
  $("#playtime").textContent = `${h.startYear} → ${h.endYear}`;
  $("#payloadSize").textContent = humanBytes(d.file.size);
  const fields = [
    ["Replay version", h.version],
    ["Build", h.build],
    ["Turn range", `${h.startTurn}–${h.endTurn}`],
    ["Year range", `${h.startYear}–${h.endYear}`],
    ["Difficulty", gameEnumLabel(h.difficulty, "HANDICAP_")],
    ["Starting era", gameEnumLabel(h.startingEra, "ERA_")],
    ["Ending era", gameEnumLabel(h.era, "ERA_")],
    ["Game speed", gameEnumLabel(h.speed, "GAMESPEED_")],
    ["World size", gameEnumLabel(h.worldSize, "WORLDSIZE_")],
    ["Map script", h.mapScript],
    ["DLC", enabledDlc.length],
    ["Mods", h.mods.length],
    ["Map", `${r.mapWidth} × ${r.mapHeight} · ${r.tiles.length} tiles`],
    ["Events", r.events.length],
  ];
  $("#facts").innerHTML = fields
    .map(
      ([k, v]) =>
        `<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`,
    )
    .join("");
  renderLobbyOptions([]);
  const dlcWrap = $("#dlcRecords");
  dlcWrap.hidden = !enabledDlc.some((item) => item.name);
  dlcWrap.innerHTML = enabledDlc
    .filter((item) => item.name)
    .map((item) => `<div class="slot-group minor-civ">${esc(item.name)}</div>`)
    .join("");
  drawPlayers(h.players.map((p, i) => ({ ...p, slot: i })));
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
  const wrap = $("#lobbyOptions"),
    enabled = options.filter((option) => option.enabled);
  wrap.hidden = !enabled.length;
  wrap.innerHTML = enabled
    .map(
      (option) =>
        `<div class="lobby-option">${esc(gameEnumLabel(option.key, "GAMEOPTION_").toUpperCase())}</div>`,
    )
    .join("");
}
function drawPlayers(players, cityStates = null) {
  const wrap = $("#playerOverview"),
    isReplay = current?.kind === "replay",
    major = players.filter(
      (p) =>
        p.civilization !== "CIVILIZATION_MINOR" &&
        !(p.civilization || "").startsWith("MINOR_CIV_") &&
        p.civilization !== "CIVILIZATION_BARBARIAN",
    ),
    minor = players.filter(
      (p) =>
        p.civilization === "CIVILIZATION_MINOR" ||
        (p.civilization || "").startsWith("MINOR_CIV_"),
    ),
    barbarian = players.filter(
      (p) => p.civilization === "CIVILIZATION_BARBARIAN",
    );
  const listedCityStates =
    cityStates ??
    minor.map(
      (p) => p.displayCiv || p.shortName || p.name || "Minor civilization",
    );
  if (!players.length) {
    wrap.innerHTML =
      '<div class="map-empty">Player slots were not found in the save header.</div>';
    return;
  }
  wrap.innerHTML = `<div class="player-list">${major
    .map((p) => {
      const civ = p.civilization || "",
        label =
          civ === "CIVILIZATION_MINOR"
            ? p.displayCiv || p.shortName || p.name || "Minor"
            : civ
              ? civ.startsWith("MINOR_CIV_")
                ? civ.slice("MINOR_CIV_".length).replaceAll("_", " ")
                : gameEnumLabel(civ, "CIVILIZATION_")
              : p.displayCiv || p.shortName || p.name || "UNKNOWN CIV",
        short = label.slice(0, 2),
        playerName = p.displayCiv || p.name || label,
        steamId = steamProfileId(playerName),
        playerLabel = steamId
          ? `<a class="steam-profile" href="https://steamcommunity.com/profiles/${steamId}" target="_blank" rel="noopener noreferrer">${esc(playerName)}</a>`
          : esc(playerName),
        hue = civHue(civ || String(p.raw?.[0] ?? label)),
        civKey = p.iconKey || civ.replace(/^CIVILIZATION_/, "").toLowerCase();
      const [badgeColor, badgeSecondary] = civBadgeColors(p);
      const badgeStyle = `--civ-hue:${hue};--civ-color:${badgeColor};--civ-secondary:${badgeSecondary}`;
      const mark =
        p.iconAvailable === false || civ.startsWith("MINOR_CIV_")
          ? `<span class="civ-mark civ-mark-fallback" style="${badgeStyle}">${esc(short)}</span>`
          : `<img class="civ-mark civ-mark-image" style="${badgeStyle}" src="./assets/civ-icons/${esc(civKey)}.png" alt="${esc(label)} emblem" title="${esc(label)}"><span hidden class="civ-mark civ-mark-fallback" style="${badgeStyle}">${esc(short)}</span>`;
      const subtitle = isReplay
        ? p.leader || civ || label
        : civ || p.displayCiv || label;
      return `<div class="player-row${p.status === 3 ? " human" : ""}"><span class="player-slot">${String(p.slot).padStart(2, "0")}</span>${mark}<span class="player-info"><strong>${playerLabel}</strong><small>${esc(subtitle)}</small></span><span class="player-status">${slotStatus(p.status)}</span></div>`;
    })
    .join(
      "",
    )}</div><div class="slot-groups">${listedCityStates.length ? `<div class="slot-group">MINOR CIVILIZATIONS <b>${listedCityStates.length}</b></div>${listedCityStates.map((name) => `<div class="slot-group minor-civ">${esc(typeof name === "string" ? name : name.displayCiv || name.shortName || name.name || "Minor civilization")}</div>`).join("")}` : ""}${barbarian.length ? `<div class="slot-group">BARBARIANS <b>${barbarian.length}</b></div>` : ""}</div>`;
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
  const validColor = (value) => /^#[\da-f]{6}$/i.test(String(value || ""));
  const [civColor, civSecondary] =
    civilizationColors[player.civilization] || [];
  return [
    validColor(player.color) ? player.color : civColor || replayPalette.player,
    validColor(player.secondaryColor)
      ? player.secondaryColor
      : civSecondary || replayPalette.playerSecondaryNeutral,
  ];
}
function renderTab(tab, { navigate = false } = {}) {
  activeTab = tab;
  document
    .querySelectorAll(".tabs button")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (!current) return;
  const h = current.header,
    box = $("#tabContent");
  if (current.kind === "replay") {
    const sectionsBox = $("#tabSections"),
      fallbackCard = $("#tabContentCard");
    fallbackCard.hidden = true;
    sectionsBox.hidden = false;
    if (replaySectionsOwner !== current) {
      replaySectionsOwner = current;
      replaySections.clear();
      replaySectionContents.clear();
      replaySectionsRendered.clear();
      replayMapNavigator = null;
      eventReturnScrollY = null;
      const buildGeneration = ++replayBuildGeneration;
      sectionsBox.replaceChildren();
      const titles = {
        map: "Map history",
        history: "Turn history",
        events: "Events",
        players: "Players",
        metadata: "Metadata",
      };
      const order = ["map", "events", "history", "players", "metadata"];
      for (const name of order) {
        const button = document.querySelector(`.tabs button[data-tab="${name}"]`);
        if (!button || button.hidden) continue;
        const section = document.createElement("section");
        section.className = `card replay-section${name === "map" ? " replay-map-section wide-map" : ""}`;
        section.id = `replay-section-${name}`;
        const content = document.createElement("div");
        content.className = "raw";
        section.setAttribute("aria-label", titles[name]);
        section.append(content);
        sectionsBox.append(section);
        replaySections.set(name, section);
        replaySectionContents.set(name, content);
      }
      const renderSection = (name) => {
        if (replaySectionsRendered.has(name)) return;
        const content = replaySectionContents.get(name);
        if (!content) return;
        replaySectionsRendered.add(name);
        renderReplayTab(name, current, content);
      };
      renderSection("map");
      const buildNextSection = () => {
        if (buildGeneration !== replayBuildGeneration || replaySectionsOwner !== current) return;
        const next = order.find((name) => replaySections.has(name) && !replaySectionsRendered.has(name));
        if (!next) return;
        renderSection(next);
        if (window.requestIdleCallback)
          window.requestIdleCallback(buildNextSection, { timeout: 500 });
        else setTimeout(buildNextSection, 0);
      };
      if (window.requestIdleCallback)
        window.requestIdleCallback(buildNextSection, { timeout: 500 });
      else setTimeout(buildNextSection, 0);
    }
    if (tab !== "summary" && !replaySectionsRendered.has(tab)) {
      replaySectionsRendered.add(tab);
      const content = replaySectionContents.get(tab);
      if (content) renderReplayTab(tab, current, content);
    }
    if (navigate) {
      if (tab === "events" && eventReturnScrollY !== null) {
        const returnTo = eventReturnScrollY;
        eventReturnScrollY = null;
        window.scrollTo({ top: returnTo, behavior: "smooth" });
      } else {
        const target = tab === "summary"
          ? $("#saveTitle")
          : replaySections.get(tab);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
    return;
  }
  const sectionsBox = $("#tabSections"),
    fallbackCard = $("#tabContentCard");
  fallbackCard.hidden = true;
  sectionsBox.hidden = false;
  if (replaySectionsOwner !== current) {
    replaySectionsOwner = current;
    replaySections.clear();
    replaySectionContents.clear();
    replaySectionsRendered.clear();
    replayMapNavigator = null;
    eventReturnScrollY = null;
    replayBuildGeneration++;
    sectionsBox.replaceChildren();
    const titles = { summary: "Summary", players: "Players", metadata: "Metadata", strings: "Strings" };
    for (const name of Object.keys(titles)) {
      const button = document.querySelector(`.tabs button[data-tab="${name}"]`);
      if (!button || button.hidden) continue;
      const section = document.createElement("section");
      section.className = "card replay-section save-section";
      section.id = `save-section-${name}`;
      section.setAttribute("aria-label", titles[name]);
      const heading = document.createElement("h2");
      heading.textContent = titles[name];
      const content = document.createElement("div");
      content.className = "raw single-page-raw";
      section.append(heading, content);
      sectionsBox.append(section);
      replaySections.set(name, section);
      replaySectionContents.set(name, content);
      replaySectionsRendered.add(name);
      renderSaveTab(name, current, content);
    }
  }
  if (navigate)
    replaySections.get(tab)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderSaveTab(tab, d, box) {
  const h = d.header, p = d.payload;
  const setLines = (lines) => (box.textContent = lines.join("\n"));
  if (tab === "summary")
    setLines([
      `File: ${d.file.name}`,
      `File size: ${d.file.size} bytes`,
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
    setLines(
      [...p.tokens, ...p.strings].length
        ? [...p.tokens, ...p.strings]
        : ["No readable strings found in payload."],
    );
  if (tab === "players") {
    let minorIndex = 0;
    const playerLines = (h.players || []).map((p) => {
      const isMinor =
        p.civilization === "CIVILIZATION_MINOR" ||
        (p.civilization || "").startsWith("MINOR_CIV_");
      const cityState = isMinor ? h.cityStates?.[minorIndex++] : "";
      const civilization = isMinor
        ? cityState
          ? gameEnumLabel(`CITYSTATE_${cityState}`, "CITYSTATE_")
          : "Minor"
        : gameEnumLabel(p.civilization, "CIVILIZATION_") ||
          "(no civilization id)";
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
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x) => `<td>${x?.trustedHtml ? x.value : esc(x ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function flattenMetricValues(value, player = null, out = []) {
  if (Array.isArray(value))
    value.forEach((v, i) =>
      flattenMetricValues(v, player === null ? i : player, out),
    );
  else if (value && Number.isFinite(value.turn) && Number.isFinite(value.value))
    out.push({ ...value, player });
  return out;
}
function renderEventText(value) {
  return esc(value || "").replace(
    /\[ICON_([A-Z0-9_]+)\]/g,
    (token, name) =>
      `<img class="game-icon" src="assets/civ5-icons/ICON_${name}.png" alt="${token}" title="${name.toLowerCase()}">`,
  );
}
function renderReplayTab(tab, d, box) {
  const { header: h, replay: r } = d,
    playerByName = new Map(
      h.players.flatMap((player) =>
        [player.shortName, player.name].filter(Boolean).map((name) => [name, player]),
      ),
    );
  const text = (value) => {
    box.textContent = value;
  };
  const isCityState = (player) =>
    player?.civilization === "CIVILIZATION_MINOR" ||
    (player?.civilization || "").startsWith("MINOR_CIV_");
  const seriesColor = (player) => {
    const color = player?.secondaryColor || player?.color;
    return typeof color === "string" && /^#[\da-f]{6}$/i.test(color)
      ? color
      : replayPalette.replayFallback;
  };
  const seriesIcon = (player) => {
    if (isCityState(player)) return "./assets/civ5-icons/CIV_CS_ICON.png";
    const key = player?.iconKey || (player?.civilization || "").replace(/^CIVILIZATION_/, "").toLowerCase();
    return player?.iconAvailable !== false && /^[a-z0-9_]+$/i.test(key)
      ? `./assets/civ-icons/${key}.png`
      : "./assets/civ5-icons/CIV_CITY_ICON.png";
  };
  const cityStateTraitIcon = (player) => {
    if (!isCityState(player)) return "";
    const traits = window.CIV5_CITY_STATE_TRAITS || {};
    const names = [player?.shortName, player?.displayCiv, player?.name].filter(Boolean);
    const trait = names
      .map((name) => traits[name] || traits[name.toUpperCase().replace(/[ -]/g, "_")])
      .find(Boolean);
    if (!trait) return "";
    const iconName = trait[0] + trait.slice(1).toLowerCase();
    return `./assets/civ5-icons/${iconName}.png`;
  };
  const renderPlayerIcon = (player) => {
    const isMinor = isCityState(player), traitIcon = cityStateTraitIcon(player);
    const tint = isMinor && traitIcon
      ? `<span class="event-series-icon-tint" style="--trait-icon:url('${traitIcon}');--series-color:${seriesColor(player)}"></span>`
      : "";
    return `<span class="event-series-icon-wrap"><img class="event-series-icon" src="${traitIcon || seriesIcon(player)}" alt="">${tint}${isMinor ? `<img class="event-series-trait" src="${seriesIcon(player)}" alt="City-state icon">` : ""}</span>`;
  };
  const playerLabel = (player, index) =>
    player?.displayCiv || player?.shortName || player?.name || `Player ${index + 1}`;
  const renderEventCivilization = (name, player) =>
    player
      ? `<span class="event-civ-cell">${renderPlayerIcon(player)}<span>${esc(name || playerLabel(player, 0))}</span></span>`
      : esc(name || "");
  if (tab === "summary")
    return text(
      [
        `Replay: ${d.file.name}`,
        `Player civilization: ${gameEnumLabel(h.playerCiv, "CIVILIZATION_")}`,
        `Difficulty: ${gameEnumLabel(h.difficulty, "HANDICAP_")}`,
        `Turn range: ${h.startTurn}–${h.endTurn}`,
        `Year range: ${h.startYear}–${h.endYear}`,
        `Map: ${r.mapWidth} × ${r.mapHeight}`,
        `Players: ${h.players.length}`,
        `Replay events: ${r.events.length}`,
        `Metrics: ${r.metrics.length}`,
        ...(h.dlc.some((x) => x.enabled)
          ? [
              `DLC: ${h.dlc
                .filter((x) => x.enabled)
                .map((x) => x.name)
                .join(", ")}`,
            ]
          : []),
        ...(h.mods.length
          ? [`Mods: ${h.mods.map((x) => x.name).join(", ")}`]
          : []),
      ].join("\n"),
    );
  if (tab === "metadata") {
    const fields = [
      ["Replay version", h.version],
      ["Build", h.build],
      ["Player civilization", gameEnumLabel(h.playerCiv, "CIVILIZATION_")],
      ["Player color", h.playerColor],
      ["Difficulty", h.difficulty],
      ["Starting era", h.startingEra],
      ["Ending era", h.era],
      ["Game speed", h.speed],
      ["World size", h.worldSize],
      ["Map script", h.mapScript],
    ];
    if (h.mapScript2 && h.mapScript2 !== h.mapScript)
      fields.push(["Secondary map script", h.mapScript2]);
    const enabledDlc = h.dlc.filter((x) => x.enabled);
    if (enabledDlc.length)
      fields.push(["DLC", enabledDlc.map((x) => x.name).join("\n")]);
    if (h.mods.length)
      fields.push([
        "Mods",
        h.mods.map((x) => `${x.name} · ${x.version} · ${x.id}`).join("\n"),
      ]);
    return text(fields.map(([k, v]) => `${k}: ${v || "—"}`).join("\n"));
  }
  if (tab === "players")
    return (box.innerHTML = replayTable(
      ["#", "Civilization", "Leader", "Formal name", "Demonym"],
      h.players.map((p, i) => [
        i + 1,
        p.displayCiv || p.shortName,
        p.leader,
        p.displayCiv || p.name,
        p.demonym,
      ]),
    ));
  if (tab === "events") {
    const renderSeriesOption = ({ player, index }) => {
      const isMinor = isCityState(player), label = playerLabel(player, index);
      return `<label class="event-series-option" title="${esc(label)}">${renderPlayerIcon(player)}<span class="event-series-name"><i style="--series-color:${seriesColor(player)}"></i><span>${esc(label)}</span></span><input type="checkbox" data-series-player="${index}" ${isMinor ? "" : "checked"}></label>`;
    };
    const metrics = r.metrics.map((m) => ({
      key: m.key,
      byPlayer: m.byPlayer.map((samples) =>
        [...samples].sort((a, b) => a.turn - b.turn),
      ),
    })).filter((m) => m.byPlayer.some((samples) => samples.length));
    const chartPlayers = h.players
      .map((player, index) => ({ player, index }))
      .filter(({ index }) => metrics.some((metric) => metric.byPlayer[index]?.length));
    const sortedEvents = [...r.events].sort((a, b) => a.turn - b.turn);
    box.innerHTML = `${metrics.length ? `<section class="event-chart-card"><div class="event-chart-head"><label class="metric-picker"><select id="eventMetricSelect">${metrics.map((m, i) => `<option value="${i}">${esc(metricLabel(m.key))}</option>`).join("")}</select></label></div><div class="event-chart-layout"><aside class="event-series-panel"><div id="eventSeriesList" class="event-series-list">${chartPlayers.map(renderSeriesOption).join("")}</div></aside><div id="eventChart" class="event-chart"></div></div></section>` : ""}${replayTable(
      ["Turn", "Year", "Type", "Civilization", "Location", "Event", ""],
      sortedEvents
        .map((e) => {
          const owner = playerByName.get(e.civ);
          return [
            e.turn,
            replayYear(h, e.turn),
            e.type,
            { trustedHtml: true, value: renderEventCivilization(e.civ, owner) },
            e.x === undefined ? "" : `${e.x}, ${e.y}`,
            { trustedHtml: true, value: renderEventText(e.text) },
            "",
          ];
        }),
    )}`;
    box.querySelectorAll(".data-table tbody tr").forEach((row, index) => {
      const event = sortedEvents[index];
      if (event.x === undefined || event.y === undefined) return;
      const button = document.createElement("button");
      button.className = "event-map-button";
      button.type = "button";
      button.title = "Show event on map";
      button.setAttribute("aria-label", "Show event on map");
      button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6L13 8z"/></svg>';
      row.lastElementChild.replaceChildren(button);
      button.addEventListener("click", () => {
        const jump = { turn: event.turn, x: Number(event.x), y: Number(event.y) };
        eventReturnScrollY = window.scrollY;
        renderTab("map");
        requestAnimationFrame(() => {
          document.querySelector("#mapWorld")?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
          replayMapNavigator?.focus(jump);
        });
      });
    });
    const eventMetricSelect = box.querySelector("#eventMetricSelect"),
      eventChart = box.querySelector("#eventChart"),
      eventSeriesList = box.querySelector("#eventSeriesList");
    if (eventMetricSelect && eventChart) {
      const enabledPlayers = new Set(
        chartPlayers.filter(({ player }) => !isCityState(player)).map(({ index }) => index),
      );
      const drawEventChart = () => {
        const metric = metrics[Number(eventMetricSelect.value)],
          width = 900, height = 360, pad = { left: 54, right: 55, top: 20, bottom: 38 },
          visible = metric.byPlayer
            .map((samples, player) => ({ samples, player }))
            .filter(({ samples, player }) => samples.length && enabledPlayers.has(player)),
          points = visible.flatMap(({ samples }) => samples),
          minTurn = h.startTurn, maxTurn = Math.max(minTurn + 1, h.endTurn),
          minValue = Math.min(0, ...points.map((point) => point.value)),
          maxValue = Math.max(1, ...points.map((point) => point.value)),
          x = (turn) => pad.left + (turn - minTurn) / (maxTurn - minTurn) * (width - pad.left - pad.right),
          y = (value) => height - pad.bottom - (value - minValue) / (maxValue - minValue || 1) * (height - pad.top - pad.bottom),
          yTicks = [0, .25, .5, .75, 1].map((t) => minValue + (maxValue - minValue) * t),
          lines = visible.map(({ samples, player }) => {
            return `<path class="event-series-line" style="--series-color:${seriesColor(h.players[player])}" d="${samples.map((point, i) => `${i ? "L" : "M"}${x(point.turn).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ")}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>${esc(h.players[player]?.displayCiv || h.players[player]?.shortName || `Player ${player + 1}`)}</title></path>`;
          }).join(""),
          ticks = yTicks.map((value) => {
            const yy = y(value);
            return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}" class="chart-gridline"/><text x="${width - pad.right + 9}" y="${yy + 4}" class="chart-axis-label">${Math.round(value).toLocaleString()}</text>`;
          }).join("");
        eventChart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img"><rect class="chart-plot-bg" x="1" y="1" width="${width - 2}" height="${height - 2}"/>${ticks}<line x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}" class="chart-axis"/><text x="${pad.left}" y="${height - 10}" class="chart-axis-label">${esc(replayYear(h, minTurn))}</text><text x="${width - pad.right}" y="${height - 10}" text-anchor="end" class="chart-axis-label">${esc(replayYear(h, maxTurn))}</text>${lines}</svg>${visible.length ? "" : '<div class="event-chart-empty">Select a civilization</div>'}`;
        const svg = eventChart.querySelector("svg");
        if (!svg) return;
        const tip = document.createElement("div");
        tip.className = "event-chart-tooltip";
        tip.hidden = true;
        eventChart.append(tip);
        const nearestSample = (samples, turn) => {
          let low = 0, high = samples.length;
          while (low < high) {
            const middle = (low + high) >> 1;
            if (samples[middle].turn < turn) low = middle + 1;
            else high = middle;
          }
          const before = samples[Math.max(0, low - 1)], after = samples[Math.min(samples.length - 1, low)];
          return !before ? after : !after || turn - before.turn <= after.turn - turn ? before : after;
        };
        svg.addEventListener("pointermove", (event) => {
          const rect = svg.getBoundingClientRect(),
            plotX = (event.clientX - rect.left) * width / rect.width;
          if (plotX < pad.left || plotX > width - pad.right || !visible.length) {
            tip.hidden = true;
            return;
          }
          const turn = Math.round(minTurn + (plotX - pad.left) / (width - pad.left - pad.right) * (maxTurn - minTurn)),
            rows = visible.map(({ samples, player }) => ({ samples, player, point: nearestSample(samples, turn) })),
            chartRect = eventChart.getBoundingClientRect();
          tip.innerHTML = `<b>Turn ${turn} · ${esc(replayYear(h, turn))}</b>${rows.map(({ player, point }) => `<span><i style="--series-color:${seriesColor(h.players[player])}"></i>${esc(playerLabel(h.players[player], player))}: ${point.value.toLocaleString()}</span>`).join("")}`;
          tip.hidden = false;
          tip.style.left = `${Math.max(8, Math.min(event.clientX - chartRect.left + 12, eventChart.clientWidth - tip.offsetWidth - 8))}px`;
          tip.style.top = `${Math.max(8, Math.min(event.clientY - chartRect.top + 12, eventChart.clientHeight - tip.offsetHeight - 8))}px`;
        });
        svg.addEventListener("pointerleave", () => { tip.hidden = true; });
      };
      eventMetricSelect.addEventListener("change", drawEventChart);
      eventSeriesList?.querySelectorAll("[data-series-player]").forEach((input) =>
        input.addEventListener("change", () => {
          const player = Number(input.dataset.seriesPlayer);
          if (input.checked) enabledPlayers.add(player);
          else enabledPlayers.delete(player);
          drawEventChart();
        }),
      );
      drawEventChart();
    }
    box
      .querySelectorAll(".game-icon")
      .forEach((icon) =>
        icon.addEventListener(
          "error",
          () => icon.replaceWith(document.createTextNode(icon.alt)),
          { once: true },
        ),
      );
    return;
  }
  if (tab === "history") {
    const metrics = r.metrics.map((m) => ({
      key: m.key,
      rows: flattenMetricValues(m.byPlayer).filter((row) => row.value !== 0),
    }));
    const usable = metrics.filter((m) => m.rows.length);
    if (!usable.length)
      return text("This replay contains no turn metric samples.");
    box.innerHTML = `<label class="metric-picker">Metric <select id="metricSelect">${usable.map((m, i) => `<option value="${i}">${esc(metricLabel(m.key))}</option>`).join("")}</select></label><div id="metricRows"></div>`;
    const select = box.querySelector("#metricSelect"),
      target = box.querySelector("#metricRows");
    const draw = () => {
      const rows = usable[Number(select.value)].rows.sort(
        (a, b) => a.turn - b.turn || a.player - b.player,
      );
      target.innerHTML = replayTable(
        ["Turn", "Year", "Civilization", "Value"],
        rows
          .slice(0, 3000)
          .map((x) => [
            x.turn,
            replayYear(h, x.turn),
            { trustedHtml: true, value: renderEventCivilization(playerLabel(h.players[x.player], x.player), h.players[x.player]) },
            x.value,
          ]),
      );
    };
    select.addEventListener("change", draw);
    draw();
    return;
  }
  if (tab === "map") {
    const mapCard = box.closest(".card"),
      contentGrid = document.querySelector(".content-grid"),
      page = document.querySelector(".page"),
      pageStyle = page && getComputedStyle(page),
      pageContentWidth = page
        ? page.clientWidth -
          (Number.parseFloat(pageStyle.paddingLeft) || 0) -
          (Number.parseFloat(pageStyle.paddingRight) || 0)
        : 0,
      contentGridWidth =
        contentGrid?.getBoundingClientRect().width || pageContentWidth || mapCard.clientWidth,
      mapInnerMinWidth = Math.max(1, contentGridWidth - 36),
      radius = Math.max(9, mapInnerMinWidth / (2 + Math.sqrt(3) * r.mapWidth)),
      hexW = Math.sqrt(3) * radius,
      canvasWidth = Math.ceil(radius * 2 + hexW * r.mapWidth),
      canvasHeight = Math.ceil(radius * 2 + radius * 1.5 * (r.mapHeight - 1));
    const initialMapTurn = Math.max(
      h.startTurn,
      Math.min(1, Math.max(h.startTurn, h.endTurn)),
    );
    const canvasY = (row) => canvasHeight - radius - radius * 1.5 * row;
    const territoryTiles = r.tiles.map((_, i) => {
      const x = i % r.mapWidth,
        y = Math.floor(i / r.mapWidth),
        cx = radius + hexW * (x + 0.5 * (y & 1)),
        cy = canvasY(y),
        neighbors = y & 1
          ? [[x + 1, y, 0], [x + 1, y + 1, 5], [x, y + 1, 4], [x - 1, y, 3], [x, y - 1, 2], [x + 1, y - 1, 1]]
          : [[x + 1, y, 0], [x, y + 1, 5], [x - 1, y + 1, 4], [x - 1, y, 3], [x - 1, y - 1, 2], [x, y - 1, 1]];
      return { x, y, key: `${x},${y}`, cx, cy, neighbors };
    });
    mapCard.style.width = `min(${Math.max(contentGridWidth, canvasWidth + 36)}px,calc(100vw - 24px))`;
    mapCard.dataset.mapWidth = mapCard.style.width;
    mapCard.style.boxSizing = "border-box";
    const terrainLegend = [
      ["GRASSLAND", "Grassland"],
      ["PLAINS", "Plains"],
      ["DESERT", "Desert"],
      ["TUNDRA", "Tundra"],
      ["SNOW", "Snow"],
      ["COAST", "Coast"],
      ["OCEAN", "Ocean"],
    ];
    const opacityKey = "civ5ReplayTerritoryOpacity";
    let initialTerritoryOpacity = 55;
    try {
      const stored = Number(localStorage.getItem(opacityKey));
      if (localStorage.getItem(opacityKey) !== null && Number.isFinite(stored))
        initialTerritoryOpacity = Math.max(0, Math.min(100, stored));
    } catch {}
    box.innerHTML = `<div class="map-timeline"><button id="mapPlayToggle" class="map-play-toggle" type="button" title="Play map history"><svg class="play-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg><svg class="pause-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h4v12H3zm6 0h4v12H9z"/></svg></button><label class="metric-picker">Turn <input id="mapTurn" type="range" min="${h.startTurn}" max="${Math.max(h.startTurn, h.endTurn)}" value="${initialMapTurn}"><b id="mapTurnLabel">${initialMapTurn}</b></label><button id="mapExport" class="map-export-button" type="button">Render video</button><span id="mapExportStatus" role="status" aria-live="polite"></span></div><div class="replay-map-wrap"><div id="mapWorld" class="map-world" style="width:max(${canvasWidth}px,100%);aspect-ratio:${canvasWidth}/${canvasHeight}"><canvas class="map-layer-canvas" data-map-layer="terrain" width="${canvasWidth}" height="${canvasHeight}"></canvas><canvas class="map-layer-canvas" data-map-layer="elevation" width="${canvasWidth}" height="${canvasHeight}"></canvas><canvas class="map-layer-canvas" data-map-layer="features" width="${canvasWidth}" height="${canvasHeight}"></canvas><canvas class="map-layer-canvas" data-map-layer="grid" width="${canvasWidth}" height="${canvasHeight}"></canvas><canvas class="map-layer-canvas" data-map-layer="territory" width="${canvasWidth}" height="${canvasHeight}"></div><div id="mapTileTooltip" class="map-tile-tooltip" hidden></div><div class="map-zoom-controls"><button type="button" data-zoom="out">−</button><button type="button" data-zoom="reset">100%</button><button type="button" data-zoom="in">+</button></div></div><div class="map-layer-controls"><span>Layers</span>${[
      ["terrain", "Terrain"],
      ["elevation", "Elevation"],
      ["features", "Features"],
      ["territory", "Territory"],
      ["grid", "Grid"],
    ]
      .map(
        ([key, label]) =>
          `<label><input type="checkbox" data-map-layer="${key}" checked>${label}</label>`,
      )
      .join(
        "",
      )}</div><label class="metric-picker map-opacity-control">Territory overlay <input id="territoryOpacity" type="range" min="0" max="100" value="${initialTerritoryOpacity}"><b id="territoryOpacityLabel">${initialTerritoryOpacity}%</b></label><div class="map-legend" style="width:max(${canvasWidth}px,100%);max-width:100%;margin-inline:auto">${terrainLegend.map(([asset, name]) => `<span><i style="background-image:url('assets/terrain/${asset}.png')"></i>${name}</span>`).join("")}${h.players.map((p) => `<span><i style="background:${p.secondaryColor || p.color}"></i>${esc(p.displayCiv || p.shortName)}</span>`).join("")}</div>`;
    const world = box.querySelector("#mapWorld"),
      viewport = world.parentElement,
      range = box.querySelector("#mapTurn"),
      playToggle = box.querySelector("#mapPlayToggle"),
      exportButton = box.querySelector("#mapExport"),
      exportStatus = box.querySelector("#mapExportStatus"),
      opacityRange = box.querySelector("#territoryOpacity"),
      tooltip = box.querySelector("#mapTileTooltip"),
      zoomReadout = box.querySelector('[data-zoom="reset"]'),
      layers = Object.fromEntries(
        [...box.querySelectorAll(".map-layer-canvas")].map((canvas) => [
          canvas.dataset.mapLayer,
          { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }) },
        ]),
      );
    const renderScale = Math.min(
      2,
      Math.max(
        1,
        Math.sqrt(
          32_000_000 /
            (canvasWidth * canvasHeight * Object.keys(layers).length),
        ),
      ),
    );
    const riverCanvas = document.createElement("canvas");
    riverCanvas.className = "map-layer-canvas";
    riverCanvas.dataset.mapLayer = "rivers";
    world.insertBefore(riverCanvas, layers.territory.canvas);
    const riverCtx = riverCanvas.getContext("2d");
    layers.rivers = { canvas: riverCanvas, ctx: riverCtx };
    const layerControls = box.querySelector(".map-layer-controls");
    if (layerControls) {
      const riverLabel = document.createElement("label");
      riverLabel.innerHTML = '<input type="checkbox" data-map-layer="rivers" checked>Rivers';
      layerControls.append(riverLabel);
    }
    for (const { canvas, ctx } of Object.values(layers)) {
      canvas.width = Math.max(1, Math.round(canvasWidth * renderScale));
      canvas.height = Math.max(1, Math.round(canvasHeight * renderScale));
      ctx.scale(renderScale, renderScale);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
    const replayPlayers = new Map();
    for (const player of h.players) {
      if (player.shortName) replayPlayers.set(player.shortName, player);
      if (player.name) replayPlayers.set(player.name, player);
    }
    const applyMapEvent = (e, owners, cities) => {
      if (e.type === "CITY_FOUNDED" && e.x !== undefined) {
        const key = `${e.x},${e.y}`;
        owners.set(key, e.civ || "");
        cities.set(key, { x: Number(e.x), y: Number(e.y), owner: e.civ || "", eventText: e.text || "" });
      } else if (e.type === "CITY_RAZED") {
        for (const tile of e.tiles) cities.delete(`${tile.x},${tile.y}`);
      } else if (e.type === "CITIES_TRANSFERRED") {
        for (const tile of e.tiles) {
          owners.set(`${tile.x},${tile.y}`, e.civ || "");
          const city = cities.get(`${tile.x},${tile.y}`);
          if (city) city.owner = e.civ || "";
        }
      } else if (e.type === "TILES_CLAIMED") {
        for (const tile of e.tiles) owners.set(`${tile.x},${tile.y}`, e.civ || "");
      }
    };
    let territoryOpacity = Number(opacityRange.value),
      currentOwners = new Map(),
      currentCities = new Map(),
      focusTileKey = null,
      focusTimer = 0,
      focusFrame = 0,
      focusStartedAt = 0,
      zoom = 1,
      panX = 0,
      panY = 0,
      drag = null,
      pointers = new Map(),
      pinch = null;
    layers.territory.canvas.style.opacity = String(territoryOpacity / 100);
    const clampPan = () => {
      const baseX = Math.max(0, (viewport.clientWidth - world.clientWidth) / 2),
        scaledWidth = world.clientWidth * zoom,
        scaledHeight = world.clientHeight * zoom;
      if (scaledWidth <= viewport.clientWidth)
        panX = (viewport.clientWidth - scaledWidth) / 2 - baseX;
      else
        panX = Math.max(viewport.clientWidth - baseX - scaledWidth, Math.min(-baseX, panX));
      if (scaledHeight <= viewport.clientHeight) panY = 0;
      else panY = Math.max(viewport.clientHeight - scaledHeight, Math.min(0, panY));
    };
    const applyZoom = () => {
      clampPan();
      world.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
      zoomReadout.textContent = `${Math.round(zoom * 100)}%`;
    };
    const setZoomAt = (nextZoom, x, y, fixedMapX = null, fixedMapY = null) => {
      const baseX = Math.max(0, (viewport.clientWidth - world.clientWidth) / 2),
        mapX = fixedMapX ?? (x - baseX - panX) / zoom,
        mapY = fixedMapY ?? (y - panY) / zoom,
        next = Math.max(1, Math.min(5, nextZoom));
      zoom = next;
      panX = x - baseX - mapX * zoom;
      panY = y - mapY * zoom;
      applyZoom();
    };
    replayMapNavigator = {
      focus: ({ turn, x, y }) => {
        range.value = String(Math.max(Number(range.min), Math.min(Number(range.max), turn)));
        range.dispatchEvent(new Event("input", { bubbles: true }));
        clearTimeout(focusTimer);
        cancelAnimationFrame(focusFrame);
        focusFrame = 0;
        focusTileKey = null;
        const tile = territoryTiles[y * r.mapWidth + x];
        if (!tile) {
          zoom = 1;
          panX = panY = 0;
          applyZoom();
          tooltip.hidden = true;
          drawTerritory();
          return;
        }
        focusTileKey = `${x},${y}`;
        focusStartedAt = performance.now();
        tooltip.hidden = true;
        const animateFocus = () => {
          if (!focusTileKey || !box.contains(world)) return;
          drawTerritory();
          focusFrame = requestAnimationFrame(animateFocus);
        };
        focusFrame = requestAnimationFrame(animateFocus);
        focusTimer = setTimeout(() => {
          focusTileKey = null;
          cancelAnimationFrame(focusFrame);
          focusFrame = 0;
          if (box.contains(world)) drawTerritory();
        }, 3000);
        const mapX = tile.cx * world.clientWidth / canvasWidth,
          mapY = tile.cy * world.clientHeight / canvasHeight;
        setZoomAt(2, viewport.clientWidth / 2, viewport.clientHeight / 2, mapX, mapY);
      },
    };
    const zoomBy = (factor, x, y) => setZoomAt(zoom * factor, x, y);
    box.querySelectorAll(".map-zoom-controls button").forEach((button) =>
      button.addEventListener("click", () => {
        if (button.dataset.zoom === "reset") {
          zoom = 1;
          panX = panY = 0;
          applyZoom();
          return;
        }
        zoomBy(
          button.dataset.zoom === "in" ? 1.2 : 1 / 1.2,
          viewport.clientWidth / 2,
          viewport.clientHeight / 2,
        );
      }),
    );
    viewport.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = viewport.getBoundingClientRect(),
          factor = Math.exp(-event.deltaY * 0.0012);
        zoomBy(factor, event.clientX - rect.left, event.clientY - rect.top);
      },
      { passive: false },
    );
    viewport.addEventListener("dblclick", (event) => {
      if (event.target.closest(".map-zoom-controls")) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomBy(1.5, event.clientX - rect.left, event.clientY - rect.top);
    });
    viewport.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".map-zoom-controls")) return;
      viewport.setPointerCapture(event.pointerId);
      const rect = viewport.getBoundingClientRect(),
        point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      pointers.set(event.pointerId, point);
      if (pointers.size === 1) drag = { point, panX, panY };
      else if (pointers.size === 2) {
        const pts = [...pointers.values()],
          dx = pts[0].x - pts[1].x,
          dy = pts[0].y - pts[1].y,
          center = {
            x: (pts[0].x + pts[1].x) / 2,
            y: (pts[0].y + pts[1].y) / 2,
          },
          baseX = Math.max(0, (viewport.clientWidth - world.clientWidth) / 2);
        pinch = {
          distance: Math.hypot(dx, dy),
          zoom,
          mapX: (center.x - baseX - panX) / zoom,
          mapY: (center.y - panY) / zoom,
        };
      }
      viewport.classList.add("is-panning");
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      const rect = viewport.getBoundingClientRect();
      pointers.set(event.pointerId, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
      if (pointers.size >= 2 && pinch) {
        const pts = [...pointers.values()],
          dx = pts[0].x - pts[1].x,
          dy = pts[0].y - pts[1].y,
          center = {
            x: (pts[0].x + pts[1].x) / 2,
            y: (pts[0].y + pts[1].y) / 2,
          },
          baseX = Math.max(0, (viewport.clientWidth - world.clientWidth) / 2);
        zoom = Math.max(
          1,
          Math.min(
            5,
            (pinch.zoom * Math.hypot(dx, dy)) / Math.max(1, pinch.distance),
          ),
        );
        panX = center.x - baseX - pinch.mapX * zoom;
        panY = center.y - pinch.mapY * zoom;
        applyZoom();
      } else if (drag) {
        panX = drag.panX + (pointers.get(event.pointerId).x - drag.point.x);
        panY = drag.panY + (pointers.get(event.pointerId).y - drag.point.y);
        applyZoom();
      }
    });
    const endPan = (event) => {
      pointers.delete(event.pointerId);
      pinch = null;
      if (pointers.size === 1) {
        const [point] = pointers.values();
        drag = { point, panX, panY };
      } else {
        drag = null;
        viewport.classList.remove("is-panning");
      }
    };
    viewport.addEventListener("pointerup", endPan);
    viewport.addEventListener("pointercancel", endPan);
    viewport.addEventListener("lostpointercapture", endPan);
    const drawStaticLayers = () => {
      for (const layer of ["terrain", "elevation", "features", "grid", "rivers"])
        layers[layer].ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      const riverPattern = terrainImages.COAST?.complete && terrainImages.COAST.naturalWidth
        ? layers.rivers.ctx.createPattern(terrainImages.COAST, "repeat")
        : null;
      riverPattern?.setTransform?.(new DOMMatrix().scale(0.22));
      r.tiles.forEach((tile, i) => {
        const x = i % r.mapWidth,
          y = Math.floor(i / r.mapWidth),
          cx = radius + hexW * (x + 0.5 * (y & 1)),
          cy = canvasY(y),
          left = cx - hexW / 2,
          top = cy - radius;
        traceReplayHex(layers.terrain.ctx, cx, cy, radius);
        layers.terrain.ctx.save();
        layers.terrain.ctx.clip();
        const base = terrainImages[replayTerrainName(tile.typeId)];
        if (base)
          layers.terrain.ctx.drawImage(base, left, top, hexW, radius * 2);
        else {
          layers.terrain.ctx.fillStyle = terrainColor(tile.typeId);
          layers.terrain.ctx.fill();
        }
        layers.terrain.ctx.restore();
        for (const [layer, name] of [
          ["elevation", replayElevationName(tile.plotTypeId)],
          ["features", replayFeatureName(tile.featureId)],
        ]) {
          const image = terrainImages[name];
          if (!image) continue;
          const ctx = layers[layer].ctx;
          traceReplayHex(ctx, cx, cy, radius);
          ctx.save();
          ctx.clip();
          ctx.drawImage(image, left, top, hexW, radius * 2);
          ctx.restore();
        }
        drawReplayRiver(
          layers.rivers.ctx,
          cx,
          cy,
          radius,
          tile.riverMask,
          riverPattern,
        );
        traceReplayHex(layers.grid.ctx, cx, cy, radius);
        layers.grid.ctx.strokeStyle = replayPalette.mapGrid;
        layers.grid.ctx.lineWidth = 0.5;
        layers.grid.ctx.stroke();
      });
    };
    const terrainImages = loadReplayTerrainImages();
    const cityIcons = loadReplayCityIcons();
    drawStaticLayers();
    terrainImages.ready.then(() => {
      if (box.contains(world)) drawStaticLayers();
    });
    viewport.addEventListener("dragstart", (event) => event.preventDefault());
    const drawTerritory = (state) => {
      const ctx = layers.territory.ctx;
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      const owners = state?.owners || new Map(),
        cities = state?.cities || new Map(),
        turn = Number(range.value);
      if (!state) {
        for (const e of r.events) {
          if (e.turn > turn) break;
          applyMapEvent(e, owners, cities);
        }
      }
      currentOwners = owners;
      currentCities = cities;
      territoryTiles.forEach(({ key, cx, cy }) => {
        const owner = owners.get(key),
          player = replayPlayers.get(owner);
        if (!player && key !== focusTileKey) return;
        traceReplayHex(ctx, cx, cy, radius);
        const city = cities.get(key),
          isCityState =
            player?.civilization === "CIVILIZATION_MINOR" ||
            (player?.civilization || "").startsWith("MINOR_CIV_"),
          isMajorCity =
            city &&
            !isCityState &&
            player.civilization !== "CIVILIZATION_BARBARIAN";
        const cityColor = player?.secondaryColor || player?.color;
        ctx.fillStyle = !player
          ? "rgba(255, 205, 54, .5)"
          : isCityState
            ? city
              ? cityColor
              : replayPalette.unclaimedMinor
            : isMajorCity
              ? player.color
              : cityColor;
        ctx.fill();
      });
      territoryTiles.forEach(({ key, cx, cy, neighbors }) => {
        const owner = owners.get(key);
        if (!owner) return;
        const player = replayPlayers.get(owner);
        if (!player) return;
        const isCityState =
            player.civilization === "CIVILIZATION_MINOR" ||
            (player.civilization || "").startsWith("MINOR_CIV_"),
          borderColor = isCityState
            ? player.secondaryColor || player.color
            : player.color;
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1.5;
        for (const [neighborX, neighborY, side] of neighbors) {
          const neighborOwner = owners.get(`${neighborX},${neighborY}`);
          if (neighborOwner === owner) continue;
          if (neighborOwner) {
            ctx.save();
            traceReplayHex(ctx, cx, cy, radius);
            ctx.clip();
            traceReplayHexEdge(ctx, cx, cy, radius, side);
            ctx.stroke();
            ctx.restore();
          } else {
            traceReplayHexEdge(ctx, cx, cy, radius, side);
            ctx.stroke();
          }
        }
      });
      for (const city of cities.values()) {
        const cx = radius + hexW * (city.x + 0.5 * (city.y & 1)),
          cy = canvasY(city.y),
          player = replayPlayers.get(city.owner);
        if (
          player?.civilization === "CIVILIZATION_MINOR" ||
          (player?.civilization || "").startsWith("MINOR_CIV_")
        ) {
          const trait = cityStateTraits[normalizeReplayName(city.owner)],
            traitImage = trait ? cityIcons[trait] : null;
          if (traitImage)
            ctx.drawImage(traitImage, cx - 7, cy - 7, 14, 14);
          if (cityIcons.CIV_CS_ICON)
            ctx.drawImage(cityIcons.CIV_CS_ICON, cx + 1, cy + 1, 6, 6);
        } else {
          if (cityIcons.CIV_CITY_ICON) {
            const iconSize = Math.min(hexW, radius * 2);
            traceReplayHex(ctx, cx, cy, radius);
            ctx.save();
            ctx.clip();
            ctx.globalAlpha = 0.7;
            ctx.drawImage(
              cityIcons.CIV_CITY_ICON,
              cx - iconSize / 2,
              cy - iconSize / 2,
              iconSize,
              iconSize,
            );
            ctx.restore();
          } else {
            ctx.beginPath();
            ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
            ctx.fillStyle = player?.color || replayPalette.cityMarker;
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = replayPalette.cityMarkerStroke;
            ctx.stroke();
            ctx.fillStyle = replayPalette.cityMarkerDetail;
            ctx.fillRect(cx - 2, cy - 1.5, 4, 4);
            ctx.fillRect(cx - 3.5, cy + 1, 7, 1.5);
          }
        }
      }
      if (focusTileKey) {
        const [focusX, focusY] = focusTileKey.split(",").map(Number),
          focusTile = territoryTiles[focusY * r.mapWidth + focusX];
        if (focusTile) {
          const elapsed = performance.now() - focusStartedAt,
            progress = Math.min(1, elapsed / 3000),
            envelope = Math.sin(Math.PI * progress),
            pulse = (Math.sin(elapsed / 170) + 1) / 2;
          ctx.save();
          traceReplayHex(ctx, focusTile.cx, focusTile.cy, radius);
          ctx.shadowColor = `rgba(255, 205, 82, ${(0.7 + pulse * 0.3) * envelope})`;
          ctx.shadowBlur = radius * (1.5 + pulse * 1.5) * envelope;
          ctx.fillStyle = `rgba(255, 205, 82, ${(0.2 + pulse * 0.2) * envelope})`;
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.lineWidth = 1.25 + pulse * 0.75;
          ctx.strokeStyle = `rgba(255, 242, 195, ${(0.75 + pulse * 0.25) * envelope})`;
          ctx.stroke();
          ctx.restore();
        }
      }
      box.querySelector("#mapTurnLabel").textContent = turn;
    };
    viewport.addEventListener("mousemove", (event) => {
      const rect = world.getBoundingClientRect(),
        px = ((event.clientX - rect.left) * canvasWidth) / rect.width,
        py = canvasHeight - ((event.clientY - rect.top) * canvasHeight) / rect.height,
        tileIndex = locateReplayTile(
          px,
          py,
          r.mapWidth,
          r.mapHeight,
          radius,
          hexW,
        ),
        tile = tileIndex < 0 ? null : r.tiles[tileIndex];
      if (!tile) {
        tooltip.hidden = true;
        return;
      }
      const x = tileIndex % r.mapWidth,
        y = Math.floor(tileIndex / r.mapWidth),
        owner = currentOwners.get(`${x},${y}`),
        city = currentCities.get(`${x},${y}`),
        player = replayPlayers.get(owner),
        details = [
          `Tile ${x + 1}, ${y + 1}`,
          replayTerrainLabel(tile.typeId),
          replayElevationLabel(tile.plotTypeId),
          replayFeatureLabel(tile.featureId),
          replayRiverLabel(tile.riverMask),
          player ? player.displayCiv || player.shortName : owner || "Unclaimed",
          city?.eventText || "",
        ],
        viewportRect = viewport.getBoundingClientRect();
      tooltip.textContent = details.filter(Boolean).join(" · ");
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(8, Math.min(event.clientX - viewportRect.left + 14, viewport.clientWidth - tooltip.offsetWidth - 8))}px`;
      tooltip.style.top = `${Math.max(8, Math.min(event.clientY - viewportRect.top + 14, viewport.clientHeight - tooltip.offsetHeight - 8))}px`;
    });
    viewport.addEventListener("mouseleave", () => {
      tooltip.hidden = true;
    });
    box.querySelectorAll("[data-map-layer]").forEach((input) =>
      input.addEventListener("change", () => {
        layers[input.dataset.mapLayer].canvas.hidden = !input.checked;
      }),
    );
    opacityRange.addEventListener("input", () => {
      territoryOpacity = Number(opacityRange.value);
      box.querySelector("#territoryOpacityLabel").textContent =
        `${territoryOpacity}%`;
      layers.territory.canvas.style.opacity = String(territoryOpacity / 100);
      try {
        localStorage.setItem(opacityKey, String(territoryOpacity));
      } catch {}
    });
    range.addEventListener("input", () => {
      tooltip.hidden = true;
      drawTerritory();
    });
    let playbackTimer = 0;
    const setPlaying = (playing) => {
      clearInterval(playbackTimer);
      playToggle.classList.toggle("is-playing", playing);
      playToggle.title = playing ? "Pause map history" : "Play map history";
      if (playing) playbackTimer = setInterval(() => {
        if (Number(range.value) >= Number(range.max)) return setPlaying(false);
        range.value = String(Number(range.value) + 1);
        range.dispatchEvent(new Event("input", { bubbles: true }));
      }, 250);
    };
    playToggle.addEventListener("click", () => setPlaying(!playToggle.classList.contains("is-playing")));
    range.addEventListener("input", () => {
      if (Number(range.value) >= Number(range.max)) setPlaying(false);
    });
    const exportDialog = document.createElement("dialog");
    const exportSourceCanvas = Object.values(layers)[0].canvas;
    exportDialog.className = "map-export-dialog";
    exportDialog.innerHTML = `<form class="map-export-form"><div class="map-export-heading"><h3>Video export settings</h3><button class="map-export-close" type="button">×</button></div><label>Duration per turn <span><input name="frameDuration" type="range" min="50" max="1000" step="50" value="250"><b data-value="frameDuration">250 ms</b></span></label><label>Bitrate <span><input name="bitrate" type="range" min="500000" max="12000000" step="250000" value="2500000"><b data-value="bitrate">2.5 Mbps</b></span></label><label>Maximum width <select name="maxWidth"><option value="0">Original</option><option value="2560">2560 px</option><option value="1920">1920 px</option><option value="1280">1280 px</option></select></label><label>Codec <select name="codec"><option value="auto">Automatic (VP9 preferred)</option><option value="vp9">VP9</option><option value="vp8">VP8</option></select></label><div class="map-export-estimate"><span>Frame rate</span><b data-estimate="fps">4 fps</b><span>Output resolution</span><b data-estimate="resolution">—</b><span>Video duration</span><b data-estimate="duration">—</b></div><div class="map-export-actions"><button type="button" data-action="cancel">Cancel</button><button type="submit">Render &amp; download</button></div></form>`;
    box.append(exportDialog);
    const exportForm = exportDialog.querySelector("form"),
      frameDurationInput = exportForm.elements.frameDuration,
      bitrateInput = exportForm.elements.bitrate,
      maxWidthInput = exportForm.elements.maxWidth,
      exportDimensions = (maxWidth) => {
        const widthLimit = Number(maxWidth) || exportSourceCanvas.width,
          width = Math.max(2, Math.min(exportSourceCanvas.width, widthLimit) - Math.min(exportSourceCanvas.width, widthLimit) % 2);
        return { width, height: Math.max(2, Math.round(exportSourceCanvas.height * width / exportSourceCanvas.width / 2) * 2) };
      },
      composeExportBackground = (canvas, context, layers) => {
        context.fillStyle = cssColor("--surface") || "#fffdf8";
        context.fillRect(0, 0, canvas.width, canvas.height);
        for (const layer of layers) {
          if (layer.dataset.mapLayer !== "territory")
            context.drawImage(layer, 0, 0, canvas.width, canvas.height);
        }
      },
      composeExportFrame = (output, context, background, territoryLayer) => {
        context.drawImage(background, 0, 0);
        if (!territoryLayer.hidden) {
          context.globalAlpha = territoryOpacity / 100;
          context.drawImage(territoryLayer, 0, 0, output.width, output.height);
        }
        context.globalAlpha = 1;
      },
      updateExportEstimate = () => {
        const turns = Number(h.endTurn) - Number(h.startTurn) + 1,
          durationMs = turns * Number(frameDurationInput.value),
          { width, height } = exportDimensions(maxWidthInput.value),
          minutes = Math.floor(durationMs / 60_000),
          seconds = Math.floor(durationMs / 1_000) % 60;
        exportDialog.querySelector('[data-value="frameDuration"]').textContent = `${frameDurationInput.value} ms`;
        exportDialog.querySelector('[data-value="bitrate"]').textContent = `${(Number(bitrateInput.value) / 1_000_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} Mbps`;
        exportDialog.querySelector('[data-estimate="fps"]').textContent = `${(1000 / Number(frameDurationInput.value)).toFixed(0)} fps`;
        exportDialog.querySelector('[data-estimate="resolution"]').textContent = `${width} × ${height}`;
        exportDialog.querySelector('[data-estimate="duration"]').textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
      };
    frameDurationInput.addEventListener("input", updateExportEstimate);
    bitrateInput.addEventListener("input", updateExportEstimate);
    maxWidthInput.addEventListener("change", updateExportEstimate);
    exportButton.addEventListener("click", () => {
      if (location.protocol === "file:") {
        showNotification("Video export is unavailable when this page is opened directly from disk. Open it through a local HTTP server and try again.");
        return;
      }
      updateExportEstimate();
      exportDialog.showModal();
    });
    const closeExportDialog = () => exportDialog.close();
    exportDialog.querySelector('[data-action="cancel"]').addEventListener("click", closeExportDialog);
    exportDialog.querySelector(".map-export-close").addEventListener("click", closeExportDialog);
    exportDialog.addEventListener("click", (event) => {
      if (event.target === exportDialog) closeExportDialog();
    });
    const runExport = async ({ frameDuration, bitrate, maxWidth, codecPreference }) => {
      if (!window.VideoFrame || !window.VideoEncoder || !window.ReplayWebMMuxer) {
        exportStatus.textContent = "WebCodecs video export is not supported in this browser.";
        return;
      }
      setPlaying(false);
      exportButton.disabled = true;
      playToggle.disabled = true;
      range.disabled = true;
      const savedTurn = range.value,
        output = document.createElement("canvas"),
        background = document.createElement("canvas"),
        mapLayers = [...world.querySelectorAll(".map-layer-canvas")].filter((canvas) => !canvas.hidden),
        outputWidth = Math.max(2, Math.min(exportSourceCanvas.width, maxWidth || exportSourceCanvas.width) - Math.min(exportSourceCanvas.width, maxWidth || exportSourceCanvas.width) % 2),
        outputHeight = Math.max(2, Math.round(exportSourceCanvas.height * outputWidth / exportSourceCanvas.width / 2) * 2),
        context = output.getContext("2d");
      output.width = outputWidth;
      output.height = outputHeight;
      background.width = outputWidth;
      background.height = outputHeight;
      composeExportBackground(background, background.getContext("2d"), mapLayers);
      let encoder;
      try {
        for (const canvas of world.querySelectorAll(".map-layer-canvas")) {
          try {
            canvas.getContext("2d").getImageData(0, 0, 1, 1);
          } catch {
            const layer = canvas.dataset.mapLayer || "map";
            throw new Error(
              `The ${layer} layer contains an image the browser cannot export. Open this page through its local HTTP server (http://localhost), then reload and try again.`,
            );
          }
        }
        const totalFrames = Number(h.endTurn) - Number(h.startTurn) + 1,
          fps = 1000 / frameDuration,
          keyFrameInterval = Math.max(1, Math.round(30_000 / frameDuration)),
          config = { width: outputWidth, height: outputHeight, bitrate, framerate: fps };
        let supportedConfig = null, codec = "vp9", encoderError = null;
        const codecCandidates = codecPreference === "vp9"
          ? ["vp09.00.10.08"]
          : codecPreference === "vp8"
            ? ["vp8"]
            : ["vp09.00.10.08", "vp8"];
        for (const candidate of codecCandidates) {
          const result = await VideoEncoder.isConfigSupported({ ...config, codec: candidate });
          if (result.supported) {
            supportedConfig = result.config;
            codec = candidate === "vp8" ? "vp8" : "vp9";
            break;
          }
        }
        if (!supportedConfig) throw new Error("This browser has no supported VP8 or VP9 video encoder.");
        const muxer = new ReplayWebMMuxer(outputWidth, outputHeight, fps, codec);
        encoder = new VideoEncoder({
          output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            muxer.addFrame(chunk.timestamp, chunk.type === "key", data);
          },
          error: (error) => { encoderError = error; },
        });
        encoder.configure(supportedConfig);
        const exportState = { owners: new Map(), cities: new Map() };
        const territoryEventTypes = new Set(["CITY_FOUNDED", "CITY_RAZED", "CITIES_TRANSFERRED", "TILES_CLAIMED"]);
        let eventIndex = 0;
        for (let turn = Number(h.startTurn); turn <= Number(h.endTurn); turn++) {
          range.value = String(turn);
          let territoryChanged = turn === Number(h.startTurn);
          while (eventIndex < r.events.length && r.events[eventIndex].turn <= turn) {
            const mapEvent = r.events[eventIndex++];
            territoryChanged ||= territoryEventTypes.has(mapEvent.type);
            applyMapEvent(mapEvent, exportState.owners, exportState.cities);
          }
          if (territoryChanged) drawTerritory(exportState);
          box.querySelector("#mapTurnLabel").textContent = turn;
          composeExportFrame(output, context, background, layers.territory.canvas);
          const frameIndex = turn - Number(h.startTurn),
            frame = new VideoFrame(output, { timestamp: frameIndex * frameDuration * 1_000, duration: frameDuration * 1_000 });
          encoder.encode(frame, { keyFrame: frameIndex % keyFrameInterval === 0 });
          frame.close();
          if (frameIndex % 8 === 0 || frameIndex + 1 === totalFrames)
            exportStatus.textContent = `Rendering frame ${frameIndex + 1} of ${totalFrames}…`;
          if (encoder.encodeQueueSize >= 8)
            await new Promise((resolve) => encoder.addEventListener("dequeue", resolve, { once: true }));
          if (frameIndex % 8 === 7) {
            if (typeof globalThis.scheduler?.yield === "function") await globalThis.scheduler.yield();
            else await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        await encoder.flush();
        encoder.close();
        if (encoderError) throw encoderError;
        if (muxer.frames.length !== totalFrames)
          throw new Error(`The encoder returned ${muxer.frames.length} of ${totalFrames} frames.`);
        const blob = muxer.finish();
        if (!blob.size) throw new Error("The rendered video is empty.");
        const url = URL.createObjectURL(blob),
          link = document.createElement("a");
        link.href = url;
        link.download = `${d.file.name.replace(/\.Civ5Replay$/i, "")}.webm`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (error) {
        exportStatus.textContent = error.message || "Video rendering failed.";
      } finally {
        if (encoder && encoder.state !== "closed") encoder.close();
        range.value = savedTurn;
        drawTerritory();
        exportButton.disabled = false;
        playToggle.disabled = false;
        range.disabled = false;
      }
    };
    exportForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const settings = {
        frameDuration: Number(frameDurationInput.value),
        bitrate: Number(bitrateInput.value),
        maxWidth: Number(exportForm.elements.maxWidth.value),
        codecPreference: exportForm.elements.codec.value,
      };
      exportDialog.close();
      await runExport(settings);
    });
    drawTerritory();
    cityIcons.ready.then(() => {
      if (box.contains(world)) drawTerritory();
    });
    return;
  }
}
function replayYear(h, turn) {
  const span = Math.max(1, h.endTurn - h.startTurn),
    y0 = Number.parseInt(h.startYear, 10),
    y1 = Number.parseInt(h.endYear, 10);
  return Number.isFinite(y0) && Number.isFinite(y1)
    ? Math.round(y0 + ((y1 - y0) * (turn - h.startTurn)) / span)
    : "";
}
function terrainColor(id) {
  return replayPalette.terrain[id] || replayPalette.terrainFallback;
}
function traceReplayHex(ctx, cx, cy, radius) {
  ctx.beginPath();
  for (let side = 0; side < 6; side++) {
    const angle = (Math.PI / 180) * (60 * side - 30),
      x = cx + radius * Math.cos(angle),
      y = cy + radius * Math.sin(angle);
    if (side === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
function traceReplayHexEdge(ctx, cx, cy, radius, side) {
  const angle = (Math.PI / 180) * (60 * side - 30),
    nextAngle = (Math.PI / 180) * (60 * (side + 1) - 30);
  ctx.beginPath();
  ctx.moveTo(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  ctx.lineTo(
    cx + radius * Math.cos(nextAngle),
    cy + radius * Math.sin(nextAngle),
  );
}
function drawReplayRiver(ctx, cx, cy, radius, mask, texture) {
  if (!ctx || !(mask & 0x0e)) return;
  const vertices = Array.from({ length: 6 }, (_, side) => {
    const angle = (Math.PI / 180) * (60 * side - 30);
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
  const edges = [];
  if (mask & 0x04) edges.push([vertices[0], vertices[1]]); // WOfRiver: east edge
  if (mask & 0x02) edges.push([vertices[1], vertices[2]]); // NWOfRiver: southeast edge
  if (mask & 0x08) edges.push([vertices[2], vertices[3]]); // NEOfRiver: southwest edge
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [start, end] of edges) {
    ctx.beginPath();
    ctx.moveTo(...start);
    ctx.lineTo(...end);
    ctx.strokeStyle = replayPalette.riverShadow;
    ctx.lineWidth = 4.2;
    ctx.stroke();
    ctx.strokeStyle = texture || replayPalette.riverWater;
    ctx.lineWidth = 2.8;
    ctx.stroke();
    ctx.strokeStyle = replayPalette.riverHighlight;
    ctx.lineWidth = 0.75;
    ctx.stroke();
  }
  ctx.restore();
}
function loadReplayTerrainImages() {
  const images = {};
  const names = [
    "GRASSLAND",
    "PLAINS",
    "DESERT",
    "TUNDRA",
    "SNOW",
    "COAST",
    "OCEAN",
    "MOUNTAIN",
    "HILLS",
    "ICE",
    "JUNGLE",
    "FOREST",
  ];
  images.ready = Promise.all(
    names.map(
      (name) =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () => {
            images[name] = image;
            resolve();
          };
          image.onerror = resolve;
          image.src = `assets/terrain/${name}.png`;
        }),
    ),
  );
  return images;
}
function loadReplayCityIcons() {
  const images = {};
  const names = [
    "CIV_CITY_ICON",
    "CIV_CS_ICON",
    "Cultured",
    "Maritime",
    "Mercantile",
    "Militaristic",
    "Religious",
  ];
  images.ready = Promise.all(
    names.map(
      (name) =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () => {
            images[name === "CIV_CS_ICON" ? name : name.toUpperCase()] = image;
            resolve();
          };
          image.onerror = resolve;
          image.src = `assets/civ5-icons/${name}.png`;
        }),
    ),
  );
  return images;
}
function locateReplayTile(px, py, width, height, radius, hexW) {
  const rowGuess = Math.round((py - radius) / (radius * 1.5));
  for (
    let y = Math.max(0, rowGuess - 1);
    y <= Math.min(height - 1, rowGuess + 1);
    y++
  ) {
    const colGuess = Math.round((px - radius) / hexW - 0.5 * (y & 1));
    for (
      let x = Math.max(0, colGuess - 1);
      x <= Math.min(width - 1, colGuess + 1);
      x++
    ) {
      const cx = radius + hexW * (x + 0.5 * (y & 1)),
        cy = radius + radius * 1.5 * y,
        dx = Math.abs(px - cx),
        dy = Math.abs(py - cy);
      if (dx <= hexW / 2 && dy <= radius && dy + dx / Math.sqrt(3) <= radius)
        return y * width + x;
    }
  }
  return -1;
}
function replayTerrainName(id) {
  return ["GRASSLAND", "PLAINS", "DESERT", "TUNDRA", "SNOW", "COAST", "OCEAN"][
    id
  ];
}
function replayElevationName(id) {
  return ["MOUNTAIN", "HILLS"][id];
}
function replayRiverLabel(mask) {
  const edges = [
    (mask & 0x02) && "NW",
    (mask & 0x04) && "W",
    (mask & 0x08) && "NE",
  ].filter(Boolean);
  return edges.map((edge) => `River ${edge}`).join(", ");
}
function replayFeatureName(id) {
  return { 0: "ICE", 1: "JUNGLE", 5: "FOREST" }[id];
}
function replayTerrainLabel(id) {
  return (
    ["Grassland", "Plains", "Desert", "Tundra", "Snow", "Coast", "Ocean"][id] ||
    `Terrain ${id}`
  );
}
function replayElevationLabel(id) {
  return { 0: "Mountain", 1: "Hills" }[id] || "Flat";
}
function replayFeatureLabel(id) {
  return (
    {
      0: "Ice",
      1: "Jungle",
      2: "Marsh",
      3: "Oasis",
      4: "Flood plains",
      5: "Forest",
      15: "Cerro de Potosí",
      17: "Atoll",
      18: "Sri Pada",
      19: "Mount Sinai",
    }[id] || ""
  );
}
document
  .querySelectorAll(".tabs button")
  .forEach((b) => b.addEventListener("click", () => renderTab(b.dataset.tab, { navigate: true })));
