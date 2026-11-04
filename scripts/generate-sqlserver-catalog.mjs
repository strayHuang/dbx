import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 生成 SQL Server 补全词表：
// - 函数清单来自 Microsoft Learn 的 T-SQL 函数目录（toc.json），签名从每个函数页的
//   `## Syntax` 代码块里抽取；
// - 关键字来自官方文档「Reserved Keywords (Transact-SQL)」（保留 + 未来关键字），
//   系统函数 `@@ROWCOUNT` 这类全局变量也一并收集。
// 用法：node scripts/generate-sqlserver-catalog.mjs
const TOC_URL = "https://learn.microsoft.com/en-us/sql/toc.json?view=sql-server-ver17";
const DOCS_RAW_BASE = "https://raw.githubusercontent.com/MicrosoftDocs/sql-docs/live/docs";
const RESERVED_KEYWORDS_PATH = "t-sql/language-elements/reserved-keywords-transact-sql.md";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repoRoot, "apps/desktop/src/lib/sql/sqlserver/catalog.generated.json");
const CONCURRENCY = 8;

async function fetchText(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "dbx-catalog-generator" } });
      if (!response.ok) throw new Error(`无法下载 ${url}：HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
    }
  }
  try {
    return execFileSync("curl", ["-sSfL", "--max-time", "120", url], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    throw lastError;
  }
}

function collectFunctionEntries(node, found) {
  if (Array.isArray(node)) {
    for (const item of node) collectFunctionEntries(item, found);
    return;
  }
  if (!node || typeof node !== "object") return;
  const href = typeof node.href === "string" ? node.href : "";
  if (href.includes("t-sql/functions/")) found.push({ title: (node.toc_title || "").trim(), href });
  for (const value of Object.values(node)) collectFunctionEntries(value, found);
}

function columnValues(markdown) {
  const values = [];
  for (const match of markdown.matchAll(/:::column:::\s*\n([\s\S]*?)\n\s*:::column-end:::/g)) {
    const value = match[1]
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (value) values.push(value);
  }
  return values;
}

function parseKeywords(markdown) {
  const sections = markdown.split(/\n##\s+/);
  const futureIndex = sections.findIndex((section) => section.startsWith("Future Keywords"));
  const reserved = columnValues(sections[0]);
  const future = futureIndex >= 0 ? columnValues(sections[futureIndex]) : [];
  return { reserved, future };
}

const CATEGORY_TITLES = new Set([
  "OVERVIEW",
  "ANALYTIC",
  "CRYPTOGRAPHIC",
  "CURSOR",
  "GRAPH",
  "MATHEMATICAL",
  "METADATA",
  "RANKING",
  "SECURITY",
  "SYSTEM",
  "TRIGGER",
  "VECTORS",
  "BIT MANIPULATION",
  "DATA TYPE",
  "DATE & TIME",
  "SYSTEM STATISTICAL",
]);

function parseFunctionEntries(entries) {
  const functions = new Map();
  const systemVariables = new Set();
  const keywords = new Set();
  const phrases = new Set();

  for (const { title, href } of entries) {
    const normalized = title.replace(/\s+/g, " ").trim();
    if (!normalized || CATEGORY_TITLES.has(normalized.toUpperCase())) continue;
    if (/^@@[A-Z0-9_]+$/.test(normalized)) {
      systemVariables.add(normalized);
      continue;
    }
    if (normalized === "NEXT VALUE FOR") {
      phrases.add("NEXT VALUE FOR");
      continue;
    }
    if (normalized === "IDENTITY (Function)") {
      keywords.add("IDENTITY");
      continue;
    }
    if (normalized === "CAST & CONVERT") {
      continue;
    }
    if (normalized === "OPENROWSET(BULK)") {
      functions.set("OPENROWSET", href);
      continue;
    }
    if (/^(?:<<|>>).*$/u.test(normalized)) continue;
    const collation = normalized.match(/^COLLATION\s*-\s*([A-Z0-9_]+)$/i);
    if (collation) {
      functions.set(collation[1].toUpperCase(), href);
      continue;
    }
    const call = normalized.match(/^([A-Z0-9_]+)\(\)$/);
    if (call) {
      functions.set(call[1], href);
      continue;
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) continue;
    functions.set(normalized, href);
  }

  return { functions, systemVariables, keywords, phrases };
}

function stripGroup(value) {
  let result = value;
  // 方括号可选组可能嵌套，反复剥离直到稳定。
  for (let round = 0; round < 3; round += 1) {
    const next = result.replace(/\[[^\]]*\]/g, " ");
    if (next === result) break;
    result = next;
  }
  return result
    .replace(/<[^>]+>/g, " ")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .replace(/\\/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,;:]+|[,;:]+$/g, "")
    .trim();
}

function cleanParameter(value) {
  let token = stripGroup(value);
  if (!token) return undefined;
  if (/\.\.\./.test(token)) return undefined;
  const from = token.match(/\bfrom\b\s+(.+)$/i);
  if (from) token = stripGroup(from[1]);
  if (!token) return undefined;
  if (token.length > 32) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_ ]*$/.test(token)) return undefined;
  return token.toLowerCase();
}

function splitArguments(inner, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const pattern = new RegExp(separator, "i");
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && pattern.test(inner.slice(index).slice(0, separator.length))) {
      parts.push(inner.slice(start, index));
      start = index + separator.length;
      index += separator.length - 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

function extractParameters(markdown, name) {
  const fences = [...markdown.matchAll(/```(?:syntaxsql|sql)?\n([\s\S]*?)```/g)].map((match) => match[1]);
  if (fences.length === 0) return [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b\\s*\\(`, "i");
  const block = fences.find((fence) => pattern.test(fence));
  if (!block) return [];

  const match = pattern.exec(block);
  const open = block.indexOf("(", match.index + match[0].length - 1);
  let depth = 0;
  let close = -1;
  for (let index = open; index < block.length; index += 1) {
    if (block[index] === "(") depth += 1;
    else if (block[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) return [];

  const inner = block.slice(open + 1, close);
  // CAST / TRY_CAST / PARSE 用 `expression AS data_type` 而不是逗号分隔。
  const isCastForm = /^(?:CAST|TRY_CAST|PARSE)$/i.test(name);
  const groups = isCastForm ? splitArguments(inner, " AS ") : splitArguments(inner, ",");
  const parameters = [];
  for (const group of groups) {
    const parameter = cleanParameter(group);
    if (parameter && !parameters.includes(parameter)) parameters.push(parameter);
  }
  return parameters.slice(0, 6);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

console.log("下载 SQL Server 函数目录 TOC…");
const toc = JSON.parse(await fetchText(TOC_URL));
const entries = [];
collectFunctionEntries(toc, entries);
const { functions, systemVariables, keywords: functionKeywords, phrases } = parseFunctionEntries(entries);
console.log(`目录条目 ${entries.length} 个，函数 ${functions.size} 个，系统变量 ${systemVariables.size} 个`);

const functionList = [...functions.entries()].map(([name, href]) => ({ name, href }));
let failures = 0;
const documentedFunctions = await mapLimit(functionList, CONCURRENCY, async ({ name, href }, index) => {
  if (index % 50 === 0) console.log(`  抓取函数页面 ${index}/${functionList.length}…`);
  try {
    const path = href.split("?")[0].split("#")[0].replace(/^\/+/, "");
    const markdown = await fetchText(`${DOCS_RAW_BASE}/${path}.md`);
    return { name, parameters: extractParameters(markdown, name) };
  } catch {
    failures += 1;
    return { name, parameters: [] };
  }
});
documentedFunctions.sort((left, right) => left.name.localeCompare(right.name));

let reservedKeywords = [];
try {
  const markdown = await fetchText(`${DOCS_RAW_BASE}/${RESERVED_KEYWORDS_PATH}`);
  reservedKeywords = parseKeywords(markdown);
} catch (error) {
  throw new Error(`无法下载保留关键字文档：${error.message}`);
}

const keywordSet = new Set();
// 只取「保留关键字」：文档里另有一份 273 项的 “Future Keywords”，其中包含 INTERVAL、
// HOST 这类 SQL Server 至今不支持的写法，放进补全反而会诱导写出非法 SQL。
for (const keyword of reservedKeywords.reserved) {
  if (/^[A-Z][A-Z0-9_]*$/.test(keyword)) keywordSet.add(keyword);
}
for (const keyword of functionKeywords) keywordSet.add(keyword);
const keywords = [...keywordSet].sort();

if (keywords.length < 150) throw new Error(`关键字数量异常：${keywords.length}`);
if (documentedFunctions.length < 250) throw new Error(`函数数量异常：${documentedFunctions.length}`);

const catalog = {
  source: TOC_URL,
  docsSource: `https://github.com/MicrosoftDocs/sql-docs/tree/live/docs`,
  generatedAt: new Date().toISOString(),
  license: "CC BY 4.0 (Microsoft Learn)",
  keywords,
  systemVariables: [...systemVariables].sort(),
  phrases: [...phrases].sort(),
  functions: documentedFunctions,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(catalog)}\n`, "utf8");
console.log(`写入 ${outputPath}`);
console.log(`关键字 ${keywords.length} 项，函数 ${documentedFunctions.length} 项（${documentedFunctions.filter((item) => item.parameters.length > 0).length} 项带签名，${failures} 页抓取失败）`);
