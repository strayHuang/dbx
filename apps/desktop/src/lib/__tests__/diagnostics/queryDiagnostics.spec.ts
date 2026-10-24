// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import type { ParsedExplainPlan } from "@/lib/diagram/explainPlan";
import { buildCacheClearPlan, buildIndexSuggestionsFromSql, buildRewriteCandidates, diagnoseQueryPlan, extractReferencedRelations, extractPostgresFilterColumns, rewriteLiteralInLists, rewriteLowerLike, sqlShapeFindings } from "@/lib/diagnostics/queryDiagnostics";

const SQL_SERVER_XML = `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
  <BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT * FROM dbo.OTM o JOIN dbo.SAL s ON o.id = s.id WHERE o.shpcode = 'A'">
    <QueryPlan>
      <MissingIndexes>
        <MissingIndexGroup Impact="92.5">
          <MissingIndex Database="[VJRE_ERP]" Schema="[dbo]" Table="[OTM]">
            <ColumnGroup Usage="EQUALITY"><Column Name="[shpcode]" ColumnId="1"/></ColumnGroup>
            <ColumnGroup Usage="INEQUALITY"><Column Name="[stdate]" ColumnId="2"/></ColumnGroup>
            <ColumnGroup Usage="INCLUDE"><Column Name="[qty]" ColumnId="3"/></ColumnGroup>
          </MissingIndex>
        </MissingIndexGroup>
      </MissingIndexes>
      <RelOp NodeId="0" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="150000" EstimatedTotalSubtreeCost="120.5">
        <OutputList/>
        <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="150000" ActualExecutions="1" ActualElapsedms="2100"/></RunTimeInformation>
        <Object Database="[VJRE_ERP]" Schema="[dbo]" Table="[OTM]" Index="[PK_OTM]"/>
        <ScalarOperator ScalarString="CONVERT_IMPLICIT(int,[@1],0)=[shpcode]"/>
      </RelOp>
      <QueryTimeStats CpuTime="1800" ElapsedTime="2400"/>
    </QueryPlan>
  </StmtSimple></Statements></Batch></BatchSequence>
</ShowPlanXML>`;

function sqlServerPlan(): ParsedExplainPlan {
  return {
    databaseType: "sqlserver",
    nodes: [],
    raw: { rows: [[[SQL_SERVER_XML]]] },
  };
}

const PG_JSON = [
  {
    "Planning Time": 2.5,
    "Execution Time": 320.75,
    Plan: {
      "Node Type": "Seq Scan",
      "Relation Name": "qstest_sal1",
      Schema: "public",
      "Plan Rows": 100,
      "Actual Rows": 48000,
      "Rows Removed by Filter": 950000,
      Filter: "(status = 'A'::text) AND (created_at > '2024-01-01'::timestamp)",
      "Shared Hit Blocks": 10,
      "Shared Read Blocks": 4200,
    },
  },
];

function postgresPlan(): ParsedExplainPlan {
  return { databaseType: "postgres", nodes: [], raw: PG_JSON };
}

