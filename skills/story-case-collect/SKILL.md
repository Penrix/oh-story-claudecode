---
name: story-case-collect
version: 0.1.0
description: "从真实网文榜单批量采集故事 Seed 可用 Case。榜单只用于过滤市场垃圾，最终只保留书名与完整、有内容的真实简介。触发方式：/story-case-collect、/榜单采集、「大量采集榜单数据」「采集故事Case」。"
metadata: {"openclaw":{"source":"https://github.com/Penrix/oh-story-claudecode"}}
---
# story-case-collect：真实榜单 Case 采集

你的任务不是分析榜单，也不是总结市场趋势。

榜单在这里只有一个作用：

> **先用真实市场榜单过滤掉大量没有市场证明的作品，再从榜上作品中采集能够直接参加故事 Seed 创作的真实 Case。**

最终 Case 只有两项：

```text
书名
+
完整简介
```

排名、作者、热度、字数、标签、榜单位置等都不是创作输入。采集脚本为了定位、去重或抓详情页可以临时使用这些字段，但最终 `榜单数据.md` 不输出它们。

## 不可违反的规则

1. **简介绝不截断、绝不摘要、绝不改写。** 只允许删除明确的平台模板污染、折叠无意义空白。
2. **榜单只负责市场预筛。** 不根据排名高低给 Case 加权，不输出趋势分析，不做选题建议。
3. **简介必须有内容。** 空简介、暂无简介、只有标签、只有一句很短宣传语的作品直接淘汰。
4. **跨榜单去重。** 同名作品只保留一份；若抓到多个简介版本，保留内容更完整的版本。
5. **最终给 Seed 算法的 Markdown 必须干净。** 每条只保留 `书名 + 完整简介`。

## 默认采集顺序

### 1. 起点

起点优先走移动端 SSR，不需要 Chrome：

```bash
node ../story-long-scan/scripts/qidian-rank-scraper.js --type all --outdir {raw_dir}
```

### 2. 番茄男频

番茄需要 browser-cdp。先启动 CDP Chrome，再同时采阅读榜和新书榜的全部男频题材：

```bash
node ../browser-cdp/scripts/setup-cdp-chrome.js 9222
node ../story-long-scan/scripts/fanqie-rank-scraper.js --channel 1 --type all --top 20 --outdir {raw_dir}
```

### 3. 七猫男频

```bash
node ../story-long-scan/scripts/qimao-rank-scraper.js --channel male --type all --period all --outdir {raw_dir}
```

晋江、刺猬猫当前采集器没有稳定输出作品完整简介，不作为默认 Case 来源；后续若补齐详情页简介再接入。

## 汇总为 Case 池

采集完成后执行：

```bash
node scripts/case-pool-builder.js --input {raw_dir} --outdir {case_dir}
```

默认 `--min-chars 80`。它不是要求简介必须机械达到某种文风，而是防止一句话宣传语进入 Seed Case 池。需要更宽/更严时可以调整：

```bash
node scripts/case-pool-builder.js --input {raw_dir} --min-chars 60 --outdir {case_dir}
node scripts/case-pool-builder.js --input {raw_dir} --min-chars 120 --outdir {case_dir}
```

输出：

```text
{case_dir}/榜单数据.md
{case_dir}/榜单数据.jsonl
```

其中 Markdown 结构固定为：

```markdown
# 榜单数据

## 《书名A》

完整简介……

---

## 《书名B》

完整简介……

---
```

JSONL 同样只保留：

```json
{"title":"书名A","intro":"完整简介……"}
```

## 简介可用性

确定性过滤只负责淘汰明显不可用内容：

- 空文本 / 暂无简介；
- 去掉标签后有效内容太短；
- 很短且只有一句宣传语式文本。

不要在采集阶段用 LLM 对简介做“质量改写”“摘要”“Motion 提炼”或“市场价值判断”。

**原始 Case 始终高于采集器的理解。**

## 验收

每次批量采集结束，只看四个数字：

```text
候选简介
→ 通过内容过滤
→ 去重
→ 最终 Case
```

最终 Case 才是本次真正得到的创作参考视频数量。

若最终数量明显低于预期，优先排查：

1. 平台详情页是否被验证/登录页拦截；
2. 简介解析是否失效；
3. `--min-chars` 是否设得过高；
4. 榜单本身是否大量重复。

不要通过放宽到“只有一句话也算 Case”来虚增数量。

## 语言

- 跟随用户语言；
- 默认中文。
