#!/usr/bin/env node
/**
 * memory-tencentdb bundle — Export/import memory in portable .memory-bundle format.
 *
 * Usage:
 *   node --import tsx scripts/bundle.ts export [--data-dir <dir>] [--output <file>]
 *   node --import tsx scripts/bundle.ts import <bundle-path> [--data-dir <dir>] [--strategy merge|replace]
 *
 * Bundle format: tar.gz with:
 *   manifest.json          — version, source, timestamps, checksums
 *   conversations.jsonl    — L0 raw conversations
 *   atoms.jsonl            — L1 atomic memories
 *   scenarios/             — L2 scenario blocks (markdown)
 *   persona.md             — L3 persona profile
 *   skills/                — skill definitions + resources
 *
 * Designed for:
 *   - Portability between TencentDB instances
 *   - Migration from other memory systems (Mem0, Zep)
 *   - Backup/restore with human-readable format
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getEnv } from "../src/utils/env.js";

const TAG = "[tdai-bundle]";
const BUNDLE_VERSION = 1;

// ── Helpers ──

function resolveDataDir(): string {
  const explicit = getEnv("TDAI_DATA_DIR")?.trim();
  if (explicit) return explicit;
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";
  return path.join(home, ".memory-tencentdb", "memory-tdai");
}

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex").slice(0, 16);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

function writeJsonl<T>(filePath: string, records: T[]): void {
  const lines = records.map((r) => JSON.stringify(r));
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

// ── Export ──

function cmdExport(args: string[]): void {
  let dataDir = resolveDataDir();
  let output = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir" && args[i + 1]) dataDir = args[++i]!;
    if (args[i] === "--output" && args[i + 1]) output = args[++i]!;
  }

  if (!fs.existsSync(dataDir)) {
    console.error(`${TAG} Data directory not found: ${dataDir}`);
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bundleName = `memory-bundle-${timestamp}`;
  const tmpDir = path.join(dataDir, ".bundle-export-tmp", bundleName);
  ensureDir(tmpDir);

  console.log(`${TAG} Exporting bundle from: ${dataDir}`);

  // 1. Collect L0 conversations
  const conversationsDir = path.join(dataDir, "conversations");
  const l0Records: Array<Record<string, unknown>> = [];
  if (fs.existsSync(conversationsDir)) {
    for (const file of fs.readdirSync(conversationsDir).sort()) {
      if (!file.endsWith(".jsonl")) continue;
      const records = readJsonl<Record<string, unknown>>(path.join(conversationsDir, file));
      l0Records.push(...records);
    }
  }
  writeJsonl(path.join(tmpDir, "conversations.jsonl"), l0Records);
  console.log(`${TAG}   L0 conversations: ${l0Records.length}`);

  // 2. Collect L1 atoms
  const recordsDir = path.join(dataDir, "records");
  const l1Records: Array<Record<string, unknown>> = [];
  if (fs.existsSync(recordsDir)) {
    for (const file of fs.readdirSync(recordsDir).sort()) {
      if (!file.endsWith(".jsonl")) continue;
      const records = readJsonl<Record<string, unknown>>(path.join(recordsDir, file));
      l1Records.push(...records);
    }
  }
  writeJsonl(path.join(tmpDir, "atoms.jsonl"), l1Records);
  console.log(`${TAG}   L1 atoms: ${l1Records.length}`);

  // 3. Collect L2 scenarios
  const sceneBlocksDir = path.join(dataDir, "scene_blocks");
  if (fs.existsSync(sceneBlocksDir)) {
    const scenariosDir = path.join(tmpDir, "scenarios");
    ensureDir(scenariosDir);
    let sceneCount = 0;
    for (const file of fs.readdirSync(sceneBlocksDir)) {
      const src = path.join(sceneBlocksDir, file);
      const dest = path.join(scenariosDir, file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, dest);
        sceneCount++;
      }
    }
    console.log(`${TAG}   L2 scenarios: ${sceneCount}`);
  }

  // 4. Collect L3 persona
  const personaPath = path.join(dataDir, "persona.md");
  if (fs.existsSync(personaPath)) {
    fs.copyFileSync(personaPath, path.join(tmpDir, "persona.md"));
    console.log(`${TAG}   L3 persona: 1`);
  }

  // 5. Collect skills
  const skillsDir = path.join(dataDir, "skills");
  if (fs.existsSync(skillsDir)) {
    const bundleSkillsDir = path.join(tmpDir, "skills");
    ensureDir(bundleSkillsDir);
    let skillCount = 0;
    for (const skillName of fs.readdirSync(skillsDir)) {
      const src = path.join(skillsDir, skillName);
      if (!fs.statSync(src).isDirectory()) continue;
      const dest = path.join(bundleSkillsDir, skillName);
      execSync(`cp -r "${src}" "${dest}"`);
      skillCount++;
    }
    console.log(`${TAG}   Skills: ${skillCount}`);
  }

  // 6. Write manifest
  const manifest = {
    version: BUNDLE_VERSION,
    format: "memory-bundle",
    createdAt: new Date().toISOString(),
    source: {
      dataDir,
      hostname: execSync("hostname").toString().trim(),
    },
    stats: {
      l0Count: l0Records.length,
      l1Count: l1Records.length,
    },
    checksums: {
      conversations: sha256(JSON.stringify(l0Records)),
      atoms: sha256(JSON.stringify(l1Records)),
    },
  };
  fs.writeFileSync(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // 7. Create tar.gz archive
  const outputPath = output || path.join(dataDir, `${bundleName}.memory-bundle.tar.gz`);
  ensureDir(path.dirname(outputPath));
  execSync(`tar -czf "${outputPath}" -C "${path.dirname(tmpDir)}" "${bundleName}"`, { timeout: 300_000 });

  // 8. Cleanup
  execSync(`rm -rf "${path.join(dataDir, ".bundle-export-tmp")}"`);

  const sizeMB = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2);
  console.log(`${TAG} ✓ Bundle exported: ${outputPath} (${sizeMB} MB)`);
}

// ── Import ──

function cmdImport(args: string[]): void {
  let dataDir = resolveDataDir();
  let strategy: "merge" | "replace" = "merge";

  if (args.length < 1) {
    console.error(`${TAG} Usage: import <bundle-path> [--data-dir <dir>] [--strategy merge|replace]`);
    process.exit(1);
  }

  const bundlePath = args[0]!;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--data-dir" && args[i + 1]) dataDir = args[++i]!;
    if (args[i] === "--strategy" && args[i + 1]) strategy = args[++i]! as "merge" | "replace";
  }

  if (!fs.existsSync(bundlePath)) {
    console.error(`${TAG} Bundle not found: ${bundlePath}`);
    process.exit(1);
  }

  console.log(`${TAG} Importing bundle: ${bundlePath}`);
  console.log(`${TAG} Target: ${dataDir} (strategy: ${strategy})`);

  // 1. Extract to temp dir
  const tmpDir = path.join(dataDir, ".bundle-import-tmp");
  ensureDir(tmpDir);
  execSync(`tar -xzf "${bundlePath}" -C "${tmpDir}"`, { timeout: 300_000 });

  const entries = fs.readdirSync(tmpDir);
  if (entries.length !== 1) {
    console.error(`${TAG} Expected exactly one top-level dir in bundle`);
    execSync(`rm -rf "${tmpDir}"`);
    process.exit(1);
  }
  const bundleDir = path.join(tmpDir, entries[0]!);

  // 2. Read manifest
  const manifestPath = path.join(bundleDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`${TAG} Invalid bundle: manifest.json not found`);
    execSync(`rm -rf "${tmpDir}"`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  console.log(`${TAG} Bundle version: ${manifest.version}, created: ${manifest.createdAt}`);
  console.log(`${TAG} Source: ${manifest.source?.hostname ?? "unknown"}`);
  console.log(`${TAG} Stats: L0=${manifest.stats?.l0Count ?? 0}, L1=${manifest.stats?.l1Count ?? 0}`);

  // 3. Import L0 conversations
  const conversationsSrc = path.join(bundleDir, "conversations.jsonl");
  if (fs.existsSync(conversationsSrc)) {
    const conversationsDest = path.join(dataDir, "conversations");
    ensureDir(conversationsDest);
    const records = readJsonl<Record<string, unknown>>(conversationsSrc);
    if (strategy === "replace") {
      // Clear existing
      for (const f of fs.readdirSync(conversationsDest)) {
        if (f.endsWith(".jsonl")) fs.unlinkSync(path.join(conversationsDest, f));
      }
    }
    // Write as date-grouped files
    const byDate = new Map<string, Array<Record<string, unknown>>>();
    for (const record of records) {
      const recordedAt = String(record.recorded_at ?? record.timestamp ?? "");
      const date = recordedAt.slice(0, 10) || "unknown";
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(record);
    }
    for (const [date, dateRecords] of byDate) {
      const filePath = path.join(conversationsDest, `${date}.jsonl`);
      const existing = strategy === "merge" ? readJsonl<Record<string, unknown>>(filePath) : [];
      writeJsonl(filePath, [...existing, ...dateRecords]);
    }
    console.log(`${TAG}   Imported L0: ${records.length} messages`);
  }

  // 4. Import L1 atoms
  const atomsSrc = path.join(bundleDir, "atoms.jsonl");
  if (fs.existsSync(atomsSrc)) {
    const recordsDest = path.join(dataDir, "records");
    ensureDir(recordsDest);
    const records = readJsonl<Record<string, unknown>>(atomsSrc);
    if (strategy === "replace") {
      for (const f of fs.readdirSync(recordsDest)) {
        if (f.endsWith(".jsonl")) fs.unlinkSync(path.join(recordsDest, f));
      }
    }
    const byDate = new Map<string, Array<Record<string, unknown>>>();
    for (const record of records) {
      const updatedAt = String(record.updated_at ?? record.updated_time ?? "");
      const date = updatedAt.slice(0, 10) || "unknown";
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(record);
    }
    for (const [date, dateRecords] of byDate) {
      const filePath = path.join(recordsDest, `${date}.jsonl`);
      const existing = strategy === "merge" ? readJsonl<Record<string, unknown>>(filePath) : [];
      writeJsonl(filePath, [...existing, ...dateRecords]);
    }
    console.log(`${TAG}   Imported L1: ${records.length} atoms`);
  }

  // 5. Import L2 scenarios
  const scenariosSrc = path.join(bundleDir, "scenarios");
  if (fs.existsSync(scenariosSrc)) {
    const scenariosDest = path.join(dataDir, "scene_blocks");
    if (strategy === "replace" && fs.existsSync(scenariosDest)) {
      execSync(`rm -rf "${scenariosDest}"`);
    }
    ensureDir(scenariosDest);
    let count = 0;
    for (const file of fs.readdirSync(scenariosSrc)) {
      fs.copyFileSync(path.join(scenariosSrc, file), path.join(scenariosDest, file));
      count++;
    }
    console.log(`${TAG}   Imported L2: ${count} scenarios`);
  }

  // 6. Import L3 persona
  const personaSrc = path.join(bundleDir, "persona.md");
  if (fs.existsSync(personaSrc)) {
    if (strategy === "replace" || !fs.existsSync(path.join(dataDir, "persona.md"))) {
      fs.copyFileSync(personaSrc, path.join(dataDir, "persona.md"));
      console.log(`${TAG}   Imported L3: persona`);
    } else {
      console.log(`${TAG}   Skipped L3 persona (merge mode, existing preserved)`);
    }
  }

  // 7. Import skills
  const skillsSrc = path.join(bundleDir, "skills");
  if (fs.existsSync(skillsSrc)) {
    const skillsDest = path.join(dataDir, "skills");
    if (strategy === "replace" && fs.existsSync(skillsDest)) {
      execSync(`rm -rf "${skillsDest}"`);
    }
    ensureDir(skillsDest);
    let count = 0;
    for (const skillName of fs.readdirSync(skillsSrc)) {
      const src = path.join(skillsSrc, skillName);
      const dest = path.join(skillsDest, skillName);
      if (fs.statSync(src).isDirectory()) {
        if (strategy === "merge" && fs.existsSync(dest)) {
          // Merge: skip existing skills
          console.log(`${TAG}   Skipped skill: ${skillName} (already exists)`);
          continue;
        }
        execSync(`cp -r "${src}" "${dest}"`);
        count++;
      }
    }
    console.log(`${TAG}   Imported skills: ${count}`);
  }

  // 8. Cleanup
  execSync(`rm -rf "${tmpDir}"`);
  console.log(`${TAG} ✓ Bundle imported successfully`);
}

// ── Main ──

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "export":
    cmdExport(args);
    break;
  case "import":
    cmdImport(args);
    break;
  default:
    console.error(`${TAG} Usage: bundle <export|import> [options]`);
    console.error(`  export   [--data-dir <dir>] [--output <file>]`);
    console.error(`  import   <bundle-path> [--data-dir <dir>] [--strategy merge|replace]`);
    process.exit(1);
}
