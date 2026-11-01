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
  /** 1-based positions in the suggestion list this trial covers (`[1, 3]` → `#1 + #3`). */
  candidateRefs: number[];
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
  /** 实际执行计划的规划器总成本，作为所有试算的“现状”基线。 */
  baseCost?: number;
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

/** 创建扩展会等待 catalog 锁；限制等待时间，避免诊断被别人的长事务卡住。 */
export const HYPOPG_LOCK_TIMEOUT_SQL = "SET lock_timeout = '5s'";

export const HYPOPG_RESET_SQL = "SELECT hypopg_reset()";

export const HYPOPG_DOCS_URL = "https://hypopg.readthedocs.io";

/** One trial tests at most this many hypothetical indexes together. */
export const HYPOPG_MAX_TRIAL_INDEXES = 8;

/** 组合试算的规模上限：单条全部测，两两与三连只取最有代表性的前若干组。 */
const HYPOPG_MAX_PAIR_TRIALS = 12;
const HYPOPG_MAX_TRIPLE_TRIALS = 8;

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

export interface HypopgTrialGroup {
  id: string;
  title: string;
  indexSqls: string[];
  /** 1-based positions in the suggestion list, so the panel can render `#1 + #3`. */
  candidateRefs: number[];
}

interface HypopgCandidate {
  /** 1-based position in the original suggestion list. */
  ref: number;
  tableKey: string;
  sql: string;
  suggestion: QueryIndexSuggestion;
}

/** `public.qstest_oitm` / `qstest_oitm` → `qstest_oitm`，用于按表分组。 */
function tableKeyOf(table: string): string {
  return (table.toLowerCase().split(".").pop() ?? "").trim();
}

/**
 * 选出参与试算的候选索引，按表轮转。
 *
 * 老实现只取前 N 条，某张表建议多时会把别的表挤出候选，导致“部分索引 + 覆盖索引”
 * 这类跨表最优组合根本没进过试算。轮转保证每张表至少拿到一条，部分索引在同表内
 * 排最前（它是最容易和覆盖索引组合出最优计划的候选）。
 */
export function selectHypopgCandidates(suggestions: readonly QueryIndexSuggestion[], max = HYPOPG_MAX_TRIAL_INDEXES): HypopgCandidate[] {
  const buckets = new Map<string, HypopgCandidate[]>();
  suggestions.forEach((suggestion, index) => {
    const sql = suggestion.sql.trim().replace(/;+\s*$/, "");
    if (!sql) return;
    const candidate: HypopgCandidate = { ref: index + 1, tableKey: tableKeyOf(suggestion.table), sql, suggestion };
    const bucket = buckets.get(candidate.tableKey);
    if (bucket) bucket.push(candidate);
    else buckets.set(candidate.tableKey, [candidate]);
  });

  // 同表内：部分索引优先，其次带 INCLUDE 的覆盖索引，其余保持原顺序。
  const score = (candidate: HypopgCandidate) => (candidate.suggestion.where ? 0 : candidate.suggestion.includeColumns.length > 0 ? 1 : 2);
  const ordered = [...buckets.values()].map((bucket) =>
    bucket
      .map((candidate, order) => ({ candidate, order }))
      .sort((left, right) => score(left.candidate) - score(right.candidate) || left.order - right.order)
      .map((entry) => entry.candidate),
  );

  const selected: HypopgCandidate[] = [];
  for (let round = 0; selected.length < max; round += 1) {
    let picked = false;
    for (const bucket of ordered) {
      const candidate = bucket[round];
      if (!candidate) continue;
      selected.push(candidate);
      picked = true;
      if (selected.length >= max) break;
    }
    if (!picked) break;
  }
  return selected;
}

/**
 * 试算计划：单条全部 → 跨表两两 → 跨表三连 → 全量。
 *
 * 只有“组合”才可能找到最优解：两张表的索引各自最优，组合后规划器才会把
 * Seq Scan + Hash Join 换成 Index Scan + Nested Loop。
 */
