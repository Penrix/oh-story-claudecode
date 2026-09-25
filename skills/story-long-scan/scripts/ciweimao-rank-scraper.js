#!/usr/bin/env node
/**
 * 刺猬猫阅读排行榜采集脚本
 *
 * 配合 browser-cdp skill 使用。先启动 Chrome CDP 环境，再运行本脚本。
 * 采集策略：
 *   1. 从 rank-index 榜单页解析书名、排名和作品链接；
 *   2. 对榜单作品去重后进入公开 MIP 详情页，提取真实完整简介与平台分类；
 *   3. 明确属于“女频”的作品不写入原始 Case；
 *   4. 最终简介仍交给统一 Case Builder 做“至少两句 + 最小有效内容长度”过滤。
 * 输出 Markdown 格式匹配 scan-output-format.md 规范。
 *
 * 用法：
 *   node ciweimao-rank-scraper.js --type click       # 点击榜
 *   node ciweimao-rank-scraper.js --type monthly      # 月票榜
 *   node ciweimao-rank-scraper.js --type all           # 全部榜单
 *
 * 前置：
 *   node {SKILL_DIR}/browser-cdp/scripts/setup-cdp-chrome.js 9222
 */

const fs = require("fs");
const path = require("path");
const { ab, sleep, evalJSONBase64, scrollLoad, getArg, localDateStamp, runCli } = require("./cdp-utils");

const RANK_URL = "https://www.ciweimao.com/rank-index";
const MIP_BOOK_BASE = "https://mip.ciweimao.com/book/";
const DETAIL_SLEEP_MS = 650;

/** 连通性 + 页面就绪自检 */
function probePage(port) {
  return evalJSONBase64(
    port,
    "JSON.stringify({host:location.host,len:(document.body&&document.body.innerText||'').length})"
  );
}

const RANK_TYPES = [
  { id: "click", label: "点击榜", header: "点击榜" },
  { id: "favor", label: "收藏榜", header: "收藏榜" },
  { id: "recommend", label: "推荐榜", header: "推荐榜" },
  { id: "subscribe", label: "订阅榜", header: "订阅榜" },
  { id: "monthly", label: "月票榜", header: "月票榜" },
  { id: "tsukkomi", label: "吐槽榜", header: "吐槽榜" },
  { id: "newbook", label: "新书榜", header: "新书榜" },
  { id: "blade", label: "刀片榜", header: "刀片榜" },
  { id: "update", label: "更新榜", header: "更新榜" },
];

// ---------------------------------------------------------------------------
// 页面提取
// ---------------------------------------------------------------------------

/**
 * 从 rank-index 单页解析所有榜单。
 * 页面结构：每个榜单有标题行（如"点击榜"），后跟 NO.1 特殊条目 + #2-10 普通条目。
 * NO.1 格式：标题 / 作者 / 指标值（三行）
 * #2-10 格式：N[题材]书名 / 指标值（两行）
 */
function extractAllRanks(port) {
  const js =
    "JSON.stringify((()=>{" +
    "var text=document.body.innerText||'';" +
    "var lines=text.split(/\\n/).map(function(l){return l.trim()}).filter(Boolean);" +
    "var headers=['点击榜','收藏榜','推荐榜','订阅榜','月票榜','吐槽榜','新书榜','刀片榜','更新榜'];" +
    "var sections=[];var curName='';var curEntries=[];" +
    "for(var i=0;i<lines.length;i++){" +
    "  var line=lines[i];" +
    // 检测新 section
    "  var headerIdx=headers.indexOf(line);" +
    "  if(headerIdx>=0){" +
    "    if(curName&&curEntries.length)sections.push({name:curName,entries:curEntries});" +
    "    curName=headers[headerIdx];curEntries=[];continue" +
    "  }" +
    "  if(!curName)continue;" +
    // 跳过周期 tab 和 UI 文字
    "  if(/^(周榜|月榜|总榜)$/.test(line))continue;" +
    // NO.1 条目
    "  if(line==='NO.1'&&i+3<lines.length){" +
    "    var t=lines[i+1]||'';var a=lines[i+2]||'';var v=lines[i+3]||'';" +
    "    if(headers.indexOf(v)>=0)continue;" +
    "    curEntries.push({rank:1,title:t,author:a,genre:'',metric:v});" +
    "    i+=2;continue" +
    "  }" +
    // #2-10 条目：N[题材]书名
    "  var rm=line.match(/^(\\d{1,2})\\[(.+?)\\](.+)$/);" +
    "  if(rm){" +
    "    var nextVal=i+1<lines.length?lines[i+1]:'';" +
    "    var metric='';" +
    "    if(/^[\\d.]+(万)?$/.test(nextVal)){metric=nextVal;i++}" +
    "    curEntries.push({rank:parseInt(rm[1]),title:rm[3],author:'',genre:rm[2],metric:metric});" +
    "    continue" +
    "  }" +
    "}" +
    "if(curName&&curEntries.length)sections.push({name:curName,entries:curEntries});" +
    "return sections" +
    "})())";
  return evalJSONBase64(port, js) || [];
}

