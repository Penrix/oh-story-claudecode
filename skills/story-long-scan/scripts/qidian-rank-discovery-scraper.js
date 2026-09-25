#!/usr/bin/env node
"use strict";

/**
 * 起点排行榜动态补充采集。
 *
 * 固定移动端 SSR 入口负责“即使浏览器挂了也有数据”；本脚本在 CDP 可用时读取起点当前
 * 排行榜首页实际链接，自动补充固定列表没有覆盖的新榜单，并顺着分页多抓几页。
 *
 * 这样新增/改名榜单不需要等我们手工更新常量，同时明确排除女生/女频入口。
 */

const fs = require("fs");
const path = require("path");
const {
  ab,
  sleep,
  evalJSONBase64,
  scrollLoad,
  getArg,
  localDateStamp,
  runCli,
} = require("./cdp-utils");
const qidian = require("./qidian-rank-scraper");

const RANK_HOME = "https://www.qidian.com/rank/";

const KNOWN_LABELS = {
  yuepiao: "月票榜",
  hotsales: "畅销榜",
  retention: "留存榜",
  readindex: "阅读指数榜",
  newfans: "书友榜",
  recom: "推荐榜",
  rec: "推荐榜",
  zhuiread: "追读榜",
  follow: "追读榜",
  collect: "收藏榜",
  vipup: "更新榜",
  vipcollect: "VIP收藏榜",
  signnewbook: "签约作者新书榜",
  sign: "签约作者新书榜",
  pubnewbook: "公众作者新书榜",
  newbook: "公众作者新书榜",
  newsign: "新人签约新书榜",
  newauthor: "新人作者新书榜",
};

function buildRankDiscoveryJS() {
  return `JSON.stringify(Array.from(document.querySelectorAll('a[href]')).map(function(a){
    return {
      text:(a.innerText||a.textContent||'').replace(/\\s+/g,' ').trim(),
      href:a.getAttribute('href')||a.href||''
    };
  }))`;
}

function cleanLabel(text, slug) {
  if (KNOWN_LABELS[slug]) return KNOWN_LABELS[slug];
  const compact = String(text || "")
    .replace(/\s+/g, "")
    .replace(/更多/g, "")
    .replace(/[]/g, "")
    .trim();
  const m = compact.match(/([A-Za-z0-9\u4e00-\u9fff·]+榜)/u);
  return (m ? m[1] : compact || slug).slice(0, 40);
}

function normalizeDiscoveredRankLinks(rows) {
  const map = new Map();

  for (const raw of Array.isArray(rows) ? rows : []) {
    let url;
    try {
      url = new URL(String(raw && raw.href || ""), RANK_HOME);
    } catch {
      continue;
    }

    if (!/(^|\.)qidian\.com$/i.test(url.hostname)) continue;

    const pathName = url.pathname.replace(/\/+/g, "/");
    if (/\/(?:female|girl|lady)(?:\/|$)/i.test(pathName)) continue;
    if (/女生|女频|女性向/u.test(String(raw && raw.text || ""))) continue;

    if (pathName === "/sanjiang/" || pathName === "/sanjiang") {
      map.set("sanjiang", {
        id: "sanjiang",
        label: "三江推荐",
        url: "https://www.qidian.com/sanjiang/",
      });
      continue;
    }

    const m = pathName.match(/^\/rank\/([^/]+)(?:\/|$)/i);
    if (!m) continue;
    const slug = m[1].toLowerCase();
    if (!slug || /female|girl|lady/i.test(slug)) continue;

    const label = cleanLabel(raw && raw.text, slug);
    if (!/榜/u.test(label)) continue;

    map.set(slug, {
      id: slug,
      label,
      url: `https://www.qidian.com/rank/${slug}/`,
    });
  }

  return [...map.values()];
}

function buildPaginationDiscoveryJS(rootPath) {
  return `JSON.stringify(Array.from(document.querySelectorAll('a[href]')).map(function(a){
    var href=a.getAttribute('href')||a.href||'';
    return {text:(a.innerText||a.textContent||'').trim(),href:href};
  }).filter(function(x){
    try{
      var u=new URL(x.href,location.href);
      return u.hostname==='www.qidian.com' && u.pathname.indexOf(${JSON.stringify(rootPath)})===0;
    }catch(e){return false;}
  }))`;
}

function pageNumberFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/(?:^|\/)page(\d+)(?:\/|$)/i);
    if (m) return Number(m[1]);
    const q = Number(u.searchParams.get("page"));
    if (Number.isInteger(q) && q > 0) return q;
  } catch {}
  return 1;
}

function normalizePageUrls(rows, rootUrl, maxPages) {
  const root = new URL(rootUrl);
  const rootPath = root.pathname.endsWith("/") ? root.pathname : root.pathname + "/";
  const map = new Map([[1, rootUrl]]);

  for (const raw of Array.isArray(rows) ? rows : []) {
    try {
      const u = new URL(String(raw && raw.href || ""), rootUrl);
      if (u.hostname !== "www.qidian.com") continue;
      if (!u.pathname.startsWith(rootPath)) continue;
      const page = pageNumberFromUrl(u.toString());
      if (!Number.isInteger(page) || page < 2 || page > maxPages) continue;
      map.set(page, u.toString());
    } catch {}
  }

  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, maxPages)
    .map(([, url]) => url);
}

