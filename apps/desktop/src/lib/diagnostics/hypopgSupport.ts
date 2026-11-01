import type { QueryIndexSuggestion } from "@/lib/diagnostics/queryDiagnostics";

/**
 * hypopg (L2) 支持：只在 PostgreSQL 服务器上“已安装”时才能用。
 *
 * 关键事实（决定了这里的全部设计）：
 * - `CREATE EXTENSION` 只是登记 `sharedir` 里已有的 `hypopg.control` / `hypopg.so`；
 *   PostgreSQL 没有任何“按 URL 在线下载扩展”的机制，缺失时服务端会直接报
 *   `extension "hypopg" is not available`。
 * - 因此 DBX 只能探测 + 给出服务端可复制的安装命令，不能替用户登录服务器安装。
 * - 假设索引只在同一个后端会话（backend）内生效，所以所有试算语句必须共享
 *   一个 `clientSessionId`，结束前调用 `hypopg_reset()`。
 * - 只有不带 `ANALYZE` 的 `EXPLAIN` 会使用假设索引，因此 L2 只能回答
 *   “规划器会不会选中它、估算成本如何”，给不出真实耗时与读块数。
 */

export type HypopgPlatform = "debian" | "redhat" | "alpine" | "macos" | "windows" | "linux" | "unknown";

export interface PostgresServerProfile {
  /** 18 for PostgreSQL 18.x; 0 when the banner could not be parsed. */
  majorVersion: number;
  /** Raw `version()` output. */
  version: string;
  platform: HypopgPlatform;
  /** Human readable target used in the install hint ("Ubuntu 24.04", "Rocky Linux 9"). */
  distribution: string;
}

export interface HypopgInstallHint {
  platform: HypopgPlatform;
  distribution: string;
  /** Copy-and-paste shell commands for the PostgreSQL host (needs root/sudo). */
  shellCommands: string[];
  /** Statements to run once the package is installed; DBX runs them itself when possible. */
  sqlStatements: string[];
  /** Extra prose the package manager cannot express (Windows/source builds/权限). */
  note?: string;
}

export type HypopgAvailability = "installed" | "available" | "missing" | "unsupported" | "unknown";

export interface HypopgProbeRowset {
  columns: readonly string[];
  rows: readonly (readonly unknown[])[];
}

export interface HypopgProbe {
  available: boolean;
  installed: boolean;
  extensionVersion?: string;
  availableVersion?: string;
  isSuperuser: boolean;
  version?: string;
}

export interface HypopgPlanComparison {
  baseCost?: number;
  hypotheticalCost?: number;
  /** Negative means the hypothetical plan is cheaper than the executed baseline. */
  costDeltaPct?: number;
  used: boolean;
  /** Index names that appeared in the hypothetical plan. */
  usedIndexNames: string[];
  /** Node types of the access paths that consumed a hypothetical index. */
  accessNodeTypes: string[];
}

export interface HypopgTrial {
  id: string;
  title: string;
  indexSqls: string[];
  indexNames: string[];
  used: boolean;
  baseCost?: number;
  hypotheticalCost?: number;
  costDeltaPct?: number;
  accessNodeTypes?: string[];
  error?: string;
}

export interface HypopgAnalysis {
  availability: HypopgAvailability;
  /** Stable identity of the PostgreSQL host (`host:port`). */
  serverKey: string;
  extensionVersion?: string;
  availableVersion?: string;
  /** Hidden when the user chose “永不安装” for this server. */
  promptSuppressed: boolean;
  profile?: PostgresServerProfile;
  installHint?: HypopgInstallHint;
  trials?: HypopgTrial[];
  /** Short human readable status, appended to the diagnosis panel. */
  note?: string;
  error?: string;
}

/** `SELECT …` used to probe the server; safe on any role. */
export const HYPOPG_PROBE_SQL = `SELECT
  version() AS version,
  (SELECT extversion FROM pg_extension WHERE extname = 'hypopg') AS extension_version,
  (SELECT default_version FROM pg_available_extensions WHERE name = 'hypopg') AS available_version,
  COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_superuser`;

export const HYPOPG_CREATE_SQL = "CREATE EXTENSION IF NOT EXISTS hypopg";

export const HYPOPG_RESET_SQL = "SELECT hypopg_reset()";

export const HYPOPG_DOCS_URL = "https://hypopg.readthedocs.io";