/**
 * 从 DOM 获取书籍链接。每本书常有封面图 anchor（textContent 为空）和书名 anchor，
 * 按 bookId 聚合后取最长的非空文本作为书名，避免空封面 anchor 覆盖书名导致回填全失败。
 */
function extractBookUrls(port) {
  const js = `JSON.stringify((function(){
    function clean(t){return t.replace(/^[0-9]+\\[[^\\]]*\\]/,'').replace(/\\s+[0-9.]+(?:万|亿)?$/,'').trim();}
    var byId={};var order=[];
    Array.from(document.querySelectorAll('a[href*="/book/"]')).forEach(function(a){
      var h=a.getAttribute('href')||a.href||'';
      var m=h.match(/\\/book\\/([0-9]+)/);
      if(!m)return; var id=m[1];
      var t=clean((a.innerText||a.textContent||'').replace(/\\s+/g,' ').trim());
      if(!byId[id]){byId[id]='';order.push(id);}
      if(t&&t.length>byId[id].length)byId[id]=t;
    });
    return order.map(function(id){return {bookId:id,title:byId[id],url:'https://www.ciweimao.com/book/'+id};});
  })())`;
  return evalJSONBase64(port, js) || [];
}

/**
 * MIP 详情页是公开静态页，正文文本大致为：
 *   书名
 *   作者 著 / 分类
 *   字数 / 状态
 *   更新...
 *   立即阅读 / 放入书架
 *   月票 / 推荐票 / 打赏 / 刀片
 *   <完整简介>
 *   作品目录
 *
 * 这里故意按稳定的语义边界“最后一个榜单指标 -> 作品目录”切简介，
 * 而不是依赖容易变化的 CSS class。
 */
