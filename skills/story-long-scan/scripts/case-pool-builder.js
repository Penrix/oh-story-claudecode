#!/usr/bin/env node
"use strict";

/**
 * 把 story-long-scan 产生的榜单 Markdown 汇总为 Seed 可用 Case 池。
 *
 * 榜单只承担“市场预筛”作用。最终 Case 只保留：
 *   - title
 *   - intro（完整简介，不摘要、不截断、不改写）
 *
 * 用法：
 *   node case-pool-builder.js --input ./scan-data --outdir ./case-pool
 *   node case-pool-builder.js --input ./scan-a --input ./scan-b --min-chars 80 --outdir ./case-pool
 */

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const inputs = [];
  let outdir = ".";
  let minChars = 80;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" && argv[i + 1]) {
      inputs.push(argv[++i]);
    } else if (arg.startsWith("--input=")) {
      inputs.push(arg.slice("--input=".length));
    } else if (arg === "--outdir" && argv[i + 1]) {
      outdir = argv[++i];
    } else if (arg.startsWith("--outdir=")) {
      outdir = arg.slice("--outdir=".length);
    } else if (arg === "--min-chars" && argv[i + 1]) {
      minChars = Number(argv[++i]);
    } else if (arg.startsWith("--min-chars=")) {
      minChars = Number(arg.slice("--min-chars=".length));
    }
  }

  if (!inputs.length) inputs.push(".");
  if (!Number.isFinite(minChars) || minChars < 1) {
    throw new Error("--min-chars 必须是正整数");
  }

  return { inputs, outdir, minChars: Math.floor(minChars) };
}

