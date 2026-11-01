import { describe, expect, it } from "vitest";
import type { QueryIndexSuggestion } from "@/lib/diagnostics/queryDiagnostics";
import { buildHypopgInstallHint, compareHypotheticalPlan, hypotheticalIndexArgument, parseHypopgProbe, parsePostgresServerProfile, planHypopgTrials, serverKeyForConnection } from "@/lib/diagnostics/hypopgSupport";

const UBUNTU_PGDG = "PostgreSQL 18.3 (Ubuntu 18.3-1.pgdg24.04+1) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0, 64-bit";
const RHEL_PGDG = "PostgreSQL 14.5 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 11.2.1 20220127 (Red Hat 11.2.1-9), 64-bit";
const WINDOWS_EDB = "PostgreSQL 16.4, compiled by Visual C++ build 1944, 64-bit";

describe("parsePostgresServerProfile", () => {
  it("recognises the PGDG Ubuntu build used by the target server", () => {
    const profile = parsePostgresServerProfile(UBUNTU_PGDG);
    expect(profile.platform).toBe("debian");
    expect(profile.majorVersion).toBe(18);
    expect(profile.distribution).toBe("Ubuntu 24.04");
    expect(profile.version).toContain("PostgreSQL 18.3");
  });

  it("recognises Red Hat flavoured builds", () => {
    const profile = parsePostgresServerProfile(RHEL_PGDG);
    expect(profile.platform).toBe("redhat");
    expect(profile.majorVersion).toBe(14);
    expect(profile.distribution).toContain("Red Hat");
  });

  it("recognises the Windows build banner", () => {
    const profile = parsePostgresServerProfile(WINDOWS_EDB);
    expect(profile.platform).toBe("windows");
    expect(profile.majorVersion).toBe(16);
    expect(profile.distribution).toBe("Windows");
  });

  it("falls back to unknown when the banner carries no platform marker", () => {
    const profile = parsePostgresServerProfile("PostgreSQL 9.6.0");
    expect(profile.platform).toBe("unknown");
    expect(profile.majorVersion).toBe(9);
    expect(profile.distribution).toBe("");
  });
});

describe("buildHypopgInstallHint", () => {
  it("uses the PGDG apt package name on Debian/Ubuntu", () => {
    const hint = buildHypopgInstallHint(parsePostgresServerProfile(UBUNTU_PGDG));
    expect(hint.shellCommands).toEqual(["sudo apt-get update", "sudo apt-get install -y postgresql-18-hypopg"]);
    expect(hint.sqlStatements).toEqual(["CREATE EXTENSION IF NOT EXISTS hypopg;"]);
  });

  it("uses the PGDG rpm package name on RHEL flavours", () => {
    const hint = buildHypopgInstallHint(parsePostgresServerProfile(RHEL_PGDG));
    expect(hint.shellCommands).toEqual(["sudo dnf install -y --enablerepo=pgdg14 hypopg_14"]);
    expect(hint.note).toContain("hypopg_14");
  });

  it("does not invent package commands on Windows", () => {
    const hint = buildHypopgInstallHint(parsePostgresServerProfile(WINDOWS_EDB));
    expect(hint.shellCommands).toEqual([]);
    expect(hint.note).toContain("hypopg.dll");
    expect(hint.sqlStatements).toEqual(["CREATE EXTENSION IF NOT EXISTS hypopg;"]);
  });

  it("offers a source build when the distribution is unknown", () => {
    const hint = buildHypopgInstallHint(parsePostgresServerProfile("PostgreSQL 12.0 on x86_64-pc-linux-musl"));
    expect(hint.platform).toBe("linux");
    expect(hint.shellCommands.some((command) => command.includes("git clone"))).toBe(true);
    expect(hint.shellCommands.some((command) => command.includes("make USE_PGXS=1 install"))).toBe(true);
  });
});

describe("parseHypopgProbe", () => {
  it("reads an installed extension from the probe rowset", () => {
    const probe = parseHypopgProbe({
      columns: ["version", "extension_version", "available_version", "is_superuser"],
      rows: [[UBUNTU_PGDG, "1.4.4", "1.4.4", "t"]],
    });
    expect(probe).toMatchObject({ available: true, installed: true, extensionVersion: "1.4.4", isSuperuser: true });
  });

  it("treats NULL extension_version as not installed", () => {
    const probe = parseHypopgProbe({
      columns: ["version", "extension_version", "available_version", "is_superuser"],
      rows: [[UBUNTU_PGDG, null, null, true]],
    });
    expect(probe).toMatchObject({ available: false, installed: false, isSuperuser: true });
  });

  it("treats NULL available_version as missing files", () => {
    const probe = parseHypopgProbe({
      columns: ["version", "extension_version", "available_version", "is_superuser"],
      rows: [[UBUNTU_PGDG, null, null, "f"]],
    });
    expect(probe.available).toBe(false);
    expect(probe.isSuperuser).toBe(false);
  });

  it("survives an empty rowset", () => {
    expect(parseHypopgProbe({ columns: [], rows: [] })).toEqual({ available: false, installed: false, isSuperuser: false });
    expect(parseHypopgProbe(undefined)).toEqual({ available: false, installed: false, isSuperuser: false });
  });
});

