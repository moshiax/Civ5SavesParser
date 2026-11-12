import { readdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseSave } from "./save-parser.mjs";

const args = process.argv.slice(2);
const full = args.includes("--full");
const summary = args.includes("--summary");
const strict = args.includes("--strict");
const sinceDaysArg = args.find((arg) => arg.startsWith("--since-days="));
const sinceDays = sinceDaysArg ? Number(sinceDaysArg.slice("--since-days=".length)) : 0;
const inputs = args.filter((arg) => !["--full", "--summary", "--strict"].includes(arg) && !arg.startsWith("--since-days="));

if (!inputs.length) {
  console.error("Usage: node parse-saves.mjs [--summary|--full] [--strict] [--since-days=N] <save-or-folder> [...]");
  process.exitCode = 2;
} else {
  const files = [];
  const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400000 : 0;
  for (const input of inputs) await collect(resolve(input), files, cutoff);
  const results = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await readFile(file));
      const data = await parseSave(bytes, basename(file), {recoverMap: !strict});
      const map = data.saveMap;
      const mapSummary = map && summarizeMap(map);
      const result = {
        path: file,
        header: data.header,
        payload: { bytes: data.payload.bytes, playedSeconds: data.payload.playedSeconds },
        map: map && (full ? map : {
          ...mapSummary,
          resourceSetting: map.resourceSetting,
          resourceInventory: map.resourceInventory,
          anomalies: map.anomalies,
        }),
      };
      results.push(summary ? {
        path: file,
        turn: data.header.turn,
        saveVersion: data.header.saveVersion,
        gameVersion: data.header.gameVersion,
        build: data.header.build,
        players: data.header.players.length,
        payloadBytes: data.payload.bytes,
        map: map && {
          ...mapSummary,
          anomalyCount: map.anomalies.length,
        },
      } : result);
    } catch (error) {
      results.push({ path: file, error: error?.message || String(error) });
    }
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (results.some((result) => result.error)) process.exitCode = 1;
}

function summarizeMap(map) {
  return {
    width: map.mapWidth,
    height: map.mapHeight,
    parsedTiles: map.parsedTiles,
    totalTiles: map.tiles.length,
    complete: map.complete,
    decodeIssue: map.decodeIssue,
    entities: map.entities,
  };
}

async function collect(path, files, cutoff) {
  const info = await stat(path);
  if (info.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && [".git", "node_modules"].includes(entry.name)) continue;
      await collect(resolve(path, entry.name), files, cutoff);
    }
  } else if (/\.civ5save$/i.test(path) && (!cutoff || info.mtimeMs >= cutoff)) files.push(path);
}
