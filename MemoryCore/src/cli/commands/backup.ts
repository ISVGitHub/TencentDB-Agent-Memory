/**
 * `memory-tdai backup` command definition.
 *
 * Provides backup/restore/list/prune operations for the memory SQLite database
 * and associated file assets (conversations, records, scene_blocks, persona, skills).
 *
 * Backup format: tar.gz containing:
 *   - vectors.db (SQLite WAL checkpoint)
 *   - metadata.db (if exists)
 *   - manifest.json (schema version, timestamp, source paths, checksums)
 *   - conversations/ (JSONL files)
 *   - records/ (JSONL files)
 *   - scene_blocks/ (markdown files)
 *   - persona.md
 *   - skills/ (skill definitions + resources)
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import type { Command } from "commander";
import type { SeedCliContext } from "../index.js";

const TAG = "[memory-tdai] [backup-cmd]";

interface BackupManifest {
  version: 1;
  createdAt: string;
  sourceDir: string;
  schemaVersion: string;
  files: Array<{ path: string; size: number; sha256: string }>;
  totalSizeBytes: number;
}

/**
 * Register the `backup` subcommand under the memory-tdai CLI namespace.
 */
export function registerBackupCommand(parent: Command, ctx: SeedCliContext): void {
  const backup = parent
    .command("backup")
    .description("Backup, restore, list, and prune memory database snapshots");

  backup
    .command("create")
    .description("Create a new backup snapshot")
    .option("--output <file>", "Output archive path (default: auto-generated in data dir)")
    .option("--data-dir <dir>", "Memory data directory (default: from config)")
    .action(async (opts: Record<string, unknown>) => {
      await runBackupCreate(opts, ctx);
    });

  backup
    .command("restore")
    .description("Restore from a backup archive")
    .argument("<archive>", "Path to backup archive (.tar.gz)")
    .option("--dry-run", "Show what would be restored without applying changes", false)
    .option("--data-dir <dir>", "Memory data directory (default: from config)")
    .action(async (archive: string, opts: Record<string, unknown>) => {
      await runBackupRestore(archive, opts, ctx);
    });

  backup
    .command("list")
    .description("List available backup snapshots")
    .option("--dir <dir>", "Backup directory (default: <dataDir>/backups)")
    .action(async (opts: Record<string, unknown>) => {
      await runBackupList(opts, ctx);
    });

  backup
    .command("prune")
    .description("Remove old backups, keeping the latest N")
    .option("--keep <n>", "Number of backups to keep", "5")
    .option("--dir <dir>", "Backup directory (default: <dataDir>/backups)")
    .option("--dry-run", "Show what would be deleted without removing", false)
    .action(async (opts: Record<string, unknown>) => {
      await runBackupPrune(opts, ctx);
    });
}

// ============================
// Helpers
// ============================

function resolveDataDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const envDir = process.env.TDAI_DATA_DIR;
  if (envDir) return path.resolve(envDir);
  return path.join(process.env.HOME ?? "~", ".memory-tencentdb", "memory-tdai");
}

function resolveBackupDir(dataDir: string, explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  return path.join(dataDir, "backups");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Collect file assets that should be backed up alongside the SQLite DB. */
function collectFileAssets(dataDir: string): string[] {
  const assets: string[] = [];
  const dirs = ["conversations", "records", "scene_blocks", "skills"];
  for (const dir of dirs) {
    const full = path.join(dataDir, dir);
    if (fs.existsSync(full)) {
      assets.push(full);
    }
  }
  const files = ["persona.md"];
  for (const file of files) {
    const full = path.join(dataDir, file);
    if (fs.existsSync(full)) {
      assets.push(full);
    }
  }
  return assets;
}

/** Run WAL checkpoint on a SQLite database to ensure consistent backup. */
function walCheckpoint(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;
  try {
    execSync(`sqlite3 "${dbPath}" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null`, {
      timeout: 30_000,
      stdio: "pipe",
    });
  } catch {
    // Best-effort: if sqlite3 CLI is not available, the backup will still work
    // (WAL mode files will be included).
  }
}

/** Create a tar.gz archive from a list of paths. */
function createTarGz(archivePath: string, sources: string[], cwd: string): void {
  if (sources.length === 0) {
    throw new Error("No files to archive");
  }
  const relSources = sources.map((s) => path.relative(cwd, s));
  execSync(`tar -czf "${archivePath}" -C "${cwd}" ${relSources.map((s) => `"${s}"`).join(" ")}`, {
    timeout: 300_000,
    stdio: "pipe",
  });
}

/** Extract a tar.gz archive to a directory. */
function extractTarGz(archivePath: string, destDir: string): void {
  execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, {
    timeout: 300_000,
    stdio: "pipe",
  });
}

