/**
 * GitSourceFetcher — 基于 simple-git 的源码拉取实现。
 *
 * simple-git 内部用 child_process.spawn + args 数组，不走 shell，从原理上消除 shell 注入。
 *
 * 安全防护（002 §4-5）：
 *   - R1 git hooks：clone/fetch 本就不拉取远端 .git/hooks（hooks 为本地态），故不额外
 *     配置 core.hooksPath（加固版 git 会拒绝该配置，需 allowUnsafeHooksPath）。
 *   - R2 SSRF：只允许 public HTTPS + SSH + 内网/环回地址黑名单（对齐项目 security_rules）。
 *   - Bug 修复（方案 A）：增量 sync 的 git clean 排除 .codegraph/，避免删掉 codegraph 索引库。
 *
 * Authentication modes (v2.1):
 *   - Public HTTPS: no auth needed
 *   - HTTPS + PAT: set CODEGRAPH_GIT_TOKEN env var
 *   - SSH: set CODEGRAPH_SSH_KEY_PATH env var (path to private key)
 *   - Local path: set CODEGRAPH_LOCAL_PATH env var (skip git clone entirely)
 *   - Git credential helper: uses system git credentials (gh auth, git credential store)
 */

import simpleGit, { CleanOptions, ResetMode } from "simple-git";
import type { SimpleGitOptions } from "simple-git";
import fs from "node:fs";
import path from "node:path";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";

/**
 * 内网 / 环回 / link-local 地址黑名单（标准网段）：
 *   - 10. / 172.16-31. / 192.168.  → RFC1918 私有网段
 *   - 169.254.                     → link-local（含云元数据 169.254.169.254）
 *   - 127. / 0. / localhost / ::1  → 环回
 *   - fe80:                        → IPv6 link-local
 *
 * 该黑名单可通过环境变量 KNOWLEDGE_SSRF_CHECK=off 关闭（见 GitSourceFetcher 构造）。
 */
const PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;

/**
 * 读取 SSRF 私网黑名单开关。默认开启；
 * 当 KNOWLEDGE_SSRF_CHECK 为 off/false/0/no（大小写不敏感）时关闭。
 */
function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

/**
 * Read authentication config from environment variables.
 */
function resolveGitAuth(): GitAuthConfig {
  return {
    token: process.env.CODEGRAPH_GIT_TOKEN?.trim() || undefined,
    sshKeyPath: process.env.CODEGRAPH_SSH_KEY_PATH?.trim() || undefined,
    localPath: process.env.CODEGRAPH_LOCAL_PATH?.trim() || undefined,
  };
}

export interface GitAuthConfig {
  /** Personal Access Token for HTTPS auth */
  token?: string;
  /** Path to SSH private key */
  sshKeyPath?: string;
  /** Local path to repo (skip git clone) */
  localPath?: string;
}

