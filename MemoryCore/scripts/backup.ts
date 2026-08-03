#!/usr/bin/env node
/**
 * memory-tencentdb backup — SQLite backup/restore CLI.
 *
 * Usage:
 *   node --import tsx scripts/backup.ts create [--output <dir>]
 *   node --import tsx scripts/backup.ts restore <backup-path>
 *   node --import tsx scripts/backup.ts list [--data-dir <dir>]
 *   node --import tsx scripts/backup.ts prune [--keep <n>]
 *
 * Creates incremental SQLite backups using VACUUM INTO + file asset snapshot.
 * Backup artifact: <output>/<timestamp>-<hash>.tar.gz
 */

import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getEnv } from "../src/utils/env.js";

const TAG = "[tdai-backup]";

// ── Helpers ──

function resolveDataDir(): string {
  const explicit = getEnv("TDAI_DATA_DIR")?.trim();
  if (explicit) return explicit;
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";
  return path.join(home, ".memory-tencentdb", "memory-tdai");
}

function resolveBackupDir(dataDir: string): string {
  return path.join(dataDir, "backups");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function shortHash(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 8);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function listSqliteDbs(dataDir: string): string[] {
  const dbs: string[] = [];
  const vectorsDb = path.join(dataDir, "vectors.db");
  if (fs.existsSync(vectorsDb)) dbs.push(vectorsDb);
  // Check for metadata DB
  const metaDir = path.join(dataDir, "metadata");
  if (fs.existsSync(metaDir)) {
    for (const f of fs.readdirSync(metaDir)) {
      if (f.endsWith(".db")) dbs.push(path.join(metaDir, f));
    }
  }
  return dbs;
}

function listFileAssets(dataDir: string): string[] {
  const assets: string[] = [];
  const sceneBlocks = path.join(dataDir, "scene_blocks");
  if (fs.existsSync(sceneBlocks)) assets.push(sceneBlocks);
  const persona = path.join(dataDir, "persona.md");
  if (fs.existsSync(persona)) assets.push(persona);
  const skills = path.join(dataDir, "skills");
  if (fs.existsSync(skills)) assets.push(skills);
  const conversations = path.join(dataDir, "conversations");
  if (fs.existsSync(conversations)) assets.push(conversations);
  const records = path.join(dataDir, "records");
  if (fs.existsSync(records)) assets.push(records);
  return assets;
}

// ── Commands ──

function cmdCreate(args: string[]): void {
  let outputDir = "";
  let dataDir = resolveDataDir();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) outputDir = args[++i]!;
    if (args[i] === "--data-dir" && args[i + 1]) dataDir = args[++i]!;
  }

  if (!fs.existsSync(dataDir)) {
    console.error(`${TAG} Data directory not found: ${dataDir}`);
    process.exit(1);
  }

  const backupRoot = resolveBackupDir(dataDir);
  const ts = timestamp();
  const backupId = `${ts}-${shortHash(ts)}`;
  const backupDir = path.join(backupRoot, backupId);
  ensureDir(backupDir);

  console.log(`${TAG} Creating backup: ${backupId}`);
  console.log(`${TAG} Data dir: ${dataDir}`);
  console.log(`${TAG} Backup dir: ${backupDir}`);

  // 1. Backup SQLite databases using VACUUM INTO
  const dbs = listSqliteDbs(dataDir);
  const dbBackupDir = path.join(backupDir, "databases");
  ensureDir(dbBackupDir);

  for (const dbPath of dbs) {
    const dbName = path.basename(dbPath);
    const backupPath = path.join(dbBackupDir, `${dbName}.bak`);
    console.log(`${TAG} Backing up SQLite: ${dbName} -> ${backupPath}`);
    try {
      // Use sqlite3 CLI for VACUUM INTO (works with any SQLite version)
      execSync(`sqlite3 "${dbPath}" "VACUUM INTO '${backupPath}'"`, { timeout: 60_000 });
      console.log(`${TAG}   ✓ ${dbName} (${(fs.statSync(backupPath).size / 1024).toFixed(1)} KB)`);
    } catch (err) {
      console.error(`${TAG}   ✗ ${dbName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Copy file assets
  const assets = listFileAssets(dataDir);
  const assetsDir = path.join(backupDir, "assets");
  ensureDir(assetsDir);

  for (const assetPath of assets) {
    const assetName = path.basename(assetPath);
    const destPath = path.join(assetsDir, assetName);
    console.log(`${TAG} Copying asset: ${assetName}`);
    try {
      execSync(`cp -r "${assetPath}" "${destPath}"`, { timeout: 120_000 });
      const stat = fs.statSync(destPath);
      const size = stat.isDirectory()
        ? execSync(`du -sh "${destPath}" | cut -f1`).toString().trim()
        : `${(stat.size / 1024).toFixed(1)} KB`;
      console.log(`${TAG}   ✓ ${assetName} (${size})`);
    } catch (err) {
      console.error(`${TAG}   ✗ ${assetName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Write manifest
  const manifest = {
    version: 1,
    backupId,
    createdAt: new Date().toISOString(),
    dataDir,
    databases: dbs.map((p) => path.basename(p)),
    assets: assets.map((p) => path.basename(p)),
    config: {
      tdaiGatewayYaml: fs.existsSync(path.join(dataDir, "..", "tdai-gateway.yaml"))
        ? fs.readFileSync(path.join(dataDir, "..", "tdai-gateway.yaml"), "utf-8")
        : null,
    },
  };
  fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // 4. Create tar.gz archive
  const archiveName = `${backupId}.tar.gz`;
  const archivePath = outputDir
    ? path.join(outputDir, archiveName)
    : path.join(backupRoot, archiveName);
  ensureDir(path.dirname(archivePath));

  console.log(`${TAG} Creating archive: ${archivePath}`);
  execSync(`tar -czf "${archivePath}" -C "${backupRoot}" "${backupId}"`, { timeout: 300_000 });

  // 5. Cleanup temp dir
  execSync(`rm -rf "${backupDir}"`);

  const archiveSize = (fs.statSync(archivePath).size / (1024 * 1024)).toFixed(2);
  console.log(`${TAG} ✓ Backup complete: ${archivePath} (${archiveSize} MB)`);
}

function cmdRestore(args: string[]): void {
  let dataDir = resolveDataDir();

  if (args.length < 1) {
    console.error(`${TAG} Usage: restore <backup-path> [--data-dir <dir>]`);
    process.exit(1);
  }

  const backupPath = args[0]!;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--data-dir" && args[i + 1]) dataDir = args[++i]!;
  }

  if (!fs.existsSync(backupPath)) {
    console.error(`${TAG} Backup not found: ${backupPath}`);
    process.exit(1);
  }

  console.log(`${TAG} Restoring backup: ${backupPath}`);
  console.log(`${TAG} Target data dir: ${dataDir}`);

  // 1. Extract to temp dir
  const tmpDir = path.join(dataDir, ".backup-restore-tmp");
  ensureDir(tmpDir);

  console.log(`${TAG} Extracting archive...`);
  execSync(`tar -xzf "${backupPath}" -C "${tmpDir}"`, { timeout: 300_000 });

  // Find extracted backup dir
  const entries = fs.readdirSync(tmpDir);
  if (entries.length !== 1) {
    console.error(`${TAG} Expected exactly one top-level dir in archive, got: ${entries.join(", ")}`);
    execSync(`rm -rf "${tmpDir}"`);
    process.exit(1);
  }
  const backupDir = path.join(tmpDir, entries[0]!);

  // 2. Read manifest
  const manifestPath = path.join(backupDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`${TAG} Invalid backup: manifest.json not found`);
    execSync(`rm -rf "${tmpDir}"`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  console.log(`${TAG} Backup ID: ${manifest.backupId}`);
  console.log(`${TAG} Created: ${manifest.createdAt}`);

  // 3. Restore SQLite databases
  const dbBackupDir = path.join(backupDir, "databases");
  if (fs.existsSync(dbBackupDir)) {
    for (const dbFile of fs.readdirSync(dbBackupDir)) {
      if (!dbFile.endsWith(".bak")) continue;
      const dbName = dbFile.replace(".bak", "");
      const destPath = path.join(dataDir, dbName);
      const srcPath = path.join(dbBackupDir, dbFile);
      console.log(`${TAG} Restoring database: ${dbName}`);
      try {
        // Ensure parent dir exists
        ensureDir(path.dirname(destPath));
        fs.copyFileSync(srcPath, destPath);
        console.log(`${TAG}   ✓ ${dbName}`);
      } catch (err) {
        console.error(`${TAG}   ✗ ${dbName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 4. Restore file assets
  const assetsDir = path.join(backupDir, "assets");
  if (fs.existsSync(assetsDir)) {
    for (const assetName of fs.readdirSync(assetsDir)) {
      const srcPath = path.join(assetsDir, assetName);
      const destPath = path.join(dataDir, assetName);
      console.log(`${TAG} Restoring asset: ${assetName}`);
      try {
        if (fs.existsSync(destPath)) {
          execSync(`rm -rf "${destPath}"`);
        }
        execSync(`cp -r "${srcPath}" "${destPath}"`);
        console.log(`${TAG}   ✓ ${assetName}`);
      } catch (err) {
        console.error(`${TAG}   ✗ ${assetName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 5. Cleanup
  execSync(`rm -rf "${tmpDir}"`);
  console.log(`${TAG} ✓ Restore complete`);
}

function cmdList(args: string[]): void {
  let dataDir = resolveDataDir();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir" && args[i + 1]) dataDir = args[++i]!;
  }

  const backupDir = resolveBackupDir(dataDir);
  if (!fs.existsSync(backupDir)) {
    console.log(`${TAG} No backups found (backup dir does not exist: ${backupDir})`);
    return;
  }

  const files = fs.readdirSync(backupDir).filter((f) => f.endsWith(".tar.gz")).sort().reverse();
  if (files.length === 0) {
    console.log(`${TAG} No backups found in ${backupDir}`);
    return;
  }

  console.log(`${TAG} Backups in ${backupDir}:\n`);
  for (const f of files) {
    const fullPath = path.join(backupDir, f);
    const stat = fs.statSync(fullPath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
    const mtime = stat.mtime.toISOString();
    console.log(`  ${f}  (${sizeMB} MB, ${mtime})`);
  }
  console.log(`\n${TAG} Total: ${files.length} backup(s)`);
}

function cmdPrune(args: string[]): void {
  let keep = 5;
  let dataDir = resolveDataDir();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--keep" && args[i + 1]) keep = parseInt(args[++i]!, 10);
    if (args[i] === "--data-dir" && args[i + 1]) dataDir = args[++i]!;
  }

  const backupDir = resolveBackupDir(dataDir);
  if (!fs.existsSync(backupDir)) {
    console.log(`${TAG} No backups to prune`);
    return;
  }

  const files = fs.readdirSync(backupDir).filter((f) => f.endsWith(".tar.gz")).sort().reverse();
  if (files.length <= keep) {
    console.log(`${TAG} ${files.length} backup(s) found, keeping ${keep}. Nothing to prune.`);
    return;
  }

  const toDelete = files.slice(keep);
  for (const f of toDelete) {
    const fullPath = path.join(backupDir, f);
    console.log(`${TAG} Pruning: ${f}`);
    fs.unlinkSync(fullPath);
  }
  console.log(`${TAG} ✓ Pruned ${toDelete.length} backup(s), ${keep} remaining`);
}

// ── Main ──

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "create":
    cmdCreate(args);
    break;
  case "restore":
    cmdRestore(args);
    break;
  case "list":
    cmdList(args);
    break;
  case "prune":
    cmdPrune(args);
    break;
  default:
    console.error(`${TAG} Usage: backup <create|restore|list|prune> [options]`);
    console.error(`  create   [--output <dir>] [--data-dir <dir>]`);
    console.error(`  restore  <backup-path> [--data-dir <dir>]`);
    console.error(`  list     [--data-dir <dir>]`);
    console.error(`  prune    [--keep <n>] [--data-dir <dir>]`);
    process.exit(1);
}
