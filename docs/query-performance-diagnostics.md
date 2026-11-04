# DBX 查询性能诊断：全部逻辑与方法

> 适用范围：`apps/desktop/src/lib/diagnostics/`、`apps/desktop/src/stores/queryStore.ts`、`apps/desktop/src/components/diagnostics/QueryDiagnosticsPanel.vue`
> 支持数据库：**SQL Server** 与 **PostgreSQL**（其余数据库直接返回「不支持」）
> 文档定位：实现说明 + 算法规格 + 阈值清单，供后续调参、扩展数据库、排查误报使用。

---

## 目录

1. [能力概览](#1-能力概览)
2. [入口与支持范围](#2-入口与支持范围)
3. [端到端流程](#3-端到端流程)
4. [测量层：缓存清理、冷热判定与执行计划采集](#4-测量层缓存清理冷热判定与执行计划采集)
5. [L1：执行计划规则诊断](#5-l1执行计划规则诊断)
6. [L1：SQL 形态规则](#6-l1sql-形态规则)
7. [索引建议算法](#7-索引建议算法)
8. [L2：hypopg 假设索引试算](#8-l2hypopg-假设索引试算)
9. [L3：SQL 改写候选与实测对比](#9-l3sql-改写候选与实测对比)
10. [诊断面板展示规则](#10-诊断面板展示规则)
11. [数据结构](#11-数据结构)
12. [已知限制与边界](#12-已知限制与边界)
13. [代码索引与测试覆盖](#13-代码索引与测试覆盖)
14. [扩展与调参指引](#14-扩展与调参指引)

---

## 1. 能力概览

DBX 的「性能诊断」不是单一的一次 EXPLAIN，而是一条三层流水线：

| 层 | 名称 | 输入 | 输出 | 是否产生真实副作用 |
| --- | --- | --- | --- | --- |
| 测量层 | 基线执行 | 用户 SQL | 真实执行计划 + 耗时/读块指标 | **会真实执行 SQL** |
| L1 | 规则诊断 | 执行计划 + SQL 文本 | findings、索引建议、改写候选 | 无 |
| L2 | hypopg 假设索引 | 索引建议 | 各组合的规划器成本、是否被选用、粗估耗时 | 只创建**假设索引**，不落盘 |
| L3 | 改写实测 | L1 生成的改写候选（最多 2 条） | 真实耗时/读块排名 + 推荐方案 | **会真实执行候选 SQL** |

最终写入 `tab.diagnosis` 的结果包含：

- `metrics`：耗时、CPU、逻辑读、执行时间、计划时间、共享命中/读取块；
- `findings`：按严重级别排序的问题清单；
- `indexSuggestions`：可直接复制的 DDL；
- `hypopg`：L2 试算结果（仅 PostgreSQL）；
- `measured`：原始 SQL + 已实测的改写候选；
- `recommended`：实测最快方案；
- `coldStart` / `cacheNote`：本次测量是否真的清空了缓存。

---

## 2. 入口与支持范围

### 2.1 调用链

```text
编辑器 / 诊断面板按钮
  └─ useSqlExecution.ts::tryDiagnose
       ├─ 解析 SQL 模板变量（与执行同源，避免 EXPLAIN 拿到 :placeholder）
       ├─ 空 SQL → toast「SQL 为空」
       ├─ 数据库不是 sqlserver/postgres → toast「性能诊断目前仅支持 SQL Server 和 PostgreSQL」
       ├─ 当前页签 → 输出视图切到 diagnostics
       └─ queryStore.diagnoseTabSql(tab.id, sql, databaseType)
            └─ 写入 tab.diagnosis，失败写入 tab.diagnosisError
```

关键文件：`apps/desktop/src/composables/useSqlExecution.ts`（`runDiagnose` / `tryDiagnose`）。

### 2.2 双重支持校验

1. 入口层（`useSqlExecution.ts`）：非 `sqlserver` / `postgres` 直接 toast，不进入 store。
2. 状态层（`queryStore.ts::diagnoseTabSql`）：再次校验，写入 `tab.diagnosisError = t("diagnostics.unsupported")` 并返回 `{ ok: false, reason: "unsupported" }`。

`buildCacheClearPlan` 与 `sqlShapeFindings` 内部还兼容 `kingbase` / `opengauss` / `vastbase` 的 PostgreSQL 方言分支，但 UI 层目前不会把这些数据库放进诊断流程。

### 2.3 失败语义

| 情况 | 行为 |
| --- | --- |
| 页签不存在 / SQL 为空 | 返回 `reason: "empty"`，不写错误 |
| 数据库不支持 | `tab.diagnosisError = diagnostics.unsupported`，返回 `reason: "unsupported"` |
| 基线拿不到执行计划 | `tab.diagnosisError = baseline.error ?? diagnostics.noPlan`，返回 `reason: "error"` |
| 未捕获异常 | `tab.diagnosisError = error.message`，返回 `reason: "error"` |
| 任意失败 | `finally` 中把 `tab.isDiagnosing` 复位 |

---

## 3. 端到端流程

`queryStore.ts::diagnoseTabSql` 的完整步骤：

### 步骤 1：准备

```ts
const conn = useConnectionStore().getConfig(tab.connectionId);
const queryTimeoutSecs = queryTimeoutSecsForConnection(conn, settingsStore.editorSettings.globalQueryTimeoutSecs);
const relations = extractReferencedRelations(sql);
const cachePlan = buildCacheClearPlan(databaseType, relations);

tab.isDiagnosing = true;
tab.diagnosis = undefined;
tab.diagnosisError = undefined;
```

- 每次诊断都会先清空上一次结果。
- 超时来自连接配置，回退到全局编辑器设置。

### 步骤 2：基线执行（清缓存 + 取计划）

```ts
const baseline = await runDiagnosedPlan(tab, sql, databaseType, cachePlan.statements, queryTimeoutSecs);
if (!baseline.plan) {
  tab.diagnosisError = baseline.error || t("diagnostics.noPlan");
  return { ok: false, reason: "error" };
}
```

`baseline.coldStart` 表示**缓存清理语句是否真正执行成功**，不是「有没有尝试清理」。

### 步骤 3：L1 规则诊断

```ts
const baseDiagnosis = diagnoseQueryPlan(baseline.plan, sql);
```

产出 `metrics`、`findings`、`indexSuggestions`、`rewriteCandidates`，详见第 5~7 节。

### 步骤 4：L2 假设索引（仅 PostgreSQL）

```ts
const hypopg = databaseType === "postgres"
  ? await analyseHypotheticalIndexes(tab, sql, baseline.plan, baseDiagnosis.indexSuggestions, queryTimeoutSecs)
  : undefined;
```

- 没有索引建议 → 直接 `undefined`，不做任何探测。
- 只在**同一个 backend 会话**内创建假设索引，结束时 `hypopg_reset()` 并关闭会话。

### 步骤 5：改写实测

```ts
const measured: MeasuredCandidate[] = [
  { candidate: { id: "original", title: "原始 SQL", reason: "", sql }, ...baseDiagnosis.metrics },
];

for (const candidate of baseDiagnosis.rewriteCandidates.slice(0, 2)) {
  const run = await runDiagnosedPlan(tab, candidate.sql, databaseType, cachePlan.statements, queryTimeoutSecs);
  if (!run.plan) continue;
  measured.push({ candidate, ...diagnoseQueryPlan(run.plan, candidate.sql).metrics });
}
```

- **最多只执行 2 条候选**，串行执行，避免并发抢占同一连接。
- 每个候选都重新清一次缓存（复用同一份 `cachePlan.statements`）。
- 候选执行失败（拿不到计划）会被静默跳过，不影响整体诊断结果。

### 步骤 6：排名与推荐

```ts
const ranked = rankMeasuredCandidates(measured, databaseType);
const best = ranked[0];
const diagnosis: QueryDiagnosis = {
  ...baseDiagnosis,
  coldStart: baseline.coldStart,
  cacheNote: cachePlan.note,
  measured,
  hypopg,
  recommended: best ? {
    id: best.candidate.id,
    title: best.candidate.title,
    sql: best.candidate.sql,
    elapsedMs: best.elapsedMs ?? best.executionTimeMs,
  } : undefined,
};
tab.diagnosis = diagnosis;
```

- `ranked[0]` 可能是原始 SQL 本身（如果改写没有更快）。
- 面板里的「方案对比」展示的是 `measured`（原始 SQL 永远第一行），不是 `ranked`。

### 流程时序图

```text
用户点击诊断
   │
   ├─ 解析表名 → 生成清缓存语句
   │
   ├─ [基线] 清缓存 → 执行 SQL / EXPLAIN ANALYZE → 解析计划
   │        └─ 失败 → 写 diagnosisError，结束
   │
   ├─ L1 规则诊断（计划 + SQL 文本）
   │
   ├─ L2 hypopg（仅 PG，且有索引建议）
   │        ├─ 探测扩展
   │        ├─ 未安装 → 返回安装提示（不试算）
   │        └─ 已安装 → 逐组创建假设索引 + EXPLAIN(FORMAT JSON) → 成本比较
   │
   ├─ L3 改写实测（最多 2 条，每条都重新清缓存）
   │
   └─ 排名 → tab.diagnosis
```

---

## 4. 测量层：缓存清理、冷热判定与执行计划采集

实现位置：`apps/desktop/src/lib/diagnostics/queryDiagnostics.ts::buildCacheClearPlan`、`apps/desktop/src/stores/queryStore.ts::runDiagnosedPlan`。

### 4.1 表名提取

```ts
/\b(?:from|join|update|into)\s+([A-Za-z_][\w$]*)(?:\s*\.\s*([A-Za-z_][\w$]*))?/gi
```

- 命中 `FROM` / `JOIN` / `UPDATE` / `INTO` 后的第一个标识符；若后面跟 `.table`，输出 `schema.table`。
- 同一表名去重。
- 局限：不解析 CTE、子查询别名、引号标识符；CTE 名会被当作真实表名传给清缓存语句（通常无害，`regclass` 解析失败会让整批语句失败并降级为热缓存）。

### 4.2 各数据库的清缓存语句

| `databaseType` | 语句 | `cold` | `note` |
| --- | --- | --- | --- |
| `sqlserver` | `DBCC DROPCLEANBUFFERS WITH NO_INFOMSGS;`<br>`DBCC FREEPROCCACHE WITH NO_INFOMSGS;` | `true` | 无 |
| `postgres` / `kingbase` / `opengauss` / `vastbase` | `DISCARD ALL;`<br>每个表一条 `SELECT * FROM pg_buffercache_evict_relation('t'::regclass);` | `relations.length > 0` | 有表：`pg_buffercache (PostgreSQL 18+)`；无表：`SQL 中未解析出表名，仅清理会话计划缓存` |
| 其他 | `[]` | `false` | `该数据库不支持清空缓存` |

PostgreSQL 清缓存前会先执行：

```sql
CREATE EXTENSION IF NOT EXISTS pg_buffercache;
```

- 超时 `min(queryTimeout || 10, 10)` 秒。
- 创建失败只记 debug 日志，不阻断流程（后续 `evict` 语句会失败并降级为热缓存）。
- `pg_buffercache_evict_relation()` 需要 PostgreSQL 18+、扩展已登记、当前角色有权限。

### 4.3 冷/热判定

`runDiagnosedPlan` 中的判定逻辑：

```ts
let coldStart = false;
if (cacheStatements.length > 0) {
  // PostgreSQL 先尝试建 pg_buffercache 扩展（失败忽略）
  try {
    await api.executeMulti(..., cacheStatements.join("\n"), ...);
    coldStart = true;          // 只有整批语句成功才算冷缓存
  } catch (error) {
    console.warn(...);         // 无权限/扩展缺失 → 降级热缓存
  }
}
```

- **执行成功 = 冷缓存**；任何一条失败 = 热缓存。
- 热缓存时面板仍会显示 `sharedHitBlocks` / `sharedReadBlocks`，让用户判断命中率，而不是假装冷启动。

### 4.4 基线执行计划采集

#### SQL Server

```text
① buildExplainSql("sqlserver", sql, "json", true)  // 仅做可执行性校验
② SET STATISTICS XML ON;
③ executeMulti(sql)
④ sqlServerExplainResult(results)  // 从结果行里找 <ShowPlanXML ...>
⑤ parseExplainResult("sqlserver", xml)
finally:
  SET STATISTICS XML OFF;
  关闭诊断专用 clientSessionId
```

- `SET STATISTICS XML` 是**会话级**设置，必须在 `finally` 中关闭，避免污染后续执行。
- 关闭语句超时 `min(queryTimeout, 5)` 秒。
- 指标来源：
  - `QueryTimeStats@ElapsedTime` → `elapsedMs`
  - `QueryTimeStats@CpuTime` → `cpuMs`
  - 根 `RelOp@ActualLogicalReads` → `logicalReads`

#### PostgreSQL

```text
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) <sql>
```

- 没有复用共享的 `buildExplainSql` 输出，因为那个构造器不带 `BUFFERS`；这里显式拼接。
- 末尾分号会被去掉，避免 `EXPLAIN ... ;` 语法问题。
- 指标来源：
  - 顶层 `Execution Time` → `executionTimeMs`
  - 顶层 `Planning Time` → `planningTimeMs`
  - 根节点 `Shared Hit Blocks` / `Shared Read Blocks` 求和 → `sharedHitBlocks` / `sharedReadBlocks`
- `EXPLAIN ANALYZE` 会**真实执行** SQL：对 DML 会产生真实副作用，诊断只应对只读 SQL 使用。

### 4.5 会话隔离

每次 `runDiagnosedPlan` 都创建独立会话：

```ts
const executionId = uuid();
const clientSessionId = `${tabClientSessionId(tab, "diagnostics")}:${executionId}`;
```

`finally` 中 `closeClientSessionId(...)`，保证：

- 清缓存、取计划、关闭统计设置都在同一会话；
- 不会把会话级设置泄漏给用户正常查询；
- 手动事务模式下不会长期占用连接。

---

## 5. L1：执行计划规则诊断

入口：`diagnoseQueryPlan(plan, sql)`，按 `plan.databaseType` 分派：

```ts
if (plan.databaseType === "sqlserver") {
  return {
    metrics: { elapsedMs, cpuMs, logicalReads },
    findings: dedupeFindings([...计划 findings, ...sqlShapeFindings(sql, "sqlserver")]),
    indexSuggestions: mergeIndexSuggestions(计划索引, buildIndexSuggestionsFromSql(sql, "sqlserver")),
    rewriteCandidates: buildRewriteCandidates(sql, 计划表名集合, "sqlserver"),
  };
}
if (plan.databaseType === "postgres") {
  // 同理，metrics 换成 executionTimeMs / planningTimeMs / sharedHitBlocks / sharedReadBlocks
}
// 其他方言：只返回 SQL 形态规则
return { metrics: {}, findings: sqlShapeFindings(sql), indexSuggestions: [], rewriteCandidates: [] };
```

所有 findings 最终按 `code + ":" + detail` 去重（`dedupeFindings`），避免同一个计划节点重复报同一问题。

### 5.1 SQL Server 规则

计划解析：`parseSqlServerPlan`。先在所有结果单元格中查找包含 `<ShowPlanXML` 的字符串，`DOMParser` 解析失败则返回空事实。

| code | 严重级别 | 触发条件 | 输出/建议 |
| --- | --- | --- | --- |
| （MissingIndexes 不产生 finding，只转为索引建议） | — | 存在 `MissingIndexGroup` / `MissingIndex` | 由 `Impact`、`ColumnGroup` 生成 `CREATE NONCLUSTERED INDEX` |
| `sqlserver.implicit-conversion` | warning | 任一 `ScalarOperator@ScalarString` 包含 `CONVERT_IMPLICIT` | 展示表达式前 180 字符，建议两侧类型一致 |
| `sqlserver.table-scan` | critical | 存在大表扫描节点（见下） | 汇总最多 4 张表；建议来自最多 3 张表的扫描索引提示 |

#### MissingIndexes → 索引建议

```text
MissingIndexGroup@Impact
  └─ MissingIndex@Schema / @Table
       ├─ ColumnGroup@Usage = EQUALITY   → 前置键列
       ├─ ColumnGroup@Usage = INEQUALITY → 后置键列
       └─ ColumnGroup@Usage = INCLUDE    → INCLUDE 列
```

- 键列为空 → 跳过。
- 表名展示为 `schema.table`（`Schema` 缺省 `dbo`）。
- 索引名：`IX_${table}_${cols}`，剔除非单词字符，截断 120 字符。
- DDL：
  ```sql
  CREATE NONCLUSTERED INDEX IX_...
  ON [schema].[table] (col1, col2) INCLUDE (col3);
  ```
- `reason`：`SQL Server 缺失索引提示（预估收益 {impact}%）`。

#### 大表扫描判定

| 物理算子 | 阈值 | 展示 |
| --- | --- | --- |
| `Table Scan` | `EstimateRows >= 1000` | `schema.table（预估 N 行）` |
| `Clustered Index Scan` | `EstimateRows >= 10000` | `schema.table 聚集索引扫描（预估 N 行）` |

- 最多取前 3 张扫描表生成具体索引建议（`buildScanIndexHint`）。
- finding 的 `detail` 最多列 4 张表，超出用 `；` 拼接。
- 没有任何扫描提示时，建议为通用文案：「检查 WHERE/JOIN 谓词列，建立覆盖索引或调整谓词写法。」

#### 隐式转换

- 只扫描 `RelOp` 内的 `ScalarOperator`，取 `ScalarString`。
- 命中 `CONVERT_IMPLICIT` 即报 warning。
- 同一条表达式在多个算子中重复出现时，由 `dedupeFindings` 兜底去重。

### 5.2 PostgreSQL 规则

计划解析：`parsePostgresPlan` → 递归 `walkPostgresNode`。

#### 顶层指标与 JIT

| 指标 | 来源 |
| --- | --- |
| `executionTimeMs` | 顶层 `Execution Time` |
| `planningTimeMs` | 顶层 `Planning Time` |
| `sharedHitBlocks` | 所有根节点 `Shared Hit Blocks` 之和 |
| `sharedReadBlocks` | 所有根节点 `Shared Read Blocks` 之和 |

JIT 规则：

```ts
if (jitMs > 0 && executionTimeMs && jitMs / executionTimeMs >= 0.05) {
  // postgres.jit-overhead (warning)
}
```

- JIT 耗时取 `JIT.Timing.Total`（毫秒），函数数取 `JIT.Functions`。
- 占比 ≥ 5% 时提示 `SET jit = off` 对比，或调高 `jit_above_cost` / `jit_inline_above_cost`。
- 阈值含义：短查询的编译开销可能高于解释执行收益。

#### 节点规则（精确阈值）

| code | 严重级别 | 触发条件 | 建议 |
| --- | --- | --- | --- |
| `postgres.seq-scan` | critical | `Relation Name` 存在、`Node Type` 包含 `Seq Scan`，且 `Rows Removed by Filter >= 1000` **或** `Actual Rows >= 10000` | 生成具体覆盖索引（见 7.3） |
| `postgres.sort-spill` | warning | `Node Type === "Sort"` 且 `Sort Method` 小写包含 `external` | ORDER BY 列建索引，或临时调大 `work_mem` |
| `postgres.heap-fetches` | warning | `Node Type` 包含 `Index Only Scan` 且 `Heap Fetches > 0` | `VACUUM (ANALYZE)` 更新可见性映射 |
| `postgres.join-filter` | warning | `Node Type === "Nested Loop"` 且 `Rows Removed by Join Filter >= 1000` | 连接列建索引 / 检查连接类型 |
| `postgres.estimate-drift` | info | `Plan Rows > 0 && Actual Rows > 0`，`max(actual/plan, plan/actual) >= 10` 且 `Actual Rows >= 100` | 对相关表 `ANALYZE`，必要时提高统计目标 |
| `postgres.implicit-cast` | warning | `Filter` 中存在**列**类型转换（`hasColumnCast`） | 两侧类型一致，否则索引失效 |
| `postgres.function-on-column` | warning | `Filter` 含 `lower/upper/trim/substr/substring/date_trunc/to_char(` | 建表达式索引或改写条件 |

补充细节：

- `Seq Scan` 的 `totalRows = Actual Rows * Actual Loops`（并行 worker 会被乘回去），`removedRows = Rows Removed by Filter * Actual Loops`。
- `estimate-drift` 只报 info，避免估算偏差淹没真正的 critical 问题。
- `Filter` 的函数规则和 cast 规则可以同时命中，属于有意为之（不同修复手段）。

#### `hasColumnCast`：只认「列被转换」

```ts
/\bcast\s*\(\s*[A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)?\s+as\s+/i
/\(\s*[A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)?\s*\)\s*::/i
/[A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)?\s*::\s*[A-Za-z_]/i
```

- 命中 `CAST(col AS …)`、`(col)::type`、裸 `col::type`。
- 常量侧由 PostgreSQL 自动补的 `'0'::numeric` 不会命中（字面量以引号/数字开头）。
- 这条规则是「能保留索引可用性」与「索引失效」的分界线：

  ```sql
  qty1 <> '0'::numeric   -- 常量转换，索引仍可用 → 不报
  qty1::text <> '0'      -- 列转换，索引失效   → 报
  ```

#### `Filter` 列提取（用于扫描索引建议）

```ts
/\b([A-Za-z_][\w$]*)\s*(?:=\s*|<>|!=|>=|<=|>|<|~~|!~~|like|ilike)/gi
```

- 排除 `and/or/not/null/true/false`。
- 排除 `col::numeric > 5` 中 `::` 前面的类型名。
- 最多返回 4 列。

### 5.3 SQL Server 与 PostgreSQL 的对称性

| 能力 | SQL Server | PostgreSQL |
| --- | --- | --- |
| 缺失索引提示 | 计划原生 `MissingIndex` | 无，由 SQL 文本 + 扫描节点推导 |
| 隐式转换 | `CONVERT_IMPLICIT` | `hasColumnCast`（列侧） |
| 大表扫描 | `Table Scan` / `Clustered Index Scan` 阈值 | `Seq Scan` 阈值 |
| 聚合/排序溢出 | 未实现 | `Sort Method external` |
| JIT | 不适用 | `JIT.Timing.Total` 占比 |
| 估算偏差 | 未实现 | `Plan Rows` vs `Actual Rows` |

---

## 6. L1：SQL 形态规则

实现：`sqlShapeFindings(sql, databaseType)`。

预处理：

```ts
const normalized = sql
  .replace(/--[^\n]*/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/'(?:''|[^'])*'/g, "''");
```

- `normalized` 去掉注释和字符串字面量，避免字符串里的关键字误报。
- 少数规则（前导通配符 LIKE、ILIKE、正则运算符）故意读取原始 `sql`，因为模式本身就在字符串字面量里。

### 6.1 通用规则

| code | 严重级别 | 触发条件 | 建议 |
| --- | --- | --- | --- |
| `sql.select-star` | info | 以 `SELECT *` 开头，或出现 `, *` | 只选需要的列 |
| `sql.leading-wildcard-like` | warning | 原始 SQL 匹配 `like\s+'%` | PG：`pg_trgm` + GIN；SQL Server：全文索引或反转列；其他：反转列/全文检索 |
| `sql.not-in-subquery` | warning | `NOT IN (SELECT` | 改 `NOT EXISTS` 或 `LEFT JOIN … IS NULL` |
| `sql.or-predicate` | info | 含 `OR` 且以 `SELECT` 开头 | 评估拆 `UNION ALL`，或为每个条件建索引 |
| `sql.deep-offset` | warning | `OFFSET` 后跟 ≥2 位数字 | 改 keyset 分页 |
| `sql.function-in-where` | warning | `WHERE …` 中出现 `lower/upper/trim/substr/substring/date_trunc/to_char(` | 改写条件或建表达式索引 |

### 6.2 PostgreSQL 专用规则

| code | 严重级别 | 触发条件 | 建议 |
| --- | --- | --- | --- |
| `postgres.ilike-trigram` | warning | 原始 SQL 匹配 `ilike\s+'%` | `pg_trgm` + `gin_trgm_ops`，同索引支持 LIKE/ILIKE |
| `postgres.regex-operator` | info | 原始 SQL 匹配 `[~!]?~\*?\s*'` 且不含 `ILIKE` | 可改写为前缀 LIKE，否则用 pg_trgm GIN |
| `postgres.any-array-idiom` | info | `IN (…)` 且不是 `IN (SELECT …)` | 参数化时用 `col = ANY($1)` |
| `postgres.date-function` | warning | `WHERE …` 含 `date_trunc/to_char/extract(` | 改写为日期范围条件 |
| `postgres.cast-in-where` | warning | 谓词区（从 `WHERE`/`HAVING` 开始）`hasColumnCast` | 类型一致，或建表达式索引 |
| `postgres.order-by-random` | warning | `ORDER BY random()` | 主键区间抽样 / `TABLESAMPLE` / 预计算随机列 |
| `postgres.count-star` | info | `COUNT(*)` + `WHERE` + 无 `GROUP BY` | 只判存在性时改 `SELECT EXISTS (SELECT 1 …)` |

### 6.3 SQL Server 专用规则

| code | 严重级别 | 触发条件 | 建议 |
| --- | --- | --- | --- |
| `sqlserver.ilike-invalid` | critical | 含 `ILIKE` | T-SQL 不支持；改 `LOWER(col) LIKE LOWER(...)` 或 CI 排序规则 |
| `sqlserver.limit-syntax` | warning | 含 `LIMIT n` | 改 `TOP (n)` 或 `OFFSET … FETCH` |
| `sqlserver.isnull-predicate` | warning | `WHERE …` 含 `ISNULL(` | 改 `(col IS NULL OR col = @v)` 等可 SARG 形式 |
| `sqlserver.convert-column` | warning | `WHERE …` 含 `CONVERT(` / `CAST(` | 转换移到常量侧，或计算列 + 索引 |
| `sqlserver.date-function` | warning | `WHERE …` 含 `year/month/day/datepart/datediff(` | 改日期范围 |
| `sqlserver.top-without-order` | info | `SELECT TOP n` 且无 `ORDER BY` | 补确定的 `ORDER BY` |
| `sqlserver.nolock` | info | `WITH (NOLOCK)` | 改用 `READ_COMMITTED_SNAPSHOT ON` |
| `sqlserver.table-variable` | warning | `DECLARE @x TABLE` | 改临时表 `#temp`，确保统计信息 |

---

## 7. 索引建议算法

索引建议有两个来源，最终合并：

1. **执行计划侧**：SQL Server `MissingIndexes`；PostgreSQL `Seq Scan` 节点。
2. **SQL 文本侧**：解析每条 SQL 的别名列角色，逐表生成覆盖索引与部分索引。

### 7.1 SQL 文本列角色推导

实现：`deriveSqlColumnFacts(sql)` → `{ aliases, usage }`。

#### 1）提取别名到基表的映射

`extractSqlTableAliases(sql)`：

- 先用 `maskParenthesizedContents` 把括号内部全部替换为空格（保留偏移），因此派生表 `FROM (SELECT …) t2` 不会被当成基表。
- 匹配 `FROM` / `JOIN` 后的 `table [AS] alias`。
- 额外处理旧式逗号连接：`FROM a x, b y`，按顶层逗号切分。
- 别名缺省时回退裸表名；`WHERE`、`JOIN`、`ON` 等保留字不会当别名。

#### 2）列角色分类

对每个 `alias.column` 引用，向前/向后取最多 64 字符判断角色：

| 角色 | 判定条件（`after` / `before` 片段） | 用途 |
| --- | --- | --- |
| `join` | 后接 `=/<>/!=` 且右侧是另一个已登记别名；或前接另一个别名 + `=/<>/!=` | 两侧都记 join，保证被驱动表也有连接键 |
| `equality` | `IN (`；`=/<>/!=` 后接字面量/参数/`ANY(`/`ARRAY[`/`NULL`/`true`/`false`；反向比较 `'A' = status` | 前置键列 |
| `range` | `BETWEEN`；`>=/<=/>/<` 后接字面量/参数/`ANY(`/`ARRAY[`；反向比较 `'A' > status` | 后置键列 |
| `output` | `SELECT` 列表、`GROUP BY` 中的 `alias.col`；不带别名的裸列归主表 | `INCLUDE` 候选 |

补充规则：

- `USING (a, b)` 会与它前面最近的 `JOIN` 目标配对，两侧别名都登记 `join`。
- `NATURAL JOIN` 不写列名，当前实现无法推断（只有 `USING` 显式处理）。
- `SELECT` 中不带别名的裸列若不在 `NON_COLUMN_WORDS`、不是已知别名、不是投影别名（前一个字符是 `)` 或数字），归第一个别名。
- 函数名（`sum/avg/count/cast/coalesce/…`）在 `NON_COLUMN_WORDS` 中，不会被当成列。

#### 3）单表谓词（部分索引的 WHERE 来源）

```ts
const LITERAL_PREDICATE =
  /([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)\s*(<>|!=|>=|<=|=|>|<)\s*('(?:''|[^'])*'|-?\d+(?:\.\d+)?|\b(?:true|false|null)\b)/gi;
```

- 先把注释与字符串内部用空格遮罩（保留偏移），再从**原始 SQL** 回读字面量，保证 `'0'` 的引号不被丢掉。
- 仅接受 `alias.col op 常量`，因此天然是单表谓词，可安全写进部分索引的 `WHERE`。
- 结果存进 `usage.predicates`，同一别名下按 `列 + 操作符 + 操作数` 去重。

### 7.2 单表索引方案生成

实现：`buildTableIndexSuggestions(input)`，计划侧与 SQL 文本侧共用。

输入：

```ts
{
  databaseType, table,
  equality, range, join, output, predicates,
  variant: "equality-first" | "range-first" | "scan-hint" | "join-first" | "partial",
}
```

算法：

```text
filters    = unique(equality + range)
referenced = unique(filters + join + output)

push(columns, variant):
  keyColumns = unique(columns).slice(0, 4)
  若键列为空 → 跳过
  若同表内键列组合已出现 → 跳过
  includeColumns = referenced 去掉键列后 .slice(0, 6)
  生成 DDL

① filters 非空 → push(filters + join, variant)
② 每个 join 列单独 → push([column], "join-first")，最多 2 条
③ join 为空 && equality 非空 && range 非空 → push(range + equality, "range-first")

④ 部分索引（仅 postgres 且有 predicates）：
   predicateColumns = 谓词列
   otherKeys = unique(join + filters 去掉谓词列).slice(0, 4)
   keyColumns = otherKeys 非空 ? otherKeys : predicateColumns.slice(0, 1)
   includeColumns = unique(referenced + predicateColumns) 去掉键列 .slice(0, 6)
   where = predicates.map(p => quoteIdentifier(col) + " " + op + " " + operand).join(" AND ")
   去重键 = "partial:" + 键列 + ":" + where
```

关键设计：

- **键列最多 4、INCLUDE 最多 6**：控制索引宽度，避免建议出无法维护的超宽索引。
- **过滤列在前、连接列紧随其后**：一条索引同时服务 `WHERE` 过滤与 `JOIN` 定位。
- **连接列单独成键**（最多 2 条）：嵌套循环从驱动侧探测时，需要以连接键开头的索引。
- **range-first 对照方案**：仅在没有 join 时生成，避免组合爆炸；部分优化器在范围选择性更高时更优。
- **部分索引只在 PostgreSQL 生成**：L2 的 hypopg 试算只跑在 PG 上；且部分索引最容易与其它表的覆盖索引组合出最优计划。
- 同表内「键列相同」的方案只保留第一条，避免 INCLUDE 差异造成大量近似重复。

`INDEX_VARIANT_REASON` 文案：

| variant | 面板上的 reason |
| --- | --- |
| `equality-first` | 来自 SQL 谓词与输出列推导（等值列在前、范围列在后，输出列放 INCLUDE） |
| `range-first` | 对照方案：范围列在前（部分优化器在范围选择性更高时更优），输出列放 INCLUDE |
| `scan-hint` | 来自执行计划中的顺序扫描：过滤列作键、连接列紧随其后，其余列放 INCLUDE |
| `join-first` | 连接列作键列：本表被其他表驱动时，嵌套循环可按连接键直接定位行 |
| `partial` | 部分索引：把 WHERE 谓词写进索引定义，只索引命中的行（索引更小、扫描更少），常与连接/覆盖索引组合使用 |

### 7.3 扫描 → 具体索引提示

`buildScanIndexHint(input)` 用于 PostgreSQL `Seq Scan` 与 SQL Server 大表扫描。

输入合并：

```text
equality = unique(计划 Filter 列 + SQL 文本 equality)
range    = SQL 文本 range
join     = SQL 文本 join
output   = SQL 文本 output
predicates = SQL 文本 predicates
```

用 `usageForRelation` 合并同一张表的所有别名（支持自连接）。

`scope` 文案：

```text
本次扫描约 {totalRows}行{（N 个并行进程）}{（过滤掉 M 行）}{，读取 K 个块}
```

- `formatCount`：≥10000 显示为 `N 万`（四舍五入到整数万）。
- 过滤掉的行数只有 ≥1000 时才写进文案。
- 读块数只有节点报告了 `Shared Read Blocks` 时才写。

三种建议文案：

1. **过滤 + 连接**：过滤列作键、连接列紧随其后，一条索引同时服务 WHERE 与 JOIN；连接列单独作键的那条供驱动侧探测。
2. **仅过滤**：过滤列作键，其余列放 INCLUDE 可走 Index Only Scan。
3. **仅连接**：扫描来自连接等值而非自身过滤，应在连接列建索引，让优化器用 Nested Loop + Index Scan。

解析不出任何过滤/连接列时：

```text
未从 SQL 中解析出 {table} 的过滤/连接列，请补全 WHERE/JOIN 谓词后再评估索引；{scope}。
```

### 7.4 SQL 文本侧批量生成

`buildIndexSuggestionsFromSql(sql, databaseType)`：

- 对每个别名调用 `buildTableIndexSuggestions`，`variant = "equality-first"`。
- 因此每张表至少会得到「过滤 + 连接」方案（如果有过滤列），并可能得到 join-first / range-first / partial。

### 7.5 计划侧与 SQL 侧合并

`mergeIndexSuggestions(planSuggestions, sqlSuggestions)`：

1. **表名规范化**
   - 计划侧常给 `public.qstest_oitw`，SQL 侧只有 `qstest_oitw`。
   - 建立裸表名 → 限定名的映射；同一裸名对应两个 schema 时标记 ambiguous，放弃消歧。
2. **去重键**：`表 + 键列 + WHERE`（全部小写）。
3. **列集合去重**：`表 + (键列 ∪ INCLUDE 列，排序) + WHERE`。
4. 计划侧先入：
   - 完全相同的键 → 跳过；
   - 记录该方案的列集合。
5. SQL 侧后入：
   - 键相同 → 跳过；
   - 列集合相同 → 跳过（计划侧胜出，因为它是优化器实际选择的访问路径）。
   - 只登记计划侧的列集合，因此 SQL 侧的 `equality-first` 与 `range-first` 对照方案仍会保留。

### 7.6 DDL 生成差异

`buildIndexSuggestionSql(...)`：

#### SQL Server

```sql
CREATE NONCLUSTERED INDEX IX_<table>_<col1>_<col2><suffix>
ON [schema].[table] ([col1], [col2]) INCLUDE ([col3]);
```

- schema 缺省 `dbo`。
- 索引名截断 120 字符。
- 后缀：`range-first` → `_R`，`join-first` → `_J`，其余无后缀。
- 列名统一用方括号。

#### PostgreSQL

```sql
CREATE INDEX ON <table> (<col1>, <col2>) INCLUDE (<col3>) WHERE <col1> != '0';
```

- `quoteIdentifier` 只对**不匹配** `^[a-z_][\w$]*$` 的标识符加双引号，普通小写列名保持简洁。
- 部分索引会把 `where` 同时存入 `QueryIndexSuggestion.where`，便于面板展示和 hypopg 识别。
- 不带 `CONCURRENTLY`、不带索引名，方便用户放到自己的迁移脚本里再调整。

### 7.7 一个具体例子

SQL 文本中同时出现：

```sql
WHERE t1.qty1 != '0' AND t2.itementry = t1.itementry
```

`qstest_oitw` 会得到：

```text
#1  (qty1, itementry)                         ← 过滤 + 连接
#2  (itementry) INCLUDE (qty1)                ← join-first
#3  (itementry) INCLUDE (qty1) WHERE qty1 != '0'  ← 部分索引
```

`qstest_oitm` 会得到覆盖索引（连接键 + 输出列）。

hypopg 会把「#3 部分索引 + oitm 覆盖索引」当作一个跨表组合试算——这正是旧实现漏掉最优解的原因。

---

## 8. L2：hypopg 假设索引试算

实现：`apps/desktop/src/lib/diagnostics/hypopgSupport.ts` + `queryStore.ts::analyseHypotheticalIndexes`。

### 8.1 四条决定设计的事实

文件头注释已经写明，后续改动必须遵守：

1. `CREATE EXTENSION` 只是登记 `sharedir` 里已有的 `hypopg.control` / `hypopg.so`；PostgreSQL 没有「按 URL 在线下载扩展」的机制。文件缺失时服务端直接报 `extension "hypopg" is not available`。
2. 因此 DBX 只能**探测 + 给出服务端可复制的安装命令**，不能替用户登录服务器安装。
3. 假设索引只在**同一个 backend 会话**内生效，所有试算语句必须共享一个 `clientSessionId`，结束前 `hypopg_reset()`。
4. 只有**不带 `ANALYZE` 的 `EXPLAIN`** 会使用假设索引，因此 L2 只能回答「规划器会不会选中它、估算成本如何」，给不出真实耗时与读块数。

### 8.2 完整流程

```text
suggestions.length === 0 → 返回 undefined
  │
  ├─ serverKey = host:port（无 host 回退 connection.id）
  ├─ decision = settings.hypopgInstallDecisions[serverKey]
  ├─ promptSuppressed = (decision === "never")
  ├─ clientSessionId = tabClientSessionId(tab, "hypopg"):uuid
  ├─ timeout = clamp(queryTimeout || 10, 10, 60) 秒
  │
  ├─ ① 探测：HYPOPG_PROBE_SQL
  │     ├─ version() → profile（发行版/主版本）
  │     ├─ pg_extension.extversion → 已安装
  │     └─ pg_available_extensions.default_version → 文件可用
  │
  ├─ ② 文件可用 + 未登记 + 超级用户
  │     ├─ SET lock_timeout = '5s'
  │     ├─ CREATE EXTENSION IF NOT EXISTS hypopg;
  │     ├─ 再探测
  │     └─ 成功 → autoCreatedVersion；失败 → installError
  │
  ├─ ③ 仍未安装 → 返回安装提示（不试算）
  │
  ├─ ④ 已安装 → 逐组试算
  │     ├─ hypopg_reset()
  │     ├─ 每组：hypopg_create_index($$DDL$$) → 收集 indexname
  │     ├─ EXPLAIN (FORMAT JSON) <sql>   ← 注意：不带 ANALYZE
  │     ├─ compareHypotheticalPlan(基线 raw, 假设 raw, 假设索引名)
  │     └─ 记录 trial（失败记录 error）
  │
  ├─ ⑤ hypopg_reset()
  └─ finally closeClientSessionId
```

### 8.3 探测 SQL

```sql
SELECT
  version() AS version,
  (SELECT extversion FROM pg_extension WHERE extname = 'hypopg') AS extension_version,
  (SELECT default_version FROM pg_available_extensions WHERE name = 'hypopg') AS available_version,
  COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_superuser
```

`parseHypopgProbe` 的判定：

| 字段 | 判定 |
| --- | --- |
| `installed` | `extension_version` 非空 |
| `available` | `available_version` 或 `extension_version` 非空 |
| `isSuperuser` | 兼容布尔值 `true/t/1/yes` 与字符串形式 |
| `version` | 原始 `version()` 文本 |

### 8.4 自动创建扩展

条件：`!installed && available && isSuperuser`。

```text
SET lock_timeout = '5s'       ← 避免被其他会话的 idle in transaction 卡住
CREATE EXTENSION IF NOT EXISTS hypopg;
再探测一次
```

- 成功：`extensionVersion` 更新，返回 `note = 已自动创建扩展 hypopg（版本 x）`。
- 失败：记录真实 `installError`，并在面板里优先展示真实报错，而不是笼统的「需要超级用户」。
- 非超级用户：不尝试创建，只返回安装提示。

### 8.5 安装提示矩阵

`buildHypopgInstallHint(profile)`，`sqlStatements` 固定为：

```sql
CREATE EXTENSION IF NOT EXISTS hypopg;
```

| 平台 | shell 命令 | 说明 |
| --- | --- | --- |
| Debian / Ubuntu | `sudo apt-get update`<br>`sudo apt-get install -y postgresql-<major>-hypopg` | 包名带主版本；找不到包需先加 PGDG 源 |
| RHEL / Rocky / Alma / CentOS / SUSE | `sudo dnf install -y --enablerepo=pgdg<major> hypopg_<major>`<br>（主版本未知时 `sudo dnf install -y hypopg`） | PGDG RPM 包名 `hypopg_<major>` |
| Alpine | `sudo apk add postgresql<major>-hypopg`<br>（主版本未知时 `sudo apk add postgresql-hypopg`） | 官方仓库不一定提供，缺失时源码编译 |
| macOS | `brew install hypopg` | 与已装 PostgreSQL 主版本匹配 |
| Windows | 无 shell 命令 | 没有预编译包，需同版本 MSVC 编译，把 `hypopg.dll` / `hypopg.control` 放到 `lib` / `share/extension` |
| Linux / unknown | `git clone --depth 1 https://github.com/HypoPG/hypopg.git /tmp/hypopg-src`<br>`cd /tmp/hypopg-src && make USE_PGXS=1`<br>`cd /tmp/hypopg-src && sudo make USE_PGXS=1 install` | 需要 PostgreSQL 头文件；`pg_config` 必须指向服务器实际运行的 PostgreSQL |

平台识别（`detectPlatform`）：

| 正则 | 平台 |
| --- | --- |
| `mingw` / `msvc` / `visual c++` / `windows` | windows |
| `darwin` / `macos` / `os x` | macos |
| `alpine` | alpine |
| `rhel` / `red hat` / `centos` / `rocky` / `alma` / `oracle linux` / `suse` / `opensuse` | redhat |
| `ubuntu` / `debian` | debian |
| `linux` | linux |
| 其他 | unknown |

发行版展示（`detectDistribution`）：优先识别 PGDG 版本号（`Ubuntu 18.3-1.pgdg24.04+1` → `Ubuntu 24.04`），再识别普通 Ubuntu/Debian/RHEL 版本。

安装提示的三种形态：

| 情况 | `availability` | 面板 |
| --- | --- | --- |
| 文件已装、当前库未登记 | `available` | 标题「服务器已装 hypopg，当前数据库未启用」；shell 命令清空，只给 SQL |
| 文件缺失 | `missing` | 标题「服务器未安装 hypopg」；给 shell + SQL 步骤 |
| 探测失败 | `unknown` | 不展示安装块，只展示 `error` |

`promptSuppressed = true` 时 `installHint = undefined`，但**仍然探测**，这样用户自己装好后可以立刻用上试算。注意：`promptSuppressed` 只隐藏安装提示，不会隐藏已安装后的试算结果。

### 8.6 「稍候 / 永不安装」决策持久化

- 面板按钮 → `settingsStore.rememberHypopgInstallDecision(serverKey, "later" | "never")`。
- 存储位置：`editorSettings.hypopgInstallDecisions`（随编辑器设置持久化）。
- `serverKey`：`host:port` 小写；无 host 用 `connection.id`。因此决策是**按服务器**而非按连接/数据库。
- `never`：以后该服务器不再出现安装提示（`promptSuppressed`）。
- `later`：本次诊断临时隐藏（`hypopgDismissed`），下次重新诊断仍会提示。
- 清洗规则 `normalizeHypopgInstallDecisions`：只接受 `later` / `never`，最多保留最近 100 条（重新插入会刷新写入顺序，优先淘汰最旧条目）。

### 8.7 候选筛选：按表轮转

`selectHypopgCandidates(suggestions, max = 8)`：

```text
1. 每条建议去掉尾部 ;，按裸表名（小写、去掉 schema）分桶
2. 桶内排序：
     where 存在            → 0（部分索引优先）
     includeColumns 非空   → 1（覆盖索引其次）
     其他                  → 2
   同分保持原顺序
3. 轮转选取：第 1 轮每桶取第 1 条，第 2 轮每桶取第 2 条……直到取满 8 条或取空
```

为什么必须轮转：

- 旧实现只取前 N 条，某张表建议多时会把别的表整体挤出候选。
- 轮转保证每张表至少拿到一条，且同表内部分索引排最前（最容易与覆盖索引组合出最优计划）。
- `ref` 记录该候选在**原始建议列表**中的 1-based 序号，面板用它显示 `#3`。

### 8.8 试算组合生成

`planHypopgTrials(suggestions)`，返回顺序固定：

| 组合 | ID | 标题 | 数量上限 |
| --- | --- | --- | --- |
| 单条 | `single-<ref>` | `#<ref>` | 每个候选都测（≤8） |
| 两两 | `pair-<a>-<b>` | `#a + #b` | 12（`HYPOPG_MAX_PAIR_TRIALS`） |
| 三连 | `triple-<a>-<b>-<c>` | `#a + #b + #c` | 8（`HYPOPG_MAX_TRIPLE_TRIALS`） |
| 全量 | `all` | `全部 N 条` | 1（N > 1 时） |

排序细节：

- 两两组合**跨表优先**：`Number(同表) - Number(同表)`，跨表为 0、同表为 1，所以跨表先排；再按 `ref` 升序。
- 三连只保留**三个表各不相同**的组合，按 `ref` 之和升序取前 8，避免同一张表堆三条索引。
- 最大组合数：8 + 12 + 8 + 1 = **29 组**（实际受候选数与表数限制）。
- 「全量」只包含通过轮转入选的候选，不是用户看到的全部建议。

### 8.9 每组试算的执行

```ts
await hypopg_reset();
for (const indexSql of group.indexSqls) {
  const created = await run(hypotheticalIndexArgument(indexSql));
  indexNames.push(created.rows[0][0]);
}
const explain = await run(`EXPLAIN (FORMAT JSON) ${sql去掉尾部;}`);
const comparison = compareHypotheticalPlan(basePlan.raw, parseExplainResult("postgres", explain).raw, indexNames);
```

`hypotheticalIndexArgument`：

```ts
const statement = indexSql.trim().replace(/;+\s*$/, "");
const quoted = `$$${statement}$$`;
return `SELECT indexname FROM hypopg_create_index(${quoted})`;
```

- 用 `$$` 美元引号包裹 DDL，避免 DDL 里的单引号（部分索引的 `WHERE qty1 != '0'`）破坏语句。
- 返回的行第一列是 PostgreSQL 生成的假设索引名（通常形如 `<oid>btree_hypo_...`）。

失败处理：

- 每组用 `try/catch` 独立包裹；失败时仍 push 一个 `{ ..., used: false, error }` 的 trial。
- 单组失败不会中断其它组合。
- 循环结束后统一 `hypopg_reset()`；即使 reset 失败也不影响结论，因为会话关闭会丢弃假设索引。

### 8.10 计划比较

`compareHypotheticalPlan(baseRaw, hypotheticalRaw, hypotheticalIndexNames)`：

| 输出 | 计算方式 |
| --- | --- |
| `baseCost` | 基线计划根 `Plan["Total Cost"]` |
| `hypotheticalCost` | 假设计划根 `Plan["Total Cost"]` |
| `costDeltaPct` | `(hypCost - baseCost) / baseCost * 100`，仅当 `baseCost > 0`；负值表示更便宜 |
| `used` | 假设计划中是否出现任一假设索引 |
| `usedIndexNames` | 命中的 `Index Name` |
| `accessNodeTypes` | 使用假设索引的节点类型（如 `Index Scan` / `Bitmap Index Scan`） |

索引名匹配：

```text
"<41072>btree_hypo_itemcode" → { oid: "41072", tail: "btree_hypo_itemcode" }
两个名字都有 OID → 必须 OID 相等
否则 → 任一方向子串包含即可
```

原因：hypopg 返回的索引名带 OID 前缀，而执行计划里的 `Index Name` 可能只保留可读部分。

### 8.11 推荐判定

`pickBestHypopgTrial(trials)`：

```text
1. 过滤掉 error 或 hypotheticalCost 非有限值的试算
2. cheapest = min(hypotheticalCost)
3. 保留 hypotheticalCost <= cheapest * 1.02（2% 容差）
4. 按 (索引条数升序, 成本升序) 取第一条
```

设计动机：多建一条索引就多一份写入、膨胀和维护成本；「全量组合」只比「两两组合」便宜不到 2% 时，应推荐索引更少的方案。

### 8.12 成本可读化

| 函数 | 规则 |
| --- | --- |
| `formatPlanCost(cost)` | `en-US` 千分位 + 1 位小数，如 `107,703.0`；`undefined` → `—` |
| `deltaText(pct)` | `abs(pct) < 0.05` → 基本持平；负 → `降低 {abs}%`；正 → `升高 {pct}%` |
| `estimateElapsedMs(hypCost, baseCost, baseElapsed)` | `baseElapsed * hypCost / baseCost`；任一缺失、非有限、`baseCost <= 0`、`baseElapsed <= 0` → `undefined` |
| 粗估耗时展示 | ≥100 ms 取整；否则保留 1 位小数 |
| `hypopgBestText` | `推荐方案：{title}，{delta}（{count} 条索引）` |

必须向用户明确的语义：

- 「估算成本」是 PostgreSQL 规划器的**相对代价单位**，不是毫秒，只能横向比较。
- 「粗估耗时」按实测耗时与成本的比例线性折算，只用于数量级感受，真实效果需建索引后实测。
- 成本与耗时不成严格正比（缓存、并行度、函数调用都会影响）。

---

## 9. L3：SQL 改写候选与实测对比

实现：`buildRewriteCandidates(sql, relationNames, databaseType)`、`rankMeasuredCandidates`。

### 9.1 生成条件

- 只对以 `SELECT` 或 `WITH` 开头的语句生成改写；DML 不生成候选（但基线仍会执行）。
- 先去掉注释（保留字符串字面量）。

### 9.2 候选类型

| ID | 标题 | 触发条件 | 改写方式 | 方言 |
| --- | --- | --- | --- | --- |
| `not-exists` | NOT IN → NOT EXISTS | 含 `NOT IN (SELECT` | 仅替换关键字为 `NOT EXISTS (SELECT`，子查询内容不变 | 通用 |
| `explicit-columns` | SELECT * → 显式列 | 含 `SELECT *`，且能从 FROM/JOIN 解析出别名 | 替换为 `alias.*` 列表，最多 8 个别名 | 通用 |
| `any-array` | IN 列表 → `= ANY(ARRAY[…])` | PG；`IN (字面量…)` 且至少 2 项、全部是字面量 | `col = ANY (ARRAY[1, 2])` | PostgreSQL |
| `ilike` | `LOWER(col) LIKE → col ILIKE` | PG；`LOWER(col) LIKE LOWER('x')` 或 `LOWER(col) LIKE 'x'` | `col ILIKE 'x'` | PostgreSQL |

补充规则：

- `NOT IN` 列表（非子查询）不会被 `rewriteLiteralInLists` 改写。
- `IN (SELECT …)` 不会被改写为数组。
- `SELECT a.*` 不会命中 `SELECT *` 规则。
- `selectStarColumnsFromRelations` 只接受别名；没有别名的表不会生成显式列候选。
- 改写只做**文本级**变换，不做语法树级等价验证。

### 9.3 实测与排名

```ts
// 原始 SQL 永远作为第一条 measured
const measured = [原 SQL];

// 只执行前 2 条改写候选，串行，且每条都重新清缓存
for (const candidate of rewriteCandidates.slice(0, 2)) { ... }

// 排名：SQL Server 用 elapsedMs；其他用 executionTimeMs；缺失视为 +∞
rankMeasuredCandidates(measured, databaseType);
```

- 「推荐方案」= 排名第一（可能仍是原始 SQL）。
- 面板「方案对比」按 `measured` 原顺序展示（原始 SQL 第一行），不是按排名。
- 每条候选实测都会重新执行一次 `runDiagnosedPlan`，因此会重新清缓存、重新取计划。

### 9.4 语义注意事项

| 改写 | 等价性 |
| --- | --- |
| `NOT IN (SELECT …)` → `NOT EXISTS (SELECT …)` | **不完全等价**：`NOT IN` 在子查询含 NULL 时返回 unknown，`NOT EXISTS` 不会。执行前需确认子查询列非空。 |
| `IN (1, 2)` → `= ANY (ARRAY[1, 2])` | 语义等价。 |
| `LOWER(col) LIKE LOWER('x')` → `col ILIKE 'x'` | 对大小写折叠基本等价，但依赖排序规则/区域设置；非 ASCII 场景需谨慎。 |
| `SELECT *` → `alias.*` | 结果列相同；但 `alias.*` 仍然返回全部列，性能收益来自后续手动裁剪，不是自动裁剪。 |

---

## 10. 诊断面板展示规则

实现：`apps/desktop/src/components/diagnostics/QueryDiagnosticsPanel.vue`。

### 10.1 顶部

- 标题「慢查询诊断」+ 重新诊断按钮（`loading` 时显示旋转图标）。
- 冷/热徽章：
  - `coldStart === true` → 雪花图标 +「冷缓存」，`title = cacheNote`；
  - `false` → 太阳图标 +「热缓存（未清空）」。
- `error` 用红色边框块展示。

### 10.2 指标卡

只展示有值的指标，`grid-cols-2 md:grid-cols-4`：

| 指标 | 格式 |
| --- | --- |
| `elapsedMs` 耗时 | 1 位小数 |
| `cpuMs` CPU | 1 位小数 |
| `logicalReads` 逻辑读 | 原值 |
| `executionTimeMs` 执行时间 | 1 位小数 + `ms` |
| `planningTimeMs` 计划时间 | 1 位小数 + `ms` |
| `sharedHitBlocks` 共享命中块 | 原值 |
| `sharedReadBlocks` 共享读取块 | 原值 |

### 10.3 问题诊断

- 按 `critical(0) → warning(1) → info(2)` 排序。
- 每条展示：图标、标题、detail、suggestion。
- 空列表显示「未发现明显的执行计划问题」。

### 10.4 索引建议

- 每条带 `#{{ index + 1 }}` 编号，与 hypopg 试算的编号一一对应。
- 展示 reason；SQL Server MissingIndex 额外展示 `impact%`。
- 复制按钮复制完整 DDL。
- DDL 用 `<pre>` 保留换行。

### 10.5 hypopg 安装提示

显示条件（`showHypopgSetup`）：

```text
hypopg 存在
&& !promptSuppressed
&& !hypopgDismissed
&& availability 不是 installed / unknown
&& installHint 存在
```

内容：

- 标题：`available` →「服务器已装 hypopg，当前数据库未启用」；否则「服务器未安装 hypopg」。
- 右上角：`发行版 · PostgreSQL 主版本`。
- 说明文案：优先 `hypopg.note`，否则按 `available/missing` 用 i18n。
- 真实 `hypopg.error`（自动创建失败时）。
- shell 步骤（若有）+ SQL 步骤。
- note 说明（包名、PGDG 源、Windows 编译等）。
- 按钮：复制全部步骤 / 稍候安装 / 永不安装。
- 「永不安装」下方固定提示：「选择『永不安装』后，这台服务器不再提示 hypopg。」

### 10.6 hypopg 试算表

显示条件（`showHypopgTrials`）：

```text
hypopg.availability === "installed"
&& trials.length > 0
&& !hypopgDismissed
```

表头：

| 列 | 内容 |
| --- | --- |
| 试算组合（对应上方索引编号） | 组合标题 + 小字 `#N 表 (键) INCLUDE (…) WHERE …`；hover 显示完整 DDL；失败显示 error |
| 规划器是否选用 | 已选用（绿）/ 未选用（仍走原计划） |
| 估算成本（相对单位） | 千分位 1 位小数；失败显示 `-` |
| 相对现状 | 降低/升高/基本持平；绿/黄/灰 |
| 粗估耗时 | 按成本比例折算；失败显示 `-` |

- 第一行是**基线行**「当前计划（不建索引）」：成本 = `hypopg.baseCost`（缺省时回退到首个有成本的试算 `baseCost`），相对现状 =「基线」，耗时 = 实测耗时。
- 试算行按成本升序，失败或无成本排最后；同成本按索引条数升序。
- 推荐行用 `bg-emerald-500/5` 高亮。
- 表下：
  - `推荐方案：{title}，{delta}（{count} 条索引）`
  - 成本说明（相对单位，不是毫秒）
  - `hypopg.note`（如已自动创建扩展）

### 10.7 方案对比表

显示条件：`measured.length > 1`。

| 列 | 内容 |
| --- | --- |
| 方案 | 候选标题（原始 SQL / NOT EXISTS / 显式列 / ANY ARRAY / ILIKE） |
| 耗时 | SQL Server 用 `elapsedMs`，PostgreSQL 用 `executionTimeMs`；都缺失显示 `-` |
| 逻辑读 | `logicalReads`，PG 不提供则为 `-` |

- 推荐方案行高亮。
- 表下展示推荐 SQL + 复制按钮。

### 10.8 两个「推荐」的区别

| 名称 | 来源 | 含义 |
| --- | --- | --- |
| hypopg 推荐方案 | `pickBestHypopgTrial` | 规划器成本最低且 2% 内索引最少的**假设索引组合** |
| 底部推荐方案 | `rankMeasuredCandidates[0]` | 实测耗时最快的**SQL 写法**（可能是原始 SQL） |

两者互不替代：前者回答「建哪些索引」，后者回答「SQL 要不要改」。

### 10.9 判读顺序（推荐）

1. **先看冷/热徽章**：热缓存下的耗时不能直接和冷缓存的历史数据比较；命中/读取块比例更能说明问题。
2. **再看指标卡**：确认是 CPU 密集、I/O 密集，还是计划时间异常。
3. **读 findings**：critical（大表扫描、方言语法错误）优先；warning（隐式转换、函数包裹、排序溢出）次之；info 用于优化空间提示。
4. **评估索引建议**：
   - 先用 `#编号` 和 reason 理解每条索引的用途；
   - 复制 DDL 前先确认库里没有等价索引（工具不检查现有索引）；
   - 注意部分索引只适合谓词命中率低、且查询稳定带该谓词的场景。
5. **看 hypopg 试算**：
   - 基线行给出「不建索引」的成本与实测耗时；
   - 「规划器是否选用」回答假设索引有没有被选中；
   - 「相对现状」为负且被选用的组合才值得建；
   - 推荐方案按「2% 内索引最少」挑选，优先采纳索引更少的组合；
   - 粗估耗时只用于数量级判断，最终以真实建索引后的实测为准。
6. **看改写实测**：只有实测更快时才采纳；采纳前确认语义等价（尤其是 `NOT IN → NOT EXISTS`）。
7. **上线前复测**：在生产同构环境、接近真实数据量下复测；索引会增加写入与维护成本，需整体评估。

---

## 11. 数据结构

核心类型（`queryDiagnostics.ts`）：

```ts
type DiagnosticSeverity = "critical" | "warning" | "info";

interface QueryDiagnosticFinding {
  severity: DiagnosticSeverity;
  code: string;
  title: string;
  detail: string;
  suggestion?: string;
}

interface QueryIndexSuggestion {
  table: string;
  columns: string[];
  includeColumns: string[];
  impact?: number;      // SQL Server MissingIndexes 预估收益 0-100
  where?: string;       // 部分索引谓词（仅 PostgreSQL）
  sql: string;
  reason: string;
}

interface QueryRewriteCandidate {
  id: string;
  title: string;
  reason: string;
  sql: string;
}

interface QueryDiagnosis {
  databaseType: string;
  metrics: PlanExecutionMetrics;
  findings: QueryDiagnosticFinding[];
  indexSuggestions: QueryIndexSuggestion[];
  rewriteCandidates: QueryRewriteCandidate[];
  coldStart: boolean;
  cacheNote?: string;
  measured: MeasuredCandidate[];
  recommended?: { id: string; title: string; sql: string; elapsedMs?: number };
  hypopg?: HypopgAnalysis;
}
```

hypopg 类型（`hypopgSupport.ts`）：

```ts
type HypopgAvailability = "installed" | "available" | "missing" | "unsupported" | "unknown";

interface HypopgAnalysis {
  availability: HypopgAvailability;
  serverKey: string;
  extensionVersion?: string;
  availableVersion?: string;
  promptSuppressed: boolean;
  profile?: PostgresServerProfile;
  installHint?: HypopgInstallHint;
  trials?: HypopgTrial[];
  baseCost?: number;
  note?: string;
  error?: string;
}

interface HypopgTrial {
  id: string;
  title: string;
  candidateRefs: number[];   // 原始索引建议的 1-based 序号
  indexSqls: string[];
  indexNames: string[];
  used: boolean;
  baseCost?: number;
  hypotheticalCost?: number;
  costDeltaPct?: number;
  accessNodeTypes?: string[];
  error?: string;
}
```

> `unsupported` 虽在类型里，但当前 `analyseHypotheticalIndexes` 不会返回它；实际只会返回 `installed` / `available` / `missing` / `unknown`。

---

## 12. 已知限制与边界

### 12.1 副作用

- **诊断会对传入 SQL 真实执行一次**（SQL Server 用 `SET STATISTICS XML ON` + 直接执行；PostgreSQL 用 `EXPLAIN ANALYZE`，DML 也会真实生效）。只读 SQL 才是安全的使用方式。
- 改写候选也会真实执行，但候选只为 `SELECT` / `WITH` 生成。
- 清缓存是高权限操作：SQL Server `DBCC` 失败、PostgreSQL `pg_buffercache_evict_relation` 失败时，会降级为热缓存，不会中断诊断。

### 12.2 测量精度

- 每次候选测量都会重新清缓存，但缓存清理不保证 100% 生效（共享缓冲、OS 页缓存、连接池预热都会影响）。
- SQL Server 指标来自 `STATISTICS XML`；PostgreSQL 指标来自 `EXPLAIN ANALYZE BUFFERS`。
- PostgreSQL L2 的成本是规划器估算值，不是实测值；粗估耗时是线性折算，只能看数量级。
- **PostgreSQL 面板的「粗估耗时」列当前恒为 `-`**：面板用 `diagnosis.metrics.elapsedMs` 作为折算基线，而 PostgreSQL 的实测耗时字段是 `executionTimeMs`。这是已知展示缺口，修正时应同时兼容两个字段。

### 12.3 SQL 文本解析

- 只识别 `[A-Za-z_][\w$]*` 形式的标识符；带引号/反引号/方括号的标识符、中文表名无法解析。
- 不解析 CTE 名称与子查询内部别名；CTE 名可能被当作真实表传给清缓存语句。
- `FROM (SELECT …) t` 派生表会被跳过。
- `NATURAL JOIN` 因不写列名，无法推导连接键；`USING (…)` 可以。
- 多语句脚本不会被拆分，整段 SQL 作为一个诊断单元。
- SQL 注释与字符串会被遮罩，但部分规则仍读取原始 SQL（如 `LIKE '%`），字符串内容可能造成误报。
- `NOT IN → NOT EXISTS` 是文本替换，不保证 NULL 语义等价。
- `SELECT * → alias.*` 不会自动裁剪列，收益有限。

### 12.4 索引建议

- 不检查现有索引，可能建议已存在的索引；也不会识别「已有前缀索引可复用」。
- 不读取表的行数、选择率、统计信息，只按 SQL 形态推导。
- 键列上限 4、INCLUDE 上限 6 是硬编码经验值。
- 同一张表内键列相同的方案只保留第一条，可能丢掉更优的 INCLUDE 组合。
- SQL Server 的缺失索引提示依赖优化器是否生成 `MissingIndexGroup`；PostgreSQL 没有等价提示，只能靠扫描节点 + SQL 文本。

### 12.5 L2 hypopg

- 只支持 PostgreSQL；只探测，不远程安装扩展文件。
- 只有不带 `ANALYZE` 的 `EXPLAIN` 会使用假设索引，所以不能得到真实耗时/读块。
- 假设索引只在当前 backend 会话内有效，会话断开即消失。
- 候选最多 8 条；两两最多 12 组、三连最多 8 组；「全量」只是这 8 条的全量，不是所有建议的全量。
- `EXPLAIN (FORMAT JSON)` 仍然会做规划，但不会执行；对 DML 的 `EXPLAIN` 也不会产生副作用（与基线不同）。
- `accessNodeTypes` 已采集但面板未展示。

### 12.6 性能与并发

- 一次完整诊断至少执行「基线 + 最多 2 条改写」共 3 次真实查询；大表上耗时会明显放大。
- L2 最多 29 组试算，每组一次 `EXPLAIN`；虽然不执行，但规划本身也需要时间。
- 所有语句串行执行，且使用独立 `clientSessionId`，避免与用户查询互相污染。
- `CREATE EXTENSION` 有 5 秒锁超时，避免被其他会话的长事务卡死。

---

## 13. 代码索引与测试覆盖

### 13.1 代码索引

| 文件 | 关键函数/常量 | 职责 |
| --- | --- | --- |
| `apps/desktop/src/lib/diagnostics/queryDiagnostics.ts` | `buildCacheClearPlan` | 各数据库清缓存语句与冷/热标记 |
| 同上 | `extractReferencedRelations` | 从 SQL 提取 `schema.table` |
| 同上 | `parseSqlServerPlan` | ShowPlan XML → 指标 / findings / 索引 |
| 同上 | `parsePostgresPlan` / `walkPostgresNode` | EXPLAIN JSON → 指标 / 节点规则 |
| 同上 | `hasColumnCast` / `extractPostgresFilterColumns` | 列类型转换与 Filter 列提取 |
| 同上 | `deriveSqlColumnFacts` / `extractSqlTableAliases` | SQL 别名与列角色推导 |
| 同上 | `buildTableIndexSuggestions` | 单表索引方案生成（含部分索引） |
| 同上 | `buildScanIndexHint` | 扫描节点 → 具体索引文案 |
| 同上 | `buildIndexSuggestionsFromSql` | SQL 文本侧批量建议 |
| 同上 | `mergeIndexSuggestions` | 计划侧与 SQL 侧去重合并 |
| 同上 | `buildIndexSuggestionSql` | 方言 DDL 生成 |
| 同上 | `sqlShapeFindings` / `postgresShapeFindings` / `sqlServerShapeFindings` | SQL 形态规则 |
| 同上 | `buildRewriteCandidates` / `rewriteLiteralInLists` / `rewriteLowerLike` | 改写候选 |
| 同上 | `rankMeasuredCandidates` / `dedupeFindings` | 排名与去重 |
| `apps/desktop/src/lib/diagnostics/hypopgSupport.ts` | `HYPOPG_PROBE_SQL` / `HYPOPG_CREATE_SQL` / `HYPOPG_LOCK_TIMEOUT_SQL` / `HYPOPG_RESET_SQL` | 探测、创建、锁超时、重置 |
| 同上 | `parseHypopgProbe` / `parsePostgresServerProfile` / `buildHypopgInstallHint` | 探测结果与安装矩阵 |
| 同上 | `serverKeyForConnection` | 按服务器记忆决策 |
| 同上 | `selectHypopgCandidates` / `planHypopgTrials` | 候选轮转与组合生成 |
| 同上 | `compareHypotheticalPlan` | 假设计划与基线比较 |
| 同上 | `formatPlanCost` / `pickBestHypopgTrial` / `estimateElapsedMs` | 成本可读化与推荐 |
| 同上 | `hypotheticalIndexArgument` | 美元引号包裹 DDL |
| `apps/desktop/src/stores/queryStore.ts` | `diagnoseTabSql` | 诊断编排 |
| 同上 | `runDiagnosedPlan` | 清缓存 + 采集计划 |
| 同上 | `analyseHypotheticalIndexes` | L2 探测与试算编排 |
| `apps/desktop/src/stores/settingsStore.ts` | `rememberHypopgInstallDecision` / `forgetHypopgInstallDecision` | 决策持久化 |
| `apps/desktop/src/components/diagnostics/QueryDiagnosticsPanel.vue` | 全部模板与 computed | 面板展示 |
| `apps/desktop/src/composables/useSqlExecution.ts` | `runDiagnose` / `tryDiagnose` | UI 入口 |
| `apps/desktop/src/i18n/locales/zh-CN.ts` / `en.ts` | `diagnostics.*` | 文案 |

### 13.2 测试覆盖

| 文件 | 用例数 | 覆盖点 |
| --- | --- | --- |
| `apps/desktop/src/lib/__tests__/diagnostics/queryDiagnostics.spec.ts` | 19 | 表名提取、冷缓存语句、SQL Server MissingIndex、PG Seq Scan 索引、Filter 列提取、NOT EXISTS 改写、写语句不改写、ILIKE/pg_trgm、SQL Server 方言误用、非 SARGable 谓词、IN→ANY、NOT IN 保持、LOWER LIKE→ILIKE、组合覆盖索引、列归属、各种 JOIN、扫描→覆盖索引、JIT 开销、列/常量 cast 区分 |
| `apps/desktop/src/lib/__tests__/diagnostics/hypopgSupport.spec.ts` | 28 | 发行版识别（Ubuntu PGDG/RHEL/Windows/unknown）、安装命令矩阵、探测解析、假设计划比较（OID/未选用/无成本）、组合生成（单条/两两/三连/全量）、按表轮转、部分索引优先、成本格式化、2% 推荐规则、耗时折算、`$$` 包裹、serverKey |
| `apps/desktop/src/stores/__tests__/settingsStore.spec.ts` | 相关用例 | `rememberHypopgInstallDecision("host:port", "later"/"never")` |

合计：**47 个诊断相关用例**（19 + 28）。

---

## 14. 扩展与调参指引

### 14.1 支持新数据库

按顺序改四处：

1. `diagnoseTabSql` 的支持校验（`sqlserver` / `postgres` 白名单）。
2. `buildCacheClearPlan` 增加清缓存分支；无法真正清缓存时返回 `cold: false` 并写 `note`。
3. `runDiagnosedPlan` 增加执行计划采集分支（如 MySQL `EXPLAIN ANALYZE` / Oracle `DBMS_XPLAN`）。
4. `diagnoseQueryPlan` 增加解析分支；没有专用解析器时至少返回 `sqlShapeFindings(sql, databaseType)`。

### 14.2 调阈值

| 参数 | 位置 | 当前值 | 调整影响 |
| --- | --- | --- | --- |
| SQL Server Table Scan 行数 | `parseSqlServerPlan` | 1000 | 降低 → 更多扫描告警 |
| SQL Server Clustered Index Scan 行数 | 同上 | 10000 | 同上 |
| PG Seq Scan Rows Removed | `walkPostgresNode` | 1000 | 降低 → 小表也会告警 |
| PG Seq Scan Actual Rows | 同上 | 10000 | 降低 → 更多扫描告警 |
| PG 估算偏差倍数 | 同上 | 10 倍 | 降低 → 更多 info |
| PG 估算偏差最小行数 | 同上 | 100 | 防止 1 行表误报 |
| PG Join Filter 丢弃行数 | 同上 | 1000 | 降低 → 更多连接告警 |
| JIT 占比 | `parsePostgresPlan` | 5% | 降低 → 更多 JIT 告警 |
| 索引键列上限 | `buildTableIndexSuggestions` | 4 | 提高 → 更宽索引 |
| INCLUDE 上限 | 同上 | 6 | 提高 → 更宽覆盖索引 |
| join-first 条数 | 同上 | 2 | 提高 → 更多候选 |
| hypopg 候选数 | `selectHypopgCandidates` | 8 | 提高 → 试算量增加 |
| hypopg 两两组合数 | `planHypopgTrials` | 12 | 同上 |
| hypopg 三连组合数 | 同上 | 8 | 同上 |
| hypopg 推荐容差 | `pickBestHypopgTrial` | 2% | 提高 → 更偏向索引更少的方案 |
| 实测改写条数 | `diagnoseTabSql` | 2 | 提高 → 更多真实执行 |

> 修改常量后建议同时补充对应 spec，尤其是 `planHypopgTrials` 的组合顺序与 `pickBestHypopgTrial` 的边界。

### 14.3 新增规则

- **执行计划规则**：在 `parseSqlServerPlan` / `walkPostgresNode` 中 push 一个 `{ severity, code, title, detail, suggestion }`；`code` 用 `数据库.规则名` 命名。
- **SQL 形态规则**：加到 `sqlShapeFindings`（通用）或 `postgresShapeFindings` / `sqlServerShapeFindings`（方言）。
- **索引变体**：在 `buildTableIndexSuggestions` 中新增 `push(...)`，并给 `INDEX_VARIANT_REASON` 补文案。
- **改写规则**：在 `buildRewriteCandidates` 中新增分支，保证 `id` 唯一、`sql` 可执行、并评估语义等价性。
- 所有新增规则都受 `dedupeFindings` 的 `code:detail` 去重约束。

---

## 附：一句话总结

> DBX 的性能诊断 = **真实冷启动测量** → **执行计划规则 + SQL 形态规则** → **从 SQL 文本还原索引建议（含 PostgreSQL 部分索引）** → **hypopg 组合试算找出规划器成本最低的索引组合** → **把候选改写也真实跑一遍做排名**，最终把「问题、索引 DDL、假设索引组合、SQL 改写」一起交给用户决策。
