"use strict";
import {
  parseSave,
  saveFeatureName,
  saveImprovementName,
  saveResourceName,
} from "./save-parser.mjs";
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
const colorTable = window.CIV5_COLORS || {};
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
const DEBUG_STORAGE_KEY = "civ5-parser-debug";
let debugEnabled = false;
try { debugEnabled = localStorage.getItem(DEBUG_STORAGE_KEY) === "true"; } catch {}
const debugToggle = $("#debugToggle");
debugToggle.addEventListener("click", () => setDebugEnabled(!debugEnabled));
function setDebugEnabled(enabled, logChange = true) {
  debugEnabled = Boolean(enabled);
  try { localStorage.setItem(DEBUG_STORAGE_KEY, String(debugEnabled)); } catch {}
  debugToggle.setAttribute("aria-pressed", String(debugEnabled));
  debugToggle.classList.toggle("is-enabled", debugEnabled);
  debugToggle.title = `Debug logs ${debugEnabled ? "enabled" : "disabled"}`;
  if (logChange) console.info(`[Civ5] Debug logs ${debugEnabled ? "enabled" : "disabled"}`);
}
setDebugEnabled(debugEnabled, false);
window.Civ5ParserDebug = {
  get enabled() { return debugEnabled; },
  setEnabled: setDebugEnabled,
};
const metricLabel = (key) => key.replace(/^(?:REPLAYDATASET|INFOADDICTDATASET)_/, "");
const cssColor = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const replayPalette = {
  player: cssColor("--color-player-default"),
  playerSecondary: cssColor("--color-player-secondary-default"),
  playerSecondaryNeutral: cssColor("--color-player-secondary-neutral"),
  replayFallback: cssColor("--color-replay-fallback"),
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
const replayFeaturesRenderedSeparately = ["ICE", "JUNGLE", "FOREST", "FLOOD_PLAINS", "FALLOUT"];
const replayYieldNames = ["Food", "Production", "Gold", "Science", "Culture", "Faith"];
const replayYieldIcons = ["ICON_FOOD", "ICON_PRODUCTION", "ICON_GOLD", "ICON_RESEARCH", "ICON_CULTURE", "ICON_FAITH"];
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
let redrawSaveMapInPlace = null;
let dragDepth = 0;
let showRecoveredMapTiles = false;
function saveMapForDisplay(map, showRecovered) {
  if (!map || showRecovered) return map;
  const firstRecovered = map.tiles.findIndex((tile) => tile.recovered);
  if (firstRecovered < 0) return map;
  const cities = new Set();
  let parsedTiles = 0, units = 0;
  const tiles = map.tiles.map((tile, index) => {
    if (index >= firstRecovered) return {
      x: tile.x, y: tile.y, typeId: 6, plotTypeId: 3, units: [], dataUnavailable: true,
    };
    if (!tile.dataUnavailable) parsedTiles++;
    units += tile.units?.length || 0;
    if (tile.plotCity?.owner >= 0 && tile.plotCity?.id >= 0)
      cities.add(`${tile.plotCity.owner}:${tile.plotCity.id}`);
    return tile;
  });
  return {
    ...map,
    tiles,
    parsedTiles,
    complete: false,
    entities: {units, cities: cities.size},
  };
}
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
function civilizationDisplayName(player, fallbackIndex = -1) {
  const civilization = String(player?.civilization || "");
  if (civilization === "CIVILIZATION_BARBARIAN" || fallbackIndex === 63)
    return "BARBARIANS";
  if (civilization.startsWith("CIVILIZATION_") && civilization !== "CIVILIZATION_MINOR")
    return gameEnumLabel(civilization, "CIVILIZATION_");
  if (civilization.startsWith("MINOR_CIV_"))
    return displayCityStateName(civilization.slice("MINOR_CIV_".length));
  const named = player?.displayCiv || player?.shortName || player?.name;
  if (named) return civilization === "CIVILIZATION_MINOR" ? displayCityStateName(named) : String(named);
  if (civilization === "CIVILIZATION_MINOR") return "MINOR CIVILIZATION";
  return fallbackIndex >= 0 ? `PLAYER ${fallbackIndex + 1}` : "UNKNOWN CIVILIZATION";
}
function displayCityStateName(value) {
  const name = String(value || "").replace(/_CITY$/i, "").replaceAll("_", " ");
  return name === name.toLocaleUpperCase()
    ? name.toLocaleLowerCase().replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toLocaleUpperCase())
    : name;
}
function cityStateName(value, fallback = "Minor civilization") {
  const name = typeof value === "string"
    ? value
    : value?.displayCiv || value?.shortName || value?.name;
  return displayCityStateName(name || fallback);
}
function replayTeamDisplayName(teamId, playersByTeam) {
  if (teamId === 21) return "Observer";
  if (teamId === 63) return "BARBARIANS";
  const players = playersByTeam.get(teamId) || [];
  return players.length
    ? [...new Set(players.map((player) => civilizationDisplayName(player, player.slot)))].join(" / ")
    : `Team ${teamId + 1}`;
}
function orderVisibilityTeamIds(teamIds) {
  const rank = (id) => id === 21 ? 2 : id === 63 ? 1 : 0;
  return teamIds.sort((a, b) => rank(a) - rank(b) || a - b);
}
function unitDisplayName(unit, playerName) {
  const type = unit.type?.replace(/^UNIT_/, "").replaceAll("_", " ") || `Unknown unit type · ID ${unit.id}`,
    owner = Number.isInteger(unit.owner) && unit.owner >= 0 ? playerName(unit.owner) : "";
  return owner ? `${type} · ${owner}` : type;
}
function logSaveUnitDiagnostics(data) {
  if (!debugEnabled) return;
  const map = data.saveMap;
  if (!map) return;
  const references = map.tiles.flatMap((tile) => tile.units.map((unit) => ({
    tile: `${tile.x + 1}, ${tile.y + 1}`,
    owner: unit.owner,
    id: unit.id,
    type: unit.type || "UNKNOWN",
    recordOffset: map.units.find((record) => record.owner === unit.owner && record.id === unit.id)?.offset ?? null,
  })));
  console.groupCollapsed(`[Civ5] Unit parse · ${data.file.name} · ${references.filter((unit) => unit.type !== "UNKNOWN").length}/${references.length} mapped`);
  console.info("Save", {turn: data.header.turn, build: data.header.build, map: `${map.mapWidth}×${map.mapHeight}`});
  console.table(references);
  console.table((map.unitArrayScan?.candidates || []).map((candidate) => ({
    offset: candidate.offset,
    recordStart: candidate.recordStart,
    slots: candidate.slots,
    count: candidate.count,
    firstVersion: candidate.firstVersion,
    firstRecordWords: candidate.firstWords?.slice(0, 8).join(", "),
    nearbyTypes: candidate.nearbyTypeHashes?.map(({type}) => type).join(", "),
  })));
  console.groupEnd();
}
function renderReplayProgress(file, state, update) {
  if (update.type === "header") {
    state.header = update.header;
    state.file = file;
    state.firstEvents = [];
    state.previewedEvents = 0;
    state.eventCount = 0;
    state.metrics = null;
    state.map = null;
    const h = state.header;
    current = {kind: "replay", file, header: h, replay: {mapWidth: 0, mapHeight: 0, tiles: [], events: [], metrics: []}};
    prepareProgressView();
    $("#saveTitle").textContent = gameEnumLabel(h.playerCiv, "CIVILIZATION_") || h.players[0]?.name || "Civ V replay";
    $("#savePath").textContent = file.name;
    $("#turn").textContent = h.endTurn;
    $("#dimensions").textContent = "Reading map…";
    $("#playtime").textContent = `${h.startYear} → ${h.endYear}`;
    $("#payloadSize").textContent = humanBytes(file.size);
    renderFacts([["Replay version", h.version], ["Build", h.build], ["Turn range", `${h.startTurn}–${h.endTurn}`], ["Players", h.players.length]]);
    renderLobbyOptions([]);
    $("#dlcRecords").hidden = true;
    drawPlayers(h.players.map((player, index) => ({...player, slot: index})));
    $("#tabContent").innerHTML = '<div class="replay-progress"><h2>Replay sections</h2><p>Header and players ready</p><p data-progress="metrics">Waiting for metrics…</p><p data-progress="events">Waiting for events…</p><p data-progress="map">Waiting for map…</p><ol data-progress="event-preview"></ol></div>';
  } else if (update.type === "metrics") {
    state.metrics = update.metrics;
    const samples = update.metrics.reduce((sum, metric) => sum + metric.byPlayer.reduce((n, player) => n + player.length, 0), 0);
    const line = $("[data-progress='metrics']");
    if (line) line.textContent = `${update.metrics.length} metrics ready · ${samples.toLocaleString()} samples`;
  } else if (update.type === "events") {
    state.eventCount = update.count;
    for (const event of update.items) if (state.firstEvents.length < 12) state.firstEvents.push(event);
    const line = $("[data-progress='events']");
    if (line) line.textContent = `${state.eventCount.toLocaleString()} events parsed`;
    const list = $("[data-progress='event-preview']");
    if (list && state.firstEvents.length > state.previewedEvents) {
      list.insertAdjacentHTML("beforeend", state.firstEvents.slice(state.previewedEvents).map((event) => `<li>${esc(event.text || `Event ${event.typeId} · turn ${event.turn}`)}</li>`).join(""));
      state.previewedEvents = state.firstEvents.length;
    }
  } else if (update.type === "map-start") {
    state.map = {width: update.mapWidth, height: update.mapHeight, tiles: 0, total: update.mapWidth * update.mapHeight};
    $("#dimensions").textContent = `${update.mapWidth} × ${update.mapHeight}`;
    const line = $("[data-progress='map']");
    if (line) line.textContent = `Map ${update.mapWidth} × ${update.mapHeight} · reading tiles…`;
    const canvas = document.createElement("canvas");
    canvas.className = "replay-progress-map";
    canvas.width = update.mapWidth;
    canvas.height = update.mapHeight;
    canvas.setAttribute("aria-label", "Map preview loading tile by tile");
    $("#tabContent .replay-progress")?.append(canvas);
    state.map.context = canvas.getContext("2d", {alpha: false});
  } else if (update.type === "map-tiles" && state.map) {
    state.map.tiles = update.count;
    const ctx = state.map.context;
    paintProgressTiles(ctx, update.items, update.start, state.map.width, state.map.height);
    const line = $("[data-progress='map']");
    if (line) line.textContent = `Map tiles ${update.count.toLocaleString()} / ${update.total.toLocaleString()}`;
  }
}
function renderSaveProgress(file, state, update) {
  if (update.type === "header") {
    state.header = update.header;
    current = {kind: "save", file, header: {...update.header, players: []}, payload: {bytes: file.size}};
    prepareProgressView();
    $("#saveTitle").textContent = gameEnumLabel(update.header.civ, "CIVILIZATION_") || "Civ V save";
    $("#savePath").textContent = file.name;
    $("#turn").textContent = update.header.turn;
    $("#dimensions").textContent = update.header.worldSize.replace(/^WORLDSIZE_/, "");
    $("#playtime").textContent = "Reading save data…";
    $("#payloadSize").textContent = humanBytes(file.size);
    renderFacts([["Save version", update.header.saveVersion], ["Game version", update.header.gameVersion], ["Build", update.header.build], ["Turn", update.header.turn], ["Civilization", gameEnumLabel(update.header.civ, "CIVILIZATION_")], ["World size", update.header.worldSize]]);
    renderLobbyOptions([]);
    $("#dlcRecords").hidden = true;
    $("#tabContent").innerHTML = '<div class="replay-progress"><h2>Save sections</h2><p>Header ready · reading map blocks…</p><p data-progress="save-map">Waiting for map…</p><p data-progress="save-entities">Waiting for units and cities…</p><canvas class="replay-progress-map" data-progress-map></canvas></div>';
  } else if (update.type === "map-start") {
    state.map = {width: update.mapWidth, height: update.mapHeight, count: 0, total: update.mapWidth * update.mapHeight};
    $("#dimensions").textContent = `${update.mapWidth} × ${update.mapHeight}`;
    const canvas = $("[data-progress-map]");
    if (canvas) {
      canvas.width = update.mapWidth;
      canvas.height = update.mapHeight;
      state.map.context = canvas.getContext("2d", {alpha: false});
    }
    const line = $("[data-progress='save-map']");
    if (line) line.textContent = `Map ${update.mapWidth} × ${update.mapHeight} · parsing tiles…`;
  } else if (update.type === "map-tiles" && state.map) {
    state.map.count = update.start + update.tiles.length;
    const ctx = state.map.context;
    paintProgressTiles(ctx, update.tiles, update.start, state.map.width, state.map.height);
    const line = $("[data-progress='save-map']");
    if (line) line.textContent = `Map tiles ${state.map.count.toLocaleString()} / ${state.map.total.toLocaleString()}`;
  } else if (update.type === "players") {
    current.header.players = update.players;
    drawPlayers(update.players);
  } else if (update.type === "entities") {
    const line = $("[data-progress='save-entities']");
    if (line) line.textContent = `Entities ready · ${update.units} units · ${update.cities} cities`;
  }
}
function prepareProgressView() {
  $("#result").hidden = false;
  $("#tabSections").hidden = true;
  $("#tabContentCard").hidden = false;
  setAvailableTabs(["summary"]);
  document.querySelectorAll(".tabs button").forEach((button) =>
    button.classList.toggle("active", button.dataset.tab === "summary"),
  );
}
function paintProgressTiles(context, tiles, start, width, height) {
  if (!context) return;
  tiles.forEach((tile, offset) => {
    const index = start + offset;
    context.fillStyle = terrainColor(tile.typeId);
    context.fillRect(index % width, height - 1 - Math.floor(index / width), 1, 1);
  });
}
function saveCityDisplayName(value) {
  const raw = String(value || "");
  let name = raw.replace(/^TXT_KEY_/, ""), marker = name.lastIndexOf("_CITY_NAME_");
  if (marker >= 0) name = name.slice(marker + "_CITY_NAME_".length);
  else if (name.startsWith("CITY_NAME_")) name = name.slice("CITY_NAME_".length);
  else if (name.startsWith("CITYSTATE_")) name = name.slice("CITYSTATE_".length);
  if (name !== raw.replace(/^TXT_KEY_/, ""))
    return name.split("_").filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ");
  return raw;
}
function yieldReplayTask() {
  if (typeof globalThis.scheduler?.yield === "function") return globalThis.scheduler.yield();
  if (typeof MessageChannel !== "undefined") return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(0);
  });
  return new Promise((resolve) => setTimeout(resolve, 0));
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
    const onProgress = createProgressHandler(file, isReplay ? "Replay" : "Parse");
    let data;
    if (isReplay) {
      const replayProgress = {};
      data = await parseReplay(bytes, file.name, {
        onSection: (update) => renderReplayProgress(file, replayProgress, update),
        onProgress,
      });
    } else {
      const saveProgress = {};
      data = await parseSave(bytes, file.name, {
          recoverMap: true,
          diagnostics: debugEnabled,
          onSection: (update) => renderSaveProgress(file, saveProgress, update),
          onProgress,
      });
    }
    if (!isReplay) logSaveUnitDiagnostics(data);
    current = data;
    render(data);
    $("#result").hidden = false;
    $("#dropHint").hidden = true;
    $("#status").hidden = true;
  } catch (e) {
    setStatus(e.message || "Save decode failed.", true);
  }
}
function createProgressHandler(file, label) {
  let previousProgressAt = performance.now();
  return ({phase, percent}) => {
    const message = `${phase} · ${percent}%`;
    if (debugEnabled) {
      const now = performance.now();
      console.debug(`[Civ5] ${label} ${phase}: ${percent}% (+${Math.round(now - previousProgressAt)} ms)`);
      previousProgressAt = now;
    }
    setStatus(message);
    $("#dropHint").textContent = `${humanBytes(file.size)} · ${message}`;
  };
}

