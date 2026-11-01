import type { ParsedExplainPlan } from "@/lib/diagram/explainPlan";
import type { HypopgAnalysis } from "@/lib/diagnostics/hypopgSupport";

export type DiagnosticSeverity = "critical" | "warning" | "info";

export interface QueryDiagnosticFinding {
  severity: DiagnosticSeverity;
  code: string;
  title: string;
  detail: string;
  suggestion?: string;
}

export interface QueryIndexSuggestion {
  table: string;
  columns: string[];
  includeColumns: string[];
  /** SQL Server MissingIndexes impact percentage (0-100). */
  impact?: number;
  /** Partial index predicate (`WHERE …`), PostgreSQL only. */
  where?: string;
  sql: string;
  reason: string;
}

export interface QueryRewriteCandidate {
  id: string;
  title: string;
  reason: string;
  sql: string;
}

export interface PlanExecutionMetrics {
  elapsedMs?: number;
  cpuMs?: number;
  logicalReads?: number;
  executionTimeMs?: number;
  planningTimeMs?: number;
  sharedHitBlocks?: number;
  sharedReadBlocks?: number;
}

export interface QueryDiagnosis {
  databaseType: string;
  metrics: PlanExecutionMetrics;
  findings: QueryDiagnosticFinding[];
  indexSuggestions: QueryIndexSuggestion[];
  rewriteCandidates: QueryRewriteCandidate[];
  /** True only when the cache was actually evicted before measurement. */
  coldStart: boolean;
  cacheNote?: string;
  /** Measured candidates, original SQL included as the first entry. */
  measured: MeasuredCandidate[];
  recommended?: { id: string; title: string; sql: string; elapsedMs?: number };
  /** PostgreSQL-only hypothetical-index trial (L2). Absent when the server cannot run it. */
  hypopg?: HypopgAnalysis;
}

export type QueryDiagnosisCore = Omit<QueryDiagnosis, "coldStart" | "cacheNote" | "measured" | "recommended" | "hypopg">;

/** Cache-clearing statements per database, applied before every measured run. */
export interface CacheClearPlan {
  statements: string[];
  /**
   * `true` when the statements really evict cached data pages. When PostgreSQL
   * cannot reach `pg_buffercache_evict_relation` the caller must label the run as
   * warm and report hit/read ratios instead of claiming a cold start.
   */
  cold: boolean;
  note?: string;
}

const SQLSERVER_CACHE_CLEAR = ["DBCC DROPCLEANBUFFERS WITH NO_INFOMSGS;", "DBCC FREEPROCCACHE WITH NO_INFOMSGS;"];

const POSTGRES_CACHE_CLEAR_FALLBACK = ["DISCARD ALL;"];

export function buildCacheClearPlan(databaseType: string | undefined, relations: readonly string[]): CacheClearPlan {
  if (databaseType === "sqlserver") {
    return { statements: [...SQLSERVER_CACHE_CLEAR], cold: true };
  }
  if (databaseType === "postgres" || databaseType === "kingbase" || databaseType === "opengauss" || databaseType === "vastbase") {
    const statements = [...POSTGRES_CACHE_CLEAR_FALLBACK];
    for (const relation of relations) {
      const literal = relation.replace(/'/g, "''");
      statements.push(`SELECT * FROM pg_buffercache_evict_relation('${literal}'::regclass);`);
    }
    return {
      statements,
      cold: relations.length > 0,
      note: relations.length > 0 ? "pg_buffercache (PostgreSQL 18+)" : "SQL 中未解析出表名，仅清理会话计划缓存",
    };
  }
  return { statements: [], cold: false, note: "该数据库不支持清空缓存" };
}

/** Tables referenced by FROM/JOIN clauses, as `schema.table` when the schema is written. */
export function extractReferencedRelations(sql: string): string[] {
  const relations = new Set<string>();
  const pattern = /\b(?:from|join|update|into)\s+([A-Za-z_][\w$]*)(?:\s*\.\s*([A-Za-z_][\w$]*))?/gi;
  for (const match of sql.matchAll(pattern)) {
    const first = match[1];
    const second = match[2];
    if (!first) continue;
    if (second) relations.add(`${first}.${second}`);
    else relations.add(first);
  }
  return [...relations];
}

function textOf(row: unknown): string | undefined {
  if (typeof row !== "string") return undefined;
  return row;
}

function findShowPlanXml(raw: unknown): string | undefined {
  const rows = (raw as { rows?: unknown[][][] } | null)?.rows;
  if (!Array.isArray(rows)) return undefined;
  for (const result of rows) {
    if (!Array.isArray(result)) continue;
    for (const row of result) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const text = textOf(cell);
        if (text && text.includes("<ShowPlanXML")) return text;
      }
    }
  }
  return undefined;
}

function numberAttr(element: Element, name: string): number | undefined {
  const value = element.getAttribute(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** ShowPlan attributes come bracket-quoted (`[dbo]`, `[OTM]`); display them bare. */
function sqlServerIdentifier(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const unquoted = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1).replace(/\]\]/g, "]") : trimmed;
  return unquoted || undefined;
}

interface SqlServerPlanFacts {
  elapsedMs?: number;
  cpuMs?: number;
  logicalReads?: number;
  findings: QueryDiagnosticFinding[];
  indexes: QueryIndexSuggestion[];
  relations: string[];
}

function parseSqlServerPlan(raw: unknown, sql?: string): SqlServerPlanFacts {
  const empty: SqlServerPlanFacts = { findings: [], indexes: [], relations: [] };
  const xml = findShowPlanXml(raw);
  if (!xml || typeof DOMParser === "undefined") return empty;
  const document = new DOMParser().parseFromString(xml, "text/xml");
  if (document.querySelector("parsererror")) return empty;

  const facts = sql ? deriveSqlColumnFacts(sql) : undefined;
  const findings: QueryDiagnosticFinding[] = [];
  const indexes: QueryIndexSuggestion[] = [];
  const relations: string[] = [];

  for (const missingIndexGroup of Array.from(document.querySelectorAll("MissingIndexGroup"))) {
    const impact = numberAttr(missingIndexGroup, "Impact");
    for (const missingIndex of Array.from(missingIndexGroup.querySelectorAll("MissingIndex"))) {
      const table = sqlServerIdentifier(missingIndex.getAttribute("Table"));
      if (!table) continue;
      const schema = sqlServerIdentifier(missingIndex.getAttribute("Schema")) || "dbo";
      const rawSchema = missingIndex.getAttribute("Schema") || "[dbo]";
      const rawTable = missingIndex.getAttribute("Table") || table;
      const equality: string[] = [];
      const inequality: string[] = [];
      const include: string[] = [];
      for (const group of Array.from(missingIndex.querySelectorAll("ColumnGroup"))) {
        const usage = (group.getAttribute("Usage") || "").toUpperCase();
        const names = Array.from(group.querySelectorAll("Column"))
          .map((column) => column.getAttribute("Name"))
          .filter((name): name is string => !!name);
        if (usage === "EQUALITY") equality.push(...names);
        else if (usage === "INEQUALITY") inequality.push(...names);
        else if (usage === "INCLUDE") include.push(...names);
      }
      const keyColumns = [...equality, ...inequality];
      if (keyColumns.length === 0) continue;
      const indexName = `IX_${table.replace(/[^\w]/g, "")}_${keyColumns.map((column) => column.replace(/[^\w]/g, "")).join("_")}`.slice(0, 120);
      const includeClause = include.length > 0 ? ` INCLUDE (${include.join(", ")})` : "";
      indexes.push({
        table: `${schema}.${table}`,
        columns: keyColumns,
        includeColumns: include,
        impact,
        sql: `CREATE NONCLUSTERED INDEX ${indexName}\nON ${rawSchema}.${rawTable} (${keyColumns.join(", ")})${includeClause};`,
        reason: impact !== undefined ? `SQL Server 缺失索引提示（预估收益 ${impact}%）` : "SQL Server 缺失索引提示",
      });
    }
  }

  const rootRelOp = document.querySelector("QueryPlan RelOp");
  const queryTimeStats = document.querySelector("QueryTimeStats");
  const elapsedMs = queryTimeStats ? numberAttr(queryTimeStats, "ElapsedTime") : undefined;
  const cpuMs = queryTimeStats ? numberAttr(queryTimeStats, "CpuTime") : undefined;
  const logicalReads = rootRelOp ? numberAttr(rootRelOp, "ActualLogicalReads") : undefined;

  const scans: string[] = [];
  const scannedTables: { display: string; relation: string; rows: number }[] = [];
  for (const relOp of Array.from(document.querySelectorAll("RelOp"))) {
    const physicalOp = relOp.getAttribute("PhysicalOp") || "";
    const object = relOp.querySelector("Object");
    const table = sqlServerIdentifier(object?.getAttribute("Table"));
    const schema = sqlServerIdentifier(object?.getAttribute("Schema"));
    if (table) relations.push(`${schema || "dbo"}.${table}`);
    const estimateRows = numberAttr(relOp, "EstimateRows") ?? 0;
    if (physicalOp === "Table Scan" && table && estimateRows >= 1000) {
      scans.push(`${schema || "dbo"}.${table}（预估 ${Math.round(estimateRows)} 行）`);
      scannedTables.push({ display: `${schema || "dbo"}.${table}`, relation: table, rows: estimateRows });
    } else if (physicalOp === "Clustered Index Scan" && table && estimateRows >= 10000) {
      scans.push(`${schema || "dbo"}.${table} 聚集索引扫描（预估 ${Math.round(estimateRows)} 行）`);
      scannedTables.push({ display: `${schema || "dbo"}.${table}`, relation: table, rows: estimateRows });
    }
    for (const scalar of Array.from(relOp.querySelectorAll("ScalarOperator"))) {
      const expression = scalar.getAttribute("ScalarString") || "";
      if (expression.includes("CONVERT_IMPLICIT")) {
        findings.push({
          severity: "warning",
          code: "sqlserver.implicit-conversion",
          title: "存在隐式类型转换",
          detail: `比较时发生隐式转换：${expression.slice(0, 180)}`,
          suggestion: "让谓词两侧的数据类型一致（改字段类型或显式 CAST 常量），否则索引无法有效 Seek。",
        });
      }
    }
  }
  if (scans.length > 0) {
    // Turn "big table scan" into the concrete index that removes it: join keys
    // and output columns come from the query text, since the plan only reports
    // the filters it chose to evaluate.
    const hints = scannedTables.slice(0, 3).map((scan) => buildScanIndexHint({ databaseType: "sqlserver", table: scan.display, relation: scan.relation, facts, totalRows: scan.rows }));
    for (const hint of hints) indexes.push(...hint.indexes);
    findings.push({
      severity: "critical",
      code: "sqlserver.table-scan",
      title: "大表扫描",
      detail: `执行计划包含大表扫描：${scans.slice(0, 4).join("；")}`,
      suggestion: hints.length > 0 ? hints.map((hint) => hint.text).join(" ") : "检查 WHERE/JOIN 谓词列，建立覆盖索引或调整谓词写法。",
    });
  }

  return {
    elapsedMs,
    cpuMs,
    logicalReads,
    findings,
    indexes,
    relations: [...new Set(relations)],
  };
}