/** One trial tests at most this many hypothetical indexes together. */
export const HYPOPG_MAX_TRIAL_INDEXES = 6;

/** Identity of the PostgreSQL host, so “永不安装” is remembered per server, not per connection/database. */
export function serverKeyForConnection(connection: { id: string; host?: string; port?: number | string }): string {
  const host = String(connection.host ?? "")
    .trim()
    .toLowerCase();
  const port = String(connection.port ?? "").trim();
  if (!host) return connection.id;
  return port ? `${host}:${port}` : host;
}

function detectPlatform(version: string): HypopgPlatform {
  if (/mingw|msvc|visual c\+\+(?=[\s)]|$)|windows/i.test(version)) return "windows";
  if (/darwin|macos|os x/i.test(version)) return "macos";
  if (/alpine/i.test(version)) return "alpine";
  if (/rhel|red hat|centos|rocky|alma|oracle linux|suse|opensuse/i.test(version)) return "redhat";
  if (/ubuntu|debian/i.test(version)) return "debian";
  if (/linux/i.test(version)) return "linux";
  return "unknown";
}

/** `Ubuntu 18.3-1.pgdg24.04+1` carries the distro release, `Rocky Linux 9.6` the major release. */
function detectDistribution(version: string, platform: HypopgPlatform): string {
  const ubuntuFromPgdb = /\b(?:ubuntu|debian)\s+\S*?pgdg(\d+(?:\.\d+)?)/i.exec(version);
  if (ubuntuFromPgdb) return `${platform === "debian" && /debian/i.test(version) ? "Debian" : "Ubuntu"} ${ubuntuFromPgdb[1]}`;
  const ubuntu = /\bubuntu\s+(\d+(?:\.\d+)?)/i.exec(version);
  if (ubuntu) return `Ubuntu ${ubuntu[1]}`;
  const debian = /\bdebian\s+(\d+(?:\.\d+)?)/i.exec(version);
  if (debian) return `Debian ${debian[1]}`;
  const rhel = /\b(?:rhel|red hat enterprise linux|red hat|centos|rocky linux|rocky|almalinux|alma linux|oracle linux|suse|opensuse)\s*(?:linux)?\s*(?:release\s*)?(\d+(?:\.\d+)?)?/i.exec(version);
  if (rhel) {
    const name = rhel[0]
      .replace(/\s+/g, " ")
      .replace(/release\s*/i, "")
      .trim();
    return rhel[1] ? `${name} ${rhel[1]}` : name;
  }
  if (platform === "windows") return "Windows";
  if (platform === "macos") return "macOS";
  if (platform === "alpine") return "Alpine Linux";
  if (platform === "linux") return "Linux";
  return "";
}

export function parsePostgresServerProfile(version: string): PostgresServerProfile {
  const trimmed = version.trim();
  const majorMatch = /\bpostgresql\s+(\d+)/i.exec(trimmed);
  const majorVersion = majorMatch ? Number(majorMatch[1]) : 0;
  const platform = detectPlatform(trimmed);
  return { majorVersion, version: trimmed, platform, distribution: detectDistribution(trimmed, platform) };
}

/**
 * Copy-and-paste install steps for the host running PostgreSQL.
 *
 * Package names are verified against the public repositories:
 * - Debian/Ubuntu (PGDG apt): `postgresql-<major>-hypopg` (1.4.4 for 18 on 24.04)
 * - RHEL/Rocky/Alma (PGDG yum): `hypopg_<major>`
 * - macOS (Homebrew): `hypopg`
 * - Windows: no prebuilt package, must be compiled with MSVC
 */
