#!/usr/bin/env node
/**
 * 起点关联书单采集器
 *
 * 目的不是把“书单”当成新的排行榜，而是：
 *   已上榜作品（市场过滤锚点）
 *   -> 作品页“包含本书的书单”
 *   -> 真实读者书单
 *   -> 书单里的其他作品
 *   -> 完整书名 + 完整简介
 *
 * 这样新书/老书不再是维度；只要它通过“榜单锚点 -> 真实书单”的关系进入池子，
 * 就作为 Seed Case 候选，最终仍由 case-pool-builder 做简介可用性过滤和全池去重。
 *
 * 用法：
 *   node qidian-booklist-scraper.js --input .case-raw --outdir .case-raw
 *   node qidian-booklist-scraper.js --input .case-raw --anchors 30 --lists 60 --books 600
 *
 * 前置：
 *   node ../../browser-cdp/scripts/setup-cdp-chrome.js 9222
 */

"use strict";

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

const args = process.argv.slice(2);
const PORT = parseInt(getArg(args, "--port") || "9222", 10);
const INPUT = getArg(args, "--input") || ".";
const OUTDIR = getArg(args, "--outdir") || ".";
const MAX_ANCHORS = parseInt(getArg(args, "--anchors") || "30", 10);
const MAX_LISTS = parseInt(getArg(args, "--lists") || "60", 10);
const MAX_BOOKS = parseInt(getArg(args, "--books") || "600", 10);
const MAX_CATALOG_LISTS = parseInt(getArg(args, "--catalog-lists") || "30", 10);
const MIN_LIST_FOLLOWERS = parseInt(getArg(args, "--min-list-followers") || "20", 10);
const HOP2_ANCHORS = parseInt(getArg(args, "--hop2-anchors") || "0", 10);
const DETAIL_CHUNK = 6;