export function planHypopgTrials(suggestions: readonly QueryIndexSuggestion[]): HypopgTrialGroup[] {
  const candidates = selectHypopgCandidates(suggestions);
  if (candidates.length === 0) return [];

  const groups: HypopgTrialGroup[] = [];
  const groupOf = (id: string, refs: HypopgCandidate[], title: string): HypopgTrialGroup => ({
    id,
    title,
    indexSqls: refs.map((candidate) => candidate.sql),
    candidateRefs: refs.map((candidate) => candidate.ref),
  });

  // 单条：每条候选都单独试一次，作为“这条索引本身有没有用”的基线。
  for (const candidate of candidates) {
    groups.push(groupOf(`single-${candidate.ref}`, [candidate], `#${candidate.ref}`));
  }

  // 两两组合：跨表优先（两张表各自被驱动/覆盖，才可能出现 Nested Loop）。
  const pairs: [HypopgCandidate, HypopgCandidate][] = [];
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      pairs.push([candidates[left]!, candidates[right]!]);
    }
  }
  pairs.sort((left, right) => {
    const cross = Number(left[0].tableKey === left[1].tableKey) - Number(right[0].tableKey === right[1].tableKey);
    return cross || left[0].ref - right[0].ref || left[1].ref - right[1].ref;
  });
  for (const [first, second] of pairs.slice(0, HYPOPG_MAX_PAIR_TRIALS)) {
    groups.push(groupOf(`pair-${first.ref}-${second.ref}`, [first, second], `#${first.ref} + #${second.ref}`));
  }

  // 三连：只取跨表且表各不相同的前若干组，避免同一张表堆三条索引。
  const triples: HypopgCandidate[][] = [];
  for (let first = 0; first < candidates.length; first += 1) {
    for (let second = first + 1; second < candidates.length; second += 1) {
      for (let third = second + 1; third < candidates.length; third += 1) {
        const trio = [candidates[first]!, candidates[second]!, candidates[third]!];
        if (new Set(trio.map((candidate) => candidate.tableKey)).size !== 3) continue;
        triples.push(trio);
      }
    }
  }
  triples.sort((left, right) => left.reduce((sum, candidate) => sum + candidate.ref, 0) - right.reduce((sum, candidate) => sum + candidate.ref, 0));
  for (const trio of triples.slice(0, HYPOPG_MAX_TRIPLE_TRIALS)) {
    groups.push(groupOf(`triple-${trio.map((candidate) => candidate.ref).join("-")}`, trio, trio.map((candidate) => `#${candidate.ref}`).join(" + ")));
  }

  // 全量：所有候选同时生效，作为“能省多少”的上界。
  if (candidates.length > 1) {
    groups.push(groupOf("all", candidates, `全部 ${candidates.length} 条`));
  }
  return groups;
}

/** 规划器成本是相对单位（不是毫秒），展示时加千分位，方便肉眼比较大小。 */
export function formatPlanCost(cost?: number): string {
  if (cost === undefined || !Number.isFinite(cost)) return "—";
  return cost.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/**
 * 在成本相差不到 2% 的试算里挑索引最少的那个。
 *
 * 多建一条索引就多一份写入、膨胀和维护成本，所以“全量组合”只比“两两组合”
 * 便宜一点点时，应推荐两两组合。
 */
export function pickBestHypopgTrial<T extends { hypotheticalCost?: number; candidateRefs: readonly number[]; error?: string }>(trials: readonly T[]): T | undefined {
  const usable = trials.filter((trial) => !trial.error && typeof trial.hypotheticalCost === "number" && Number.isFinite(trial.hypotheticalCost));
  if (usable.length === 0) return undefined;
  const cheapest = Math.min(...usable.map((trial) => trial.hypotheticalCost!));
  return [...usable].filter((trial) => trial.hypotheticalCost! <= cheapest * 1.02).sort((left, right) => left.candidateRefs.length - right.candidateRefs.length || left.hypotheticalCost! - right.hypotheticalCost!)[0];
}

/**
 * 按“成本比例”把实测耗时线性折算成粗估耗时。
 *
 * 规划器成本与实际耗时不成严格正比（读缓存、并行度、函数调用都会影响），
 * 所以只用于给数量级感受，面板必须明确标注“粗估”。
 */
export function estimateElapsedMs(hypotheticalCost?: number, baseCost?: number, baseElapsedMs?: number): number | undefined {
  if (hypotheticalCost === undefined || baseCost === undefined || baseElapsedMs === undefined) return undefined;
  if (!Number.isFinite(hypotheticalCost) || !Number.isFinite(baseCost) || !Number.isFinite(baseElapsedMs)) return undefined;
  if (baseCost <= 0 || baseElapsedMs <= 0) return undefined;
  return (baseElapsedMs * hypotheticalCost) / baseCost;
}

/** Dollar-quoted argument for `hypopg_create_index`. */
export function hypotheticalIndexArgument(indexSql: string): string {
  const statement = indexSql.trim().replace(/;+\s*$/, "");
  // 用 $$ 美元引号包裹 DDL，避免内容里的单引号/分号破坏语句
  const quoted = `$$${statement}$$`;
  return `SELECT indexname FROM hypopg_create_index(${quoted})`;
}