export function buildHypopgInstallHint(profile: PostgresServerProfile): HypopgInstallHint {
  const major = profile.majorVersion;
  const serverVersion = major > 0 ? `PostgreSQL ${major}` : "当前 PostgreSQL";
  const sqlStatements = [`${HYPOPG_CREATE_SQL};`];

  switch (profile.platform) {
    case "debian":
      return {
        platform: profile.platform,
        distribution: profile.distribution || "Debian/Ubuntu",
        shellCommands: ["sudo apt-get update", `sudo apt-get install -y postgresql-${major}-hypopg`],
        sqlStatements,
        note: `包名带主版本号（${serverVersion}）。若提示找不到包，需要先按 ${HYPOPG_DOCS_URL} 的说明添加 PGDG 软件源；这台服务器上的 PostgreSQL 本身已经来自 PGDG。`,
      };
    case "redhat":
      return {
        platform: profile.platform,
        distribution: profile.distribution || "RHEL/CentOS/Rocky",
        shellCommands: [major > 0 ? `sudo dnf install -y --enablerepo=pgdg${major} hypopg_${major}` : "sudo dnf install -y hypopg"],
        sqlStatements,
        note: `PGDG 的 RPM 扩展包名为 hypopg_${major || "<主版本>"}；仓库未启用时先执行 sudo dnf install -y pgdg-redhat-repo。`,
      };
    case "alpine":
      return {
        platform: profile.platform,
        distribution: profile.distribution || "Alpine Linux",
        shellCommands: [major > 0 ? `sudo apk add postgresql${major}-hypopg` : "sudo apk add postgresql-hypopg"],
        sqlStatements,
        note: "Alpine 官方仓库不一定提供 hypopg；缺失时按源码编译步骤安装。",
      };
    case "macos":
      return {
        platform: profile.platform,
        distribution: profile.distribution || "macOS",
        shellCommands: ["brew install hypopg"],
        sqlStatements,
        note: "Homebrew 安装的是与已装 PostgreSQL 主版本匹配的 hypopg；若同时装了多个版本，用 brew info hypopg 确认绑定关系。",
      };
    case "windows":
      return {
        platform: profile.platform,
        distribution: profile.distribution || "Windows",
        shellCommands: [],
        sqlStatements,
        note: "Windows 没有 hypopg 预编译包：需要用与 PostgreSQL 相同版本的 MSVC 编译源码（见 https://github.com/HypoPG/hypopg ），把生成的 hypopg.dll 与 hypopg.control 放到 PostgreSQL 的 lib / share/extension 目录。",
      };
    case "linux":
    case "unknown":
    default:
      return {
        platform: profile.platform,
        distribution: profile.distribution || "Linux",
        shellCommands: [`git clone --depth 1 https://github.com/HypoPG/hypopg.git /tmp/hypopg-src`, "cd /tmp/hypopg-src && make USE_PGXS=1", "cd /tmp/hypopg-src && sudo make USE_PGXS=1 install"],
        sqlStatements,
        note: `源码编译需要 PostgreSQL 头文件（例如 postgresql-server-dev-${major || "<主版本>"} 或 postgresql${major || "<主版本>"}-devel）；编译时使用的 pg_config 必须指向服务器实际运行的 PostgreSQL。`,
      };
  }
}

function cellText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function cellFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const text = cellText(value)?.toLowerCase();
  return text === "true" || text === "t" || text === "1" || text === "yes";
}

/** Parses `HYPOPG_PROBE_SQL` output; tolerates drivers that return strings for booleans. */
export function parseHypopgProbe(rowset: HypopgProbeRowset | undefined): HypopgProbe {
  if (!rowset || rowset.rows.length === 0) return { available: false, installed: false, isSuperuser: false };
  const row = rowset.rows[0] ?? [];
  const columnIndex = (name: string) => rowset.columns.findIndex((column) => column.toLowerCase() === name);
  const read = (name: string) => {
    const index = columnIndex(name);
    return index >= 0 ? row[index] : undefined;
  };
  const extensionVersion = cellText(read("extension_version"));
  const availableVersion = cellText(read("available_version"));
  return {
    available: availableVersion !== undefined || extensionVersion !== undefined,
    installed: extensionVersion !== undefined,
    extensionVersion,
    availableVersion,
    isSuperuser: cellFlag(read("is_superuser")),
    version: cellText(read("version")),
  };
}

function rootPlan(raw: unknown): Record<string, unknown> | undefined {
  const root = Array.isArray(raw) ? raw[0] : raw;
  if (!root || typeof root !== "object") return undefined;
  const record = root as Record<string, unknown>;
  const plan = record.Plan ?? record;
  return plan && typeof plan === "object" ? (plan as Record<string, unknown>) : undefined;
}

function rootCost(raw: unknown): number | undefined {
  const plan = rootPlan(raw);
  if (!plan) return undefined;
  const total = plan["Total Cost"];
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

function walkPlanNodes(node: unknown, visit: (node: Record<string, unknown>) => void) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  visit(record);
  const children = record.Plans;
  if (Array.isArray(children)) for (const child of children) walkPlanNodes(child, visit);
}

