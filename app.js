"use strict";
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
  return (
    ["Open", "AI", "Closed", "Human", "Observer"][status] ||
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
  return text.startsWith(prefix)
    ? text.slice(prefix.length).replaceAll("_", " ")
    : text;
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
    f.name.toLowerCase().endsWith(".civ5save"),
  );
  if (file) inspect(file);
  else setStatus("Drop a .Civ5Save file.", true);
});
async function inspect(file) {
  if (!file.name.toLowerCase().endsWith(".civ5save"))
    return setStatus("This is not a .Civ5Save file.", true);
  $("#dropTitle").textContent = file.name;
  $("#dropHint").hidden = false;
  $("#dropHint").textContent =
    `${humanBytes(file.size)} · Reading save header and compressed payload…`;
  setStatus("Reading save…");
  $("#result").hidden = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const data = await parseSave(
      new Uint8Array(await file.arrayBuffer()),
      file.name,
    );
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
    playerNames = getStrings(23);
  const players = statuses
    .map((status, i) => ({
      slot: i,
      status,
      civilization: playerCivs[i] || "",
      name: playerNames[i] || "",
    }))
    .filter((x) => x.status > 0 && x.status < 4 && x.civilization);
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
  drawPlayers(h.players || []);
  renderTab(activeTab);
}
function drawPlayers(players) {
  const wrap = $("#playerOverview"),
    major = players.filter(
      (p) =>
        p.civilization !== "CIVILIZATION_MINOR" &&
        p.civilization !== "CIVILIZATION_BARBARIAN",
    ),
    minor = players.filter((p) => p.civilization === "CIVILIZATION_MINOR"),
    barbarian = players.filter(
      (p) => p.civilization === "CIVILIZATION_BARBARIAN",
    );
  if (!players.length) {
    wrap.innerHTML =
      '<div class="map-empty">Player slots were not found in the save header.</div>';
    return;
  }
  wrap.innerHTML = `<div class="player-list">${major
    .map((p) => {
      const civ = p.civilization || "UNKNOWN CIV",
        label = gameEnumLabel(civ, "CIVILIZATION_"),
        short = label.slice(0, 2),
        playerName = p.name || label,
        steamId = steamProfileId(playerName),
        playerLabel = steamId
          ? `<a class="steam-profile" href="https://steamcommunity.com/profiles/${steamId}" target="_blank" rel="noopener noreferrer">${esc(playerName)}</a>`
          : esc(playerName),
        hue = civHue(civ),
        civKey = civ.replace(/^CIVILIZATION_/, "").toLowerCase();
      const mark = `<img class="civ-mark civ-mark-image" src="assets/civ-icons/${civKey}.png" alt="${esc(label)} emblem" title="${esc(label)}"><span hidden class="civ-mark civ-mark-fallback" style="--civ-hue:${hue}" aria-label="${esc(label)}">${esc(short)}</span>`;
      return `<div class="player-row${p.status === 3 ? " human" : ""}"><span class="player-slot">${String(p.slot).padStart(2, "0")}</span>${mark}<span class="player-info"><strong>${playerLabel}</strong><small>${esc(civ)}</small></span><span class="player-status">${slotStatus(p.status)}</span></div>`;
    })
    .join(
      "",
    )}</div><div class="slot-groups">${minor.length ? `<div class="slot-group">MINOR CIVILIZATIONS <b>${minor.length}</b></div>` : ""}${barbarian.length ? `<div class="slot-group">BARBARIANS <b>${barbarian.length}</b></div>` : ""}</div>`;
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
function renderTab(tab) {
  activeTab = tab;
  document
    .querySelectorAll(".tabs button")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (!current) return;
  const p = current.payload,
    h = current.header,
    box = $("#tabContent");
  if (tab === "summary")
    box.textContent = [
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
    ].join("\n");
  if (tab === "strings")
    box.textContent =
      [...p.tokens, ...p.strings].join("\n") ||
      "No readable strings found in payload.";
  if (tab === "players")
    box.textContent =
      (h.players || [])
        .map(
          (p) =>
            `Slot ${String(p.slot).padStart(2, "0")} · ${slotStatus(p.status)} · ${gameEnumLabel(p.civilization, "CIVILIZATION_") || "(no civilization id)"}${p.name ? ` · ${p.name}` : ""}`,
        )
        .join("\n") || "No player slots found.";
}
document
  .querySelectorAll(".tabs button")
  .forEach((b) => b.addEventListener("click", () => renderTab(b.dataset.tab)));
