import type { ParsedExplainPlan } from "@/lib/diagram/explainPlan";

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
}

export type QueryDiagnosisCore = Omit<QueryDiagnosis, "coldStart" | "cacheNote" | "measured" | "recommended">;

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

function parseSqlServerPlan(raw: unknown): SqlServerPlanFacts {
  const empty: SqlServerPlanFacts = { findings: [], indexes: [], relations: [] };
  const xml = findShowPlanXml(raw);
  if (!xml || typeof DOMParser === "undefined") return empty;
  const document = new DOMParser().parseFromString(xml, "text/xml");
  if (document.querySelector("parsererror")) return empty;

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
  for (const relOp of Array.from(document.querySelectorAll("RelOp"))) {
    const physicalOp = relOp.getAttribute("PhysicalOp") || "";
    const object = relOp.querySelector("Object");
    const table = sqlServerIdentifier(object?.getAttribute("Table"));
    const schema = sqlServerIdentifier(object?.getAttribute("Schema"));
    if (table) relations.push(`${schema || "dbo"}.${table}`);
    const estimateRows = numberAttr(relOp, "EstimateRows") ?? 0;
    if (physicalOp === "Table Scan" && table && estimateRows >= 1000) {
      scans.push(`${schema || "dbo"}.${table}（预估 ${Math.round(estimateRows)} 行）`);
    } else if (physicalOp === "Clustered Index Scan" && table && estimateRows >= 10000) {
      scans.push(`${schema || "dbo"}.${table} 聚集索引扫描（预估 ${Math.round(estimateRows)} 行）`);
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
    findings.push({
      severity: "critical",
      code: "sqlserver.table-scan",
      title: "大表扫描",
      detail: `执行计划包含大表扫描：${scans.slice(0, 4).join("；")}`,
      suggestion: "检查 WHERE/JOIN 谓词列，建立覆盖索引或调整谓词写法。",
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

function parsePostgresPlan(raw: unknown): PostgresPlanFacts {
  const roots = Array.isArray(raw) ? raw : [raw];
  const findings: QueryDiagnosticFinding[] = [];
  const indexes: QueryIndexSuggestion[] = [];
  const relations: string[] = [];
  let executionTimeMs: number | undefined;
  let planningTimeMs: number | undefined;
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;

  for (const item of roots) {
    if (!item || typeof item !== "object") continue;
    const root = item as Record<string, unknown>;
    if (typeof root["Execution Time"] === "number") executionTimeMs = root["Execution Time"];
    if (typeof root["Planning Time"] === "number") planningTimeMs = root["Planning Time"];
    const plan = (root.Plan ?? root) as Record<string, unknown>;
    walkPostgresNode(plan, findings, indexes, relations);
    sharedHitBlocks += Number(plan["Shared Hit Blocks"] ?? 0);
    sharedReadBlocks += Number(plan["Shared Read Blocks"] ?? 0);
  }

  return { executionTimeMs, planningTimeMs, sharedHitBlocks, sharedReadBlocks, findings, indexes, relations: [...new Set(relations)] };
}

function walkPostgresNode(node: Record<string, unknown>, findings: QueryDiagnosticFinding[], indexes: QueryIndexSuggestion[], relations: string[]): void {
  const nodeType = String(node["Node Type"] ?? "");
  const relation = node["Relation Name"] ? String(node["Relation Name"]) : undefined;
  const schema = node["Schema"] ? String(node["Schema"]) : undefined;
  if (relation) relations.push(schema ? `${schema}.${relation}` : relation);

  const rowsRemoved = Number(node["Rows Removed by Filter"] ?? 0);
  const filter = node["Filter"] ? String(node["Filter"]) : undefined;
  const actualRows = Number(node["Actual Rows"] ?? 0);
  const planRows = Number(node["Plan Rows"] ?? 0);

  if (relation && nodeType.includes("Seq Scan") && (rowsRemoved >= 1000 || actualRows >= 10000)) {
    const columns = filter ? extractPostgresFilterColumns(filter) : [];
    findings.push({
      severity: "critical",
      code: "postgres.seq-scan",
      title: "顺序扫描大表",
      detail: `${schema ? `${schema}.` : ""}${relation} 使用 Seq Scan，实际返回 ${actualRows} 行${rowsRemoved > 0 ? `，过滤掉 ${rowsRemoved} 行` : ""}${filter ? `；Filter: ${filter}` : ""}`,
      suggestion: columns.length > 0 ? `考虑为过滤列建索引：${columns.join(", ")}` : "检查过滤条件是否有可索引的列。",
    });
    if (columns.length > 0) {
      const table = schema ? `${schema}.${relation}` : relation;
      indexes.push({
        table,
        columns,
        includeColumns: [],
        sql: `CREATE INDEX ON ${quoteIdentifier(schema)}.${quoteIdentifier(relation)} (${columns.map((column) => quoteIdentifier(column)).join(", ")});`,
        reason: "Seq Scan 的过滤列",
      });
    }
  }

  const sortMethod = node["Sort Method"] ? String(node["Sort Method"]) : undefined;
  if (nodeType === "Sort" && sortMethod && sortMethod.toLowerCase().includes("external")) {
    findings.push({
      severity: "warning",
      code: "postgres.sort-spill",
      title: "排序溢出到磁盘",
      detail: `Sort Method: ${sortMethod}${node["Sort Space Used"] ? `，占用 ${String(node["Sort Space Used"])} kB` : ""}`,
      suggestion: "让排序走索引（ORDER BY 列建索引），或在会话内临时调大 work_mem。",
    });
  }

  const heapFetches = Number(node["Heap Fetches"] ?? 0);
  if (nodeType.includes("Index Only Scan") && heapFetches > 0) {
    findings.push({
      severity: "warning",
      code: "postgres.heap-fetches",
      title: "Index Only Scan 仍需回表",
      detail: `Heap Fetches: ${heapFetches}`,
      suggestion: "执行 VACUUM (ANALYZE) 更新可见性映射，避免 index-only scan 退化为回表。",
    });
  }

  const joinFilterRemoved = Number(node["Rows Removed by Join Filter"] ?? 0);
  if (nodeType === "Nested Loop" && joinFilterRemoved >= 1000) {
    findings.push({
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
      findings.push({
        severity: "info",
        code: "postgres.estimate-drift",
        title: "行数估算偏差较大",
        detail: `${nodeType}${relation ? ` on ${relation}` : ""}：预估 ${planRows} 行，实际 ${actualRows} 行（约 ${ratio.toFixed(0)} 倍）`,
        suggestion: "对相关表执行 ANALYZE（必要时提高统计目标），让优化器获得准确的选择性。",
      });
    }
  }

  if (filter && /::\s*(text|character varying|numeric|timestamp|date|integer|bigint)\b/i.test(filter)) {
    findings.push({
      severity: "warning",
      code: "postgres.implicit-cast",
      title: "谓词中存在类型转换",
      detail: `Filter: ${filter}`,
      suggestion: "比较两侧类型保持一致（改字段类型或改常量写法），类型转换会导致索引失效。",
    });
  }
  if (filter && /\b(lower|upper|trim|substr|substring|date_trunc|to_char)\s*\(/i.test(filter)) {
    findings.push({
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
      if (child && typeof child === "object") walkPostgresNode(child as Record<string, unknown>, findings, indexes, relations);
    }
  }
}

function quoteIdentifier(value: string | undefined): string {
  if (!value) return "";
  return /^[a-z_][\w$]*$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}

/** Columns used by simple comparison predicates in a PostgreSQL Filter expression. */
export function extractPostgresFilterColumns(filter: string): string[] {
  const columns = new Set<string>();
  const pattern = /\b([A-Za-z_][\w$]*)\s*(?:=\s*|<>|!=|>=|<=|>|<|~~|!~~|like|ilike)/gi;
  for (const match of filter.matchAll(pattern)) {
    const column = match[1];
    if (!column) continue;
    if (/^(and|or|not|null|true|false)$/i.test(column)) continue;
    columns.add(column);
  }
  return [...columns].slice(0, 4);
}

export function diagnoseQueryPlan(plan: ParsedExplainPlan, sql: string): QueryDiagnosisCore {
  if (plan.databaseType === "sqlserver") {
    const facts = parseSqlServerPlan(plan.raw);
    return {
      databaseType: plan.databaseType,
      metrics: { elapsedMs: facts.elapsedMs, cpuMs: facts.cpuMs, logicalReads: facts.logicalReads },
      findings: dedupeFindings([...facts.findings, ...sqlShapeFindings(sql, "sqlserver")]),
      indexSuggestions: mergeIndexSuggestions(facts.indexes, buildIndexSuggestionsFromSql(sql, "sqlserver")),
      rewriteCandidates: buildRewriteCandidates(sql, new Set(facts.relations.map((relation) => relation.split(".").pop()?.toLowerCase() ?? "")), "sqlserver"),
    };
  }
  if (plan.databaseType === "postgres") {
    const facts = parsePostgresPlan(plan.raw);
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
  const seen = new Set<string>();
  const merged: QueryIndexSuggestion[] = [];
  for (const suggestion of [...planSuggestions, ...sqlSuggestions]) {
    const key = `${suggestion.table.toLowerCase()}\0${suggestion.columns.map((column) => column.toLowerCase()).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(suggestion);
  }
  return merged;
}

interface SqlTableAlias {
  /** Alias as written in the query (`t1`). */
  alias: string;
  /** Table name possibly schema-qualified (`public.orders`). */
  table: string;
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

/** Maps aliases to base tables, ignoring derived tables (`from (select …) t2`). */
function extractSqlTableAliases(sql: string): SqlTableAlias[] {
  const aliases: SqlTableAlias[] = [];
  const seen = new Set<string>();
  const pattern = /\b(?:from|join)\s+(?!\()([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s*(?:(?:as)\s+)?([A-Za-z_][\w$]*)?/gi;
  for (const match of sql.matchAll(pattern)) {
    const table = match[1];
    if (!table) continue;
    const candidate = match[2];
    const alias = candidate && !RESERVED_ALIAS_WORDS.has(candidate.toLowerCase()) ? candidate : (table.split(".").pop() ?? table);
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push({ alias, table });
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

/**
 * Derives composite covering-index suggestions directly from the query text.
 *
 * Execution plans only expose the predicates the optimizer chose to report
 * (SQL Server MissingIndexes, PostgreSQL per-row Filters), so BETWEEN range
 * joins, IN lists and aggregate inputs are routinely missing. This pass reads
 * WHERE/ON predicates per alias, then adds SELECT/GROUP BY/aggregate columns as
 * INCLUDE columns: equality columns first, range columns after them.
 */
export function buildIndexSuggestionsFromSql(sql: string, databaseType: string): QueryIndexSuggestion[] {
  const aliases = extractSqlTableAliases(sql);
  if (aliases.length === 0) return [];
  const aliasSet = new Map(aliases.map((entry) => [entry.alias.toLowerCase(), entry]));
  // Strip comments and string literals before scanning so values never look like columns.
  const scan = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''");

  const buckets = new Map<string, { equality: string[]; range: string[]; include: string[] }>();
  const bucketFor = (alias: string) => {
    const key = alias.toLowerCase();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { equality: [], range: [], include: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  const pushUnique = (list: string[], value: string) => {
    const normalized = value.toLowerCase();
    if (!list.some((existing) => existing.toLowerCase() === normalized)) list.push(value);
  };

  // Predicate classification from each `alias.column` reference.
  const columnReference = /([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)/g;
  for (const match of scan.matchAll(columnReference)) {
    const alias = match[1]!.toLowerCase();
    const column = match[2]!;
    if (!aliasSet.has(alias)) continue;
    const rest = scan.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 48);
    const bucket = bucketFor(alias);
    if (/^\s+between\b/i.test(rest)) {
      pushUnique(bucket.range, column);
    } else if (/^\s+in\s*\(/i.test(rest)) {
      pushUnique(bucket.equality, column);
    } else if (/^\s*(?:=|<>|!=)\s*(?:'|\?|\d|any\s*\(|array\[|null)/i.test(rest)) {
      pushUnique(bucket.equality, column);
    } else if (/^\s*(?:>=|<=|>|<)\s*(?:'|\?|\d|any\s*\(|array\[)/i.test(rest)) {
      pushUnique(bucket.range, column);
    } else {
      // Join equality: `a.x = b.y` marks x on a as a key column.
      const joinEquality = /^\s*=\s*([A-Za-z_][\w$]*)\.[A-Za-z_][\w$]*/i.exec(rest);
      if (joinEquality && aliasSet.has(joinEquality[1]!.toLowerCase())) pushUnique(bucket.equality, column);
    }
  }

  // SELECT list, GROUP BY and aggregate inputs become INCLUDE candidates.
  const selectMatch = /\bselect\b([\s\S]*?)\bfrom\b/i.exec(scan);
  const groupMatch = /\bgroup\s+by\b([\s\S]*?)(?:\b(?:having|order\s+by|limit|offset)\b|$)/i.exec(scan);
  const referenced = new Map<string, string[]>();
  const addReferenced = (alias: string, column: string) => {
    const key = alias.toLowerCase();
    let list = referenced.get(key);
    if (!list) {
      list = [];
      referenced.set(key, list);
    }
    pushUnique(list, column);
  };
  // Unqualified SELECT/GROUP BY columns belong to the primary FROM relation.
  const primaryAlias = aliases[0]?.alias.toLowerCase();
  for (const source of [selectMatch?.[1] ?? "", groupMatch?.[1] ?? ""]) {
    for (const match of source.matchAll(columnReference)) {
      const alias = match[1]!.toLowerCase();
      if (!aliasSet.has(alias)) continue;
      addReferenced(alias, match[2]!);
    }
    if (primaryAlias) {
      for (const match of source.matchAll(/\b([A-Za-z_][\w$]*)\b(?!\s*\()/g)) {
        const word = match[1]!;
        const lower = word.toLowerCase();
        if (NON_COLUMN_WORDS.has(lower) || aliasSet.has(lower) || /^\d/.test(word)) continue;
        // Skip projection aliases: they follow a closing paren or a numeric literal.
        const before = source.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
        if (/[)\d]\s*$/.test(before)) continue;
        addReferenced(primaryAlias, word);
      }
    }
  }

  const suggestions: QueryIndexSuggestion[] = [];
  for (const [aliasKey, bucket] of buckets) {
    const entry = aliasSet.get(aliasKey);
    if (!entry) continue;
    const keyColumns = [...bucket.equality, ...bucket.range].slice(0, 4);
    if (keyColumns.length === 0) continue;
    const includeColumns = (referenced.get(aliasKey) ?? []).filter((column) => !keyColumns.some((key) => key.toLowerCase() === column.toLowerCase())).slice(0, 6);
    suggestions.push(buildIndexSuggestionSql(entry.table, keyColumns, includeColumns, databaseType, "equality-first"));
    // 等值与范围列都存在时，同时给出范围列在前的对照方案，便于实际执行后对比。
    if (bucket.equality.length > 0 && bucket.range.length > 0) {
      const rangeFirst = [...bucket.range, ...bucket.equality].slice(0, 4);
      suggestions.push(buildIndexSuggestionSql(entry.table, rangeFirst, includeColumns, databaseType, "range-first"));
    }
  }
  return suggestions;
}

function buildIndexSuggestionSql(table: string, columns: string[], includeColumns: string[], databaseType: string, variant: "equality-first" | "range-first"): QueryIndexSuggestion {
  const [schema, name] = table.includes(".") ? (table.split(".") as [string, string]) : [undefined, table];
  const reason = variant === "equality-first" ? "来自 SQL 谓词与输出列推导（等值列在前、范围列在后，输出列放 INCLUDE）" : "对照方案：范围列在前（部分优化器在范围选择性更高时更优），输出列放 INCLUDE";
  if (databaseType === "sqlserver") {
    const suffix = variant === "range-first" ? "_R" : "";
    const indexName = `IX_${name.replace(/[^\w]/g, "")}_${columns.map((column) => column.replace(/[^\w]/g, "")).join("_")}${suffix}`.slice(0, 120);
    const target = `[${schema ?? "dbo"}].[${name}]`;
    const includeClause = includeColumns.length > 0 ? ` INCLUDE (${includeColumns.map((column) => `[${column}]`).join(", ")})` : "";
    return {
      table: `${schema ?? "dbo"}.${name}`,
      columns,
      includeColumns,
      sql: `CREATE NONCLUSTERED INDEX ${indexName}\nON ${target} (${columns.map((column) => `[${column}]`).join(", ")})${includeClause};`,
      reason,
    };
  }
  const quotedTable = schema ? `${quoteIdentifier(schema)}.${quoteIdentifier(name)}` : quoteIdentifier(name);
  const includeClause = includeColumns.length > 0 ? ` INCLUDE (${includeColumns.map((column) => quoteIdentifier(column)).join(", ")})` : "";
  return {
    table: schema ? `${schema}.${name}` : name,
    columns,
    includeColumns,
    sql: `CREATE INDEX ON ${quotedTable} (${columns.map((column) => quoteIdentifier(column)).join(", ")})${includeClause};`,
    reason,
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
  if (/\bwhere[^;]*::\s*(text|varchar|character varying|numeric|int|integer|bigint|date|timestamp)\b/i.test(normalized)) {
    findings.push({
      severity: "warning",
      code: "postgres.cast-in-where",
      title: "谓词中显式类型转换",
      detail: "在列或参数上追加 `::type` 会让索引无法按原类型比较。",
      suggestion: "让列与参数类型一致；无法一致时建立表达式索引。",
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