/** `"<41072>btree_hypo_itemcode"` → `{ oid: "41072", tail: "btree_hypo_itemcode" }`. */
function splitIndexName(name: string): { oid?: string; tail: string } {
  const match = /^<(\d+)>(.+)$/.exec(name.trim());
  return match ? { oid: match[1], tail: match[2]! } : { tail: name.trim() };
}

function indexNameMatches(nodeName: string, hypotheticalName: string): boolean {
  const node = splitIndexName(nodeName);
  const hypothetical = splitIndexName(hypotheticalName);
  if (node.oid && hypothetical.oid) return node.oid === hypothetical.oid;
  if (!node.tail || !hypothetical.tail) return false;
  return node.tail.includes(hypothetical.tail) || hypothetical.tail.includes(node.tail);
}

/**
 * Compares the executed baseline plan (EXPLAIN ANALYZE) with the plan produced
 * while hypothetical indexes existed (plain EXPLAIN, which is the only form
 * hypopg can influence).
 */
export function compareHypotheticalPlan(baseRaw: unknown, hypotheticalRaw: unknown, hypotheticalIndexNames: readonly string[]): HypopgPlanComparison {
  const baseCost = rootCost(baseRaw);
  const hypotheticalCost = rootCost(hypotheticalRaw);
  const usedIndexNames: string[] = [];
  const accessNodeTypes: string[] = [];

  const hypothetical = rootPlan(hypotheticalRaw);
  if (hypothetical) {
    walkPlanNodes(hypothetical, (node) => {
      const indexName = typeof node["Index Name"] === "string" ? (node["Index Name"] as string) : undefined;
      if (!indexName) return;
      if (!hypotheticalIndexNames.some((name) => indexNameMatches(indexName, name))) return;
      usedIndexNames.push(indexName);
      const nodeType = typeof node["Node Type"] === "string" ? (node["Node Type"] as string) : undefined;
      if (nodeType && !accessNodeTypes.includes(nodeType)) accessNodeTypes.push(nodeType);
    });
  }

  let costDeltaPct: number | undefined;
  if (baseCost !== undefined && hypotheticalCost !== undefined && baseCost > 0) {
    costDeltaPct = ((hypotheticalCost - baseCost) / baseCost) * 100;
  }

  return { baseCost, hypotheticalCost, costDeltaPct, used: usedIndexNames.length > 0, usedIndexNames, accessNodeTypes };
}

/**
 * Trial plan: first every suggestion together (one index set can be better than
 * any single index), then the leading suggestions individually so the user can
 * tell which one the planner actually wants.
 */
export function planHypopgTrials(suggestions: readonly QueryIndexSuggestion[]): { id: string; title: string; indexSqls: string[] }[] {
  const normalized = suggestions.map((suggestion) => ({ suggestion, sql: suggestion.sql.trim().replace(/;+\s*$/, "") })).filter((entry) => entry.sql.length > 0);
  if (normalized.length === 0) return [];

  const groups: { id: string; title: string; indexSqls: string[] }[] = [];
  const combined = normalized.slice(0, HYPOPG_MAX_TRIAL_INDEXES);
  groups.push({
    id: "combined",
    title: `组合试算：${combined.length} 条建议同时生效`,
    indexSqls: combined.map((entry) => entry.sql),
  });

  for (const [index, entry] of normalized.slice(0, 3).entries()) {
    const columns = entry.suggestion.columns.join(", ");
    const include = entry.suggestion.includeColumns.length > 0 ? ` INCLUDE (${entry.suggestion.includeColumns.join(", ")})` : "";
    groups.push({
      id: `single-${index}`,
      title: `单独试算：${entry.suggestion.table} (${columns})${include}`,
      indexSqls: [entry.sql],
    });
  }
  return groups;
}

/** Dollar-quoted argument for `hypopg_create_index`. */
export function hypotheticalIndexArgument(indexSql: string): string {
  const statement = indexSql.trim().replace(/;+\s*$/, "");
  // 用 $$ 美元引号包裹 DDL，避免内容里的单引号/分号破坏语句
  const quoted = `$$${statement}$$`;
  return `SELECT indexname FROM hypopg_create_index(${quoted})`;
}