interface PostgresPlanFacts {
  executionTimeMs?: number;
  planningTimeMs?: number;
  sharedHitBlocks?: number;
  sharedReadBlocks?: number;
  findings: QueryDiagnosticFinding[];
  indexes: QueryIndexSuggestion[];
  relations: string[];
}

/** Total JIT compilation time (ms) from a plan's `JIT.Timing` block. */
function jitTimingMs(root: Record<string, unknown>): number {
  const jit = root["JIT"];
  if (!jit || typeof jit !== "object") return 0;
  const timing = (jit as Record<string, unknown>)["Timing"];
  if (!timing || typeof timing !== "object") return 0;
  const total = (timing as Record<string, unknown>)["Total"];
  return typeof total === "number" ? total : 0;
}

function jitFunctionCount(root: Record<string, unknown>): number {
  const jit = root["JIT"];
  if (!jit || typeof jit !== "object") return 0;
  const count = (jit as Record<string, unknown>)["Functions"];
  return typeof count === "number" ? count : 0;
}

function parsePostgresPlan(raw: unknown, sql?: string): PostgresPlanFacts {
  const roots = Array.isArray(raw) ? raw : [raw];
  const facts = sql ? deriveSqlColumnFacts(sql) : undefined;
  const findings: QueryDiagnosticFinding[] = [];
  const indexes: QueryIndexSuggestion[] = [];
  const relations: string[] = [];
  let executionTimeMs: number | undefined;
  let planningTimeMs: number | undefined;
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;
  let jitMs = 0;
  let jitFunctions = 0;

  for (const item of roots) {
    if (!item || typeof item !== "object") continue;
    const root = item as Record<string, unknown>;
    if (typeof root["Execution Time"] === "number") executionTimeMs = root["Execution Time"];
    if (typeof root["Planning Time"] === "number") planningTimeMs = root["Planning Time"];
    const plan = (root.Plan ?? root) as Record<string, unknown>;
    walkPostgresNode(plan, { findings, indexes, relations, facts });
    sharedHitBlocks += Number(plan["Shared Hit Blocks"] ?? 0);
    sharedReadBlocks += Number(plan["Shared Read Blocks"] ?? 0);
    jitMs += jitTimingMs(root);
    jitFunctions += jitFunctionCount(root);
  }

  // JIT only pays for itself on CPU-bound work that runs long. On a few hundred
  // milliseconds, emitting the compiled plan can cost more than the interpreted
  // execution it replaces.
  if (jitMs > 0 && executionTimeMs && jitMs / executionTimeMs >= 0.05) {
    findings.push({
      severity: "warning",
      code: "postgres.jit-overhead",
      title: "JIT 编译开销占比偏高",
      detail: `JIT 编译耗时 ${jitMs.toFixed(1)} ms，占执行时间 ${Math.round((jitMs / executionTimeMs) * 100)}%${jitFunctions > 0 ? `（${jitFunctions} 个函数）` : ""}。`,
      suggestion: "会话内 SET jit = off 重跑对比，或调高 jit_above_cost / jit_inline_above_cost，让这类短查询走解释执行。",
    });
  }

  return { executionTimeMs, planningTimeMs, sharedHitBlocks, sharedReadBlocks, findings, indexes, relations: [...new Set(relations)] };
}

interface PostgresWalkContext {
  findings: QueryDiagnosticFinding[];
  indexes: QueryIndexSuggestion[];
  relations: string[];
  /** Query-text column usage, used to turn scans into concrete index advice. */
  facts?: SqlColumnFacts;
}

