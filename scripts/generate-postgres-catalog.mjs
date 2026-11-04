import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 生成 PostgreSQL 18 的补全词表：
// - 关键字来自 src/include/parser/kwlist.h（官方解析器的完整关键字表）
// - 函数来自 doc/src/sgml/func.sgml（官方文档中带签名的函数清单）
// 用法：node scripts/generate-postgres-catalog.mjs [git-ref]
const DEFAULT_REF = "REL_18_STABLE";
const rawBase = (ref) => `https://raw.githubusercontent.com/postgres/postgres/${ref}`;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repoRoot, "apps/desktop/src/lib/sql/postgres/catalog.generated.json");

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
  // 部分代理环境会中断 undici 连接，退回 curl 更稳。
  try {
    return execFileSync("curl", ["-sSfL", "--max-time", "120", url], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    throw lastError;
  }
}

function parseKeywords(source) {
  const keywords = new Set();
  for (const match of source.matchAll(/PG_KEYWORD\("([^"]+)"\s*,\s*[A-Z_0-9]+\s*,\s*([A-Z_]+)/g)) {
    const name = match[1].trim();
    // 关键字表里只有单词条目；多词短语由 catalog.ts 手工维护。
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    keywords.add(name.toUpperCase());
  }
  return [...keywords].sort();
}

const FUNCTION_SKIP = new Set([
  "ANY",
  "ARRAY",
  "CAST",
  "EXISTS",
  "ILIKE",
  "LIKE",
  "NOT",
  "ROW",
  "SIMILAR",
  "SOME",
  "COLLATION",
]);

function normalizeFunctionName(raw) {
  let name = raw.replace(/\s+/g, " ").trim();
  if (!name) return undefined;
  name = name.replace(/^pg_catalog\./i, "");
  name = name.replace(/\(.*$/, "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  const upper = name.toUpperCase();
  if (FUNCTION_SKIP.has(upper)) return undefined;
  return upper;
}

function tagsOf(group, tag) {
  return [...group.matchAll(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "g"))].map((match) => match[1].trim()).filter(Boolean);
}

function cleanParameter(group) {
  // 一个参数条目通常写成 `<replaceable>field</replaceable> <type>text</type>`，
  // 参数名优先于类型名，两者都没有时才退回纯文本。
  const named = tagsOf(group, "replaceable").concat(tagsOf(group, "parameter"));
  const typed = tagsOf(group, "type");
  const raw = named.length > 0 ? named.join(" ") : typed.length > 0 ? typed.join(" ") : group.replace(/<[^>]*>/g, " ");
  const value = raw.replace(/\s+/g, " ").trim();
  if (!value) return undefined;
  if (value.length > 32) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_ ]*$/.test(value)) return undefined;
  return value.toLowerCase();
}

function extractParameters(source, offset) {
  let index = offset;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (source[index] !== "(") return [];
  let depth = 0;
  let end = index;
  for (; end < source.length; end += 1) {
    if (source[end] === "(") depth += 1;
    else if (source[end] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const inner = source.slice(index + 1, end);
  if (inner.length > 240) return [];

  const parameters = [];
  let groupDepth = 0;
  let start = 0;
  const flush = (stop) => {
    const parameter = cleanParameter(inner.slice(start, stop));
    if (parameter) parameters.push(parameter);
    start = stop + 1;
  };
  for (let cursor = 0; cursor < inner.length; cursor += 1) {
    const character = inner[cursor];
    if (character === "(" || character === "[") groupDepth += 1;
    else if (character === ")" || character === "]") groupDepth = Math.max(0, groupDepth - 1);
    else if (character === "," && groupDepth === 0) flush(cursor);
  }
  flush(inner.length);
  return parameters.slice(0, 6);
}

function parseFunctions(source) {
  const starts = [];
  const parenthesized = new Set();
  for (const match of source.matchAll(/<function>\s*([^<]+?)\s*<\/function>/g)) {
    const name = normalizeFunctionName(match[1]);
    if (!name) continue;
    const offset = match.index + match[0].length;
    starts.push({ name, offset });
    // 只有在文档里以 `func(...)` 形式出现过的名字才算真正的函数。
    // 例如 COALESCE 章节正文里提到的 NVL / IFNULL 属于别的数据库，必须排除。
    if (/^\s*\(/.test(source.slice(offset, offset + 8))) parenthesized.add(name);
  }

  const byName = new Map();
  const score = (parameters) => (parameters.length > 0 ? 1 : 0) + (parameters.some((parameter) => parameter.startsWith("any")) ? 2 : 0);
  for (const { name, offset } of starts) {
    if (!parenthesized.has(name)) continue;
    const parameters = extractParameters(source, offset);
    const current = byName.get(name);
    // 文档中同名函数会出现多次（说明文字、不同重载）。优先保留带参数、且参数是
    // 泛化类型（anyarray/anyelement…）的条目，避免拿到 tsvector 这类窄重载。
    if (!current || score(parameters) > score(current.parameters)) byName.set(name, { parameters });
  }

  return [...byName.entries()]
    .map(([name, entry]) => ({ name, parameters: entry.parameters }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

const ref = process.argv[2] || DEFAULT_REF;
console.log(`下载 PostgreSQL 词表：${ref}`);
const [keywordSource, functionsSource] = await Promise.all([
  fetchText(`${rawBase(ref)}/src/include/parser/kwlist.h`),
  fetchText(`${rawBase(ref)}/doc/src/sgml/func.sgml`),
]);

const keywords = parseKeywords(keywordSource);
const functions = parseFunctions(functionsSource);
if (keywords.length < 400) throw new Error(`关键字数量异常：${keywords.length}`);
if (functions.length < 400) throw new Error(`函数数量异常：${functions.length}`);

const catalog = {
  source: `https://github.com/postgres/postgres/tree/${ref}`,
  ref,
  generatedAt: new Date().toISOString(),
  license: "PostgreSQL License",
  keywords,
  functions,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(catalog)}\n`, "utf8");
console.log(`写入 ${outputPath}`);
console.log(`关键字 ${keywords.length} 项，函数 ${functions.length} 项`);
