import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";
import { SQLSERVER_DOCUMENTED_FUNCTION_SIGNATURES, SQLSERVER_KEYWORDS, SQLSERVER_SYNTAX_PHRASES, SQLSERVER_SYSTEM_VARIABLES, SQLSERVER_TYPE_KEYWORDS } from "@/lib/sql/sqlserver/catalog";

const SQLSERVER_OPTIONS = {
  databaseType: "sqlserver" as never,
  tables: [],
  columnsByTable: new Map(),
};

function labelsFor(sql: string) {
  return buildSqlCompletionItems(sql, sql.length, SQLSERVER_OPTIONS).map((item) => item.label);
}

const SQLSERVER_TABLE_OPTIONS = {
  databaseType: "sqlserver" as never,
  tables: [{ name: "OSHP" }, { name: "OITB" }],
  columnsByTable: new Map([
    [
      "oshp",
      [
        { name: "DocEntry", table: "OSHP" },
        { name: "IsInvalid", table: "OSHP" },
      ],
    ],
    ["oitb", [{ name: "ItmsGrpCod", table: "OITB" }]],
  ]),
};

function tableLabelsFor(sql: string) {
  return buildSqlCompletionItems(sql, sql.length, SQLSERVER_TABLE_OPTIONS).map((item) => item.label);
}

describe("SQL Server completion catalog", () => {
  it("ships the official reserved keywords, system variables and documented functions", () => {
    expect(SQLSERVER_KEYWORDS.length).toBeGreaterThan(180);
    expect(SQLSERVER_SYSTEM_VARIABLES.length).toBeGreaterThan(30);
    expect(SQLSERVER_DOCUMENTED_FUNCTION_SIGNATURES.size).toBeGreaterThan(300);
    expect(SQLSERVER_KEYWORDS).toContain("MERGE");
    expect(SQLSERVER_SYSTEM_VARIABLES).toContain("@@ROWCOUNT");
    expect(SQLSERVER_SYNTAX_PHRASES).toContain("NEXT VALUE FOR");
    expect(SQLSERVER_TYPE_KEYWORDS).toContain("VECTOR");
  });

  it("offers reserved keywords that were previously missing", () => {
    expect(labelsFor("merg")).toContain("MERGE");
  });

  it("offers functions documented only in the Microsoft catalog", () => {
    expect(SQLSERVER_DOCUMENTED_FUNCTION_SIGNATURES.has("GENERATE_SERIES")).toBe(true);
    expect(labelsFor("SELECT generate_se")).toContain("GENERATE_SERIES");
    expect(SQLSERVER_DOCUMENTED_FUNCTION_SIGNATURES.get("DATE_BUCKET")).toEqual(["datepart", "number", "date"]);
    expect(SQLSERVER_DOCUMENTED_FUNCTION_SIGNATURES.has("VECTOR_DISTANCE")).toBe(true);
  });

  it("keeps hand-written signatures for high-frequency functions", () => {
    // 官方目录里 TRY_CAST 的签名是 `expression, data_type`，手工维护的版本更贴近实际写法。
    const items = buildSqlCompletionItems("SELECT TRY_CA", "SELECT TRY_CA".length, SQLSERVER_OPTIONS);
    expect(items.find((item) => item.label === "TRY_CAST")?.apply).toBe("TRY_CAST(${expression AS type})");

    const convertItems = buildSqlCompletionItems("SELECT CONVER", "SELECT CONVER".length, SQLSERVER_OPTIONS);
    expect(convertItems.find((item) => item.label === "CONVERT")?.apply).toBe("CONVERT(${type}, ${expression})");
  });

  it("suggests datepart values inside the newer date functions", () => {
    expect(labelsFor("SELECT DATE_BUCKET(")).toContain("MONTH");
    expect(labelsFor("SELECT DATETRUNC(")).toContain("QUARTER");
    expect(labelsFor("SELECT DATEDIFF_BIG(")).toContain("DAYOFYEAR");
  });

  it("completes the target type only in the CONVERT type slot", () => {
    const firstArgument = tableLabelsFor("SELECT CONVERT(");
    expect(firstArgument).toContain("NVARCHAR");
    expect(firstArgument).not.toContain("DocEntry");

    // `CONVERT(type, value)`: the second argument is a value, so columns come back.
    const sql = "SELECT CONVERT(NVARCHAR(50),  FROM OSHP s0";
    expect(buildSqlCompletionItems(sql, sql.indexOf(",") + 1, SQLSERVER_TABLE_OPTIONS).map((item) => item.label)).toContain("DocEntry");
  });

  it("completes the target type in CAST, TRY_CAST, PARSE and TRY_CONVERT", () => {
    for (const sql of ["SELECT CAST(CardCode AS ", "SELECT TRY_CAST(CardCode AS ", "SELECT PARSE(CardCode AS ", "SELECT TRY_CONVERT("]) {
      const labels = tableLabelsFor(sql);
      expect(labels).toContain("NVARCHAR");
      expect(labels).not.toContain("DocEntry");
    }

    // The value argument of CAST keeps column completion.
    const sql = "SELECT CAST(  FROM OSHP s0";
    expect(buildSqlCompletionItems(sql, sql.indexOf("(") + 1, SQLSERVER_TABLE_OPTIONS).map((item) => item.label)).toContain("DocEntry");
  });

  it("resolves table aliases written after a NOLOCK table hint", () => {
    const sql = "SELECT s0. s1. FROM OSHP(nolock) s0, OITB (nolock) s1";
    expect(buildSqlCompletionItems(sql, sql.indexOf("s0.") + "s0.".length, SQLSERVER_TABLE_OPTIONS).map((item) => item.label)).toEqual(["DocEntry", "IsInvalid"]);

    expect(buildSqlCompletionItems(sql, sql.indexOf("s1.") + "s1.".length, SQLSERVER_TABLE_OPTIONS).map((item) => item.label)).toEqual(["ItmsGrpCod"]);
  });

  it("resolves a reused alias to the table of the current parenthesis scope", () => {
    const options = {
      databaseType: "sqlserver" as never,
      dialect: "sqlserver" as never,
      tables: [{ name: "OETT" }, { name: "YValueDetail" }],
      columnsByTable: new Map([
        ["oett", [{ name: "dayTargetAmount", table: "OETT" }]],
        ["yvaluedetail", [{ name: "priceOfDay", table: "YValueDetail" }]],
      ]),
    };
    const sql = "(select x from OETT(nolock) t1)\nunion all\n(select t1. from YValueDetail(nolock) t1)";
    const secondArm = buildSqlCompletionItems(sql, sql.indexOf("t1.") + "t1.".length, options).map((item) => item.label);

    expect(secondArm).toContain("priceOfDay");
    expect(secondArm).not.toContain("dayTargetAmount");
  });
});