export interface GitSourceFetcherOptions {
  /**
   * 是否启用 SSRF 私网 / 环回地址黑名单校验。
   * 默认读环境变量 KNOWLEDGE_SSRF_CHECK（默认开启）；显式传入时优先于环境变量。
   */
  ssrfCheck?: boolean;
  /** Git authentication config. Defaults to env vars. */
  auth?: GitAuthConfig;
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  /** SSRF 私网黑名单校验开关（https-only 协议校验始终生效，不受此开关影响）。 */
  private readonly ssrfCheck: boolean;
  private readonly auth: GitAuthConfig;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
    this.auth = opts?.auth ?? resolveGitAuth();
  }

  validate(sourceUrl: string): void {
    // Local path mode: skip URL validation
    if (this.auth.localPath && this.isLocalPath(sourceUrl)) {
      if (!fs.existsSync(sourceUrl)) {
        throw new Error(`Local path does not exist: ${sourceUrl}`);
      }
      return;
    }

    // Support HTTPS and SSH URLs
    const isHttps = sourceUrl.startsWith("https://");
    const isSsh = sourceUrl.startsWith("git@") || sourceUrl.startsWith("ssh://");

    if (!isHttps && !isSsh) {
      throw new Error(
        "Unsupported URL scheme. Use https:// for HTTPS repos or git@host:path for SSH repos. " +
        "Set CODEGRAPH_GIT_TOKEN for HTTPS auth, CODEGRAPH_SSH_KEY_PATH for SSH auth.",
      );
    }

    // SSH: validate key path if provided
    if (isSsh && this.auth.sshKeyPath) {
      if (!fs.existsSync(this.auth.sshKeyPath)) {
        throw new Error(`SSH key not found: ${this.auth.sshKeyPath}`);
      }
    }

    const host = this.extractHost(sourceUrl);
    if (!host) {
      throw new Error(`invalid repo_url: cannot parse host from ${sourceUrl}`);
    }
    // R2: SSRF 防护 —— 禁止指向内网 / 环回地址（可经 KNOWLEDGE_SSRF_CHECK=off 关闭）。
    // SSH to private addresses is allowed (common for internal Git servers).
    if (!isSsh && this.ssrfCheck && this.isPrivateAddress(host)) {
      throw new Error(`repo_url must not point to private/loopback address: ${host}`);
    }
  }

  async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    // Local path mode: symlink or copy instead of clone
    if (this.auth.localPath && this.isLocalPath(sourceUrl)) {
      return this.fetchLocal(sourceUrl, localPath);
    }

    this.validate(sourceUrl);

    const gitOptions = this.buildGitOptions(sourceUrl);
    const cloneArgs: Record<string, string> = {
      "--depth": "1",
      "--branch": branch,
    };

    // Inject auth into URL for HTTPS + PAT
    const authenticatedUrl = this.injectAuth(sourceUrl);

    await simpleGit(gitOptions).clone(authenticatedUrl, localPath, cloneArgs);
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    // Local path mode: re-copy
    if (this.auth.localPath && this.isLocalPath(sourceUrl)) {
      return this.fetchLocal(sourceUrl, localPath);
    }

    this.validate(sourceUrl);

    const gitOptions = this.buildGitOptions(sourceUrl);
    const git = simpleGit(localPath);

    // Configure auth for fetch
    if (this.auth.sshKeyPath) {
      await git.env("GIT_SSH_COMMAND", `ssh -i ${this.auth.sshKeyPath} -o StrictHostKeyChecking=no`);
    }

    await git.fetch("origin", branch, { "--depth": "1" });
    await git.reset(ResetMode.HARD, [`origin/${branch}`]);
    // Bug 修复（方案 A）：clean 排除 .codegraph/，否则会删掉 codegraph 的索引库，
    // 导致增量 sync 永远失败、每次回退到全量 clone。
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  // ── 内部 helper ──

  /**
   * Build simple-git options with SSH key injection.
   */
  private buildGitOptions(sourceUrl: string): SimpleGitOptions {
    const opts: SimpleGitOptions = {};
    if (this.auth.sshKeyPath && (sourceUrl.startsWith("git@") || sourceUrl.startsWith("ssh://"))) {
      opts.env = {
        ...process.env,
        GIT_SSH_COMMAND: `ssh -i ${this.auth.sshKeyPath} -o StrictHostKeyChecking=no`,
      };
    }
    return opts;
  }

  /**
   * Inject PAT into HTTPS URL.
   * https://github.com/user/repo -> https://TOKEN@github.com/user/repo
   */
  private injectAuth(url: string): string {
    if (!this.auth.token || !url.startsWith("https://")) return url;
    // Don't inject if URL already has auth
    const afterProtocol = url.slice(8);
    if (afterProtocol.includes("@")) return url;
    return `https://${this.auth.token}@${afterProtocol}`;
  }

  /**
   * Fetch from a local path (symlink or copy).
   */
  private async fetchLocal(sourcePath: string, localPath: string): Promise<FetchResult> {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Local path does not exist: ${sourcePath}`);
    }
    // Remove existing target
    if (fs.existsSync(localPath)) {
      fs.rmSync(localPath, { recursive: true, force: true });
    }
    // Use symlink for efficiency (read-only)
    fs.symlinkSync(sourcePath, localPath, "dir");
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  /**
   * Check if a string looks like a local filesystem path.
   */
  private isLocalPath(p: string): boolean {
    return p.startsWith("/") || p.startsWith("~/") || p.startsWith("./") || p.startsWith("../");
  }

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }

  private extractHost(url: string): string {
    try {
      // Handle SSH URLs: git@host:path
      if (url.startsWith("git@")) {
        const match = url.match(/git@([^:]+)/);
        return match?.[1] ?? "";
      }
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  private isPrivateAddress(host: string): boolean {
    return PRIVATE_ADDR_RE.test(host);
  }
}