function collectMarkdownFiles(inputPath, out = []) {
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) {
    if (inputPath.toLowerCase().endsWith(".md")) out.push(inputPath);
    return out;
  }

  for (const name of fs.readdirSync(inputPath)) {
    const full = path.join(inputPath, name);
    const child = fs.statSync(full);
    if (child.isDirectory()) collectMarkdownFiles(full, out);
    else if (child.isFile() && name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

function normalizeTitle(title) {
  return String(title || "")
    .replace(/^《|》$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeIntro(raw) {
  return String(raw || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function contentLength(text) {
  return String(text || "").replace(/[\s\p{P}\p{S}]/gu, "").length;
}

function introBodyWithoutLeadingTags(text) {
  return String(text || "")
    .replace(/^(?:[【\[].{1,80}?[】\]]\s*)+/u, "")
    .trim();
}

function evaluateIntro(intro, minChars = 80) {
  const text = normalizeIntro(intro);
  if (!text) return { ok: false, reason: "empty" };
  if (/^(?:暂无|暂未|没有)(?:简介|介绍|内容)?[。.!！]?$/u.test(text)) {
    return { ok: false, reason: "placeholder" };
  }

  const body = introBodyWithoutLeadingTags(text);
  const chars = contentLength(body);
  if (chars < minChars) return { ok: false, reason: "short" };

  const sentenceCount = body
    .split(/[。！？!?；;]/u)
    .map((x) => x.trim())
    .filter(Boolean).length;

  // 防止“只有一句宣传语但碰巧比较长”。足够长的单句仍保留，避免误杀真实简介。
  if (sentenceCount < 2 && chars < Math.ceil(minChars * 1.6)) {
    return { ok: false, reason: "thin" };
  }

  return { ok: true, reason: "ok" };
}

function isUsefulIntro(intro, minChars = 80) {
  return evaluateIntro(intro, minChars).ok;
}

function extractCasesFromMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const cases = [];
  let currentTitle = "";
  let capture = false;
  let buffer = [];

  const flush = () => {
    if (!currentTitle || !capture) return;
    const intro = normalizeIntro(buffer.join("\n"));
    if (intro) cases.push({ title: normalizeTitle(currentTitle), intro });
    capture = false;
    buffer = [];
  };

  for (const line of lines) {
    const heading = line.match(/^#{2,4}\s+#\d+\s+(.+?)\s*$/u);
    if (heading) {
      flush();
      currentTitle = heading[1];
      capture = false;
      buffer = [];
      continue;
    }

    if (currentTitle && /^\*\*简介\*\*\s*$/u.test(line.trim())) {
      capture = true;
      buffer = [];
      continue;
    }

    if (capture) {
      if (/^---\s*$/u.test(line) || /^#{2,4}\s+#\d+\s+/u.test(line)) {
        flush();
        const nextHeading = line.match(/^#{2,4}\s+#\d+\s+(.+?)\s*$/u);
        if (nextHeading) currentTitle = nextHeading[1];
        continue;
      }
      buffer.push(line);
    }
  }

  flush();
  return cases;
}

function dedupeCases(cases) {
  const map = new Map();
  let duplicates = 0;

  for (const item of cases) {
    const title = normalizeTitle(item.title);
    const intro = normalizeIntro(item.intro);
    if (!title || !intro) continue;
    const key = title.replace(/[《》\s]/g, "").toLowerCase();
    const previous = map.get(key);
    if (!previous) {
      map.set(key, { title, intro });
      continue;
    }
    duplicates++;
    if (contentLength(intro) > contentLength(previous.intro)) {
      map.set(key, { title, intro });
    }
  }

  return { cases: [...map.values()], duplicates };
}

function renderCaseMarkdown(cases) {
  const lines = ["# 榜单数据", ""];
  for (const item of cases) {
    lines.push(`## 《${item.title}》`, "", item.intro, "", "---", "");
  }
  return lines.join("\n");
}

function buildCasePool(markdowns, minChars = 80) {
  const extracted = markdowns.flatMap(extractCasesFromMarkdown);
  const accepted = [];
  const rejected = { empty: 0, placeholder: 0, short: 0, thin: 0 };

  for (const item of extracted) {
    const verdict = evaluateIntro(item.intro, minChars);
    if (verdict.ok) accepted.push(item);
    else rejected[verdict.reason] = (rejected[verdict.reason] || 0) + 1;
  }

  const deduped = dedupeCases(accepted);
  return {
    cases: deduped.cases,
    stats: {
      extracted: extracted.length,
      acceptedBeforeDedupe: accepted.length,
      duplicates: deduped.duplicates,
      final: deduped.cases.length,
      rejected,
    },
  };
}

function main() {
  const { inputs, outdir, minChars } = parseArgs(process.argv.slice(2));
  const files = [...new Set(inputs.flatMap((p) => collectMarkdownFiles(path.resolve(p))))].sort();
  if (!files.length) throw new Error("没有找到可汇总的 Markdown 榜单文件");

  const markdowns = files.map((file) => fs.readFileSync(file, "utf8"));
  const result = buildCasePool(markdowns, minChars);

  fs.mkdirSync(outdir, { recursive: true });
  const mdPath = path.join(outdir, "榜单数据.md");
  const jsonlPath = path.join(outdir, "榜单数据.jsonl");

  fs.writeFileSync(mdPath, renderCaseMarkdown(result.cases), "utf8");
  fs.writeFileSync(
    jsonlPath,
    result.cases.map((item) => JSON.stringify(item)).join("\n") + (result.cases.length ? "\n" : ""),
    "utf8"
  );

  const s = result.stats;
  console.log(`候选简介：${s.extracted}`);
  console.log(`通过内容过滤：${s.acceptedBeforeDedupe}`);
  console.log(`去重：${s.duplicates}`);
  console.log(`最终 Case：${s.final}`);
  console.log(
    `淘汰：empty=${s.rejected.empty || 0}, placeholder=${s.rejected.placeholder || 0}, short=${s.rejected.short || 0}, thin=${s.rejected.thin || 0}`
  );
  console.log(`已写入：${mdPath}`);
  console.log(`已写入：${jsonlPath}`);

  if (!result.cases.length) process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`case pool build failed: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  normalizeTitle,
  normalizeIntro,
  contentLength,
  evaluateIntro,
  isUsefulIntro,
  extractCasesFromMarkdown,
  dedupeCases,
  renderCaseMarkdown,
  buildCasePool,
};