function walkPostgresNode(node: Record<string, unknown>, ctx: PostgresWalkContext): void {
  const nodeType = String(node["Node Type"] ?? "");
  const relation = node["Relation Name"] ? String(node["Relation Name"]) : undefined;
  const schema = node["Schema"] ? String(node["Schema"]) : undefined;
  if (relation) ctx.relations.push(schema ? `${schema}.${relation}` : relation);

  const rowsRemoved = Number(node["Rows Removed by Filter"] ?? 0);
  const filter = node["Filter"] ? String(node["Filter"]) : undefined;
  const actualRows = Number(node["Actual Rows"] ?? 0);
  const planRows = Number(node["Plan Rows"] ?? 0);
  const loops = Number(node["Actual Loops"] ?? 1) || 1;

  if (relation && nodeType.includes("Seq Scan") && (rowsRemoved >= 1000 || actualRows >= 10000)) {
    const filterColumns = filter ? extractPostgresFilterColumns(filter) : [];
    const detailTable = schema ? `${schema}.${relation}` : relation;
    const hint = buildScanIndexHint({
      databaseType: "postgres",
      table: detailTable,
      relation,
      facts: ctx.facts,
      filterColumns,
      totalRows: actualRows * loops,
      removedRows: rowsRemoved * loops,
      readBlocks: Number(node["Shared Read Blocks"] ?? 0) || undefined,
      loops,
    });
    ctx.findings.push({
      severity: "critical",
      code: "postgres.seq-scan",
      title: "顺序扫描大表",
      detail: `${detailTable} 使用 Seq Scan，实际返回 ${Math.round(actualRows * loops)} 行${rowsRemoved > 0 ? `，过滤掉 ${Math.round(rowsRemoved * loops)} 行` : ""}${filter ? `；Filter: ${filter}` : ""}`,
      suggestion: hint.text,
    });
    if (hint.indexes.length > 0) ctx.indexes.push(...hint.indexes);
  }

  const sortMethod = node["Sort Method"] ? String(node["Sort Method"]) : undefined;
  if (nodeType === "Sort" && sortMethod && sortMethod.toLowerCase().includes("external")) {
    ctx.findings.push({
      severity: "warning",
      code: "postgres.sort-spill",
      title: "排序溢出到磁盘",
      detail: `Sort Method: ${sortMethod}${node["Sort Space Used"] ? `，占用 ${String(node["Sort Space Used"])} kB` : ""}`,
      suggestion: "让排序走索引（ORDER BY 列建索引），或在会话内临时调大 work_mem。",
    });
  }

  const heapFetches = Number(node["Heap Fetches"] ?? 0);
  if (nodeType.includes("Index Only Scan") && heapFetches > 0) {
    ctx.findings.push({
      severity: "warning",
      code: "postgres.heap-fetches",
      title: "Index Only Scan 仍需回表",
      detail: `Heap Fetches: ${heapFetches}`,
      suggestion: "执行 VACUUM (ANALYZE) 更新可见性映射，避免 index-only scan 退化为回表。",
    });
  }

  const joinFilterRemoved = Number(node["Rows Removed by Join Filter"] ?? 0);
  if (nodeType === "Nested Loop" && joinFilterRemoved >= 1000) {
    ctx.findings.push({
      severity: "warning",
      code: "postgres.join-filter",
      title: "连接条件过滤掉大量行",
      detail: `Rows Removed by Join Filter: ${joinFilterRemoved}`,
      suggestion: "为连接列建立索引，或检查连接条件的类型是否一致。",
    });
  }

  if (planRows > 0 && actualRows > 0) {
    const ratio = Math.max(actualRows / planRows, planRows / actualRows);
    if (ratio >= 10 && actualRows >= 100) {
      ctx.findings.push({
        severity: "info",
        code: "postgres.estimate-drift",
        title: "行数估算偏差较大",
        detail: `${nodeType}${relation ? ` on ${relation}` : ""}：预估 ${planRows} 行，实际 ${actualRows} 行（约 ${ratio.toFixed(0)} 倍）`,
        suggestion: "对相关表执行 ANALYZE（必要时提高统计目标），让优化器获得准确的选择性。",
      });
    }
  }

  // A cast of the *literal* side (`qty1 <> '0'::numeric`) keeps the column's
  // index usable; only a cast wrapping the column invalidates it.
  if (filter && hasColumnCast(filter)) {
    ctx.findings.push({
      severity: "warning",
      code: "postgres.implicit-cast",
      title: "谓词中存在类型转换",
      detail: `Filter: ${filter}`,
      suggestion: "比较两侧类型保持一致（改字段类型或改常量写法），类型转换会导致索引失效。",
    });
  }
  if (filter && /\b(lower|upper|trim|substr|substring|date_trunc|to_char)\s*\(/i.test(filter)) {
    ctx.findings.push({
      severity: "warning",
      code: "postgres.function-on-column",
      title: "过滤列被函数包裹",
      detail: `Filter: ${filter}`,
      suggestion: "建立表达式索引（如 CREATE INDEX ON t (lower(col))），或改写条件避免函数包裹。",
    });
  }

  const plans = node.Plans;
  if (Array.isArray(plans)) {
    for (const child of plans) {
      if (child && typeof child === "object") walkPostgresNode(child as Record<string, unknown>, ctx);
    }
  }
}

function quoteIdentifier(value: string | undefined): string {
  if (!value) return "";
  return /^[a-z_][\w$]*$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}

/**
 * True only when a *column* — not a literal — carries a cast. Postgres rewrites
 * `col > 5` to `col > '5'::numeric`; that literal cast keeps the index usable,
 * while `col::text > '5'` invalidates it.
 */
export function hasColumnCast(expression: string): boolean {
  if (/\bcast\s*\(\s*[A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)?\s+as\s+/i.test(expression)) return true;
  if (/\(\s*[A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)?\s*\)\s*::/i.test(expression)) return true;
  // Bare `col::type`; a literal starts with a quote or digit, so it never matches.
  return /[A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)?\s*::\s*[A-Za-z_]/i.test(expression);
}

/** Columns used by simple comparison predicates in a PostgreSQL Filter expression. */
export function extractPostgresFilterColumns(filter: string): string[] {
  const columns = new Set<string>();
  const pattern = /\b([A-Za-z_][\w$]*)\s*(?:=\s*|<>|!=|>=|<=|>|<|~~|!~~|like|ilike)/gi;
  for (const match of filter.matchAll(pattern)) {
    const column = match[1];
    if (!column) continue;
    if (/^(and|or|not|null|true|false)$/i.test(column)) continue;
    // `col::numeric > 5` makes the type name look like a cmp column; skip it.
    const before = filter.slice(Math.max(0, (match.index ?? 0) - 4), match.index ?? 0);
    if (before.endsWith("::")) continue;
    columns.add(column);
  }
  return [...columns].slice(0, 4);
}

export function diagnoseQueryPlan(plan: ParsedExplainPlan, sql: string): QueryDiagnosisCore {
  if (plan.databaseType === "sqlserver") {
    const facts = parseSqlServerPlan(plan.raw, sql);
    return {
      databaseType: plan.databaseType,
      metrics: { elapsedMs: facts.elapsedMs, cpuMs: facts.cpuMs, logicalReads: facts.logicalReads },
      findings: dedupeFindings([...facts.findings, ...sqlShapeFindings(sql, "sqlserver")]),
      indexSuggestions: mergeIndexSuggestions(facts.indexes, buildIndexSuggestionsFromSql(sql, "sqlserver")),
      rewriteCandidates: buildRewriteCandidates(sql, new Set(facts.relations.map((relation) => relation.split(".").pop()?.toLowerCase() ?? "")), "sqlserver"),
    };
  }
  if (plan.databaseType === "postgres") {
    const facts = parsePostgresPlan(plan.raw, sql);
    return {
      databaseType: plan.databaseType,
      metrics: {
        executionTimeMs: facts.executionTimeMs,
        planningTimeMs: facts.planningTimeMs,
        sharedHitBlocks: facts.sharedHitBlocks,
        sharedReadBlocks: facts.sharedReadBlocks,
      },
      findings: dedupeFindings([...facts.findings, ...sqlShapeFindings(sql, "postgres")]),
      indexSuggestions: mergeIndexSuggestions(facts.indexes, buildIndexSuggestionsFromSql(sql, "postgres")),
      rewriteCandidates: buildRewriteCandidates(sql, new Set(facts.relations.map((relation) => relation.split(".").pop()?.toLowerCase() ?? "")), "postgres"),
    };
  }
  return { databaseType: plan.databaseType, metrics: {}, findings: sqlShapeFindings(sql), indexSuggestions: [], rewriteCandidates: [] };
}

function mergeIndexSuggestions(planSuggestions: QueryIndexSuggestion[], sqlSuggestions: QueryIndexSuggestion[]): QueryIndexSuggestion[] {
  const bareName = (table: string) => {
    const lower = table.toLowerCase();
    return lower.split(".").pop() ?? lower;
  };
  // The query text often omits the schema (`qstest_oitw`) while the plan reports
  // it (`public.qstest_oitw`). Resolve the bare name to the plan's qualified name,
  // but only when it is unambiguous — two schemas may share a table name.
  const qualifiedByBare = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const suggestion of planSuggestions) {
    const bare = bareName(suggestion.table);
    if (ambiguous.has(bare)) continue;
    const full = suggestion.table.toLowerCase();
    const known = qualifiedByBare.get(bare);
    if (known === undefined) qualifiedByBare.set(bare, full);
    else if (known !== full) {
      ambiguous.add(bare);
      qualifiedByBare.delete(bare);
    }
  }
  const canonicalTable = (table: string) => {
    const lower = table.toLowerCase();
    if (lower.includes(".")) return lower;
    return qualifiedByBare.get(lower) ?? lower;
  };

  const seenKeys = new Set<string>();
  const planColumnSets = new Set<string>();
  const merged: QueryIndexSuggestion[] = [];
  const keyOf = (suggestion: QueryIndexSuggestion) => `${canonicalTable(suggestion.table)}\0${suggestion.columns.map((column) => column.toLowerCase()).join(",")}\0${suggestion.where?.toLowerCase() ?? ""}`;
  // Key ∪ INCLUDE. A plan hint and a SQL hint carrying the same columns describe
  // the same physical index; the plan version wins because it already reflects
  // the access path the optimizer chose. Only plan suggestions are registered
  // here, so the SQL-side equality-first / range-first pair is still kept.
  const columnSetOf = (suggestion: QueryIndexSuggestion) =>
    `${canonicalTable(suggestion.table)}\0${[...suggestion.columns, ...suggestion.includeColumns]
      .map((column) => column.toLowerCase())
      .sort()
      .join(",")}\0${suggestion.where?.toLowerCase() ?? ""}`;

  for (const suggestion of planSuggestions) {
    const key = keyOf(suggestion);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    planColumnSets.add(columnSetOf(suggestion));
    merged.push(suggestion);
  }
  for (const suggestion of sqlSuggestions) {
    const key = keyOf(suggestion);
    if (seenKeys.has(key)) continue;
    if (planColumnSets.has(columnSetOf(suggestion))) continue;
    seenKeys.add(key);
    merged.push(suggestion);
  }
  return merged;
}

interface SqlTableAlias {
  /** Alias as written in the query (`t1`). */
  alias: string;
  /** Table name possibly schema-qualified (`public.orders`). */
  table: string;
  /** Offset of the declaration, used to pair `JOIN` targets with `USING` columns. */
  index: number;
}

const RESERVED_ALIAS_WORDS = new Set([
  "where",
  "join",
  "on",
  "inner",
  "left",
  "right",
  "full",
  "outer",
  "cross",
  "natural",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "union",
  "except",
  "intersect",
  "window",
  "qualify",
  "returning",
  "values",
  "set",
  "using",
  "as",
  "and",
  "or",
  "not",
  "select",
  "from",
]);

/** Blanks out everything inside parentheses, keeping offsets so regex indices stay valid. */
function maskParenthesizedContents(sql: string): string {
  let depth = 0;
  let masked = "";
  for (const character of sql) {
    if (character === "(") {
      depth += 1;
      masked += character;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      masked += character;
      continue;
    }
    masked += depth > 0 && character !== "\n" ? " " : character;
  }
  return masked;
}

/** Falls back to the bare table name when the alias slot holds a keyword (`on`, `where`). */
function resolveAlias(candidate: string | undefined, table: string): string {
  return candidate && !RESERVED_ALIAS_WORDS.has(candidate.toLowerCase()) ? candidate : (table.split(".").pop() ?? table);
}

/**
 * Maps aliases to base tables, ignoring derived tables (`from (select …) t2`).
 *
 * Covers every `JOIN` flavour (inner/left/right/full/cross, `ON` or `USING`),
 * plus the legacy comma-separated FROM list — that is an implicit inner join
 * and is still very common in older SQL Server queries.
 */
function extractSqlTableAliases(sql: string): SqlTableAlias[] {
  const aliases: SqlTableAlias[] = [];
  const seen = new Set<string>();
  const add = (table: string, candidate: string | undefined, index: number) => {
    const alias = resolveAlias(candidate, table);
    const key = alias.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    aliases.push({ alias, table, index });
  };

  const structural = maskParenthesizedContents(sql);
  for (const match of structural.matchAll(/\b(?:from|join)\s+(?!\()([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s*(?:(?:as)\s+)?([A-Za-z_][\w$]*)?/gi)) {
    if (match[1]) add(match[1], match[2], match.index ?? 0);
  }

  // `from a x, b y` — one relation per top-level comma. Parenthesized contents
  // are already blanked, so their commas cannot split anything.
  const fromClause = /\bfrom\b([^;]*?)(?=\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|\boffset\b|\bunion\b|\bexcept\b|\bintersect\b|\bon\b|;|$)/i.exec(structural);
  if (fromClause?.[1] !== undefined) {
    let offset = (fromClause.index ?? 0) + fromClause[0].length - fromClause[1].length;
    for (const chunk of fromClause[1].split(",")) {
      const position = offset;
      offset += chunk.length + 1;
      const trimmed = chunk.trim();
      if (!trimmed || trimmed.startsWith("(")) continue;
      const relation = /^([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s*(?:(?:as)\s+)?([A-Za-z_][\w$]*)?/i.exec(trimmed);
      if (relation?.[1]) add(relation[1], relation[2], position);
    }
  }
  return aliases;
}

const NON_COLUMN_WORDS = new Set([
  "select",
  "from",
  "where",
  "group",
  "by",
  "order",
  "having",
  "limit",
  "offset",
  "as",
  "distinct",
  "all",
  "and",
  "or",
  "not",
  "case",
  "when",
  "then",
  "else",
  "end",
  "null",
  "true",
  "false",
  "is",
  "in",
  "between",
  "like",
  "ilike",
  "exists",
  "union",
  "sum",
  "avg",
  "count",
  "min",
  "max",
  "cast",
  "convert",
  "coalesce",
  "isnull",
  "extract",
  "date_trunc",
  "to_char",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "natural",
  "join",
  "on",
  "asc",
  "desc",
  "over",
  "partition",
  "window",
  "filter",
]);

/** `alias.col <op> 常量` —— 单表谓词，可以直接写进部分索引的 WHERE。 */
export interface AliasPredicateLiteral {
  column: string;
  operator: string;
  /** Literal exactly as written in the SQL (`'0'`, `0`, `true`). */
  operand: string;
}

/** Column roles an alias plays in the query text. */
export interface AliasColumnUsage {
  /** `col = value`, `col <> value`, `col IN (…)` — the leading key columns. */
  equality: string[];
  /** `col BETWEEN …`, `col > value` — trailing key columns. */
  range: string[];
  /** Both sides of `a.x = b.y`; each side records its own column. */
  join: string[];
  /** SELECT list / GROUP BY / aggregate inputs — INCLUDE candidates. */
  output: string[];
  /** Constant predicates on this alias, reusable as a partial-index WHERE. */
  predicates?: AliasPredicateLiteral[];
}

export interface SqlColumnFacts {
  aliases: SqlTableAlias[];
  /** Keyed by lower-cased alias. */
  usage: Map<string, AliasColumnUsage>;
}

/** Strips comments and string literals so values can never look like columns. */
function stripSqlNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''");
}

/**
 * Blanks comments and the *inside* of string literals while keeping every offset
 * in place, so a match found here can be read back verbatim from the original SQL.
 */
function maskSqlKeepingOffsets(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, (match) => " ".repeat(match.length))
    .replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length))
    .replace(/'(?:''|[^'])*'/g, (match) => `'${" ".repeat(Math.max(0, match.length - 2))}'`);
}

/** `alias.column <op> 常量` — the constant is required, so the predicate is single-table. */
const LITERAL_PREDICATE = /([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)\s*(<>|!=|>=|<=|=|>|<)\s*('(?:''|[^'])*'|-?\d+(?:\.\d+)?|\b(?:true|false|null)\b)/gi;

function addUnique(list: string[], value: string): void {
  const normalized = value.toLowerCase();
  if (!list.some((existing) => existing.toLowerCase() === normalized)) list.push(value);
}

function addPredicate(bucket: AliasColumnUsage, predicate: AliasPredicateLiteral): void {
  const key = `${predicate.column.toLowerCase()}\0${predicate.operator}\0${predicate.operand}`;
  const predicates = (bucket.predicates ??= []);
  if (predicates.some((entry) => `${entry.column.toLowerCase()}\0${entry.operator}\0${entry.operand}` === key)) return;
  predicates.push(predicate);
}

function uniqueColumns(columns: readonly string[]): string[] {
  const unique: string[] = [];
  for (const column of columns) addUnique(unique, column);
  return unique;
}

const COLUMN_REFERENCE = /([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)/g;
/** `x = b.y` — the reference is the left operand of a column-to-column comparison. */
const JOIN_AFTER = /^[\s)]*(?:=|<>|!=)[\s(]*([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)/;
/** `a.x = …` right before the reference — it is the right operand of that comparison. */
const JOIN_BEFORE = /([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)[\s)]*(?:=|<>|!=)[\s(]*$/;

/**
 * Classifies every `alias.column` reference per alias.
 *
 * A join comparison marks **both** sides: without the right-hand side the
 * joined-to table never receives its join key, which is exactly the index that
 * turns a nested loop into an index scan.
 */
export function deriveSqlColumnFacts(sql: string): SqlColumnFacts {
  const aliases = extractSqlTableAliases(sql);
  const usage = new Map<string, AliasColumnUsage>();
  if (aliases.length === 0) return { aliases, usage };
  const aliasSet = new Map(aliases.map((entry) => [entry.alias.toLowerCase(), entry]));
  const scan = stripSqlNoise(sql);

  const usageFor = (alias: string): AliasColumnUsage => {
    const key = alias.toLowerCase();
    let bucket = usage.get(key);
    if (!bucket) {
      bucket = { equality: [], range: [], join: [], output: [] };
      usage.set(key, bucket);
    }
    return bucket;
  };

  for (const match of scan.matchAll(COLUMN_REFERENCE)) {
    const aliasKey = match[1]!.toLowerCase();
    if (!aliasSet.has(aliasKey)) continue;
    const column = match[2]!;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const after = scan.slice(end, end + 64);
    const before = scan.slice(Math.max(0, start - 64), start);

    const joinAfter = JOIN_AFTER.exec(after);
    if (joinAfter && aliasSet.has(joinAfter[1]!.toLowerCase())) {
      addUnique(usageFor(aliasKey).join, column);
      addUnique(usageFor(joinAfter[1]!).join, joinAfter[2]!);
      continue;
    }
    const joinBefore = JOIN_BEFORE.exec(before);
    if (joinBefore && aliasSet.has(joinBefore[1]!.toLowerCase())) {
      addUnique(usageFor(aliasKey).join, column);
      addUnique(usageFor(joinBefore[1]!).join, joinBefore[2]!);
      continue;
    }

    if (/^[\s)]*between\b/i.test(after)) {
      addUnique(usageFor(aliasKey).range, column);
    } else if (/^[\s)]*in\s*\(/i.test(after)) {
      addUnique(usageFor(aliasKey).equality, column);
    } else if (/^[\s)]*(?:=|<>|!=)[\s(]*(?:'|\?|\d|any\s*\(|array\[|null|true|false)/i.test(after)) {
      addUnique(usageFor(aliasKey).equality, column);
    } else if (/^[\s)]*(?:>=|<=|>|<)[\s(]*(?:'|\?|\d|any\s*\(|array\[)/i.test(after)) {
      addUnique(usageFor(aliasKey).range, column);
    } else if (/['\d)]\s*(?:=|<>|!=)\s*$/.test(before)) {
      // Reversed value comparison: `'A' = status`, `1 <> qty`.
      addUnique(usageFor(aliasKey).equality, column);
    } else if (/['\d)]\s*(?:>=|<=|>|<)\s*$/.test(before)) {
      addUnique(usageFor(aliasKey).range, column);
    }
  }

  // `alias.col <op> 常量` 是单表谓词，可以原样写进部分索引的 WHERE：
  // 只索引命中的行，索引体积和扫描量都按谓词命中率缩小。
  const masked = maskSqlKeepingOffsets(sql);
  for (const match of masked.matchAll(LITERAL_PREDICATE)) {
    const aliasKey = match[1]!.toLowerCase();
    if (!aliasSet.has(aliasKey)) continue;
    const operandLength = match[4]!.length;
    const operandStart = (match.index ?? 0) + match[0].length - operandLength;
    const operand = sql.slice(operandStart, operandStart + operandLength).trim();
    if (!operand) continue;
    addPredicate(usageFor(aliasKey), { column: match[2]!, operator: match[3]!, operand });
  }

  // `JOIN … USING (a, b)` and `NATURAL JOIN` write no `alias.column` reference, so
  // the scan above cannot see those join keys. Pair every USING clause with the
  // join target declared right before it and the relation on the other side.
  const structural = maskParenthesizedContents(scan);
  const joinTargets = [...structural.matchAll(/\bjoin\s+(?!\()([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s*(?:(?:as)\s+)?([A-Za-z_][\w$]*)?/gi)].map((match) => ({
    alias: resolveAlias(match[2], match[1]!),
    index: match.index ?? 0,
  }));
  for (const match of scan.matchAll(/\busing\s*\(\s*([^)]*?)\s*\)/gi)) {
    const start = match.index ?? 0;
    const target = joinTargets.filter((entry) => entry.index < start).pop();
    if (!target || !aliasSet.has(target.alias.toLowerCase())) continue;
    const counterparts = aliases.filter((entry) => entry.index < target.index && entry.alias.toLowerCase() !== target.alias.toLowerCase());
    const counterpart = counterparts[counterparts.length - 1] ?? aliases.find((entry) => entry.alias.toLowerCase() !== target.alias.toLowerCase());
    if (!counterpart) continue;
    for (const raw of match[1]!.split(",")) {
      const column = raw.trim();
      if (!/^[A-Za-z_][\w$]*$/.test(column)) continue;
      addUnique(usageFor(target.alias).join, column);
      addUnique(usageFor(counterpart.alias).join, column);
    }
  }

  // SELECT list, GROUP BY and aggregate inputs become INCLUDE candidates.
  const selectBody = /\bselect\b([\s\S]*?)\bfrom\b/i.exec(scan)?.[1] ?? "";
  const groupBody = /\bgroup\s+by\b([\s\S]*?)(?:\b(?:having|order\s+by|limit|offset)\b|$)/i.exec(scan)?.[1] ?? "";
  const primaryAlias = aliases[0]?.alias.toLowerCase();
  for (const body of [selectBody, groupBody]) {
    for (const match of body.matchAll(COLUMN_REFERENCE)) {
      const aliasKey = match[1]!.toLowerCase();
      if (!aliasSet.has(aliasKey)) continue;
      addUnique(usageFor(aliasKey).output, match[2]!);
    }
    if (!primaryAlias) continue;
    // Blank out `alias.column` before looking for unqualified columns; otherwise
    // `t3.groupname` would be filed as a column of the primary relation.
    const masked = body.replace(COLUMN_REFERENCE, (full: string) => " ".repeat(full.length));
    for (const match of masked.matchAll(/\b([A-Za-z_][\w$]*)\b(?!\s*\()/g)) {
      const word = match[1]!;
      const lower = word.toLowerCase();
      if (NON_COLUMN_WORDS.has(lower) || aliasSet.has(lower) || /^\d/.test(word)) continue;
      // Skip projection aliases: they follow a closing paren or a numeric literal.
      const before = masked.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
      if (/[)\d]\s*$/.test(before)) continue;
      addUnique(usageFor(primaryAlias).output, word);
    }
  }

  return { aliases, usage };
}

/** Merges the usage of every alias bound to `relation` (self-joins included). */
function usageForRelation(facts: SqlColumnFacts | undefined, relation: string): AliasColumnUsage | undefined {
  if (!facts) return undefined;
  const wanted = relation.toLowerCase();
  const wantedBare = wanted.split(".").pop() ?? wanted;
  const merged: AliasColumnUsage = { equality: [], range: [], join: [], output: [] };
  let matched = false;
  for (const entry of facts.aliases) {
    const table = entry.table.toLowerCase();
    const bare = table.split(".").pop() ?? table;
    if (table !== wanted && bare !== wantedBare) continue;
    const usage = facts.usage.get(entry.alias.toLowerCase());
    if (!usage) continue;
    matched = true;
    for (const role of ["equality", "range", "join", "output"] as const) {
      for (const column of usage[role]) addUnique(merged[role], column);
    }
    for (const predicate of usage.predicates ?? []) addPredicate(merged, predicate);
  }
  return matched ? merged : undefined;
}

/** Row/block counts read better as `149 万` than as `1494773`. */
function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 10000) return `${Math.round(value / 10000)} 万`;
  return String(Math.round(value));
}

interface ScanIndexHintInput {
  databaseType: string;
  /** Table as shown to the user (`public.qstest_oitm`). */
  table: string;
  /** Bare relation name from the plan, used to look up query-text column usage. */
  relation: string;
  facts?: SqlColumnFacts;
  /** Columns the plan actually evaluated in `Filter`, when it reported any. */
  filterColumns?: string[];
  totalRows: number;
  removedRows?: number;
  readBlocks?: number;
  /** Parallel workers that ran this scan (`Actual Loops`). */
  loops?: number;
}

type IndexSuggestionVariant = "equality-first" | "range-first" | "scan-hint" | "join-first" | "partial";

const INDEX_VARIANT_REASON: Record<IndexSuggestionVariant, string> = {
  "equality-first": "来自 SQL 谓词与输出列推导（等值列在前、范围列在后，输出列放 INCLUDE）",
  "range-first": "对照方案：范围列在前（部分优化器在范围选择性更高时更优），输出列放 INCLUDE",
  "scan-hint": "来自执行计划中的顺序扫描：过滤列作键、连接列紧随其后，其余列放 INCLUDE",
  "join-first": "连接列作键列：本表被其他表驱动时，嵌套循环可按连接键直接定位行",
  partial: "部分索引：把 WHERE 谓词写进索引定义，只索引命中的行（索引更小、扫描更少），常与连接/覆盖索引组合使用",
};

interface TableIndexInput {
  databaseType: string;
  /** Table as written to the user (`public.qstest_oitm`). */
  table: string;
  equality: string[];
  range: string[];
  join: string[];
  output: string[];
  /** `alias.col <op> 常量` predicates, used to build a partial-index variant. */
  predicates?: AliasPredicateLiteral[];
  /** Variant used by the filter-leading suggestion. */
  variant: IndexSuggestionVariant;
}

/** `(a, b) INCLUDE (c) WHERE …` — only the key/INCLUDE/partial part, for prose. */
function summarizeIndex(suggestion: QueryIndexSuggestion): string {
  const include = suggestion.includeColumns.length > 0 ? ` INCLUDE (${suggestion.includeColumns.join(", ")})` : "";
  const where = suggestion.where ? ` WHERE ${suggestion.where}` : "";
  return `(${suggestion.columns.join(", ")})${include}${where}`;
}

/**
 * One table's index options, shared by the plan pass and the SQL-text pass.
 *
 * Every join flavour (inner/left/right/full/cross, `ON`/`USING`, comma lists) is
 * folded into `join`, so a table is always analysed on both fronts: a
 * filter-leading index for its WHERE predicates *and* join-first indexes that let
 * the optimizer probe this table from the driving side of the join.
 */
function buildTableIndexSuggestions(input: TableIndexInput): QueryIndexSuggestion[] {
  const equality = uniqueColumns(input.equality);
  const range = uniqueColumns(input.range);
  const join = uniqueColumns(input.join);
  const filters = uniqueColumns([...equality, ...range]);
  // Every column this table has to supply: filters, join keys and projection.
  const referenced = uniqueColumns([...filters, ...join, ...input.output]);
  const suggestions: QueryIndexSuggestion[] = [];
  const seen = new Set<string>();
  const push = (columns: string[], variant: IndexSuggestionVariant) => {
    const keyColumns = uniqueColumns(columns).slice(0, 4);
    if (keyColumns.length === 0) return;
    const dedupe = keyColumns.map((column) => column.toLowerCase()).join(",");
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    const includeColumns = referenced.filter((column) => !keyColumns.some((key) => key.toLowerCase() === column.toLowerCase())).slice(0, 6);
    suggestions.push(buildIndexSuggestionSql(input.table, keyColumns, includeColumns, input.databaseType, variant));
  };

  // Filters first and the join keys right behind them: one index serves the
  // WHERE predicate and the join lookup at the same time.
  if (filters.length > 0) push([...filters, ...join], input.variant);
  // Each join key also stands on its own, because the driving side decides which
  // column the nested loop probes by.
  for (const column of join.slice(0, 2)) push([column], "join-first");
  // Keep the range-first comparison plan when there is no join to weigh in.
  if (join.length === 0 && equality.length > 0 && range.length > 0) push([...range, ...equality], "range-first");

  // 部分索引：谓词命中率低的查询，把谓词写进索引定义能直接砍掉索引体积和扫描量，
  // 常与其它表的覆盖索引组合出最优计划。只对 PostgreSQL 生成（L2 的 hypopg 试算只跑在 PG 上）。
  const predicates = (input.predicates ?? []).filter((predicate) => predicate.operand.length > 0);
  if (input.databaseType === "postgres" && predicates.length > 0) {
    const predicateColumns = uniqueColumns(predicates.map((predicate) => predicate.column));
    const isPredicateColumn = (column: string) => predicateColumns.some((entry) => entry.toLowerCase() === column.toLowerCase());
    const otherKeys = uniqueColumns([...join, ...filters.filter((column) => !isPredicateColumn(column))]).slice(0, 4);
    // 没有别的过滤/连接列时，只能拿谓词列本身作键。
    const keyColumns = otherKeys.length > 0 ? otherKeys : predicateColumns.slice(0, 1);
    const includeColumns = uniqueColumns([...referenced, ...predicateColumns])
      .filter((column) => !keyColumns.some((key) => key.toLowerCase() === column.toLowerCase()))
      .slice(0, 6);
    const where = predicates.map((predicate) => `${quoteIdentifier(predicate.column)} ${predicate.operator} ${predicate.operand}`).join(" AND ");
    const dedupe = `partial:${keyColumns.map((column) => column.toLowerCase()).join(",")}:${where}`;
    if (!seen.has(dedupe)) {
      seen.add(dedupe);
      suggestions.push(buildIndexSuggestionSql(input.table, keyColumns, includeColumns, input.databaseType, "partial", undefined, where));
    }
  }

  return suggestions;
}

/**
 * Turns "this table is scan-only" into the specific index that removes the scan.
 *
 * The plan alone only knows which filters *it* evaluated, which is empty for
 * scans that exist purely because of a join key. Join columns and output
 * columns are therefore taken from the query text.
 */
function buildScanIndexHint(input: ScanIndexHintInput): { text: string; indexes: QueryIndexSuggestion[] } {
  const usage = usageForRelation(input.facts, input.relation);
  const planFilters = uniqueColumns(input.filterColumns ?? []);
  const equality = uniqueColumns([...planFilters, ...(usage?.equality ?? [])]);
  const range = uniqueColumns(usage?.range ?? []);
  const join = uniqueColumns(usage?.join ?? []);
  const output = uniqueColumns(usage?.output ?? []);
  const filters = uniqueColumns([...equality, ...range]);

  const workers = input.loops && input.loops > 1 ? `（${input.loops} 个并行进程）` : "";
  const scope = `本次扫描约 ${formatCount(input.totalRows)}行${workers}${input.removedRows && input.removedRows >= 1000 ? `（过滤掉 ${formatCount(input.removedRows)}行）` : ""}${input.readBlocks ? `，读取 ${formatCount(input.readBlocks)}个块` : ""}`;

  const indexes = buildTableIndexSuggestions({ databaseType: input.databaseType, table: input.table, equality, range, join, output, predicates: usage?.predicates, variant: "scan-hint" });
  if (indexes.length === 0) {
    return { text: `未从 SQL 中解析出 ${input.table} 的过滤/连接列，请补全 WHERE/JOIN 谓词后再评估索引；${scope}。`, indexes };
  }

  const indexText = indexes.map(summarizeIndex).join("、");
  if (filters.length > 0 && join.length > 0) {
    return {
      text: `为 ${input.table} 建立索引 ${indexText}：过滤列作键、连接列紧随其后，一条索引同时服务 WHERE 过滤与 JOIN 定位；连接列单独作键的那条供优化器从驱动侧按连接键探测，避免整表顺序扫描（${scope}）。`,
      indexes,
    };
  }
  if (filters.length > 0) {
    return {
      text: `为 ${input.table} 建立索引 ${indexText}：过滤列作键列${indexes[0]?.includeColumns.length ? "，其余列放 INCLUDE 后可走 Index Only Scan" : ""}，直接定位命中的行，避免整表顺序扫描（${scope}）。`,
      indexes,
    };
  }
  return {
    text: `${input.table} 的扫描来自连接等值而非自身过滤条件，应在连接列上建索引 ${indexText}：优化器可用嵌套循环 + Index Scan 按连接键逐行取数，避免整表顺序扫描（${scope}）。`,
    indexes,
  };
}

/**
 * Derives composite covering-index suggestions directly from the query text.
 *
 * Execution plans only expose the predicates the optimizer chose to report
 * (SQL Server MissingIndexes, PostgreSQL per-row Filters), so BETWEEN range
 * joins, IN lists, `USING (…)` keys and aggregate inputs are routinely missing.
 * This pass reads WHERE/ON/USING per alias and hands each table to the shared
 * builder, which always covers both its own filters and its join keys.
 */
export function buildIndexSuggestionsFromSql(sql: string, databaseType: string): QueryIndexSuggestion[] {
  const facts = deriveSqlColumnFacts(sql);
  const suggestions: QueryIndexSuggestion[] = [];
  for (const entry of facts.aliases) {
    const usage = facts.usage.get(entry.alias.toLowerCase());
    if (!usage) continue;
    suggestions.push(
      ...buildTableIndexSuggestions({
        databaseType,
        table: entry.table,
        equality: usage.equality,
        range: usage.range,
        join: usage.join,
        output: usage.output,
        predicates: usage.predicates,
        variant: "equality-first",
      }),
    );
  }
  return suggestions;
}

function buildIndexSuggestionSql(table: string, columns: string[], includeColumns: string[], databaseType: string, variant: IndexSuggestionVariant = "equality-first", reason?: string, whereClause?: string): QueryIndexSuggestion {
  const [schema, name] = table.includes(".") ? (table.split(".") as [string, string]) : [undefined, table];
  const why = reason ?? INDEX_VARIANT_REASON[variant];
  if (databaseType === "sqlserver") {
    const suffix = variant === "range-first" ? "_R" : variant === "join-first" ? "_J" : "";
    const indexName = `IX_${name.replace(/[^\w]/g, "")}_${columns.map((column) => column.replace(/[^\w]/g, "")).join("_")}${suffix}`.slice(0, 120);
    const target = `[${schema ?? "dbo"}].[${name}]`;
    const includeClause = includeColumns.length > 0 ? ` INCLUDE (${includeColumns.map((column) => `[${column}]`).join(", ")})` : "";
    return {
      table: `${schema ?? "dbo"}.${name}`,
      columns,
      includeColumns,
      sql: `CREATE NONCLUSTERED INDEX ${indexName}\nON ${target} (${columns.map((column) => `[${column}]`).join(", ")})${includeClause};`,
      reason: why,
    };
  }
  const quotedTable = schema ? `${quoteIdentifier(schema)}.${quoteIdentifier(name)}` : quoteIdentifier(name);
  const includeClause = includeColumns.length > 0 ? ` INCLUDE (${includeColumns.map((column) => quoteIdentifier(column)).join(", ")})` : "";
  const wherePart = whereClause ? ` WHERE ${whereClause}` : "";
  return {
    table: schema ? `${schema}.${name}` : name,
    columns,
    includeColumns,
    ...(whereClause ? { where: whereClause } : {}),
    sql: `CREATE INDEX ON ${quotedTable} (${columns.map((column) => quoteIdentifier(column)).join(", ")})${includeClause}${wherePart};`,
    reason: why,
  };
}

function dedupeFindings(findings: QueryDiagnosticFinding[]): QueryDiagnosticFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}:${finding.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Dialect-neutral SQL shape rules that do not require an execution plan. */
export function sqlShapeFindings(sql: string, databaseType?: string): QueryDiagnosticFinding[] {
  const findings: QueryDiagnosticFinding[] = [];
  // Drop string literals and comments so keywords inside them do not match.
  const normalized = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''");

  if (/^\s*select\s+\*/i.test(normalized) || /,\s*\*/i.test(normalized)) {
    findings.push({
      severity: "info",
      code: "sql.select-star",
      title: "使用了 SELECT *",
      detail: "返回全部列会增加 I/O，也让覆盖索引难以生效。",
      suggestion: "只选择实际需要的列。",
    });
  }
  if (/like\s+'%/i.test(sql)) {
    findings.push({
      severity: "warning",
      code: "sql.leading-wildcard-like",
      title: "LIKE 以前导通配符开头",
      detail: "`LIKE '%...'` 无法使用普通 B-tree 索引。",
      suggestion:
        databaseType === "postgres"
          ? "创建 pg_trgm 扩展并建 GIN 索引：CREATE EXTENSION pg_trgm; CREATE INDEX … USING gin (col gin_trgm_ops);"
          : databaseType === "sqlserver"
            ? "改用全文索引（CONTAINS/FREETEXT），或保存反转列 + 后缀匹配。"
            : "改用后缀匹配 + 反转列/反转索引，或引入全文检索/trigram 索引。",
    });
  }
  if (/\bnot\s+in\s*\(\s*select\b/i.test(normalized)) {
    findings.push({
      severity: "warning",
      code: "sql.not-in-subquery",
      title: "NOT IN 子查询",
      detail: "NOT IN 遇到 NULL 时语义容易出错，且优化器通常难以改写为反连接。",
      suggestion: "改为 NOT EXISTS 或 LEFT JOIN ... IS NULL。",
    });
  }
  if (/\bor\b/i.test(normalized) && /^\s*select\b/i.test(normalized)) {
    findings.push({
      severity: "info",
      code: "sql.or-predicate",
      title: "OR 连接不同列的条件",
      detail: "跨列的 OR 往往只能走全表扫描。",
      suggestion: "评估拆成 UNION ALL，或为每个条件分别建索引后合并。",
    });
  }
  if (/\boffset\s+\d{2,}/i.test(normalized)) {
    findings.push({
      severity: "warning",
      code: "sql.deep-offset",
      title: "深分页（大 OFFSET）",
      detail: "OFFSET 越大，数据库仍要扫描并丢弃前面的行。",
      suggestion: "改为基于排序键的 keyset 分页（WHERE key > 上一页最后一个值）。",
    });
  }
  if (/\bwhere[^;]*\b(lower|upper|trim|substr|substring|date_trunc|to_char)\s*\(/i.test(normalized)) {
    findings.push({
      severity: "warning",
      code: "sql.function-in-where",
      title: "WHERE 中对列使用函数",
      detail: "函数包裹列会让该列上的普通索引失效。",
      suggestion: "改写条件或建立表达式索引。",
    });
  }
  if (databaseType === "postgres") findings.push(...postgresShapeFindings(sql, normalized));
  if (databaseType === "sqlserver") findings.push(...sqlServerShapeFindings(normalized));
  return findings;
}

/**
 * PostgreSQL-specific idioms. Sourced from the manual's pattern-matching,
 * pg_trgm, LIMIT/OFFSET and ANY/ARRAY sections.
 */
function postgresShapeFindings(sql: string, normalized: string): QueryDiagnosticFinding[] {
  const findings: QueryDiagnosticFinding[] = [];

  if (/\bilike\s+'%/i.test(sql)) {
    findings.push({
      severity: "warning",
      code: "postgres.ilike-trigram",
      title: "ILIKE 以前导通配符开头",
      detail: "ILIKE 是 PostgreSQL 的大小写不敏感写法，但前导 `%` 让 B-tree 无法使用。",
      suggestion: "CREATE EXTENSION pg_trgm; 然后 CREATE INDEX … USING gin (col gin_trgm_ops)；该 GIN 索引同时支持 LIKE 与 ILIKE。",
    });
  }
  if (/[~!]?~\*?\s*'/i.test(sql) && !/\bilike\b/i.test(sql)) {
    findings.push({
      severity: "info",
      code: "postgres.regex-operator",
      title: "使用了 POSIX 正则运算符",
      detail: "`~` / `~*` 只能走全表或表达式索引。",
      suggestion: "能改写为前缀 LIKE/ILIKE 时优先改写；否则用 pg_trgm 的 GIN 索引。",
    });
  }
  if (/\bin\s*\([^()]*\)/i.test(normalized) && !/\bin\s*\(\s*select\b/i.test(normalized)) {
    findings.push({
      severity: "info",
      code: "postgres.any-array-idiom",
      title: "IN 列表可用 = ANY(ARRAY[…])",
      detail: "PostgreSQL 中 `col IN (a, b)` 与 `col = ANY (ARRAY[a, b])` 等价，后者便于把参数作为数组传入。",
      suggestion: "参数化查询可用 `col = ANY($1)`，一次绑定数组，避免拼接 IN 列表。",
    });
  }
  if (/\bwhere[^;]*\b(date_trunc|to_char|extract)\s*\(/i.test(normalized)) {
    findings.push({
      severity: "warning",
      code: "postgres.date-function",
      title: "日期列被函数包裹",
      detail: "`date_trunc('day', col) = …` 之类无法使用 col 上的普通索引。",
      suggestion: "改写为范围条件：col >= '2024-01-01' AND col < '2024-01-02'。",
    });
  }
  // Only the predicate zone is checked: a cast in the projection (`SELECT col::text`)
  // never touches index usability, and `'0'::numeric` on the constant side is
  // added by Postgres itself.
  const predicateStart = normalized.search(/\b(?:where|having)\b/i);
  const predicateBody = predicateStart >= 0 ? normalized.slice(predicateStart) : "";
  if (predicateBody && hasColumnCast(predicateBody)) {
    findings.push({
      severity: "warning",
      code: "postgres.cast-in-where",
      title: "谓词中显式类型转换",
      detail: "列被显式转换（`col::type` / `CAST(col AS type)`）时索引无法按原类型比较；常量侧的 `'x'::type` 不影响索引。",
      suggestion: "让列与参数类型一致；无法一致时建立表达式索引（如 CREATE INDEX ON t ((col::text))）。",
    });
  }
  if (/\border\s+by\s+random\s*\(/i.test(normalized)) {
    findings.push({
      severity: "warning",
      code: "postgres.order-by-random",
      title: "ORDER BY random()",
      detail: "全表排序后取前 N 行，大表代价极高。",
      suggestion: "改用按主键区间抽样，或 TABLESAMPLE / 预计算随机列。",
    });
  }
  if (/\bcount\s*\(\s*\*\s*\)/i.test(normalized) && /\bwhere\b/i.test(normalized) && !/\bgroup\s+by\b/i.test(normalized)) {
    findings.push({
      severity: "info",
      code: "postgres.count-star",
      title: "COUNT(*) 仅用于判断存在性",
      detail: "如果只需要知道“是否存在”，COUNT(*) 会扫描全部匹配行。",
      suggestion: "改为 SELECT EXISTS (SELECT 1 …)。",
    });
  }
  return findings;
}

/** SQL Server-specific idioms (SARGability, T-SQL syntax equivalents). */
function sqlServerShapeFindings(normalized: string): QueryDiagnosticFinding[] {
  const findings: QueryDiagnosticFinding[] = [];

  if (/\bilike\b/i.test(normalized)) {
    findings.push({
      severity: "critical",
      code: "sqlserver.ilike-invalid",
      title: "SQL Server 不支持 ILIKE",
      detail: "ILIKE 是 PostgreSQL 语法；T-SQL 中会直接报错。",
      suggestion: "改用 LOWER(col) LIKE LOWER('%x%')（注意会失去索引 Seek），或使用大小写不敏感排序规则（如 Latin1_General_CI_AS）。",
    });
  }
  if (/\blimit\s+\d+/i.test(normalized)) {
    findings.push({
      severity: "warning",
      code: "sqlserver.limit-syntax",
      title: "LIMIT 是 PostgreSQL 语法",
      detail: "SQL Server 使用 TOP 或 OFFSET … FETCH。",
      suggestion: "改为 SELECT TOP (n) …，或 ORDER BY … OFFSET m ROWS FETCH NEXT n ROWS ONLY。",
    });
  }
  if (/\bwhere[^;]*\bisnull\s*\(/i.test(normalized)) {
    findings.push({
      severity: "warning",
      code: "sqlserver.isnull-predicate",
      title: "谓词中使用 ISNULL",
      detail: "ISNULL/COALESCE 包裹列会让该列上的索引无法 Seek。",
      suggestion: "改写为 (col IS NULL OR col = @v) 等可 SARGable 的形式；输出投影中的 ISNULL 无此问题。",
    });
  }
  if (/\bwhere[^;]*\b(convert|cast)\s*\(/i.test(normalized)) {
    findings.push({
      severity: "warning",
      code: "sqlserver.convert-column",
      title: "谓词中对列做 CONVERT/CAST",
      detail: "转换列会破坏 SARGability，只能扫描。",
      suggestion: "把转换移到常量一侧，或建立计算列 + 索引。",
    });
  }
  if (/\bwhere[^;]*\b(year|month|day|datepart|datediff)\s*\(/i.test(normalized)) {
    findings.push({
      severity: "warning",
      code: "sqlserver.date-function",
      title: "谓词中对日期列使用函数",
      detail: "YEAR(col)=2024 之类无法使用日期列索引。",
      suggestion: "改写为范围：col >= '2024-01-01' AND col < '2025-01-01'。",
    });
  }
  if (/\bselect\s+top\s*(\(\s*\d+\s*\)|\s+\d+)/i.test(normalized) && !/\border\s+by\b/i.test(normalized)) {
    findings.push({
      severity: "info",
      code: "sqlserver.top-without-order",
      title: "TOP 未配合 ORDER BY",
      detail: "没有 ORDER BY 时 TOP 返回哪些行并不确定，也无法稳定复现性能。",
      suggestion: "补上确定的 ORDER BY，便于索引与分页。",
    });
  }
  if (/\bwith\s*\(\s*nolock\s*\)/i.test(normalized)) {
    findings.push({
      severity: "info",
      code: "sqlserver.nolock",
      title: "使用了 NOLOCK",
      detail: "NOLOCK 不是优化手段，会带来脏读/漏读，并可能改变行数与计划。",
      suggestion: "如为避免阻塞，改用行版本控制（READ_COMMITTED_SNAPSHOT ON）。",
    });
  }
  if (/\bdeclare\s+@\w+\s+table\b/i.test(normalized)) {
    findings.push({
      severity: "warning",
      code: "sqlserver.table-variable",
      title: "使用表变量",
      detail: "表变量没有统计信息，优化器固定按 1 行估算，容易选错连接方式。",
      suggestion: "数据量不确定时改用临时表（#temp），并在填充后确保统计信息可用。",
    });
  }
  return findings;
}

/**
 * Rule-based rewrites for slow read queries. Each candidate is meant to be
 * executed and measured; none of them assumes a language model.
 */
export function buildRewriteCandidates(sql: string, relationNames: ReadonlySet<string>, databaseType?: string): QueryRewriteCandidate[] {
  const candidates: QueryRewriteCandidate[] = [];
  const normalized = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  if (!/^\s*(select|with)\b/i.test(normalized)) return candidates;

  if (/\bnot\s+in\s*\(\s*select\b/i.test(normalized)) {
    const rewritten = normalized.replace(/\bnot\s+in\s*\(\s*select\b/i, "NOT EXISTS (SELECT");
    if (rewritten !== normalized) {
      candidates.push({
        id: "not-exists",
        title: "NOT IN → NOT EXISTS",
        reason: "反连接通常能被优化器改写为 anti-join，避免 NULL 语义问题。",
        sql: rewritten,
      });
    }
  }

  if (/select\s+\*/i.test(normalized)) {
    const columns = selectStarColumnsFromRelations(normalized, relationNames);
    if (columns.length > 0) {
      candidates.push({
        id: "explicit-columns",
        title: "SELECT * → 显式列",
        reason: "减少网络与 I/O，覆盖索引更容易命中。",
        sql: normalized.replace(/select\s+\*/i, `SELECT ${columns.join(", ")}`),
      });
    }
  }

  if (databaseType === "postgres") {
    const anyArray = rewriteLiteralInLists(normalized);
    if (anyArray.changed) {
      candidates.push({
        id: "any-array",
        title: "IN 列表 → = ANY(ARRAY[…])",
        reason: "PostgreSQL 中两者语义等价；数组形式便于参数化并复用同一计划。",
        sql: anyArray.sql,
      });
    }
    const ilike = rewriteLowerLike(normalized);
    if (ilike.changed) {
      candidates.push({
        id: "ilike",
        title: "LOWER(col) LIKE → col ILIKE",
        reason: "ILIKE 是 PostgreSQL 原生的大小写不敏感匹配，可与 pg_trgm 的 GIN 索引配合。",
        sql: ilike.sql,
      });
    }
  }

  return candidates;
}

function isSqlLiteral(value: string): boolean {
  return /^(?:null|true|false|-?\d+(?:\.\d+)?|'(?:''|[^'])*')$/i.test(value);
}

/** `col IN (1, 2)` → `col = ANY (ARRAY[1, 2])`; NOT IN and subqueries are left untouched. */
export function rewriteLiteralInLists(sql: string): { sql: string; changed: boolean } {
  let changed = false;
  const pattern = /\b(not\s+)?([A-Za-z_][\w.]*)\s+in\s*\(([^()]*?)\)/gi;
  const rewritten = sql.replace(pattern, (full: string, notPrefix: string | undefined, column: string, list: string) => {
    // `NOT IN` backtracks into column = "not"; never rewrite that.
    if (notPrefix || /^not$/i.test(column) || /\bselect\b/i.test(list)) return full;
    const items = list.split(",").map((item) => item.trim());
    if (items.length < 2 || !items.every(isSqlLiteral)) return full;
    changed = true;
    return `${column} = ANY (ARRAY[${items.join(", ")}])`;
  });
  return { sql: rewritten, changed };
}

/** `LOWER(col) LIKE LOWER('x%')` / `LOWER(col) LIKE 'x%'` → `col ILIKE 'x%'`. */
export function rewriteLowerLike(sql: string): { sql: string; changed: boolean } {
  let changed = false;
  const pattern = /\blower\s*\(\s*([A-Za-z_][\w.]*)\s*\)\s+like\s+(?:lower\s*\(\s*('[^']*')\s*\)|('[^']*'))/gi;
  const rewritten = sql.replace(pattern, (full: string, column: string, lowerLiteral: string | undefined, plainLiteral: string | undefined) => {
    const literal = lowerLiteral ?? plainLiteral;
    if (!literal) return full;
    changed = true;
    return `${column} ILIKE ${literal}`;
  });
  return { sql: rewritten, changed };
}

function selectStarColumnsFromRelations(sql: string, relationNames: ReadonlySet<string>): string[] {
  const aliases = new Map<string, string>();
  const pattern = /\b(?:from|join)\s+([A-Za-z_][\w$.]*)\s+(?:as\s+)?([A-Za-z_][\w$]*)?/gi;
  for (const match of sql.matchAll(pattern)) {
    const relation = match[1];
    if (!relation) continue;
    const bare = relation.split(".").pop()?.toLowerCase() ?? "";
    if (!relationNames.has(bare) && relationNames.size > 0) continue;
    const alias = match[2];
    if (alias && !/^(where|join|on|group|order|having|limit|offset|inner|left|right|full|cross)$/i.test(alias)) aliases.set(alias, bare);
  }
  return [...aliases.keys()].slice(0, 8).map((alias) => `${alias}.*`);
}

export interface MeasuredCandidate {
  candidate: QueryRewriteCandidate;
  elapsedMs?: number;
  logicalReads?: number;
  executionTimeMs?: number;
  sharedHitBlocks?: number;
  sharedReadBlocks?: number;
}

/** Orders measured candidates by the metric each engine reports most reliably. */
export function rankMeasuredCandidates(measured: readonly MeasuredCandidate[], databaseType: string): MeasuredCandidate[] {
  const metric = (entry: MeasuredCandidate): number => {
    if (databaseType === "sqlserver") return entry.elapsedMs ?? Number.POSITIVE_INFINITY;
    return entry.executionTimeMs ?? Number.POSITIVE_INFINITY;
  };
  return [...measured].sort((left, right) => metric(left) - metric(right));
}