function parseMIPDetailText(raw, fallbackTitle = "") {
  const lines = String(raw || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const title = String(fallbackTitle || lines[0] || "").trim();
  let author = "";
  let category = "";

  for (const line of lines.slice(0, 12)) {
    const m = line.match(/^(.+?)\s+著\s*\/\s*(.+)$/u);
    if (m) {
      author = m[1].trim();
      category = m[2].trim();
      break;
    }
  }

  let end = lines.findIndex((line) => /^作品目录$/u.test(line));
  if (end < 0) end = lines.findIndex((line) => line.includes("作品目录"));
  if (end < 0) end = lines.length;

  let start = -1;
  for (let i = 0; i < end; i++) {
    if (/^(?:[\d.]+(?:万|亿)?\s*)?(?:月票|推荐票|次打赏|刀片)$/u.test(lines[i])) {
      start = i + 1;
    }
  }

  if (start < 0) {
    const shelf = lines.findIndex((line) => /放入书架|立即阅读/u.test(line));
    if (shelf >= 0) start = shelf + 1;
  }

  if (start < 0 || start >= end) {
    return { title, author, category, desc: "" };
  }

  const desc = lines
    .slice(start, end)
    .filter(
      (line) =>
        !/^(?:[\d.]+(?:万|亿)?\s*)?(?:月票|推荐票|次打赏|刀片)$/u.test(line) &&
        !/^(?:立即阅读|放入书架)$/u.test(line)
    )
    .join("\n")
    .trim();

  return { title, author, category, desc };
}

function isAllowedCategory(category) {
  const normalized = String(category || "").replace(/\s+/g, "").trim();
  if (!normalized) return false;
  return !/(?:女频|女生|女性)/u.test(normalized);
}

function buildMIPPageTextJS() {
  return `JSON.stringify({
    host: location.host,
    text: (document.body && document.body.innerText || "")
  })`;
}

function fetchMIPDetails(port, books) {
  const details = new Map();

  for (let i = 0; i < books.length; i++) {
    const item = books[i];
    const id = String(item.bookId || "").trim();
    if (!id || details.has(id)) continue;

    const url = `${MIP_BOOK_BASE}${id}`;
    try {
      ab(port, "open", url);
      sleep(DETAIL_SLEEP_MS);
      const page = evalJSONBase64(port, buildMIPPageTextJS()) || {};
      if (!String(page.host || "").includes("ciweimao.com")) {
        console.error(`  [刺猬猫详情] ${id} 被重定向到 ${page.host || "unknown"}，跳过`);
        continue;
      }
      const detail = parseMIPDetailText(page.text, item.title);
      details.set(id, { ...detail, url: item.url || `https://www.ciweimao.com/book/${id}` });
    } catch (error) {
      console.error(
        `  [刺猬猫详情 ${i + 1}/${books.length}] ${item.title || id} 失败：${error && error.message ? error.message : error}`
      );
    }
  }

  return details;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const PORT = parseInt(getArg(args, "--port") || "9222", 10);
const OUTDIR = getArg(args, "--outdir") || ".";
const RANKTYPE = getArg(args, "--type") || "all";

function main() {
  console.log("\n→ 采集 刺猬猫排行榜...");
  console.log(`  URL: ${RANK_URL}`);

  let sections, urls;
  try {
    ab(PORT, "open", RANK_URL);
    sleep(4000);

    const probe = probePage(PORT);
    if (!probe) {
      console.error(
        `  ✗ CDP 无响应。请确认已用 browser-cdp 启动 Chrome（端口 ${PORT}），且 agent-browser 可用。`
      );
      return 0;
    }
    if (probe.host && probe.host.indexOf("ciweimao") === -1) {
      console.error(`  ✗ 当前页面非刺猬猫（host=${probe.host}），可能被重定向，已跳过。`);
      return 0;
    }

    scrollLoad(PORT, 3);
    sleep(1000);

    sections = extractAllRanks(PORT);
    if (!sections.length) {
      scrollLoad(PORT, 2);
      sleep(1000);
      sections = extractAllRanks(PORT);
    }
    if (!sections.length) {
      console.error("[ciweimao] 采集失败：未解析到榜单（页面结构可能变动或未加载）。请人工打开榜单页确认。");
      return 0;
    }

    urls = extractBookUrls(PORT);
  } catch (err) {
    console.error(`[ciweimao] 采集失败（页面加载或提取阶段）: ${err.message}`);
    return 0;
  }

  console.log(`  ✓ 提取 ${sections.length} 个榜单，${urls.length} 个书籍链接`);

  const targetTypes =
    RANKTYPE === "all"
      ? RANK_TYPES
      : RANK_TYPES.filter((r) => r.id === RANKTYPE);

  if (!targetTypes.length) {
    throw new Error(`未知 --type: ${RANKTYPE}`);
  }

  const norm = (value) => String(value || "").replace(/\s+/g, "");
  const targetEntries = [];
  const seenIds = new Set();
  let unmatchedRankEntries = 0;

  for (const rt of targetTypes) {
    const section = sections.find((item) => item.name === rt.header);
    if (!section) continue;
    for (const entry of section.entries) {
      const matched = urls.find((item) => norm(item.title) === norm(entry.title));
      if (!matched || !matched.bookId) {
        unmatchedRankEntries++;
        continue;
      }
      if (seenIds.has(String(matched.bookId))) continue;
      seenIds.add(String(matched.bookId));
      targetEntries.push({
        bookId: String(matched.bookId),
        title: entry.title || matched.title,
        url: matched.url,
      });
    }
  }

  console.log(`→ 补抓 ${targetEntries.length} 本去重榜单作品的公开 MIP 完整简介...`);
  const details = fetchMIPDetails(PORT, targetEntries);
  const introCount = [...details.values()].filter((d) => d.desc).length;
  const categoryKnownCount = [...details.values()].filter(
    (d) => String(d.category || "").trim()
  ).length;
  const categoryUnknownCount = details.size - categoryKnownCount;
  const femaleCount = [...details.values()].filter((d) =>
    /(?:女频|女生|女性)/u.test(String(d.category || "").replace(/\s+/g, ""))
  ).length;
  console.log(
    `  ✓ 详情成功 ${details.size}/${targetEntries.length}；有简介 ${introCount}；分类已识别 ${categoryKnownCount}；分类未知 ${categoryUnknownCount}；剔除女频 ${femaleCount}`
  );

  let written = 0;
  let failed = 0;
  const partialReasons = [];

  if (unmatchedRankEntries > 0) {
    partialReasons.push(`rank entries without book ids: ${unmatchedRankEntries}`);
  }
  if (details.size < targetEntries.length) {
    partialReasons.push(`detail fetch incomplete: ${details.size}/${targetEntries.length}`);
  }
  if (categoryUnknownCount > 0) {
    partialReasons.push(`unknown categories: ${categoryUnknownCount}`);
  }
  if (introCount < details.size) {
    partialReasons.push(`missing intros after detail fetch: ${details.size - introCount}`);
  }

  for (const rt of targetTypes) {
    try {
      const section = sections.find((item) => item.name === rt.header);
      if (!section || !section.entries.length) {
        failed++;
        partialReasons.push(`${rt.label}: no rank data`);
        console.log(`  ⚠ ${rt.label} 无数据，跳过`);
        continue;
      }

      const rows = [];
      for (const entry of section.entries) {
        const matched = urls.find((item) => norm(item.title) === norm(entry.title));
        if (!matched) continue;
        const detail = details.get(String(matched.bookId));
        if (!detail || !detail.desc || !isAllowedCategory(detail.category)) continue;

        rows.push({
          ...entry,
          title: detail.title || entry.title,
          author: detail.author || entry.author,
          genre: detail.category || entry.genre,
          url: detail.url || matched.url,
          desc: detail.desc,
        });
      }

      if (!rows.length) {
        failed++;
        partialReasons.push(`${rt.label}: no admissible full intros`);
        console.log(`  ⚠ ${rt.label} 没有拿到非女频完整简介，跳过输出`);
        continue;
      }

      const now = new Date().toISOString();
      const lines = [
        `# 刺猬猫 · ${rt.label}`,
        "",
        `- 来源：${RANK_URL}`,
        `- 抓取时间：${now}`,
        `- 原榜条目：${section.entries.length}`,
        `- 可用非女频简介：${rows.length}`,
        "",
        "---",
        "",
      ];

      for (const entry of rows) {
        lines.push(`### #${entry.rank} ${entry.title}`);
        const meta = [entry.author, entry.genre, entry.metric || ""]
          .filter(Boolean)
          .join(" · ");
        if (meta) lines.push(`*${meta}*`);
        if (entry.url) lines.push(`[作品页](${entry.url})`);
        lines.push("", "**简介**", "", entry.desc, "", "---", "");
      }

      const filename = `刺猬猫${rt.label}_${localDateStamp()}.md`;
      fs.mkdirSync(OUTDIR, { recursive: true });
      const filepath = path.join(OUTDIR, filename);
      fs.writeFileSync(filepath, lines.join("\n"), "utf-8");
      written++;
      console.log(`  ✓ ${rt.label}：${rows.length} 本完整简介 → ${filepath}`);
    } catch (rankErr) {
      failed++;
      const message = rankErr && rankErr.message ? rankErr.message : String(rankErr);
      partialReasons.push(`${rt.label}: ${message}`);
      console.error(`[ciweimao] ${rt.label} 处理出错，跳过: ${message}`);
    }
  }

  return {
    planned: targetTypes.length,
    written,
    failed,
    partial: failed > 0 || partialReasons.length > 0,
    partialReasons,
  };
}

if (require.main === module) {
  runCli(main, "刺猬猫采集");
}

module.exports = {
  extractAllRanks,
  extractBookUrls,
  parseMIPDetailText,
  isAllowedCategory,
  buildMIPPageTextJS,
};
