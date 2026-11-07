import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems, shouldAutoOpenSqlCompletion } from "@/lib/sql/sqlCompletion";
import { POSTGRES_FUNCTION_SIGNATURES } from "@/lib/sql/functionSignatures/postgres";
import { POSTGRES_KEYWORDS, POSTGRES_SYNTAX_PHRASES, POSTGRES_TYPE_KEYWORDS } from "@/lib/sql/postgres/catalog";

const POSTGRES_OPTIONS = {
  databaseType: "postgres" as never,
  tables: [],
  columnsByTable: new Map(),
};

function itemsFor(sql: string) {
  return buildSqlCompletionItems(sql, sql.length, POSTGRES_OPTIONS);
}

function labelsFor(sql: string) {
  return itemsFor(sql).map((item) => item.label);
}

describe("PostgreSQL 18 completion catalog", () => {
  it("ships the official parser keyword table and documented functions", () => {
    expect(POSTGRES_KEYWORDS.length).toBeGreaterThan(450);
    expect(POSTGRES_FUNCTION_SIGNATURES.size).toBeGreaterThan(600);
    expect(POSTGRES_KEYWORDS).toContain("MERGE");
    expect(POSTGRES_SYNTAX_PHRASES).toContain("AT TIME ZONE");
    expect(POSTGRES_TYPE_KEYWORDS).toContain("TIMESTAMP WITH TIME ZONE");
  });

  it("offers INTERVAL as an expression type inside SELECT statements", () => {
    const labels = labelsFor("SELECT * FROM events WHERE duration > inter");
    expect(labels).toContain("INTERVAL");
  });

  it("offers PostgreSQL keywords that were previously missing", () => {
    const labels = labelsFor("merge");
    expect(labels).toContain("MERGE");
  });

  it("offers functions documented only in the PostgreSQL manual", () => {
    const labels = labelsFor("SELECT pg_get_ex");
    expect(labels).toContain("PG_GET_EXPR");
  });

  it("keeps hand-written signatures for high-frequency functions", () => {
    expect(POSTGRES_FUNCTION_SIGNATURES.get("DATE_TRUNC")).toEqual(["field", "source"]);
  });

  it("suggests PostgreSQL data types after the :: cast operator", () => {
    const sql = "SELECT t.id::";
    const labels = labelsFor(sql);
    expect(labels).toContain("TEXT");
    expect(labels).toContain("JSONB");
    expect(labels).toContain("INTERVAL");
    expect(labels).not.toContain("SELECT");
    expect(shouldAutoOpenSqlCompletion(sql, sql.length, POSTGRES_OPTIONS)).toBe(true);
  });

  it("filters cast targets by the prefix typed after ::", () => {
    const sql = "SELECT t.id::te";
    const labels = labelsFor(sql);
    expect(labels).toContain("TEXT");
    expect(labels).not.toContain("JSONB");
    expect(shouldAutoOpenSqlCompletion(sql, sql.length, POSTGRES_OPTIONS)).toBe(true);
  });

  it("suggests date/time field values inside DATE_TRUNC and EXTRACT", () => {
    const truncLabels = labelsFor("SELECT DATE_TRUNC(");
    expect(truncLabels).toContain("MONTH");
    expect(truncLabels).not.toContain("EPOCH");
    expect(shouldAutoOpenSqlCompletion("SELECT DATE_TRUNC(", "SELECT DATE_TRUNC(".length, POSTGRES_OPTIONS)).toBe(true);

    const extractLabels = labelsFor("SELECT EXTRACT(");
    expect(extractLabels).toContain("EPOCH");
    expect(extractLabels).toContain("DOW");
  });
});