function safeFilename(label) {
  return String(label || "未知榜")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "")
    .slice(0, 50);
}

function probePage(port) {
  return evalJSONBase64(
    port,
    "JSON.stringify({host:location.host,text:(document.body&&document.body.innerText||'').slice(0,1000)})"
  );
}

function looksBlocked(probe) {
  if (!probe || !String(probe.host || "").includes("qidian.com")) return true;
  return /验证码|安全验证|人机验证|异常请求|访问验证|操作频繁|waf|请稍后再试/i.test(
    String(probe.text || "")
  );
}

function openRankPage(port, url) {
  ab(port, "open", url);
  sleep(2600);
  const probe = probePage(port);
  if (looksBlocked(probe)) return false;
  scrollLoad(port, 2);
  sleep(500);
  return true;
}

function dedupeBooks(items) {
  const map = new Map();
  for (const book of items) {
    const key = String(book.url || book.title || "").replace(/\s+/g, "").toLowerCase();
    if (!key || map.has(key)) continue;
    map.set(key, { ...book, rank: map.size + 1 });
  }
  return [...map.values()];
}

async function main() {
  const args = process.argv.slice(2);
  const port = parseInt(getArg(args, "--port") || "9222", 10);
  const outdir = getArg(args, "--outdir") || ".";
  const maxPages = Math.max(1, Math.min(10, parseInt(getArg(args, "--pages") || "5", 10)));

  if (!openRankPage(port, RANK_HOME)) {
    throw new Error("起点排行榜首页不可用或被安全验证拦截");
  }

  const rawLinks = evalJSONBase64(port, buildRankDiscoveryJS()) || [];
  const targets = normalizeDiscoveredRankLinks(rawLinks);
  if (!targets.length) {
    throw new Error("排行榜首页没有解析出可用的非女频榜单链接");
  }

  console.log(`→ 动态发现 ${targets.length} 个起点非女频榜单；每榜最多 ${maxPages} 页`);

  let written = 0;
  let failed = 0;
  const partialReasons = [];

  for (let ti = 0; ti < targets.length; ti++) {
    const target = targets[ti];
    try {
      console.log(`  [${ti + 1}/${targets.length}] ${target.label} ${target.url}`);
      if (!openRankPage(port, target.url)) {
        throw new Error("榜单首页不可用或被拦截");
      }

      const rootPath = new URL(target.url).pathname;
      const rawPages = evalJSONBase64(port, buildPaginationDiscoveryJS(rootPath)) || [];
      const pageUrls = normalizePageUrls(rawPages, target.url, maxPages);
      const allBooks = [];

      for (let pi = 0; pi < pageUrls.length; pi++) {
        const pageUrl = pageUrls[pi];
        if (pi > 0 && !openRankPage(port, pageUrl)) {
          console.log(`    ⚠ 第 ${pi + 1} 页不可用，跳过`);
          continue;
        }
        const books = qidian.extractBookList(port);
        if (Array.isArray(books) && books.length) {
          allBooks.push(...books);
          console.log(`    ✓ 第 ${pi + 1} 页 ${books.length} 本`);
        }
      }

      const books = dedupeBooks(allBooks);
      if (!books.length) throw new Error("没有解析到作品");

      const markdown = qidian.renderMarkdown(
        { label: `动态补充·${target.label}` },
        books,
        target.url,
        "cdp-discovered",
        [
          `- 动态发现：来自 ${RANK_HOME}`,
          `- 实际抓取页数：${pageUrls.length}`,
          "- 过滤：女生/女频入口不进入动态榜单集",
        ]
      );

      fs.mkdirSync(outdir, { recursive: true });
      const filepath = path.join(
        outdir,
        `起点动态补充_${safeFilename(target.label)}_${localDateStamp()}.md`
      );
      fs.writeFileSync(filepath, markdown, "utf8");
      written++;
      console.log(`    ✓ 合并去重 ${books.length} 本 → ${filepath}`);
    } catch (error) {
      failed++;
      const message = error && error.message ? error.message : String(error);
      partialReasons.push(`${target.label}: ${message}`);
      console.error(`  [qidian-discovery] ${target.label} 失败：${message}`);
    }
  }

  return {
    planned: targets.length,
    written,
    failed,
    partial: failed > 0,
    partialReasons,
  };
}

if (require.main === module) {
  runCli(main, "起点动态榜单补充");
}

module.exports = {
  KNOWN_LABELS,
  buildRankDiscoveryJS,
  cleanLabel,
  normalizeDiscoveredRankLinks,
  buildPaginationDiscoveryJS,
  pageNumberFromUrl,
  normalizePageUrls,
  safeFilename,
  looksBlocked,
  dedupeBooks,
};