describe("query diagnostics", () => {
  it("extracts referenced relations from FROM/JOIN", () => {
    expect(extractReferencedRelations("select * from dbo.otm o join public.sal s on o.id = s.id where x = 1")).toEqual(["dbo.otm", "public.sal"]);
  });

  it("builds cold-cache statements per database", () => {
    expect(buildCacheClearPlan("sqlserver", []).statements).toEqual(["DBCC DROPCLEANBUFFERS WITH NO_INFOMSGS;", "DBCC FREEPROCCACHE WITH NO_INFOMSGS;"]);
    expect(buildCacheClearPlan("sqlserver", []).cold).toBe(true);

    const postgres = buildCacheClearPlan("postgres", ["public.users"]);
    expect(postgres.cold).toBe(true);
    expect(postgres.statements.join("\n")).toContain("pg_buffercache_evict_relation('public.users'::regclass)");
    expect(postgres.statements.join("\n")).toContain("DISCARD ALL;");
  });

  it("turns SQL Server MissingIndexes into a CREATE INDEX statement", () => {
    const diagnosis = diagnoseQueryPlan(sqlServerPlan(), "SELECT * FROM dbo.OTM o JOIN dbo.SAL s ON o.id = s.id WHERE o.shpcode = 'A'");
    expect(diagnosis.indexSuggestions.length).toBeGreaterThanOrEqual(1);
    const missingIndex = diagnosis.indexSuggestions.find((entry) => entry.impact === 92.5);
    expect(missingIndex?.table).toBe("dbo.OTM");
    expect(missingIndex?.sql).toContain("CREATE NONCLUSTERED INDEX");
    expect(missingIndex?.sql).toContain("([shpcode], [stdate]) INCLUDE ([qty])");
    expect(missingIndex?.impact).toBe(92.5);
    expect(diagnosis.metrics.elapsedMs).toBe(2400);
    expect(diagnosis.metrics.cpuMs).toBe(1800);
    expect(diagnosis.findings.some((finding) => finding.code === "sqlserver.implicit-conversion")).toBe(true);
    expect(diagnosis.findings.some((finding) => finding.code === "sqlserver.table-scan")).toBe(true);
  });

  it("suggests an index for a PostgreSQL Seq Scan and reports cold-cache metrics", () => {
    const diagnosis = diagnoseQueryPlan(postgresPlan(), "select * from public.qstest_sal1 where status = 'A'");
    expect(diagnosis.metrics.executionTimeMs).toBe(320.75);
    expect(diagnosis.metrics.sharedReadBlocks).toBe(4200);
    expect(diagnosis.findings.some((finding) => finding.code === "postgres.seq-scan")).toBe(true);
    expect(diagnosis.findings.some((finding) => finding.code === "postgres.implicit-cast")).toBe(true);
    expect(diagnosis.indexSuggestions[0]?.sql).toContain("public.qstest_sal1");
  });

  it("extracts filter columns without string literals", () => {
    expect(extractPostgresFilterColumns("(status = 'A'::text) AND (created_at > '2024-01-01'::timestamp)")).toEqual(["status", "created_at"]);
  });

  it("builds a NOT EXISTS rewrite candidate for read queries", () => {
    const candidates = buildRewriteCandidates("select * from t where id not in (select id from u)", new Set(["t"]));
    expect(candidates.some((candidate) => candidate.id === "not-exists")).toBe(true);
    expect(candidates.find((candidate) => candidate.id === "not-exists")?.sql).toContain("NOT EXISTS (SELECT");
  });

  it("does not propose rewrites for write statements", () => {
    expect(buildRewriteCandidates("delete from t where id in (select id from u)", new Set(["t"]))).toEqual([]);
  });

  it("suggests pg_trgm for a PostgreSQL ILIKE with a leading wildcard", () => {
    const findings = sqlShapeFindings("select * from public.t where name ilike '%abc%'", "postgres");
    expect(findings.some((finding) => finding.code === "postgres.ilike-trigram")).toBe(true);
  });

  it("reports ILIKE and LIMIT as PostgreSQL-only syntax on SQL Server", () => {
    const findings = sqlShapeFindings("select id from t where name ilike '%a%' limit 10", "sqlserver");
    expect(findings.some((finding) => finding.code === "sqlserver.ilike-invalid")).toBe(true);
    expect(findings.some((finding) => finding.code === "sqlserver.limit-syntax")).toBe(true);
  });

  it("flags non-sargable SQL Server predicates", () => {
    const findings = sqlShapeFindings("select * from t where isnull(col, '') = 'A' and year(created_at) = 2024", "sqlserver");
    expect(findings.some((finding) => finding.code === "sqlserver.isnull-predicate")).toBe(true);
    expect(findings.some((finding) => finding.code === "sqlserver.date-function")).toBe(true);
  });

  it("rewrites a literal IN list to ANY(ARRAY[]) on PostgreSQL", () => {
    const candidates = buildRewriteCandidates("select id from t where status in ('A', 'B')", new Set(["t"]), "postgres");
    const anyArray = candidates.find((candidate) => candidate.id === "any-array");
    expect(anyArray?.sql).toContain("status = ANY (ARRAY['A', 'B'])");
  });

  it("keeps NOT IN literal lists untouched", () => {
    expect(rewriteLiteralInLists("select * from t where status not in ('A', 'B')").changed).toBe(false);
    expect(rewriteLiteralInLists("select * from t where id in (1)").changed).toBe(false);
  });

  it("rewrites LOWER(col) LIKE to ILIKE on PostgreSQL", () => {
    const result = rewriteLowerLike("select * from t where lower(name) like lower('abc%')");
    expect(result.changed).toBe(true);
    expect(result.sql).toBe("select * from t where name ILIKE 'abc%'");
  });

  it("derives a composite covering index from join predicates, IN lists and aggregate columns", () => {
    const sql = `select shpentry, sum(valueemp)/10000 valuetotal
from qstest_yj_valuedetail t1 inner join(
select min(u0.startdate) startdate,max(u0.enddate) enddate from qstest_ofpr u0
inner join qstest_ofpr u1 on '2026'=extract(year from u1.startdate)
)t2 on t1.docdate between t2.startdate and t2.enddate
and t1.shpentry in ( 2,3,6,7,8,10 )
group by shpentry`;
    const suggestions = buildIndexSuggestionsFromSql(sql, "postgres").filter((entry) => entry.table === "qstest_yj_valuedetail");
    expect(suggestions).toHaveLength(2);
    const equalityFirst = suggestions[0]!;
    expect(equalityFirst.columns).toEqual(["shpentry", "docdate"]);
    expect(equalityFirst.includeColumns).toEqual(["valueemp"]);
    expect(equalityFirst.sql).toContain("(shpentry, docdate) INCLUDE (valueemp)");
    const rangeFirst = suggestions[1]!;
    expect(rangeFirst.columns).toEqual(["docdate", "shpentry"]);
    expect(rangeFirst.sql).toContain("(docdate, shpentry) INCLUDE (valueemp)");
  });
});