// ============================
// Command handlers
// ============================

async function runBackupCreate(
  opts: Record<string, unknown>,
  ctx: SeedCliContext,
): Promise<void> {
  const { logger } = ctx;
  const dataDir = resolveDataDir(opts.dataDir as string | undefined);
  const backupDir = resolveBackupDir(dataDir);

  // Ensure backup directory exists
  fs.mkdirSync(backupDir, { recursive: true });

  const outputFile = (opts.output as string | undefined)
    ?? path.join(backupDir, `backup-${timestamp()}.tar.gz`);

  logger.info(`${TAG} Creating backup...`);
  logger.info(`${TAG}   dataDir:    ${dataDir}`);
  logger.info(`${TAG}   output:     ${outputFile}`);

  // 1. WAL checkpoint on all SQLite databases
  const dbFiles = [
    path.join(dataDir, "vectors.db"),
    ...fs.readdirSync(path.join(dataDir, "metadata"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dataDir, "metadata", d.name, "metadata.db")),
  ].filter((p) => fs.existsSync(p));

  for (const db of dbFiles) {
    logger.info(`${TAG}   WAL checkpoint: ${db}`);
    walCheckpoint(db);
  }

  // 2. Collect all files to back up
  const filesToBackup: string[] = [];

  // SQLite databases (main + WAL + SHM)
  for (const db of dbFiles) {
    filesToBackup.push(db);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = db + suffix;
      if (fs.existsSync(sidecar)) filesToBackup.push(sidecar);
    }
  }

  // File assets
  filesToBackup.push(...collectFileAssets(dataDir));

  // 3. Build manifest
  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceDir: dataDir,
    schemaVersion: "v3",
    files: [],
    totalSizeBytes: 0,
  };

  for (const file of filesToBackup) {
    const stat = fs.statSync(file);
    const relPath = path.relative(dataDir, file);
    manifest.files.push({
      path: relPath,
      size: stat.size,
      sha256: sha256File(file),
    });
    manifest.totalSizeBytes += stat.size;
  }

  // 4. Write manifest to temp file
  const tmpDir = fs.mkdtempSync(path.join(backupDir, ".tmp-"));
  const manifestPath = path.join(tmpDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // 5. Create tar.gz
  const allSources = [...filesToBackup.map((f) => path.relative(dataDir, f)), "manifest.json"];
  try {
    // Move manifest into dataDir temporarily for tar
    const manifestInData = path.join(dataDir, "manifest.json");
    fs.copyFileSync(manifestPath, manifestInData);
    try {
      createTarGz(outputFile, [...filesToBackup, manifestInData], dataDir);
    } finally {
      fs.unlinkSync(manifestInData);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const archiveSize = fs.statSync(outputFile).size;
  logger.info(`${TAG} Backup created: ${outputFile}`);
  logger.info(`${TAG}   Files: ${manifest.files.length}, Size: ${(archiveSize / 1024 / 1024).toFixed(2)} MB`);
}

async function runBackupRestore(
  archive: string,
  opts: Record<string, unknown>,
  ctx: SeedCliContext,
): Promise<void> {
  const { logger } = ctx;
  const dataDir = resolveDataDir(opts.dataDir as string | undefined);
  const dryRun = opts.dryRun === true;

  if (!fs.existsSync(archive)) {
    logger.error(`${TAG} Archive not found: ${archive}`);
    process.exit(1);
  }

  logger.info(`${TAG} ${dryRun ? "Previewing" : "Starting"} restore...`);
  logger.info(`${TAG}   archive:  ${archive}`);
  logger.info(`${TAG}   dataDir:  ${dataDir}`);

  // 1. Extract to temp dir
  const tmpDir = fs.mkdtempSync(path.join(path.dirname(archive), ".restore-"));
  try {
    extractTarGz(archive, tmpDir);

    // 2. Read manifest
    const manifestPath = path.join(tmpDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      logger.error(`${TAG} Invalid backup: manifest.json not found`);
      process.exit(1);
    }
    const manifest: BackupManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    logger.info(`${TAG}   Backup from: ${manifest.createdAt}`);
    logger.info(`${TAG}   Source dir:  ${manifest.sourceDir}`);
    logger.info(`${TAG}   Files:       ${manifest.files.length}`);
    logger.info(`${TAG}   Total size:  ${(manifest.totalSizeBytes / 1024 / 1024).toFixed(2)} MB`);

    // 3. Verify checksums
    let checksumErrors = 0;
    for (const file of manifest.files) {
      const filePath = path.join(tmpDir, file.path);
      if (!fs.existsSync(filePath)) {
        logger.error(`${TAG}   MISSING: ${file.path}`);
        checksumErrors++;
        continue;
      }
      const actual = sha256File(filePath);
      if (actual !== file.sha256) {
        logger.error(`${TAG}   CHECKSUM MISMATCH: ${file.path}`);
        checksumErrors++;
      }
    }

    if (checksumErrors > 0) {
      logger.error(`${TAG} ${checksumErrors} checksum errors — aborting restore`);
      process.exit(1);
    }

    logger.info(`${TAG}   All checksums verified`);

    if (dryRun) {
      logger.info(`${TAG} Dry run complete. Would restore ${manifest.files.length} files to ${dataDir}`);
      return;
    }

    // 4. WAL checkpoint existing DB before replacing
    const existingDb = path.join(dataDir, "vectors.db");
    if (fs.existsSync(existingDb)) {
      walCheckpoint(existingDb);
    }

    // 5. Copy files from temp to data dir
    for (const file of manifest.files) {
      const src = path.join(tmpDir, file.path);
      const dest = path.join(dataDir, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }

    logger.info(`${TAG} Restore complete: ${manifest.files.length} files restored to ${dataDir}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runBackupList(
  opts: Record<string, unknown>,
  ctx: SeedCliContext,
): Promise<void> {
  const { logger } = ctx;
  const dataDir = resolveDataDir();
  const backupDir = resolveBackupDir(dataDir, opts.dir as string | undefined);

  if (!fs.existsSync(backupDir)) {
    logger.info(`${TAG} No backups found (directory does not exist: ${backupDir})`);
    return;
  }

  const files = fs.readdirSync(backupDir)
    .filter((f) => f.endsWith(".tar.gz"))
    .sort()
    .reverse();

  if (files.length === 0) {
    logger.info(`${TAG} No backups found in ${backupDir}`);
    return;
  }

  logger.info(`${TAG} Backups in ${backupDir}:\n`);
  for (const file of files) {
    const fullPath = path.join(backupDir, file);
    const stat = fs.statSync(fullPath);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
    logger.info(`  ${file}  (${sizeMB} MB, ${stat.mtime.toISOString()})`);
  }
}

async function runBackupPrune(
  opts: Record<string, unknown>,
  ctx: SeedCliContext,
): Promise<void> {
  const { logger } = ctx;
  const dataDir = resolveDataDir();
  const backupDir = resolveBackupDir(dataDir, opts.dir as string | undefined);
  const keep = parseInt(opts.keep as string, 10) || 5;
  const dryRun = opts.dryRun === true;

  if (!fs.existsSync(backupDir)) {
    logger.info(`${TAG} No backups to prune (directory does not exist)`);
    return;
  }

  const files = fs.readdirSync(backupDir)
    .filter((f) => f.endsWith(".tar.gz"))
    .sort()
    .reverse();

  if (files.length <= keep) {
    logger.info(`${TAG} ${files.length} backups found, keeping all (keep=${keep})`);
    return;
  }

  const toDelete = files.slice(keep);
  logger.info(`${TAG} ${dryRun ? "Would delete" : "Deleting"} ${toDelete.length} backup(s), keeping latest ${keep}:\n`);

  for (const file of toDelete) {
    const fullPath = path.join(backupDir, file);
    const stat = fs.statSync(fullPath);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
    logger.info(`  ${dryRun ? "[DRY]" : "[DEL]"} ${file}  (${sizeMB} MB)`);

    if (!dryRun) {
      fs.unlinkSync(fullPath);
    }
  }

  if (!dryRun) {
    logger.info(`\n${TAG} Pruned ${toDelete.length} backup(s)`);
  }
}
