// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import type { ParsedExplainPlan } from "@/lib/diagram/explainPlan";
import { buildCacheClearPlan, buildIndexSuggestionsFromSql, buildRewriteCandidates, diagnoseQueryPlan, extractReferencedRelations, extractPostgresFilterColumns, hasColumnCast, rewriteLiteralInLists, rewriteLowerLike, sqlShapeFindings } from "@/lib/diagnostics/queryDiagnostics";

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
      Filter: "(status::text = 'A'::text) AND (created_at > '2024-01-01'::timestamp)",
      "Shared Hit Blocks": 10,
      "Shared Read Blocks": 4200,
    },
  },
];

function postgresPlan(): ParsedExplainPlan {
  return { databaseType: "postgres", nodes: [], raw: PG_JSON };
}

/** Multi-table aggregate whose real plan scans both base tables in parallel. */
const MULTI_TABLE_SQL = `select t3.groupname,t2.style,sum(t1.qty1) qty1 from qstest_oitw
t1 inner join qstest_oitm  t2 on t1.itementry=t2.docentry and t1.qty1!='0'
inner join qstest_oitg  t3 on t3.groupcode=t2.groupcode
group by t3.groupname ,t2.style`;

const PG_JOIN_PLAN = [
  {
    "Planning Time": 0.31,
    "Execution Time": 459.744,
    JIT: { Functions: 87, Timing: { Total: 58.131 } },
    Plan: {
      "Node Type": "Hash Join",
      "Actual Rows": 9034,
      "Actual Loops": 1,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "qstest_oitm",
          Schema: "public",
          "Plan Rows": 622696,
          "Actual Rows": 498257,
          "Actual Loops": 3,
          "Shared Read Blocks": 71947,
        },
        {
          "Node Type": "Seq Scan",
          "Relation Name": "qstest_oitw",
          Schema: "public",
          "Plan Rows": 55842,
          "Actual Rows": 42994,
          "Actual Loops": 3,
          "Rows Removed by Filter": 1145092,
          Filter: "(qty1 <> '0'::numeric)",
          "Shared Read Blocks": 25907,
        },
      ],
    },
  },
];