async function parseReplay(bytes, filename, {onProgress, onSection} = {}) {
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
  let nextReplayYieldAt = performance.now() + 8;
  const array = async (label, fn, max) => {
    const length = count(label, max), values = new Array(length);
    const batchSize = label === "event" ? 8192 : 4096;
    let batchStart = 0;
    for (let i = 0; i < length; i++) {
      const value = fn(i);
      values[i] = value instanceof Promise ? await value : value;
      if ((i + 1) % batchSize === 0 || i + 1 === length) {
        if (label === "event") onSection?.({type: "events", items: values.slice(batchStart, i + 1), count: i + 1});
        if (label === "map tile") onSection?.({type: "map-tiles", items: values.slice(batchStart, i + 1), start: batchStart, count: i + 1, total: length});
        batchStart = i + 1;
        onProgress?.({phase: `Reading ${label}`, percent: Math.min(99, 5 + Math.floor(94 * at / bytes.length))});
        if (label === "event" || label === "map tile" || performance.now() >= nextReplayYieldAt) {
          await yieldReplayTask();
          nextReplayYieldAt = performance.now() + 8;
        }
      }
    }
    return values;
  };
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
  const dlc = await array(
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
  const mods = await array(
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
  const civs = await array(
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
      civilization = asset?.civilization ||
        (c.raw[0] === 18
          ? "CIVILIZATION_MINOR"
          : c.raw[0] === 19
            ? "CIVILIZATION_BARBARIAN"
            : "");
    const displayCiv =
      c.name ||
      c.longName ||
      (civilization === "CIVILIZATION_MINOR" ? "Minor civilization" : "");
    const [primaryColor, secondaryColor] =
      colorTable[asset?.civilization] || colorTable[String(c.raw[2])] || [];
    return {
      slot,
      civilization,
      displayCiv,
      leader: c.leader,
      name: c.longName,
      shortName: c.name,
      demonym: c.demonym,
      color: primaryColor || replayPalette.player,
      secondaryColor: secondaryColor || replayPalette.playerSecondary,
      iconKey: asset?.icon || "",
      iconAvailable: Boolean(asset),
      raw: c.raw,
    };
  });
  onSection?.({type: "header", file: {name: filename, size: bytes.length}, header: {
    format, version, build, playerCiv, difficulty, startingEra: eraStart, era: eraEnd,
    speed: gameSpeed, worldSize, mapScript, mapScript2, playerColor, startTurn, startYear,
    endTurn, endYear, players, dlc, mods,
  }});
  const datasetKeys = await array("dataset", () => varstr(), 1000);
  const datasetValues = await array(
    "dataset values",
    async () =>
      await array(
        "civilization values",
        async () =>
          await array("metric value", () => ({ turn: i32(), value: i32() }), 100000),
        128,
      ),
    1000,
  );
  const totalReplaySamples = datasetValues.reduce((total, player) =>
    total + player.reduce((sum, values) => sum + values.length, 0), 0);
  const metricData = [], yieldDuringTransform = totalReplaySamples > 250_000;
  let transformedSamples = 0;
  for (let index = 0; index < datasetKeys.length; index++) {
    const byPlayer = [];
    for (const player of datasetValues) {
      const source = player[index] || [], samples = new Array(source.length);
      for (let sampleIndex = 0; sampleIndex < source.length; sampleIndex++) {
        const sample = source[sampleIndex];
        samples[sampleIndex] = {turn: sample.turn + startTurn, value: sample.value};
        if (yieldDuringTransform && ++transformedSamples % 8192 === 0)
          await yieldReplayTask();
      }
      byPlayer.push(samples);
    }
    metricData.push({key: datasetKeys[index], byPlayer});
  }
  onSection?.({type: "metrics", metrics: metricData});
  i32();
  const events = await array(
    "event",
    async () => {
      const turn = i32(),
        typeId = i32(),
        tiles = await array("event tile", () => ({ x: i16(), y: i16() }), 100000),
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
  onSection?.({type: "map-start", mapWidth, mapHeight});
  const tiles = await array(
    "map tile",
    () => {
      // The first two integers are replay state metadata; the viewer never uses them.
      i32();
      i32();
      return {
        plotTypeId: i8(),
        typeId: i8(),
        featureId: i8(),
        riverMask: i8(),
      };
    },
    mapWidth * mapHeight,
  );
  markReplayLakes(tiles, mapWidth, mapHeight);
  const typeNames = [
    "MAJOR_EVENT",
    "CITY_FOUNDED",
    "TILES_CLAIMED",
    "CITIES_TRANSFERRED",
    "CITY_RAZED",
    "RELIGION_FOUNDED",
    "PANTHEON_SELECTED",
  ];
  const addParsedEvent = (event) => {
    const civ = players[event.civId]?.shortName || civs[event.civId]?.name || "";
    const type = typeNames[event.typeId] || `EVENT_${event.typeId}`;
    const [tile] = event.tiles;
    return Object.assign(event, {civ, type, ...tile});
  };
  if (events.length <= 8192) events.forEach(addParsedEvent);
  else {
    for (let i = 0; i < events.length; i++) {
      addParsedEvent(events[i]);
      if ((i + 1) % 4096 === 0) {
        onProgress?.({phase: "Preparing replay events", percent: Math.min(99, 90 + Math.floor(5 * (i + 1) / events.length))});
        await yieldReplayTask();
      }
    }
  }
  const orderedEvents = await sortReplayEvents(events, onProgress);
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
      events: orderedEvents,
      metrics: metricData,
    },
  };
}
function markReplayLakes(tiles, width, height) {
  const visited = new Uint8Array(tiles.length);
  for (let start = 0; start < tiles.length; start++) {
    if (visited[start] || tiles[start].plotTypeId !== 3) continue;
    const component = [start];
    visited[start] = 1;
    for (let cursor = 0; cursor < component.length; cursor++) {
      const index = component[cursor], x = index % width, y = Math.floor(index / width);
      const visit = (nx, ny) => {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        const next = ny * width + nx;
        if (!visited[next] && tiles[next].plotTypeId === 3) {
          visited[next] = 1;
          component.push(next);
        }
      };
      visit(x - 1, y);
      visit(x + 1, y);
      if (y & 1) {
        visit(x, y - 1); visit(x + 1, y - 1);
        visit(x, y + 1); visit(x + 1, y + 1);
      } else {
        visit(x - 1, y - 1); visit(x, y - 1);
        visit(x - 1, y + 1); visit(x, y + 1);
      }
    }
    if (component.length <= 9)
      for (const index of component) tiles[index].isLake = true;
  }
}
async function sortReplayEvents(events, onProgress) {
  const compare = (a, b) => a.turn - b.turn;
  const runSize = 32768;
  if (events.length <= runSize) return events.sort(compare);
  const runs = [];
  for (let start = 0; start < events.length; start += runSize) {
    runs.push(events.slice(start, start + runSize).sort(compare));
    onProgress?.({phase: "Ordering replay events", percent: 95 + Math.floor(3 * Math.min(events.length, start + runSize) / events.length)});
    await yieldReplayTask();
  }
  const heap = [];
  const less = (a, b) => compare(a.event, b.event) < 0 || (a.event.turn === b.event.turn && a.run < b.run);
  const push = (node) => {
    let index = heap.length;
    heap.push(node);
    while (index) {
      const parent = (index - 1) >> 1;
      if (!less(heap[index], heap[parent])) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
  };
  const pop = () => {
    const first = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1, right = left + 1;
        let smallest = index;
        if (left < heap.length && less(heap[left], heap[smallest])) smallest = left;
        if (right < heap.length && less(heap[right], heap[smallest])) smallest = right;
        if (smallest === index) break;
        [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
        index = smallest;
      }
    }
    return first;
  };
  runs.forEach((run, index) => { if (run.length) push({run: index, index: 0, event: run[0]}); });
  const sorted = new Array(events.length);
  for (let index = 0; index < sorted.length; index++) {
    const node = pop();
    sorted[index] = node.event;
    node.index++;
    if (node.index < runs[node.run].length) {
      node.event = runs[node.run][node.index];
      push(node);
    }
    if ((index + 1) % 8192 === 0) await yieldReplayTask();
  }
  return sorted;
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
function render(d) {
  redrawSaveMapInPlace = null;
  if (d.kind === "replay") return renderReplay(d);
  setAvailableTabs(["summary", "map", "players", "metadata", "strings"]);
  const h = d.header,
    p = d.payload;
  $("#saveTitle").textContent =
    gameEnumLabel(h.civ, "CIVILIZATION_") || "Civ V save";
  $("#savePath").textContent = d.file.name;
  $("#turn").textContent = h.turn;
  $("#dimensions").textContent = d.saveMap ? `${d.saveMap.mapWidth} × ${d.saveMap.mapHeight}` : h.worldSize.replace(/^WORLDSIZE_/, "");
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
  renderFacts(fields);
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
  renderFacts(fields);
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
function renderFacts(fields) {
  $("#facts").innerHTML = fields
    .map(([label, value]) => `<div class="fact"><span>${esc(label)}</span><b>${esc(value)}</b></div>`)
    .join("");
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
  const wrap = $("#playerOverview"), isReplay = current?.kind === "replay";
  const major = [], minor = [], barbarian = [];
  for (const player of players) {
    const civ = player.civilization || "";
    if (civ === "CIVILIZATION_MINOR" || civ.startsWith("MINOR_CIV_")) minor.push(player);
    else if (civ === "CIVILIZATION_BARBARIAN") barbarian.push(player);
    else major.push(player);
  }
  const listedCityStates =
    cityStates ??
    minor.map((player) => cityStateName(player));
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
            ? cityStateName(p, "Minor")
            : civ
              ? civ.startsWith("MINOR_CIV_")
                ? civ.slice("MINOR_CIV_".length).replaceAll("_", " ")
                : gameEnumLabel(civ, "CIVILIZATION_")
              : p.displayCiv || p.shortName || p.name || "UNKNOWN CIV",
        short = label.slice(0, 2),
        playerName = civ === "CIVILIZATION_MINOR" ? cityStateName(p.displayCiv || p.name, label) : p.displayCiv || p.name || label,
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
        : civ.startsWith("CIVILIZATION_")
          ? civ.slice("CIVILIZATION_".length)
          : civ.startsWith("MINOR_CIV_")
            ? civ.slice("MINOR_CIV_".length)
            : civ || p.displayCiv || label;
      const displaySlot = Number(p.slot) + (isReplay ? 0 : 1);
      return `<div class="player-row${p.status === 3 ? " human" : ""}"><span class="player-slot">${String(displaySlot).padStart(2, "0")}</span>${mark}<span class="player-info"><strong>${playerLabel}</strong><small>${esc(subtitle)}</small></span><span class="player-status">${slotStatus(p.status)}</span></div>`;
    })
    .join(
      "",
    )}</div><div class="slot-groups">${listedCityStates.length ? `<div class="slot-group">MINOR CIVILIZATIONS <b>${listedCityStates.length}</b></div>${listedCityStates.map((name) => `<div class="slot-group minor-civ">${esc(cityStateName(name))}</div>`).join("")}` : ""}${barbarian.length ? `<div class="slot-group">BARBARIANS <b>${barbarian.length}</b></div>` : ""}</div>`;
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
  const [civColor, civSecondary] = colorTable[player.civilization] || [];
  return [
    isCssColor(player.color) ? player.color : civColor || replayPalette.player,
    isCssColor(player.secondaryColor)
      ? player.secondaryColor
      : civSecondary || replayPalette.playerSecondaryNeutral,
  ];
}
function isCssColor(value) {
  return /^#[\da-f]{6}$/i.test(String(value || ""));
}
function normalizeMapPlayerColors(players) {
  return players.map((player) => {
    const [civPrimary, civSecondary] = colorTable[player.civilization] || [];
    // Saves store named palette keys, while replays may already use CSS colors.
    // Resolve the saved key explicitly so minor civs retain their own border color.
    const savedColorKey = String(player.color || "").trim().toUpperCase();
    const [savedPrimary, savedSecondary] =
      colorTable[savedColorKey] || [];
    const fallbackHue = civHue(player.civilization || String(player.slot));
    return {
      ...player,
      // Civ5 map owners are engine player IDs. Keep this separate from the
      // display order so both replay participants and save slots resolve the
      // same way when drawing plot ownership.
      mapOwnerId: Number.isInteger(player.mapOwnerId)
        ? player.mapOwnerId
        : Number.isInteger(player.slot)
          ? player.slot
          : null,
      color: isCssColor(player.color) ? player.color : savedPrimary || civPrimary || `hsl(${fallbackHue} 62% 48%)`,
      secondaryColor: isCssColor(player.secondaryColor)
        ? player.secondaryColor
        : savedSecondary || civSecondary || `hsl(${(fallbackHue + 34) % 360} 48% 74%)`,
    };
  });
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
        section.className = `card replay-section${name === "map" ? " replay-map-section" : ""}`;
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
    const titles = { summary: "Summary", map: "Map", players: "Players", metadata: "Metadata", strings: "Strings" };
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
      if (name === "map" && current.saveMap) {
        const turn = current.header.turn;
        const displayMap = saveMapForDisplay(current.saveMap, showRecoveredMapTiles);
        renderReplayTab("map", { header: { startTurn: turn, endTurn: turn, players: current.header.players, turn, saveMode: true }, replay: {...displayMap, events: []} }, content);
        const integrityFindings = (current.saveMap.integrityFindings || current.saveMap.anomalies)
          .filter((item) => item.type !== "plot-record-decode-error");
        if (integrityFindings.length) {
          const alert = document.createElement("div");
          alert.className = "save-map-anomalies";
          const resourceMode = current.saveMap.resourceSetting.setting || "uncertain";
          const findingLocation = (item) => {
            let x = Number.isInteger(item.x) ? item.x : item.coordinates?.x,
              y = Number.isInteger(item.y) ? item.y : item.coordinates?.y;
            if ((!Number.isInteger(x) || !Number.isInteger(y)) && Number.isInteger(item.tileIndex)) {
              x = item.tileIndex % current.saveMap.mapWidth;
              y = Math.floor(item.tileIndex / current.saveMap.mapWidth);
            }
            if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= current.saveMap.mapWidth || y >= current.saveMap.mapHeight)
              return "";
            return `<span class="inline-link" role="link" tabindex="0" data-save-map-jump="${x},${y}" title="Show this tile on the map">${x + 1}, ${y + 1}</span>`;
          };
          alert.innerHTML = `<strong>Save integrity · ${integrityFindings.length}</strong><ul>${integrityFindings.slice(0, 100).map((item) => item.x !== undefined ? `<li>${esc(item.resource)} × ${item.quantity} at ${findingLocation(item)}${item.allowed ? ` · allowed for ${esc(resourceMode)}: ${item.allowed.join(", ")}` : ""} <code>${esc(item.type)}</code></li>` : `<li><code>${esc(item.type)}</code> · ${esc(item.message || `${item.resource}: expected ${item.expected}, found ${item.actual}`)}${findingLocation(item) ? ` · at ${findingLocation(item)}` : ""}${item.tileIndex !== undefined ? ` · plot ${item.tileIndex} · payload byte ${item.offset}` : ""}</li>`).join("")}</ul>`;
          const jumpToFinding = (link) => {
            const [x, y] = link.dataset.saveMapJump.split(",").map(Number);
            document.querySelector("#mapWorld")?.scrollIntoView({ behavior: "smooth", block: "center" });
            requestAnimationFrame(() => replayMapNavigator?.focus({ turn: current.header.turn, x, y }));
          };
          alert.addEventListener("click", (event) => {
            const link = event.target.closest("[data-save-map-jump]");
            if (link) jumpToFinding(link);
          });
          alert.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            const link = event.target.closest("[data-save-map-jump]");
            if (!link) return;
            event.preventDefault();
            jumpToFinding(link);
          });
          content.prepend(alert);
        }
        if (!current.saveMap.complete) {
          const note = document.createElement("p");
          note.className = "save-map-incomplete";
          note.textContent = `Only ${current.saveMap.parsedTiles} of ${current.saveMap.tiles.length} tile records decoded; remaining cells are placeholders. Decoder stopped at plot ${current.saveMap.decodeIssue?.tileIndex ?? "?"} (byte ${current.saveMap.decodeIssue?.offset ?? "?"}).`;
          content.prepend(note);
        }
      } else if (name === "map") {
        content.textContent = "Serialized map data was not recognized in this save.";
      } else renderSaveTab(name, current, content);
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
      const displaySlot = Number(p.slot) + (current?.kind === "replay" ? 0 : 1);
      return `Slot ${String(displaySlot).padStart(2, "0")} · ${slotStatus(p.status)} · ${civilization}${p.leader ? ` · Leader: ${gameEnumLabel(p.leader, "LEADER_")}` : ""}${p.name ? ` · Player: ${p.name}` : ""}${p.color ? ` · Color: ${p.color}` : ""}`;
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
    const sortedEvents = r.events;
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
    const mapPlayers = normalizeMapPlayerColors(h.players);
    const mapCard = box.closest(".card"),
      page = document.querySelector(".page"),
      pageStyle = page && getComputedStyle(page),
      pageContentWidth = page
        ? page.clientWidth - (Number.parseFloat(pageStyle.paddingLeft) || 0) - (Number.parseFloat(pageStyle.paddingRight) || 0)
        : window.innerWidth - 56,
      layoutWidth = Math.max(mapCard.clientWidth, document.querySelector(".content-grid")?.clientWidth || 0, pageContentWidth),
      mapCanvasMaxWidth = Math.max(1, layoutWidth - 36),
      radius = Math.max(1, mapCanvasMaxWidth / (2 + Math.sqrt(3) * r.mapWidth)),
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
      return { x, y, key: `${x},${y}`, cx, cy, neighbors, tile: r.tiles[i] };
    });
    mapCard.style.removeProperty("width");
    mapCard.style.removeProperty("box-sizing");
    delete mapCard.dataset.mapWidth;
    const terrainLegend = [
      ["GRASSLAND", "Grassland"],
      ["PLAINS", "Plains"],
      ["DESERT", "Desert"],
      ["TUNDRA", "Tundra"],
      ["SNOW", "Snow"],
      ["COAST", "Coast"],
      ["LAKE", "Lake"],
      ["OCEAN", "Ocean"],
    ];
    const opacityKey = "civ5ReplayTerritoryOpacity";
    let initialTerritoryOpacity = 55;
    try {
      const stored = Number(localStorage.getItem(opacityKey));
      if (localStorage.getItem(opacityKey) !== null && Number.isFinite(stored))
        initialTerritoryOpacity = Math.max(0, Math.min(100, stored));
    } catch {}
    box.innerHTML = `<div class="map-timeline"><button id="mapPlayToggle" class="map-play-toggle" type="button" title="Play map history"><svg class="play-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg><svg class="pause-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h4v12H3zm6 0h4v12H9z"/></svg></button><label class="metric-picker">Turn <input id="mapTurn" type="range" min="${h.startTurn}" max="${Math.max(h.startTurn, h.endTurn)}" value="${initialMapTurn}"><b id="mapTurnLabel">${initialMapTurn}</b></label><button id="mapExport" class="map-export-button" type="button">Render video</button><span id="mapExportStatus" role="status" aria-live="polite"></span></div><div class="replay-map-wrap"><div id="mapWorld" class="map-world" style="width:${canvasWidth}px;aspect-ratio:${canvasWidth}/${canvasHeight}"><canvas class="map-layer-canvas" data-map-layer="terrain" width="${canvasWidth}" height="${canvasHeight}"></canvas><canvas class="map-layer-canvas" data-map-layer="elevation" width="${canvasWidth}" height="${canvasHeight}"></canvas><canvas class="map-layer-canvas" data-map-layer="features" width="${canvasWidth}" height="${canvasHeight}"></canvas><canvas class="map-layer-canvas" data-map-layer="grid" width="${canvasWidth}" height="${canvasHeight}"></canvas><canvas class="map-layer-canvas" data-map-layer="territory" width="${canvasWidth}" height="${canvasHeight}"></canvas></div><div id="mapTileTooltip" class="map-tile-tooltip" hidden></div><div class="map-zoom-controls"><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="reset">100%</button><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-map-fullscreen aria-label="Open map in fullscreen" title="Fullscreen map">⛶</button></div></div><div class="map-layer-controls"><span>Layers</span>${[
      ["terrain", "Terrain"],
      ["elevation", "Elevation"],
      ["features", "Features"],
      ["territory", "Territory"],
      ...(h.saveMode ? [["icons", "Icons"]] : []),
      ["grid", "Grid"],
    ]
      .map(
        ([key, label]) =>
          `<label><input type="checkbox" data-map-layer="${key}" checked>${label}</label>`,
      )
      .join(
        "",
      )}</div><label class="metric-picker map-opacity-control">Territory overlay <input id="territoryOpacity" type="range" min="0" max="100" value="${initialTerritoryOpacity}"><b id="territoryOpacityLabel">${initialTerritoryOpacity}%</b></label><div class="map-legend" style="width:${canvasWidth}px;max-width:100%;margin-inline:auto">${terrainLegend.map(([asset, name]) => `<span><i style="background-image:url('assets/terrain/${asset}.png')"></i>${name}</span>`).join("")}${mapPlayers.map((p) => `<span><i style="background:${p.secondaryColor}"></i>${esc(civilizationDisplayName(p, p.slot))}</span>`).join("")}</div>`;
    const tileDialog = document.createElement("dialog");
    tileDialog.className = "animated-dialog tile-details-dialog";
    tileDialog.setAttribute("aria-labelledby", "tileDetailsTitle");
    tileDialog.innerHTML = '<header><h2 id="tileDetailsTitle">Tile details</h2><button type="button" class="tile-details-close" aria-label="Close">×</button></header><div class="tile-details-content"></div>';
    box.append(tileDialog);
    tileDialog.querySelector(".tile-details-close").addEventListener("click", () => tileDialog.close());
    tileDialog.addEventListener("click", (event) => {
      if (event.target === tileDialog) tileDialog.close();
    });
    const hasMapHistory = !h.saveMode && h.startTurn < h.endTurn && r.events.length > 0;
    if (!hasMapHistory) {
      const timeline = box.querySelector(".map-timeline");
      timeline.hidden = true;
      timeline.style.display = "none";
    }
    let tileClickStart = null;
    const world = box.querySelector("#mapWorld"),
      viewport = world.parentElement,
      range = box.querySelector("#mapTurn"),
      playToggle = box.querySelector("#mapPlayToggle"),
      exportButton = box.querySelector("#mapExport"),
      exportStatus = box.querySelector("#mapExportStatus"),
      opacityRange = box.querySelector("#territoryOpacity"),
      tooltip = box.querySelector("#mapTileTooltip"),
      hoverState = { tileIndex: null },
      zoomReadout = box.querySelector('[data-zoom="reset"]'),
      tileDetails = tileDialog.querySelector(".tile-details-content"),
      layers = Object.fromEntries(
        [...box.querySelectorAll(".map-layer-canvas")].map((canvas) => [
          canvas.dataset.mapLayer,
          { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }) },
        ]),
      );
    const cityCanvas = document.createElement("canvas");
    cityCanvas.className = "map-layer-canvas";
    cityCanvas.dataset.mapLayer = "cities";
    // City icons in saves must sit above the territory fill; the unit/icon
    // canvas is appended later and therefore remains above cities.
    world.insertBefore(cityCanvas, layers.territory.canvas.nextSibling);
    layers.cities = { canvas: cityCanvas, ctx: cityCanvas.getContext("2d") };
    const mapPixelCount = canvasWidth * canvasHeight;
    const renderScale = Math.min(
      2,
      Math.max(
        1,
        Math.sqrt(
          32_000_000 /
            (mapPixelCount * (Object.keys(layers).length + 1)),
        ),
      ),
    );
    const iconRenderScale = Math.min(2, Math.sqrt(32_000_000 / mapPixelCount));
    const riverCanvas = document.createElement("canvas");
    riverCanvas.className = "map-layer-canvas";
    riverCanvas.dataset.mapLayer = "rivers";
    world.insertBefore(riverCanvas, layers.territory.canvas);
    const riverCtx = riverCanvas.getContext("2d");
    layers.rivers = { canvas: riverCanvas, ctx: riverCtx };
    const routeCanvas = document.createElement("canvas");
    routeCanvas.className = "map-layer-canvas";
    routeCanvas.dataset.mapLayer = "routes";
    world.insertBefore(routeCanvas, layers.territory.canvas);
    layers.routes = { canvas: routeCanvas, ctx: routeCanvas.getContext("2d") };
    const iconCanvas = document.createElement("canvas");
    iconCanvas.className = "map-layer-canvas";
    iconCanvas.dataset.mapLayer = "icons";
    world.append(iconCanvas);
    layers.icons = { canvas: iconCanvas, ctx: iconCanvas.getContext("2d") };
    const layerControls = box.querySelector(".map-layer-controls");
    if (layerControls) {
      const riverLabel = document.createElement("label");
      riverLabel.innerHTML = '<input type="checkbox" data-map-layer="rivers" checked>Rivers';
      layerControls.append(riverLabel);
      const routeLabel = document.createElement("label");
      routeLabel.innerHTML = '<input type="checkbox" data-map-layer="routes" checked>Roads and railroads';
      layerControls.append(routeLabel);
      if (h.saveMode) {
        const recoveryLabel = document.createElement("label");
        recoveryLabel.className = "map-recovery-option";
        recoveryLabel.innerHTML = `<input type="checkbox" data-map-recovery ${showRecoveredMapTiles ? "checked" : ""}><span>Recover damaged sections</span>`;
        layerControls.append(recoveryLabel);
        recoveryLabel.querySelector("input").addEventListener("change", (event) => {
          showRecoveredMapTiles = event.currentTarget.checked;
          const displayMap = saveMapForDisplay(current.saveMap, showRecoveredMapTiles);
          if (redrawSaveMapInPlace?.(displayMap)) return;
          replaySectionsOwner = null;
          render(current);
        });
      }
    }
    for (const [name, { canvas, ctx }] of Object.entries(layers)) {
      const layerScale = name === "icons" ? Math.max(1, iconRenderScale) : renderScale;
      canvas.width = Math.max(1, Math.round(canvasWidth * layerScale));
      canvas.height = Math.max(1, Math.round(canvasHeight * layerScale));
      ctx.scale(layerScale, layerScale);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
    const replayPlayers = new Map(), playersByTeam = new Map();
    for (const player of mapPlayers) {
      if (player.shortName) replayPlayers.set(player.shortName, player);
      if (player.name) replayPlayers.set(player.name, player);
      if (Number.isInteger(player.mapOwnerId)) replayPlayers.set(player.mapOwnerId, player);
      if (Number.isInteger(player.teamId)) {
        if (!playersByTeam.has(player.teamId)) playersByTeam.set(player.teamId, []);
        playersByTeam.get(player.teamId).push(player);
      }
    }
    const playerForMapOwner = (owner) => {
      // Replay events can store a civilization/name string, while save plots
      // store numeric player IDs. Preserve direct replay-name lookup first.
      const directMatch = replayPlayers.get(owner);
      const ownerIsNumericId = Number.isInteger(owner) ||
        (typeof owner === "string" && /^\s*-?\d+\s*$/.test(owner));
      if (directMatch && !ownerIsNumericId)
        return directMatch;
      const id = Number(owner);
      if (!Number.isInteger(id)) return null;
      // Plot ownership is serialized as a numeric player ID. Resolve that ID
      // against the save slot before considering display names, which can
      // otherwise collide with numeric owner strings.
      return mapPlayers.find((player) => player.mapOwnerId === id) ||
        mapPlayers.find((player) => player.slot === id) ||
        directMatch || replayPlayers.get(id) || null;
    };
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
      if (scaledHeight <= viewport.clientHeight)
        panY = (viewport.clientHeight - scaledHeight) / 2;
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
          hoverState.tileIndex = null;
          drawTerritory();
          return;
        }
        focusTileKey = `${x},${y}`;
        focusStartedAt = performance.now();
        tooltip.hidden = true;
        hoverState.tileIndex = null;
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
      button.addEventListener("click", async () => {
        if (button.hasAttribute("data-map-fullscreen")) {
          if (!document.fullscreenEnabled || typeof viewport.requestFullscreen !== "function") {
            showNotification("Fullscreen mode is not available in this browser.");
            return;
          }
          try {
            if (document.fullscreenElement === viewport) await document.exitFullscreen();
            else await viewport.requestFullscreen();
          } catch (error) {
            showNotification(`Could not open fullscreen map: ${error.message}`);
          }
          return;
        }
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
    viewport.addEventListener("fullscreenchange", () => {
      const fullscreen = document.fullscreenElement === viewport,
        fullscreenButton = box.querySelector("[data-map-fullscreen]");
      world.style.width = fullscreen
        ? `min(100vw, ${(canvasWidth / canvasHeight) * 100}vh)`
        : `${canvasWidth}px`;
      zoom = 1;
      panX = panY = 0;
      if (fullscreenButton) {
        fullscreenButton.textContent = fullscreen ? "×" : "⛶";
        fullscreenButton.title = fullscreen ? "Exit fullscreen" : "Fullscreen map";
        fullscreenButton.setAttribute("aria-label", fullscreen ? "Exit fullscreen" : "Open map in fullscreen");
      }
      requestAnimationFrame(applyZoom);
    });
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
      tileClickStart = null;
      if (event.target.closest(".map-zoom-controls")) return;
      tileClickStart = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
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
    let staticDrawGeneration = 0,
      committedStaticDrawGeneration = 0,
      saveMapUpdateVersion = 0;
    const drawStaticLayers = () => {
      const generation = ++staticDrawGeneration;
      const tiles = r.tiles;
      const staticLayerNames = ["terrain", "elevation", "cities", "features", "grid", "rivers", "routes", "icons"];
      const drawLayers = Object.fromEntries(staticLayerNames.map((name) => {
        const source = layers[name].canvas;
        const canvas = document.createElement("canvas");
        canvas.width = source.width;
        canvas.height = source.height;
        const ctx = canvas.getContext("2d");
        ctx.scale(canvas.width / canvasWidth, canvas.height / canvasHeight);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        return [name, {canvas, ctx}];
      }));
      const riverPattern = terrainImages.COAST?.complete && terrainImages.COAST.naturalWidth
        ? drawLayers.rivers.ctx.createPattern(terrainImages.COAST, "repeat")
        : null;
      riverPattern?.setTransform?.(new DOMMatrix().scale(0.22));
      const iconCtx = drawLayers.icons.ctx,
        cityCtx = drawLayers.cities.ctx;
      const drawBadge = (image, x, y, size, fallback, stroke = "#643f20", imageFilter = "none", imageScale = 1) => {
        iconCtx.save();
        iconCtx.fillStyle = "#fffdf0";
        iconCtx.strokeStyle = stroke;
        iconCtx.lineWidth = 1.25;
        iconCtx.beginPath();
        iconCtx.arc(x, y, size * 0.58, 0, Math.PI * 2);
        iconCtx.fill();
        if (image?.complete && image.naturalWidth) {
          iconCtx.save();
          if (imageScale > 1) {
            iconCtx.beginPath();
            iconCtx.arc(x, y, size * 0.58, 0, Math.PI * 2);
            iconCtx.clip();
          }
          iconCtx.filter = imageFilter;
          const imageSize = size * imageScale;
          iconCtx.drawImage(image, x - imageSize / 2, y - imageSize / 2, imageSize, imageSize);
          iconCtx.restore();
        }
        else {
          iconCtx.fillStyle = stroke;
          iconCtx.font = `bold ${Math.max(7, size * 0.72)}px sans-serif`;
          iconCtx.textAlign = "center"; iconCtx.textBaseline = "middle";
          iconCtx.fillText(fallback, x, y);
        }
        iconCtx.beginPath();
        iconCtx.arc(x, y, size * 0.58, 0, Math.PI * 2);
        iconCtx.stroke();
        iconCtx.restore();
      };
      const drawFalloutOverlay = (image, x, y, size) => {
        if (!image?.complete || !image.naturalWidth) return;
        iconCtx.save();
        iconCtx.globalAlpha = 0.42;
        iconCtx.drawImage(image, x - size / 2, y - size / 2, size, size);
        iconCtx.restore();
      };
      const drawPillageFlame = (x, y, size) => {
        iconCtx.save();
        iconCtx.translate(x, y);
        iconCtx.scale(size, size);
        iconCtx.shadowColor = "#f04716";
        iconCtx.shadowBlur = 2.5;
        iconCtx.fillStyle = "#e33a17";
        iconCtx.beginPath();
        iconCtx.moveTo(0, 0.5); iconCtx.bezierCurveTo(-0.48, 0.08, -0.12, -0.12, -0.18, -0.5);
        iconCtx.bezierCurveTo(0.36, -0.16, 0.42, 0.03, 0, 0.5); iconCtx.fill();
        iconCtx.shadowBlur = 0;
        iconCtx.fillStyle = "#ffc247";
        iconCtx.beginPath();
        iconCtx.moveTo(0.02, 0.32); iconCtx.bezierCurveTo(-0.22, 0.03, 0.1, -0.02, 0.02, -0.22);
        iconCtx.bezierCurveTo(0.25, 0.05, 0.2, 0.2, 0.02, 0.32); iconCtx.fill();
        iconCtx.restore();
      };
      const drawTile = (tile, i) => {
        const x = i % r.mapWidth,
          y = Math.floor(i / r.mapWidth),
          cx = radius + hexW * (x + 0.5 * (y & 1)),
          cy = canvasY(y),
          left = cx - hexW / 2,
          top = cy - radius,
          featureName = h.saveMode ? saveFeatureName(tile.featureHash) : "";
        traceReplayHex(drawLayers.terrain.ctx, cx, cy, radius);
        drawLayers.terrain.ctx.save();
        drawLayers.terrain.ctx.clip();
        const base = terrainImages[replayTerrainName(tile.typeId, tile.isLake)];
        if (base)
          drawLayers.terrain.ctx.drawImage(base, left, top, hexW, radius * 2);
        else {
          drawLayers.terrain.ctx.fillStyle = terrainColor(tile.typeId);
          drawLayers.terrain.ctx.fill();
        }
        drawLayers.terrain.ctx.restore();
        for (const [layer, name] of [
          ["elevation", replayElevationName(tile.plotTypeId)],
          ["features", replayFeatureName(tile.featureId)],
        ]) {
          const image = terrainImages[name];
          if (!image) continue;
          const ctx = drawLayers[layer].ctx;
          traceReplayHex(ctx, cx, cy, radius);
          ctx.save();
          ctx.clip();
          ctx.drawImage(image, left, top, hexW, radius * 2);
          ctx.restore();
        }
        const ctx = iconCtx, featureCtx = drawLayers.features.ctx,
          resourceName = saveResourceName(tile.resourceHash),
          resourceIcon = tile.resourceHash ? tileIcons[`RESOURCE_${resourceName.toUpperCase()}`] : null,
          improvementIcon = tile.improvementName ? tileIcons[`IMPROVEMENT_${tile.improvementName}`] : null,
          featureIcon = featureName && !replayFeaturesRenderedSeparately.includes(featureName) ? tileIcons[`FEATURE_${featureName}`] : null,
          falloutIcon = featureName === "FALLOUT" ? tileIcons.FEATURE_FALLOUT : null;
        const dominantFeature = ["OASIS", "ATOLL", "MARSH"].includes(featureName);
        if (dominantFeature && featureIcon?.complete && featureIcon.naturalWidth) {
          featureCtx.save();
          traceReplayHex(featureCtx, cx, cy, radius);
          featureCtx.clip();
          featureCtx.globalAlpha = 0.92;
          featureCtx.drawImage(featureIcon, left + hexW * 0.06, top + radius * 0.06, hexW * 0.88, radius * 1.76);
          featureCtx.restore();
        }
        let resourceMarkerSize = 0, improvementMarkerSize = 0;
        if (tile.resourceHash) {
          resourceMarkerSize = Math.max(11, radius * 0.62);
          drawBadge(resourceIcon, cx, cy, resourceMarkerSize, "R", tile.quantityOutsideRules ? "#b42318" : "#643f20");
        }
        if (tile.improvementHash) {
          improvementMarkerSize = Math.max(9, radius * 0.42);
          const ix = cx + radius * 0.49, iy = cy + radius * 0.44;
          drawBadge(improvementIcon, ix, iy, improvementMarkerSize, tile.improvementPillaged ? "×" : "I", tile.improvementPillaged ? "#b42318" : "#643f20", tile.improvementPillaged ? "grayscale(1) brightness(.82)" : "none");
          if (tile.improvementPillaged) drawPillageFlame(ix + improvementMarkerSize * 0.42, iy - improvementMarkerSize * 0.4, improvementMarkerSize * 0.72);
        }
        if (falloutIcon) {
          if (resourceMarkerSize) drawFalloutOverlay(falloutIcon, cx, cy, resourceMarkerSize);
          if (improvementMarkerSize) drawFalloutOverlay(falloutIcon, cx + radius * 0.49, cy + radius * 0.44, improvementMarkerSize);
          if (!resourceMarkerSize && !improvementMarkerSize) drawBadge(falloutIcon, cx, cy, Math.max(13, radius * 0.72), "F", "#68714a");
        }
        if (tile.resourceHash && tile.resourceAmount > 1) {
          const amountBaseSize = tile.improvementHash ? improvementMarkerSize : resourceMarkerSize,
            amountBaseX = tile.improvementHash ? cx + radius * 0.49 : cx,
            amountBaseY = tile.improvementHash ? cy + radius * 0.44 : cy,
            amountX = amountBaseX + amountBaseSize * 0.38,
            amountY = amountBaseY + amountBaseSize * 0.38;
          ctx.save();
          ctx.fillStyle = "#fffdf0"; ctx.strokeStyle = "#643f20"; ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.arc(amountX, amountY, Math.max(4, amountBaseSize * 0.3), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = "#2f251b"; ctx.font = `bold ${Math.max(6, amountBaseSize * 0.4)}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(String(tile.resourceAmount), amountX, amountY); ctx.restore();
        }
        if (tile.featureHash && !dominantFeature && !replayFeaturesRenderedSeparately.includes(featureName)) drawBadge(featureIcon, cx - radius * 0.48, cy - radius * 0.42, Math.max(9, radius * 0.4), "F", "#315d3c");
        if (tile.underConstructionHash && !tile.improvementHash && tile.buildProgress?.some(({progress}) => progress > 0)) drawBadge(tileIcons[`IMPROVEMENT_${saveImprovementName(tile.underConstructionHash)}`], cx + radius * 0.48, cy - radius * 0.03, Math.max(9, radius * 0.38), "…", "#8b5e20");
        if (tile.units?.length) {
          const unit = tile.units[0], portraitIcon = unit.type && tileIcons[`UNIT_PORTRAIT_${unit.type}`];
          drawBadge(portraitIcon || tileIcons.ICON_UNIT_STACK, cx + radius * 0.48, cy - radius * 0.42,
            Math.max(9, radius * 0.4), tile.units.length > 9 ? "U" : String(tile.units.length), "#3a4f73", "none", portraitIcon ? 1.4 : 1);
        }
        if (tile.dataUnavailable) {
          const grid = drawLayers.grid.ctx;
          grid.save();
          traceReplayHex(grid, cx, cy, radius);
          grid.fillStyle = "rgba(139, 94, 32, 0.42)";
          grid.fill();
          grid.fillStyle = "#fffdf0";
          grid.font = `bold ${Math.max(12, radius * 0.9)}px sans-serif`;
          grid.textAlign = "center";
          grid.textBaseline = "middle";
          grid.fillText("?", cx, cy);
          grid.restore();
        }
        drawReplayRiver(
          drawLayers.rivers.ctx,
          cx,
          cy,
          radius,
          tile.riverMask,
          riverPattern,
        );
        const grid = drawLayers.grid.ctx;
        traceReplayHex(grid, cx, cy, radius);
        grid.strokeStyle = replayPalette.mapGrid;
        grid.lineWidth = 0.5;
        grid.stroke();
      };
      const drawBatch = (start) => {
        if (!box.contains(world)) return;
        const end = Math.min(tiles.length, start + 1024);
        for (let i = start; i < end; i++) drawTile(tiles[i], i);
        if (end < tiles.length) {
          setTimeout(() => drawBatch(end), 0);
          return;
        }
      drawReplayRoutes(drawLayers.routes.ctx, tiles, r.mapWidth, r.mapHeight, radius, hexW, canvasY);
      if (h.saveMode) {
        const savedCities = new Map((r.cities || []).map((city) => [`${city.owner}:${city.id}`, city]));
        for (const tile of tiles) {
          const cityRef = tile.plotCity;
          if (cityRef?.owner < 0 || cityRef?.id < 0 || cityRef?.owner == null || cityRef?.id == null) continue;
          const key = `${cityRef.owner}:${cityRef.id}`;
          if (!savedCities.has(key))
            savedCities.set(key, {...cityRef, x: tile.x, y: tile.y, razingTurns: 0});
        }
        for (const city of savedCities.values()) {
          const cx = radius + hexW * (city.x + 0.5 * (city.y & 1)),
            cy = canvasY(city.y),
            player = replayPlayers.get(city.owner),
            isMinor = player?.civilization === "CIVILIZATION_MINOR" || (player?.civilization || "").startsWith("MINOR_CIV_"),
            cityName = player?.displayCiv || player?.shortName || player?.name || "",
            cityTrait = cityStateTraits[normalizeReplayName(cityName)],
            cityImage = isMinor ? (cityTrait && cityIcons[cityTrait]) || cityIcons.CIV_CS_ICON : cityIcons.CIV_CITY_ICON,
            citySize = Math.min(hexW * 0.72, radius * 1.35);
          if (cityImage?.complete && cityImage.naturalWidth) {
            cityCtx.save();
            traceReplayHex(cityCtx, cx, cy, radius);
            cityCtx.clip();
            cityCtx.globalAlpha = isMinor ? 0.9 : 0.76;
            cityCtx.drawImage(cityImage, cx - citySize / 2, cy - citySize / 2, citySize, citySize);
            cityCtx.restore();
          }
          if (city.razingTurns > 0 && cityIcons.CITY_FIRING?.complete && cityIcons.CITY_FIRING.naturalWidth) {
            const fireSize = Math.min(hexW * 0.56, radius * 1.05);
            cityCtx.save();
            traceReplayHex(cityCtx, cx, cy, radius);
            cityCtx.clip();
            cityCtx.drawImage(cityIcons.CITY_FIRING, cx - fireSize / 2, cy - fireSize / 2, fireSize, fireSize);
            cityCtx.restore();
          }
        }
      }
      if (generation <= committedStaticDrawGeneration || !box.contains(world)) return;
      for (const name of staticLayerNames) {
        const target = layers[name].ctx;
        target.save();
        target.setTransform(1, 0, 0, 1, 0, 0);
        target.clearRect(0, 0, target.canvas.width, target.canvas.height);
        target.drawImage(drawLayers[name].canvas, 0, 0);
        target.restore();
      }
      committedStaticDrawGeneration = generation;
      };
      drawBatch(0);
    };
    const terrainImages = loadReplayTerrainImages();
    const cityIcons = loadReplayCityIcons();
    const tileIcons = h.saveMode ? loadReplayTileIcons(r.tiles, radius) : {};
    drawStaticLayers();
    Promise.all([terrainImages.ready, cityIcons.ready, tileIcons.ready]).then(() => {
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
        if (h.saveMode) {
          r.tiles.forEach((tile) => {
            const key = `${tile.x},${tile.y}`;
            if (tile.owner >= 0) owners.set(key, tile.owner);
            if (tile.plotCity?.owner >= 0 && tile.plotCity?.id >= 0 && !cities.has(key))
              cities.set(key, {x: tile.x, y: tile.y, owner: tile.plotCity.owner, id: tile.plotCity.id, eventText: `City #${tile.plotCity.id}`});
          });
          for (const city of r.cities || []) cities.set(`${city.x},${city.y}`, {
            ...city,
            eventText: `${saveCityDisplayName(city.name)} · ${city.population} population`,
          });
        }
      }
      currentOwners = owners;
      currentCities = cities;
      territoryTiles.forEach(({ key, cx, cy, tile }) => {
        const owner = owners.get(key),
          player = playerForMapOwner(owner);
        if (!player && key !== focusTileKey) return;
        traceReplayHex(ctx, cx, cy, radius);
        const city = cities.get(key) ||
            (h.saveMode && tile.plotCity?.owner >= 0 && tile.plotCity?.id >= 0
              ? tile.plotCity
              : null),
          isCityState =
            player?.civilization === "CIVILIZATION_MINOR" ||
            (player?.civilization || "").startsWith("MINOR_CIV_"),
          isMajorCity =
            city &&
            !isCityState &&
            player.civilization !== "CIVILIZATION_BARBARIAN";
        // The second palette swatch is the visible color for minor civs:
        // their first swatch is black for every city-state palette entry.
        const cityColor = player?.secondaryColor || player?.color;
        ctx.fillStyle = !player
          ? "rgba(255, 205, 54, .5)"
          : isCityState
            ? city
              ? cityColor
              : player.color
            : isMajorCity
              ? player.color
              : cityColor;
        ctx.fill();
      });
      territoryTiles.forEach(({ key, cx, cy, neighbors }) => {
        const owner = owners.get(key);
        if (owner === undefined || owner === null || owner === "") return;
        const player = playerForMapOwner(owner);
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
      if (!h.saveMode) for (const city of cities.values()) {
        const cx = radius + hexW * (city.x + 0.5 * (city.y & 1)),
          cy = canvasY(city.y),
          player = playerForMapOwner(city.owner);
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
        hoverState.tileIndex = null;
        return;
      }
      if (hoverState.tileIndex === tileIndex) return;
      hoverState.tileIndex = tileIndex;
      const x = tileIndex % r.mapWidth,
        y = Math.floor(tileIndex / r.mapWidth),
        hasUnmappedFeature = tile.featureHash && tile.featureId < 0,
        owner = currentOwners.get(`${x},${y}`),
        city = currentCities.get(`${x},${y}`),
        player = playerForMapOwner(owner),
        playerName = (slot) => civilizationDisplayName(playerForMapOwner(slot), slot),
        visibleTeamIds = orderVisibilityTeamIds((tile.visibilityCount || [])
          .map((count, teamId) => count > 0 && teamId < 64 ? teamId : -1)
          .filter((teamId) => teamId >= 0)),
        visibleTeamNames = visibleTeamIds.map((teamId) => replayTeamDisplayName(teamId, playersByTeam)),
        exploredTeamIds = orderVisibilityTeamIds((tile.revealedFlags || []).flatMap((word, wordIndex) =>
          Array.from({length: 32}, (_, bit) => wordIndex * 32 + bit)
            .filter((teamId) => teamId < 64 && ((word >>> (teamId % 32)) & 1)),
        )),
        exploredTeamNames = exploredTeamIds.map((teamId) => replayTeamDisplayName(teamId, playersByTeam)),
        crossingDirections = replayRiverCrossingLabel(tile.riverCrossing),
        anchorNames = ["Natural wonder", "Settler", "Worker"],
        archaeology = replayArchaeologyLabel(tile.archaeology, playerName),
        details = [
          `Tile ${x + 1}, ${y + 1}`,
          replayTerrainLabel(tile.typeId, tile.isLake),
          replayElevationLabel(tile.plotTypeId),
          tile.featureName ? `Feature: ${tile.featureName.replaceAll("_", " ")}` : hasUnmappedFeature ? `Unknown feature · ${tile.featureHash.toString(16).padStart(8, "0")}` : replayFeatureLabel(tile.featureId),
          tile.resourceHash ? `${saveResourceName(tile.resourceHash)}${tile.resourceAmount > 1 ? ` · ${tile.resourceAmount}` : ""}` : "",
          tile.improvementHash ? `${tile.improvementName ? tile.improvementName.replaceAll("_", " ") : `Unknown improvement ${tile.improvementHash.toString(16).padStart(8, "0")}`}${tile.improvementPillaged ? " · pillaged" : ""}` : "",
          tile.underConstructionHash && !tile.improvementHash && tile.buildProgress?.some(({progress}) => progress > 0) ? `Under construction · ${saveImprovementName(tile.underConstructionHash).replaceAll("_", " ") || tile.underConstructionHash.toString(16).padStart(8, "0")}` : "",
          tile.routeId === 0 ? `Road${tile.routePillaged ? " · pillaged" : ""}` : tile.routeId === 1 ? `Railroad${tile.routePillaged ? " · pillaged" : ""}` : "",
          tile.dataUnavailable ? "Tile fields not decoded · placeholder" : "",
          replayRiverLabel(tile.riverMask),
          player ? civilizationDisplayName(player, owner) : owner !== undefined && owner >= 0 ? civilizationDisplayName(null, owner) : "Unclaimed",
          tile.units?.length ? `Units: ${tile.units.map((unit) => unitDisplayName(unit, playerName)).join(", ")}` : "",
          h.saveMode && tile.city
            ? `${saveCityDisplayName(tile.city.name)} · ${tile.city.population} population`
            : h.saveMode && tile.plotCity?.owner >= 0 && tile.plotCity?.id >= 0
              ? `${playerName(tile.plotCity.owner)} · #${tile.plotCity.id}`
              : "",
          tile.culture ? `Culture stored here: ${tile.culture}` : "",
          tile.ownershipDuration ? `Owned for ${tile.ownershipDuration} turns` : "",
          tile.improvementDuration ? `Improvement built ${tile.improvementDuration} turns ago` : "",
          tile.upgradeProgress ? `Improvement upgrade progress: ${tile.upgradeProgress}` : "",
          tile.playerBuiltImprovement >= 0 ? `Improvement built by ${playerName(tile.playerBuiltImprovement)}` : "",
          Number.isInteger(tile.worldAnchor) && anchorNames[tile.worldAnchor] ? `Map marker: ${anchorNames[tile.worldAnchor]}` : "",
          tile.startingPlot ? "Starting location" : "",
          tile.potentialCityWork ? "Can be worked by a nearby city" : "",
          crossingDirections,
          exploredTeamNames.length ? `Explored by: ${exploredTeamNames.join(", ")}` : "",
          visibleTeamNames.length ? `Currently visible to: ${visibleTeamNames.join(", ")}` : "",
          tile.resourceForceReveal?.some(Boolean) ? `Resource revealed to ${tile.resourceForceReveal.filter(Boolean).length} teams` : "",
          tile.revealedOwner?.some((value) => value >= 0 && value !== owner) ? `Last known owner: ${[...new Set(tile.revealedOwner.filter((value) => value >= 0 && value !== owner).map(playerName))].join(", ")}` : "",
          tile.revealedImprovement?.some((hash) => hash && hash !== tile.improvementHash) ? `Previously seen improvements: ${[...new Set(tile.revealedImprovement.filter((hash) => hash && hash !== tile.improvementHash).map((hash) => saveImprovementName(hash)?.replaceAll("_", " ") || "unknown improvement"))].join(", ")}` : "",
          tile.revealedRoute?.some((value) => value >= 0) ? `Previously seen routes: ${[...new Set(tile.revealedRoute.filter((value) => value >= 0).map((value) => value === 0 ? "road" : value === 1 ? "railroad" : "other route"))].join(", ")}` : "",
          archaeology,
          tile.yields?.some(Boolean) ? {html: `<span class="tile-yield-list" aria-label="Tile yields">${tile.yields.map((value, i) => value ? `<span class="tile-yield" title="${replayYieldNames[i]} ${value}"><img src="assets/civ5-icons/${replayYieldIcons[i]}.png" alt="">${value}</span>` : "").filter(Boolean).join("")}</span>`} : "",
          !h.saveMode && city?.eventText ? `Event: ${city.eventText}` : "",
        ],
        viewportRect = viewport.getBoundingClientRect();
      tooltip.innerHTML = details.filter(Boolean).map((detail, index) => `<div class="tile-tooltip-row${index === 0 ? " tile-tooltip-title" : ""}">${typeof detail === "string" ? esc(detail) : detail.html}</div>`).join("");
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(8, Math.min(event.clientX - viewportRect.left + 14, viewport.clientWidth - tooltip.offsetWidth - 8))}px`;
      tooltip.style.top = `${Math.max(8, Math.min(event.clientY - viewportRect.top + 14, viewport.clientHeight - tooltip.offsetHeight - 8))}px`;
    });
    viewport.addEventListener("click", (event) => {
      if (!tileClickStart || Math.hypot(event.clientX - tileClickStart.x, event.clientY - tileClickStart.y) > 5 || event.target.closest(".map-zoom-controls")) {
        tileClickStart = null;
        return;
      }
      tileClickStart = null;
      const rect = world.getBoundingClientRect(),
        px = ((event.clientX - rect.left) * canvasWidth) / rect.width,
        py = canvasHeight - ((event.clientY - rect.top) * canvasHeight) / rect.height,
        index = locateReplayTile(px, py, r.mapWidth, r.mapHeight, radius, hexW),
        tile = index < 0 ? null : r.tiles[index];
      if (!tile) return;
      const x = index % r.mapWidth,
        y = Math.floor(index / r.mapWidth),
        owner = currentOwners.get(`${x},${y}`),
        city = currentCities.get(`${x},${y}`),
        label = (key) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase()),
        format = (value) => {
          if (value === null || value === undefined || value === "") return "—";
          if (typeof value === "boolean") return value ? "Yes" : "No";
          if (Array.isArray(value) || ArrayBuffer.isView(value)) return [...value].map((item) => typeof item === "number" && item < 0 ? "—" : item).join(", ") || "—";
          if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${label(key)}: ${format(item)}`).join(" · ");
          return String(value);
        },
        fields = [
          ["Coordinates", `${x + 1}, ${y + 1}`],
          ["Terrain", replayTerrainLabel(tile.typeId, tile.isLake)],
          ["Relief", replayElevationLabel(tile.plotTypeId)],
          ["Feature", tile.featureName?.replaceAll("_", " ") || (tile.featureHash ? `Unknown (${tile.featureHash.toString(16).padStart(8, "0")})` : replayFeatureLabel(tile.featureId))],
          ["Resource", tile.resourceHash ? `${saveResourceName(tile.resourceHash)}${tile.resourceAmount > 1 ? ` × ${tile.resourceAmount}` : ""}` : "None"],
          ["Improvement", tile.improvementHash ? `${tile.improvementName?.replaceAll("_", " ") || `Unknown (${tile.improvementHash.toString(16).padStart(8, "0")})`}${tile.improvementPillaged ? " (pillaged)" : ""}` : "None"],
          ["Route", tile.routeId === 0 ? `Road${tile.routePillaged ? " (pillaged)" : ""}` : tile.routeId === 1 ? `Railroad${tile.routePillaged ? " (pillaged)" : ""}` : "None"],
          ["Owner", owner >= 0 ? civilizationDisplayName(playerForMapOwner(owner), owner) : "Unclaimed"],
          ["Units", tile.units?.map((unit) => unitDisplayName(unit, (slot) => civilizationDisplayName(playerForMapOwner(slot), slot))).join(", ") || "None"],
          ...(tile.city
            ? [["City", `${saveCityDisplayName(tile.city.name)} · ${tile.city.population} population`]]
            : h.saveMode && tile.plotCity?.owner >= 0
              ? [["City", `${civilizationDisplayName(playerForMapOwner(tile.plotCity.owner), tile.plotCity.owner)} · #${tile.plotCity.id}`]]
              : []),
          ...(!h.saveMode && city?.eventText ? [["Event", city.eventText]] : []),
          ["Yields", tile.yields?.map((value, i) => value ? `${replayYieldNames[i]} ${value}` : "").filter(Boolean).join(" · ") || "—"],
          ...Object.entries(tile).filter(([key]) => !["x", "y", "typeId", "plotTypeId", "landmassId", "isLake", "featureId", "featureHash", "featureName", "resourceHash", "resourceAmount", "improvementHash", "improvementName", "improvementPillaged", "routeId", "routePillaged", "owner", "plotCity", "city", "yields", "units", "dataUnavailable"].includes(key)).map(([key, value]) => [label(key), format(value)]),
          ...(tile.dataUnavailable ? [["Decode status", "Tile fields were not decoded; map placeholder shown"]] : []),
        ];
      tileDialog.querySelector("#tileDetailsTitle").textContent = `Tile ${x + 1}, ${y + 1}`;
      tileDetails.innerHTML = `<dl>${fields.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`;
      tooltip.hidden = true;
      if (!tileDialog.open) tileDialog.showModal();
    });
    viewport.addEventListener("mouseleave", () => {
      tooltip.hidden = true;
      hoverState.tileIndex = null;
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
      hoverState.tileIndex = null;
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
    exportDialog.className = "animated-dialog map-export-dialog";
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
    if (h.saveMode) {
      redrawSaveMapInPlace = (displayMap) => {
        if (!box.contains(world)) return false;
        const version = ++saveMapUpdateVersion;
        const nextTileIcons = loadReplayTileIcons(displayMap.tiles, radius);
        nextTileIcons.ready.then(() => {
          if (version !== saveMapUpdateVersion || !box.contains(world)) return;
          Object.assign(tileIcons, nextTileIcons);
          r.tiles = displayMap.tiles;
          r.cities = displayMap.cities;
          territoryTiles.forEach((entry, index) => { entry.tile = r.tiles[index]; });
          drawStaticLayers();
          drawTerritory();
        });
        return true;
      };
    }
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
function drawReplayRoutes(ctx, tiles, mapWidth, mapHeight, radius, hexW, canvasY) {
  if (!ctx) return;
  const center = (x, y) => [radius + hexW * (x + 0.5 * (y & 1)), canvasY(y)];
  const strokeSegment = (start, end, routeId, pillaged) => {
    const [x1, y1] = start, [x2, y2] = end;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(pillaged ? [Math.max(2, radius * 0.22), Math.max(1.5, radius * 0.16)] : []);
    ctx.strokeStyle = "rgba(32, 27, 22, .88)";
    ctx.lineWidth = radius * (routeId === 1 ? 0.28 : 0.24);
    ctx.stroke();
    ctx.strokeStyle = routeId === 1 ? "#bdb8ad" : "#b69762";
    ctx.lineWidth = radius * (routeId === 1 ? 0.17 : 0.13);
    ctx.stroke();
    if (routeId === 1 && !pillaged) {
      ctx.setLineDash([Math.max(1.5, radius * 0.12), Math.max(1.5, radius * 0.12)]);
      ctx.strokeStyle = "#48443d";
      ctx.lineWidth = Math.max(0.7, radius * 0.045);
      ctx.stroke();
    } else if (routeId === 0 && !pillaged) {
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(255, 231, 177, .8)";
      ctx.lineWidth = Math.max(0.55, radius * 0.035);
      ctx.stroke();
    }
    ctx.restore();
  };
  const connect = (x1, y1, x2, y2) => {
    if (x2 < 0 || x2 >= mapWidth || y2 < 0 || y2 >= mapHeight) return;
    const a = tiles[y1 * mapWidth + x1], b = tiles[y2 * mapWidth + x2];
    if (!a || !b || a.dataUnavailable || b.dataUnavailable || ![0, 1].includes(a.routeId) || ![0, 1].includes(b.routeId)) return;
    const start = center(x1, y1), end = center(x2, y2);
    if (a.routeId === b.routeId) {
      strokeSegment(start, end, a.routeId, a.routePillaged || b.routePillaged);
      return;
    }
    const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    strokeSegment(start, midpoint, a.routeId, a.routePillaged);
    strokeSegment(midpoint, end, b.routeId, b.routePillaged);
  };
  for (let y = 0; y < mapHeight; y++) {
    for (let x = 0; x < mapWidth; x++) {
      connect(x, y, x + 1, y);
      const lowerRowX = y & 1 ? x : x - 1;
      connect(x, y, lowerRowX, y + 1);
      connect(x, y, lowerRowX + 1, y + 1);
    }
  }
}
function loadReplayImages(names, sourceFor, keyFor = (name) => name) {
  const images = {};
  images.ready = Promise.all([...names].map((name) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => { images[keyFor(name)] = image; resolve(); };
    image.onerror = resolve;
    image.src = sourceFor(name);
  })));
  return images;
}
function loadReplayTerrainImages() {
  const names = "GRASSLAND PLAINS DESERT TUNDRA SNOW COAST OCEAN LAKE MOUNTAIN HILLS ICE JUNGLE FOREST".split(" ");
  return loadReplayImages(names, (name) => `assets/terrain/${name}.png`);
}
function loadReplayCityIcons() {
  const names = ["CIV_CITY_ICON", "CIV_CS_ICON", "CITY_FIRING", "Cultured", "Maritime", "Mercantile", "Militaristic", "Religious"];
  return loadReplayImages(
    names,
    (name) => `assets/civ5-icons/${name}.png`,
    (name) => name === "CIV_CS_ICON" ? name : name.toUpperCase(),
  );
}
function loadReplayTileIcons(tiles, radius) {
  const names = new Set();
  for (const tile of tiles) {
    const resource = saveResourceName(tile.resourceHash);
    if (tile.resourceHash && !resource.startsWith("Unknown resource ")) names.add(`RESOURCE_${resource.toUpperCase()}`);
    const improvement = saveImprovementName(tile.improvementHash);
    if (tile.improvementHash && improvement) names.add(`IMPROVEMENT_${improvement}`);
    const plannedImprovement = saveImprovementName(tile.underConstructionHash);
    if (tile.underConstructionHash && !tile.improvementHash && tile.buildProgress?.some(({progress}) => progress > 0) && plannedImprovement) names.add(`IMPROVEMENT_${plannedImprovement}`);
    const feature = saveFeatureName(tile.featureHash);
    if (tile.featureHash && feature && !["ICE", "JUNGLE", "FOREST", "FLOOD_PLAINS"].includes(feature)) names.add(`FEATURE_${feature}`);
    if (tile.units?.length) {
      names.add("ICON_UNIT_STACK");
      for (const unit of tile.units) if (unit.type) names.add(`UNIT_PORTRAIT_${unit.type}`);
    }
  }
  const images = loadReplayImages(names, (name) => name.startsWith("UNIT_PORTRAIT_")
    ? `assets/unit-portraits/${name.slice("UNIT_PORTRAIT_".length)}.png`
    : `assets/civ5-icons/${name}.png`);
  images.ready = images.ready.then(() => {
    const portraitRows = tiles.flatMap((tile) => (tile.units || []).map((unit) => {
      const key = unit.type ? `UNIT_PORTRAIT_${unit.type}` : "ICON_UNIT_STACK";
      const image = images[key];
      const badgeSize = Math.max(9, radius * 0.4);
      const portraitScale = unit.type && image?.naturalWidth ? 1.4 : 1;
      const assetPath = unit.type
        ? `assets/unit-portraits/${unit.type}.png`
        : `assets/civ5-icons/${key}.png`;
      return {
        tile: `${tile.x + 1}, ${tile.y + 1}`,
        owner: unit.owner,
        id: unit.id,
        type: unit.type || "UNKNOWN",
        asset: key,
        assetPath,
        loaded: Boolean(image?.complete && image.naturalWidth),
        naturalSize: image?.naturalWidth ? `${image.naturalWidth}×${image.naturalHeight}` : "missing",
        badgeSize: Number(badgeSize.toFixed(1)),
        portraitDrawSize: Number((badgeSize * portraitScale).toFixed(1)),
      };
    }));
    if (debugEnabled) {
      console.groupCollapsed(`[Civ5] Unit icon assets · ${portraitRows.length} map references`);
      console.table(portraitRows);
      console.groupEnd();
    }
  });
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
function replayTerrainName(id, isLake = false) {
  if (isLake) return "LAKE";
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
function replayRiverCrossingLabel(mask) {
  if (!mask) return "";
  const directions = ["north-east", "east", "south-east", "south-west", "west", "north-west"];
  const crossings = directions.filter((_, direction) => mask & (1 << direction));
  return crossings.length ? `River crossing toward ${crossings.join(", ")}` : "";
}
function replayArchaeologyLabel(data, playerName) {
  if (!data?.length) return "";
  const [artifactId, eraId, firstPlayer, secondPlayer, workId] = data;
  const artifacts = ["", "ranged battle", "melee battle", "barbarian camp", "ancient ruins", "razed city", "written history"],
    eras = ["Ancient", "Classical", "Medieval", "Renaissance", "Industrial", "Modern", "Atomic", "Information"];
  const facts = [];
  if (artifactId > 0) facts.push(artifacts[artifactId] ? `event: ${artifacts[artifactId]}` : "historical event");
  if (eraId >= 0) facts.push(`${eras[eraId] || `era ${eraId}`} era`);
  const participants = [firstPlayer, secondPlayer].filter((id) => id >= 0);
  if (participants.length) facts.push(`involving ${[...new Set(participants.map(playerName))].join(" and ")}`);
  if (workId >= 0) facts.push("associated with a great work");
  return facts.length ? `Archaeological record: ${facts.join(", ")}` : "";
}
function replayFeatureName(id) {
  return { 0: "ICE", 1: "JUNGLE", 4: "PLAINS", 5: "FOREST" }[id];
}
function replayTerrainLabel(id, isLake = false) {
  if (isLake) return "Lake";
  return (
    ({0:"Grassland",1:"Plains",2:"Desert",3:"Tundra",4:"Snow",5:"Coast",6:"Ocean",18:"Sri Pada",19:"Mount Sinai"})[id] ||
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
      6: "Fallout",
      7: "Barringer Crater",
      8: "Mount Fuji",
      9: "Mesa",
      10: "Reef",
      11: "Volcano",
      12: "Gibraltar",
      13: "Geyser",
      14: "Fountain of Youth",
      15: "Cerro de Potosí",
      16: "El Dorado",
      17: "Atoll",
      18: "Sri Pada",
      19: "Mount Sinai",
    }[id] || ""
  );
}
document
  .querySelectorAll(".tabs button")
  .forEach((b) => b.addEventListener("click", () => renderTab(b.dataset.tab, { navigate: true })));
