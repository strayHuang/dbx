import catalog from "./catalog.generated.json";

/**
 * SQL Server 补全词表。
 *
 * `catalog.generated.json` 由 `scripts/generate-sqlserver-catalog.mjs` 从 Microsoft Learn
 * 生成：
 * - `functions` 来自 T-SQL 函数目录（toc.json），签名从各函数页 `## Syntax` 代码块抽取；
 * - `keywords` 来自官方「Reserved Keywords (Transact-SQL)」文档；
 * - `systemVariables` 是 `@@ROWCOUNT` 这类全局系统变量。
 *
 * 目录里没有收录的多词语法（`OFFSET FETCH`、`FOR JSON` 等）与数据类型在本文件手工维护。
 */
export const SQLSERVER_KEYWORDS: readonly string[] = catalog.keywords;
export const SQLSERVER_SYSTEM_VARIABLES: readonly string[] = catalog.systemVariables;

/** SQL Server 数据类型（含 SQL Server 2022/2025 新增类型）。 */
export const SQLSERVER_TYPE_KEYWORDS: readonly string[] = [
  "BIGINT",
  "BINARY",
  "BIT",
  "CHAR",
  "CHARACTER",
  "DATE",
  "DATETIME",
  "DATETIME2",
  "DATETIMEOFFSET",
  "DECIMAL",
  "DOUBLE PRECISION",
  "FLOAT",
  "GEOGRAPHY",
  "GEOMETRY",
  "HIERARCHYID",
  "IMAGE",
  "INT",
  "INTEGER",
  "JSON",
  "MONEY",
  "NCHAR",
  "NTEXT",
  "NUMERIC",
  "NVARCHAR",
  "REAL",
  "ROWVERSION",
  "SMALLDATETIME",
  "SMALLINT",
  "SMALLMONEY",
  "SQL_VARIANT",
  "SYSNAME",
  "TEXT",
  "TIME",
  "TIMESTAMP",
  "TINYINT",
  "UNIQUEIDENTIFIER",
  "VARBINARY",
  "VARCHAR",
  "VECTOR",
  "XML",
];

/** SQL Server 的多词语法与常用查询提示。 */
export const SQLSERVER_SYNTAX_PHRASES: readonly string[] = [
  "OFFSET",
  "FETCH NEXT",
  "FETCH FIRST",
  "NEXT VALUE FOR",
  "AT TIME ZONE",
  "WITHIN GROUP",
  "IS JSON",
  "FOR JSON",
  "FOR XML",
  "CROSS APPLY",
  "OUTER APPLY",
  "PARTITION BY",
  "ROWS BETWEEN",
  "RANGE BETWEEN",
  "UNBOUNDED PRECEDING",
  "UNBOUNDED FOLLOWING",
  "CURRENT ROW",
  "PERIOD FOR SYSTEM_TIME",
  "SYSTEM_VERSIONING",
  "NOLOCK",
  "READPAST",
  "UPDLOCK",
  "ROWLOCK",
  "HOLDLOCK",
  "TABLOCK",
  "TABLOCKX",
  "SNAPSHOT",
  "READ COMMITTED SNAPSHOT",
  "MATCH",
  "EDGE",
  "NODE",
  "LEDGER",
];

/**
 * 官方目录里与 T-SQL 语句关键字同名的触发器函数（`UPDATE()` 只能出现在触发器内）。
 * 保留关键字补全，避免用户输入 `update` 时只拿到函数项而没有 `UPDATE` 语句关键字。
 */
const STATEMENT_KEYWORD_FUNCTIONS = new Set(["UPDATE"]);

/** 官方文档中的 SQL Server 函数签名（名称大写、参数名小写）。 */
export const SQLSERVER_DOCUMENTED_FUNCTION_SIGNATURES: ReadonlyMap<string, string[]> = new Map(catalog.functions.filter(({ name }) => !STATEMENT_KEYWORD_FUNCTIONS.has(name)).map(({ name, parameters }) => [name, parameters]));