function multiTablePlan(): ParsedExplainPlan {
  return { databaseType: "postgres", nodes: [], raw: PG_JOIN_PLAN };
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

  it("keeps every index suggestion on the table that owns its columns", () => {
    const suggestions = buildIndexSuggestionsFromSql(MULTI_TABLE_SQL, "postgres");
    const forTable = (table: string) => suggestions.filter((entry) => entry.table === table);

    // groupname belongs to qstest_oitg and style to qstest_oitm; neither may leak
    // into the qstest_oitw suggestion.
    const oitw = forTable("qstest_oitw");
    expect(oitw).toHaveLength(3);
    expect(oitw[0]!.columns).toEqual(["qty1", "itementry"]);
    expect(oitw[0]!.includeColumns).toEqual([]);
    // The join key also stands alone so the other table can probe it.
    expect(oitw[1]!.columns).toEqual(["itementry"]);
    expect(oitw[1]!.includeColumns).toEqual(["qty1"]);
    expect(oitw[1]!.reason).toContain("连接列作键列");
    // `qty1 != '0'` 是单表常量谓词，写进部分索引的 WHERE 后只索引命中的行。
    expect(oitw[2]!.where).toBe("qty1 != '0'");
    expect(oitw[2]!.columns).toEqual(["itementry"]);
    expect(oitw[2]!.includeColumns).toEqual(["qty1"]);
    expect(oitw[2]!.sql).toContain("INCLUDE (qty1) WHERE qty1 != '0';");
    expect(oitw[2]!.reason).toContain("部分索引");

    const oitm = forTable("qstest_oitm");
    expect(oitm).toHaveLength(2);
    expect(oitm[0]!.columns).toEqual(["docentry"]);
    expect(oitm[0]!.includeColumns).toEqual(["groupcode", "style"]);
    expect(oitm[1]!.columns).toEqual(["groupcode"]);
    expect(oitm[1]!.includeColumns).toEqual(["docentry", "style"]);

    const oitg = forTable("qstest_oitg");
    expect(oitg).toHaveLength(1);
    expect(oitg[0]!.columns).toEqual(["groupcode"]);
    expect(oitg[0]!.includeColumns).toEqual(["groupname"]);
    expect(oitg[0]!.sql).toContain("CREATE INDEX ON qstest_oitg (groupcode) INCLUDE (groupname);");
  });

  it("analyses join keys for every join flavour, not just WHERE filters", () => {
    const joinIndex = (sql: string, table: string, joinColumn: string) => {
      const suggestions = buildIndexSuggestionsFromSql(sql, "postgres").filter((entry) => entry.table === table);
      return suggestions.find((entry) => entry.columns[0]?.toLowerCase() === joinColumn && entry.reason.includes("连接列作键列"));
    };

    expect(joinIndex("select a.name, b.title from qstest_a a inner join qstest_b b on a.id = b.aid where b.total > 10", "qstest_b", "aid")).toBeDefined();
    expect(joinIndex("select a.name, b.title from qstest_a a left join qstest_b b on a.id = b.aid where b.total > 10", "qstest_b", "aid")).toBeDefined();
    // Old-style comma join: an implicit inner join, very common in SQL Server code.
    expect(joinIndex("select a.name, b.title from qstest_a a, qstest_b b where a.id = b.aid and b.total > 10", "qstest_b", "aid")).toBeDefined();
    // `USING` never writes `alias.column`, so the key has to come from the clause itself.
    expect(joinIndex("select a.name, b.title from qstest_a a join qstest_b b using (id) where b.total > 10", "qstest_b", "id")).toBeDefined();

    // CROSS JOIN has no ON clause: each side is still analysed on its own filters.
    const crossed = buildIndexSuggestionsFromSql("select a.name, b.title from qstest_a a cross join qstest_b b where a.id > 0 and b.total > 10", "postgres");
    expect(crossed.filter((entry) => entry.table === "qstest_a")[0]?.columns).toEqual(["id"]);
    expect(crossed.filter((entry) => entry.table === "qstest_b")[0]?.columns).toEqual(["total"]);
  });

  it("turns seq scans into concrete covering indexes instead of generic advice", () => {
    const diagnosis = diagnoseQueryPlan(multiTablePlan(), MULTI_TABLE_SQL);
    const scanFindings = diagnosis.findings.filter((finding) => finding.code === "postgres.seq-scan");
    expect(scanFindings).toHaveLength(2);

    const oitmFinding = scanFindings.find((finding) => finding.detail.includes("qstest_oitm"))!;
    // No Filter is reported for this scan — the join key is the only reason it runs.
    expect(oitmFinding.suggestion).toContain("(docentry) INCLUDE (groupcode, style)");
    expect(oitmFinding.suggestion).toContain("嵌套循环");

    const oitwFinding = scanFindings.find((finding) => finding.detail.includes("qstest_oitw"))!;
    // The filter and the join key share one index; the join key also gets its own,
    // plus a partial index that only indexes rows with qty1 <> '0'.
    expect(oitwFinding.suggestion).toContain("(qty1, itementry)");
    expect(oitwFinding.suggestion).toContain("(itementry) INCLUDE (qty1)");
    expect(oitwFinding.suggestion).toContain("WHERE qty1 != '0'");

    // Plan hints win over the SQL pass when they describe the same column set,
    // so the duplicated SQL suggestions are dropped: 3 + 2 + 1 = 6.
    expect(diagnosis.indexSuggestions).toHaveLength(6);
    const oitwIndexes = diagnosis.indexSuggestions.filter((entry) => entry.table === "public.qstest_oitw");
    expect(oitwIndexes).toHaveLength(3);
    expect(oitwIndexes[0]!.columns).toEqual(["qty1", "itementry"]);
    expect(oitwIndexes[0]!.includeColumns).toEqual([]);
    expect(oitwIndexes[1]!.columns).toEqual(["itementry"]);
    expect(oitwIndexes[1]!.includeColumns).toEqual(["qty1"]);
    // 部分索引：索引体积和扫描量都按谓词命中率缩小，和覆盖索引组合后常能出最优计划。
    expect(oitwIndexes[2]!.where).toBe("qty1 != '0'");
    expect(oitwIndexes[2]!.sql).toContain("WHERE qty1 != '0';");

    const oitmIndexes = diagnosis.indexSuggestions.filter((entry) => entry.table === "public.qstest_oitm");
    expect(oitmIndexes).toHaveLength(2);
    expect(oitmIndexes[0]!.columns).toEqual(["docentry"]);
    expect(oitmIndexes[0]!.includeColumns).toEqual(["groupcode", "style"]);
    expect(oitmIndexes[1]!.columns).toEqual(["groupcode"]);

    const oitgIndex = diagnosis.indexSuggestions.find((entry) => entry.columns[0] === "groupcode" && entry.table === "qstest_oitg")!;
    expect(oitgIndex.includeColumns).toEqual(["groupname"]);
  });

  it("reports JIT compilation overhead on a short query", () => {
    const diagnosis = diagnoseQueryPlan(multiTablePlan(), MULTI_TABLE_SQL);
    expect(diagnosis.findings.some((finding) => finding.code === "postgres.jit-overhead")).toBe(true);
  });

  it("flags a cast on the column but not on the constant", () => {
    // `'0'::numeric` is on the literal side; Postgres adds it itself and the index stays usable.
    expect(hasColumnCast("(qty1 <> '0'::numeric)")).toBe(false);
    const literalCast = sqlShapeFindings("select * from t where qty <> '0' and status = 'A'::text", "postgres");
    expect(literalCast.some((finding) => finding.code === "postgres.cast-in-where")).toBe(false);

    expect(hasColumnCast("(status::text = 'A'::text)")).toBe(true);
    expect(hasColumnCast("CAST(created_at AS date) = '2024-01-01'")).toBe(true);
    const columnCast = sqlShapeFindings("select * from t where status::text = 'A'", "postgres");
    expect(columnCast.some((finding) => finding.code === "postgres.cast-in-where")).toBe(true);
  });
});