function walkMarkdownFiles(target, out = []) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (target.toLowerCase().endsWith(".md")) out.push(target);
    return out;
  }
  for (const name of fs.readdirSync(target)) {
    const full = path.join(target, name);
    const child = fs.statSync(full);
    if (child.isDirectory()) walkMarkdownFiles(full, out);
    else if (child.isFile() && name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

function extractAnchorBookIdsFromMarkdown(markdown) {
  const text = String(markdown || "");
  const ids = [];
  const seen = new Set();
  const re = /https?:\/\/(?:m\.|www\.|book\.)?qidian\.com\/(?:book|info)\/(\d+)\/?/g;
  for (const match of text.matchAll(re)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function collectAnchorBookIds(inputPath, maxAnchors = MAX_ANCHORS) {
  const files = walkMarkdownFiles(path.resolve(inputPath));
  const ids = [];
  const seen = new Set();

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    // 只从起点原始榜单文件取锚点；历史最终 Case 池没有作品 URL，不会误进。
    if (!/起点|qidian\.com/i.test(text)) continue;
    for (const id of extractAnchorBookIdsFromMarkdown(text)) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= maxAnchors) return ids;
    }
  }
  return ids;
}

function normalizeBooklistUrl(raw, base = "https://www.qidian.com/") {
  try {
    const u = new URL(String(raw || ""), base);
    if (!/qidian\.com$/i.test(u.hostname)) return "";
    if (!/\/booklist\//i.test(u.pathname)) return "";
    if (/\/booklist\/?$/i.test(u.pathname)) return "";
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

function parseFollowerCount(raw) {
  const text = String(raw || "").replace(/\s+/g, "");
  const match = text.match(/([\d.]+)\s*(万)?\+?关注/u);
  if (!match) return 0;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * (match[2] ? 10000 : 1));
}

function buildCatalogBooklistsJS() {
  return `JSON.stringify((function(){
    function abs(h){try{return new URL(h,location.href).href}catch(e){return ''}}
    var out=[];var seen={};
    Array.from(document.querySelectorAll('a[href*="/booklist/"]')).forEach(function(a){
      var u=abs(a.getAttribute('href')||a.href||'');
      if(!u||seen[u])return;
      var p='';
      try{p=new URL(u).pathname}catch(e){return}
      if(!/\\/booklist\\/detail\\//.test(p))return;
      var box=a;
      for(var i=0;i<5 && box && (box.innerText||'').length<20;i++)box=box.parentElement;
      var t=(box&&box.innerText||a.innerText||'').replace(/\\s+/g,' ').trim();
      var m=t.match(/([\\d.]+)\\s*(万)?\\+?关注/);
      var followers=0;
      if(m){followers=Math.round(Number(m[1])*(m[2]?10000:1));}
      seen[u]=1;
      out.push({url:u,title:(a.innerText||a.textContent||'').trim(),followers:followers,text:t.slice(0,300)});
    });
    return out;
  })())`;
}

function discoverCatalogBooklists() {
  if (MAX_CATALOG_LISTS <= 0) return [];
  try {
    ab(PORT, "open", "https://book.qidian.com/booklist/");
    sleep(1600);
    scrollLoad(PORT, 3, 350);
    const rows = evalJSONBase64(PORT, buildCatalogBooklistsJS());
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => ({
        url: normalizeBooklistUrl(row && row.url, "https://book.qidian.com/booklist/"),
        title: cleanText(row && row.title),
        followers: Number(row && row.followers) || parseFollowerCount(row && row.text),
      }))
      .filter((row) => row.url && row.followers >= MIN_LIST_FOLLOWERS)
      .sort((a, b) => b.followers - a.followers)
      .slice(0, MAX_CATALOG_LISTS);
  } catch (error) {
    console.error(
      `  [qidian-booklist] 推荐书单目录发现失败：${error && error.message ? error.message : error}`
    );
    return [];
  }
}

function buildBooklistLinksJS() {
  return `JSON.stringify((function(){
    function abs(h){try{return new URL(h,location.href).href}catch(e){return ''}}
    var roots=[];
    Array.from(document.querySelectorAll('section,div')).forEach(function(el){
      var t=(el.innerText||'').trim();
      if(t.indexOf('包含本书的书单')>=0 && t.length<12000) roots.push(el);
    });
    var scope=roots.length?roots[0]:document;
    var out=[];var seen={};
    Array.from(scope.querySelectorAll('a[href]')).forEach(function(a){
      var u=abs(a.getAttribute('href')||a.href||'');
      if(!u || u.indexOf('qidian.com')<0 || u.indexOf('/booklist/')<0)return;
      try{
        var p=new URL(u).pathname;
        if(/^\\/booklist\\/?$/.test(p))return;
      }catch(e){}
      if(seen[u])return;seen[u]=1;
      out.push({url:u,title:(a.innerText||a.textContent||'').trim()});
    });
    if(!out.length && scope!==document){
      Array.from(document.querySelectorAll('a[href*="/booklist/"]')).forEach(function(a){
        var u=abs(a.getAttribute('href')||a.href||'');
        if(!u||seen[u])return;
        try{if(/^\\/booklist\\/?$/.test(new URL(u).pathname))return;}catch(e){}
        seen[u]=1;out.push({url:u,title:(a.innerText||a.textContent||'').trim()});
      });
    }
    return out;
  })())`;
}

function extractBooklistLinks(port = PORT) {
  const rows = evalJSONBase64(port, buildBooklistLinksJS());
  return Array.isArray(rows) ? rows : [];
}

function buildBookIdsFromListJS() {
  return `JSON.stringify((function(){
    var out=[];var seen={};
    function txt(el){return el?(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim():''}
    Array.from(document.querySelectorAll('a[href]')).forEach(function(a){
      var href=a.getAttribute('href')||a.href||'';
      var u='';
      try{u=new URL(href,location.href).href}catch(e){return}
      if(u.indexOf('qidian.com')<0)return;
      var m=u.match(/\\/(?:book|info)\\/(\\d+)\\/?/);
      if(!m)return;
      var id=m[1];
      if(seen[id])return;

      var title=txt(a);
      if(!title || title.length>80)return;

      var box=a.closest('li')||a.closest('[class*="book"]')||a.parentElement;
      var intro='';
      if(box){
        var selectors=['p.intro','[class*="intro"]','[class*="desc"]','[class*="summary"]'];
        for(var si=0;si<selectors.length&&!intro;si++){
          var els=box.querySelectorAll(selectors[si]);
          for(var ei=0;ei<els.length;ei++){
            var t=txt(els[ei]);
            if(t.length>=20 && t!==title){intro=t;break;}
          }
        }
        if(!intro){
          var ps=Array.from(box.querySelectorAll('p')).map(txt).filter(function(t){
            return t.length>=30 && t!==title && t.indexOf('最近更新')!==0;
          });
          ps.sort(function(x,y){return y.length-x.length});
          intro=ps[0]||'';
        }
      }

      seen[id]=1;
      out.push({
        id:id,
        title:title,
        intro:intro,
        url:'https://www.qidian.com/book/'+id+'/'
      });
    });
    return out;
  })())`;
}

function extractBookIdsFromCurrentList(port = PORT) {
  const rows = evalJSONBase64(port, buildBookIdsFromListJS());
  return Array.isArray(rows) ? rows : [];
}

function cleanText(raw) {
  return String(raw || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function selectSpread(items, limit) {
  const source = Array.isArray(items) ? items : [];
  const n = Math.max(0, Math.min(source.length, Number(limit) || 0));
  if (!n) return [];
  if (n === source.length) return source.slice();

  const out = [];
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const index = Math.min(source.length - 1, Math.floor((i * source.length) / n));
    if (used.has(index)) continue;
    used.add(index);
    out.push(source[index]);
  }
  return out;
}

function buildBookDetailsJS(ids) {
  return `JSON.stringify((function(){
    var ids=${JSON.stringify(ids)};
    var out={};

    function text(el){return el?(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim():''}
    function bestIntro(doc){
      var sels=[
        '.book-intro p',
        '.book-intro',
        '[class*="book-intro"] p',
        '[class*="book-intro"]',
        '[class*="bookIntro"] p',
        '[class*="bookIntro"]'
      ];
      var cands=[];
      sels.forEach(function(sel){
        Array.from(doc.querySelectorAll(sel)).forEach(function(el){
          var t=text(el);
          if(t.length>=20 && t.length<=10000)cands.push(t);
        });
      });
      if(!cands.length){
        var labels=Array.from(doc.querySelectorAll('h1,h2,h3,h4,div,span,p')).filter(function(el){
          return text(el)==='作品简介';
        });
        labels.slice(0,3).forEach(function(label){
          var cur=label.nextElementSibling;
          for(var i=0;i<4 && cur;i++,cur=cur.nextElementSibling){
            var t=text(cur);
            if(t.length>=20 && t.length<=10000)cands.push(t);
          }
        });
      }
      cands.sort(function(a,b){return b.length-a.length});
      return cands[0]||'';
    }
    function bestTitle(doc){
      var h1=doc.querySelector('h1');
      var t=text(h1);
      if(t && t!=='作品简介')return t;
      var og=doc.querySelector('meta[property="og:title"]');
      if(og && og.content)return String(og.content).trim();
      var title=doc.querySelector('title');
      var raw=title?String(title.textContent||'').trim():'';
      return raw.replace(/\\([^)]*\\)小说在线阅读[\\s\\S]*$/,'').replace(/[-_].*起点.*$/,'').trim();
    }

    ids.forEach(function(id){
      try{
        var x=new XMLHttpRequest();
        x.open('GET','/book/'+id+'/',false);
        x.send();
        var html=x.responseText||'';
        var doc=new DOMParser().parseFromString(html,'text/html');
        out[id]={title:bestTitle(doc),intro:bestIntro(doc),url:'https://www.qidian.com/book/'+id+'/'};
      }catch(e){
        out[id]={title:'',intro:'',url:'https://www.qidian.com/book/'+id+'/',err:String(e&&e.message||e)};
      }
    });
    return out;
  })())`;
}

function fetchBookDetails(port, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += DETAIL_CHUNK) {
    const chunk = ids.slice(i, i + DETAIL_CHUNK);
    try {
      Object.assign(out, evalJSONBase64(port, buildBookDetailsJS(chunk)) || {});
    } catch (error) {
      console.error(
        `  [qidian-booklist] 详情批次 ${i + 1}-${i + chunk.length} 失败：${error && error.message ? error.message : error}`
      );
    }
    sleep(250);
  }
  return out;
}

function renderMarkdown(cases, meta = {}) {
  const lines = [
    "# 起点 · 上榜作品关联书单扩展",
    "",
    `- 榜单锚点：${meta.anchorCount || 0} 本`,
    `- 发现书单：${meta.listCount || 0} 个`,
    `- 二跳锚点：${meta.hop2AnchorCount || 0} 本`,
    `- 二跳新增书单：${meta.hop2ListCount || 0} 个`,
    `- 书单候选：${meta.candidateCount || cases.length} 本`,
    `- 成功简介：${cases.length} 本`,
    `- 抓取时间：${new Date().toISOString()}`,
    "",
    "---",
    "",
  ];

  cases.forEach((item, index) => {
    lines.push(`## #${index + 1} ${item.title}`);
    lines.push(`[作品页](${item.url})`);
    lines.push("", "**简介**", "", item.intro, "", "---", "");
  });

  return lines.join("\n");
}

function discoverBooklists(anchorIds) {
  const urls = [];
  const seen = new Set();

  for (let i = 0; i < anchorIds.length && urls.length < MAX_LISTS; i++) {
    const id = anchorIds[i];
    console.log(`  [锚点 ${i + 1}/${anchorIds.length}] https://www.qidian.com/book/${id}/`);
    try {
      ab(PORT, "open", `https://www.qidian.com/book/${id}/`);
      sleep(1200);
      const rows = extractBooklistLinks(PORT);
      for (const row of rows.slice(0, 4)) {
        const url = normalizeBooklistUrl(row && row.url, "https://www.qidian.com/");
        if (!url || seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
        if (urls.length >= MAX_LISTS) break;
      }
    } catch (error) {
      console.error(
        `  [qidian-booklist] 锚点 ${id} 书单发现失败：${error && error.message ? error.message : error}`
      );
    }
  }

  // 第二条入口：起点推荐书单目录。只取有真实关注量的具体书单，
  // 不扫“最新书单”洪流，避免把完全未经筛选的冷启动书单当成绩证据。
  const curated = discoverCatalogBooklists();
  for (const row of curated) {
    if (urls.length >= MAX_LISTS) break;
    if (seen.has(row.url)) continue;
    seen.add(row.url);
    urls.push(row.url);
  }
  if (curated.length) {
    console.log(
      `  ✓ 推荐目录补充 ${curated.length} 个书单（关注数 >= ${MIN_LIST_FOLLOWERS}）`
    );
  }

  return urls;
}

function collectBooksFromLists(listUrls, excludedIds, limit = MAX_BOOKS) {
  const rows = [];
  const seen = new Set((excludedIds || []).map(String));
  const maxBooks = Math.max(0, Number(limit) || 0);

  for (let i = 0; i < listUrls.length && rows.length < maxBooks; i++) {
    const url = listUrls[i];
    console.log(`  [书单 ${i + 1}/${listUrls.length}] ${url}`);
    try {
      ab(PORT, "open", url);
      sleep(1200);
      scrollLoad(PORT, 2, 350);
      const books = extractBookIdsFromCurrentList(PORT);
      for (const b of books) {
        const id = String(b.id || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rows.push({ id, title: cleanText(b.title), intro: cleanText(b.intro), url: b.url });
        if (rows.length >= maxBooks) break;
      }
    } catch (error) {
      console.error(
        `  [qidian-booklist] 书单页失败：${error && error.message ? error.message : error}`
      );
    }
  }

  return rows;
}

function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("非法 --port");
  }

  const anchorIds = collectAnchorBookIds(INPUT, MAX_ANCHORS);
  if (!anchorIds.length) {
    throw new Error("没有从原始起点榜单中找到可用作品 URL，无法建立书单锚点");
  }

  console.log(`→ 用 ${anchorIds.length} 本上榜作品发现第一层关联书单...`);
  const firstListUrls = discoverBooklists(anchorIds);
  if (!firstListUrls.length) {
    throw new Error("上榜作品页没有发现可用的关联书单链接");
  }
  console.log(`  ✓ 第一层发现 ${firstListUrls.length} 个去重书单`);

  console.log("→ 从第一层书单扩展作品...");
  const firstCandidates = collectBooksFromLists(firstListUrls, anchorIds, MAX_BOOKS);
  if (!firstCandidates.length) {
    throw new Error("关联书单没有解析出新的起点作品");
  }
  console.log(`  ✓ 第一层书单得到 ${firstCandidates.length} 本新候选`);

  const allLists = new Set(firstListUrls);
  const candidateMap = new Map(firstCandidates.map((item) => [String(item.id), item]));
  let hop2AnchorIds = [];
  let hop2NewListCount = 0;

  if (HOP2_ANCHORS > 0 && candidateMap.size < MAX_BOOKS) {
    hop2AnchorIds = selectSpread(firstCandidates, HOP2_ANCHORS).map((item) => String(item.id));
    if (hop2AnchorIds.length) {
      console.log(`→ 从第一层候选中均匀抽 ${hop2AnchorIds.length} 本作为二跳锚点...`);
      const hop2Lists = discoverBooklists(hop2AnchorIds);
      const newHop2Lists = hop2Lists.filter((url) => {
        if (allLists.has(url)) return false;
        allLists.add(url);
        return true;
      });
      hop2NewListCount = newHop2Lists.length;
      console.log(`  ✓ 二跳新增 ${hop2NewListCount} 个书单`);

      const remaining = Math.max(0, MAX_BOOKS - candidateMap.size);
      if (remaining > 0 && newHop2Lists.length) {
        const excluded = [...anchorIds, ...candidateMap.keys()];
        const hop2Candidates = collectBooksFromLists(newHop2Lists, excluded, remaining);
        for (const item of hop2Candidates) {
          if (!candidateMap.has(String(item.id))) {
            candidateMap.set(String(item.id), item);
          }
        }
        console.log(`  ✓ 二跳新增 ${hop2Candidates.length} 本候选`);
      }
    }
  }

  const listUrls = [...allLists];
  const candidates = [...candidateMap.values()];
  console.log(`  ✓ 两层合计 ${listUrls.length} 个书单，${candidates.length} 本新候选`);

  const missingDetail = candidates.filter((item) => !cleanText(item.intro));
  let detailMap = {};

  if (missingDetail.length) {
    // 书单页通常已经带完整简介；只有页面结构没给到简介的条目才回详情页补，
    // 避免几百本逐本详情请求造成频率限制。
    ab(PORT, "open", `https://www.qidian.com/book/${missingDetail[0].id}/`);
    sleep(1500);
    console.log(
      `→ 书单页已有简介 ${candidates.length - missingDetail.length}/${candidates.length}；补抓 ${missingDetail.length} 本详情...`
    );
    detailMap = fetchBookDetails(PORT, missingDetail.map((x) => x.id));
  } else {
    console.log(`→ 书单页已直接取得全部 ${candidates.length} 本简介，无需补抓详情`);
  }

  const cases = [];
  for (const c of candidates) {
    const d = detailMap[c.id] || {};
    const title = cleanText(d.title || c.title);
    const intro = cleanText(c.intro || d.intro);
    if (!title || !intro) continue;
    cases.push({ title, intro, url: d.url || c.url });
  }

  if (!cases.length) {
    throw new Error("书单候选详情页没有解析出可用简介");
  }

  fs.mkdirSync(OUTDIR, { recursive: true });
  const filename = `起点关联书单_${localDateStamp()}.md`;
  const filepath = path.join(OUTDIR, filename);
  fs.writeFileSync(
    filepath,
    renderMarkdown(cases, {
      anchorCount: anchorIds.length,
      listCount: listUrls.length,
      candidateCount: candidates.length,
      hop2AnchorCount: hop2AnchorIds.length,
      hop2ListCount: hop2NewListCount,
    }),
    "utf8"
  );
  console.log(`  ✓ 已保存: ${filepath}`);
  console.log(`  ✓ 完整简介：${cases.length}/${candidates.length}`);

  return {
    planned: 1,
    written: 1,
    failed: 0,
    partial: cases.length < candidates.length,
    partialReasons:
      cases.length < candidates.length
        ? [`detail-missing=${candidates.length - cases.length}`]
        : [],
  };
}

if (require.main === module) {
  runCli(main, "起点关联书单采集");
}

module.exports = {
  extractAnchorBookIdsFromMarkdown,
  normalizeBooklistUrl,
  parseFollowerCount,
  cleanText,
  selectSpread,
  buildBooklistLinksJS,
  buildCatalogBooklistsJS,
  buildBookIdsFromListJS,
  buildBookDetailsJS,
  renderMarkdown,
};