const BASE_PLAN = [
  {
    Plan: {
      "Node Type": "Hash Join",
      "Total Cost": 51234.5,
      Plans: [
        { "Node Type": "Seq Scan", "Relation Name": "qstest_oitw", "Total Cost": 48000 },
        { "Node Type": "Seq Scan", "Relation Name": "qstest_oitm", "Total Cost": 3234.5 },
      ],
    },
    "Execution Time": 636.1,
  },
];

function hypotheticalPlan(node: Record<string, unknown>, totalCost: number) {
  return [{ Plan: { "Node Type": "Hash Join", "Total Cost": totalCost, Plans: [node] }, "Planning Time": 0.8 }];
}

describe("compareHypotheticalPlan", () => {
  it("reports the hypothetical index as used when the OID token matches", () => {
    const plan = hypotheticalPlan({ "Node Type": "Index Only Scan", "Index Name": "<41072>hypo_btree_hypo_itementry", "Relation Name": "qstest_oitw", "Total Cost": 900 }, 2410.2);
    const comparison = compareHypotheticalPlan(BASE_PLAN, plan, ["<41072>btree_hypo_itementry"]);
    expect(comparison.used).toBe(true);
    expect(comparison.accessNodeTypes).toEqual(["Index Only Scan"]);
    expect(comparison.baseCost).toBe(51234.5);
    expect(comparison.hypotheticalCost).toBe(2410.2);
    expect(comparison.costDeltaPct?.toFixed(1)).toBe("-95.3");
  });

  it("reports not used when the planner kept the sequential scan", () => {
    const plan = hypotheticalPlan({ "Node Type": "Seq Scan", "Relation Name": "qstest_oitw", "Total Cost": 48000 }, 51234.5);
    const comparison = compareHypotheticalPlan(BASE_PLAN, plan, ["<41072>btree_hypo_itementry"]);
    expect(comparison.used).toBe(false);
    expect(comparison.usedIndexNames).toEqual([]);
    expect(comparison.costDeltaPct).toBe(0);
  });

  it("tolerates plans without a cost block", () => {
    const comparison = compareHypotheticalPlan(BASE_PLAN, [{ Plan: { "Node Type": "Result" } }], ["<1>btree"]);
    expect(comparison.hypotheticalCost).toBeUndefined();
    expect(comparison.costDeltaPct).toBeUndefined();
    expect(comparison.used).toBe(false);
  });
});

function suggestion(table: string, columns: string[], includeColumns: string[] = []): QueryIndexSuggestion {
  const include = includeColumns.length > 0 ? ` INCLUDE (${includeColumns.join(", ")})` : "";
  return { table, columns, includeColumns, sql: `CREATE INDEX ON ${table} (${columns.join(", ")})${include};`, reason: "test" };
}

describe("planHypopgTrials", () => {
  it("tests every suggestion together and then the leading ones individually", () => {
    const groups = planHypopgTrials([
      suggestion("qstest_oitw", ["itementry"], ["qty1"]),
      suggestion("qstest_oitm", ["docentry"], ["groupcode", "style"]),
      suggestion("qstest_oitm", ["groupcode"], ["docentry", "style"]),
      suggestion("qstest_oitg", ["groupcode"], ["groupname"]),
      suggestion("qstest_oitw", ["qty1"], ["itementry"]),
    ]);
    expect(groups.map((group) => group.id)).toEqual(["combined", "single-0", "single-1", "single-2"]);
    expect(groups[0]?.indexSqls).toHaveLength(5);
    // 尾部分号会破坏 hypopg 的语句解析，必须去掉。
    expect(groups[0]?.indexSqls.every((sql) => !sql.endsWith(";"))).toBe(true);
    expect(groups[1]?.title).toContain("qstest_oitw");
  });

  it("returns nothing when there is no suggestion", () => {
    expect(planHypopgTrials([])).toEqual([]);
  });
});

describe("hypotheticalIndexArgument", () => {
  it("wraps the DDL in a dollar-quoted argument", () => {
    expect(hypotheticalIndexArgument('CREATE INDEX ON "public"."t" ("a") INCLUDE ("b");')).toBe(`SELECT indexname FROM hypopg_create_index($$CREATE INDEX ON "public"."t" ("a") INCLUDE ("b")$$)`);
  });
});

describe("serverKeyForConnection", () => {
  it("keys the never-install decision by host and port", () => {
    expect(serverKeyForConnection({ id: "c1", host: "10.126.126.3", port: 5432 })).toBe("10.126.126.3:5432");
  });

  it("falls back to the connection id for hostless connections", () => {
    expect(serverKeyForConnection({ id: "c1", host: "  ", port: 0 })).toBe("c1");
  });
});
