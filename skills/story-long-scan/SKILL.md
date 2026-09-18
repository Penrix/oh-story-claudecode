---
name: story-long-scan
version: 1.1.0
description: "从起点、番茄、七猫等真实网文榜单批量采集故事 Seed 可用 Case。榜单只负责市场预筛，最终只保留书名与完整、有内容的真实简介。触发方式：/story-long-scan、/长篇扫榜、/榜单采集、「大量采集榜单数据」「采集故事Case」。"
metadata: {"openclaw":{"source":"https://github.com/Penrix/oh-story-claudecode"}}
---
# story-long-scan：真实榜单 Case 采集

你的任务不是分析榜单，也不是总结市场趋势。

榜单在这里只有一个作用：

> **先用真实市场榜单过滤掉大量没有市场证明的作品，再从榜上作品中采集能够直接参加故事 Seed 创作的真实 Case。**

最终 Case 只有：

```text
书名
+
完整简介
```

排名、作者、热度、字数、标签、榜单位置等都不是创作输入。采集脚本为了定位作品、进入详情页或排查异常，可以临时保留这些字段；最终交给故事 Seed 的 `榜单数据.md` 必须把它们全部去掉。

---

## 核心规则

1. **简介绝不截断。** 不允许 100 字截断，不允许摘要，不允许改写。
2. **榜单只负责预筛。** 不按排名高低给 Case 加权，不做趋势分析，不做选题建议。
3. **简介必须有内容。** 空简介、暂无简介、只有标签、只有一句很短宣传语的作品直接淘汰。
4. **跨榜单去重。** 同名作品只留一份；若同名作品抓到多个简介版本，保留内容更完整的版本。
5. **原始 Case 高于模型理解。** 采集阶段不提炼 Motion，不总结套路，不把简介压缩成理论。
6. **最终输出保持极简。** 每个 Case 只输出书名和完整简介。

---

## 默认任务解释

用户说：

- “大量采集榜单数据”
- “搜一批榜单”
- “给故事 Seed 准备真实 Case”
- “采集榜单书名和简介”

默认都解释为：

> **批量采集经过真实市场榜单预筛的作品，取得完整书名 + 完整简介，过滤明显无内容简介，去重后形成 Case 池。**

除非用户明确要求市场分析，否则不要进入题材趋势、榜单排名、热度比较、选题推荐等流程。

---

## 默认采集范围

用户没有指定平台时，优先采中国商业长篇男频：

```text
起点
+
番茄男频
+
七猫男频
```

这三个平台当前采集器都能稳定得到作品简介。

晋江、刺猬猫现有脚本没有稳定输出作品完整简介，不作为默认 Case 来源。以后补齐详情页简介后再接入。

---

## Phase 1：建立原始榜单候选

先创建一个临时目录：

```text
{raw_dir}
```

这个目录只是采集过程的中间产物，可以包含作者、排名、热度等字段。

### 起点

起点优先读取移动端 SSR，不需要 Chrome：

```bash
node scripts/qidian-rank-scraper.js --type all --outdir {raw_dir}
```

目标不是研究各榜排名，而是尽量取得多个真实榜单里的候选作品和完整简介。

### 番茄男频

番茄列表页有字体反爬，现有脚本通过详情页解析真实书名与 `abstract` 简介。

先用 `browser-cdp` 启动 Chrome，再执行：

```bash
node scripts/fanqie-rank-scraper.js --channel 1 --type all --top 20 --outdir {raw_dir}
```

默认同时采：

```text
男频阅读榜
+
男频新书榜
+
全部可发现男频题材
```

如果用户明确要求女频或全频道，再改 `--channel`。

### 七猫男频

```bash
node scripts/qimao-rank-scraper.js --channel male --type all --period all --outdir {raw_dir}
```

七猫榜单页本身包含简介。保留完整简介，不做长度截断。

---

## Phase 2：完整简介保真

三个主采集器的简介清洗都遵守同一原则：

```text
允许：
删除明确的平台模板污染
折叠无意义空白

禁止：
按长度截断
摘要
改写
补写
把简介改成一句话
```

详情见 [references/scan-output-format.md](references/scan-output-format.md)。

如果平台只给到一句话式简介，不要擅自扩写。把它交给下一阶段的可用性过滤决定是否淘汰。

---

## Phase 3：汇总成 Seed Case 池

原始榜单抓完后运行：

```bash
node scripts/case-pool-builder.js --input {raw_dir} --outdir {case_dir}
```

默认最小有效内容长度：

```text
--min-chars 80
```

它不是文学质量评分，只是一个低成本垃圾过滤门，用来剔除明显不能支持 Seed 重演的空壳简介。

需要调整时：

```bash
node scripts/case-pool-builder.js --input {raw_dir} --min-chars 60 --outdir {case_dir}
node scripts/case-pool-builder.js --input {raw_dir} --min-chars 120 --outdir {case_dir}
```

Builder 会依次执行：

```text
读取所有榜单 Markdown
↓
提取书名 + 完整简介
↓
淘汰空简介 / 占位简介 / 标签串 / 极短宣传语
↓
按书名跨榜单去重
↓
同名多个版本保留内容更完整的简介
↓
写出最终 Case 池
```

---

## 最终输出

固定生成：

```text
{case_dir}/榜单数据.md
{case_dir}/榜单数据.jsonl
```

### 榜单数据.md

格式必须保持：

```markdown
# 榜单数据

## 《书名A》

完整简介……

---

## 《书名B》

完整简介……

---
```

不要加入：

- 作者
- 排名
- 热度
- 字数
- 标签
- 榜单名称
- 市场分析
- 对简介的解释

### 榜单数据.jsonl

每行只有：

```json
{"title":"书名A","intro":"完整简介……"}
```

这个文件用于后续程序处理或再次筛选。

---

## 简介可用性过滤

`case-pool-builder.js` 只做确定性、保守的垃圾过滤。

直接淘汰：

```text
空文本
暂无简介 / 暂未介绍
只有【标签+标签】
有效内容明显过短
很短且只有一句宣传语
```

保留：

```text
能看见人物/状态/变化/行动/关系/机会中的若干项
虽然写法普通，但已经能看懂“这是一本什么书”
单句较长但确实包含足够故事内容
```

不要在采集阶段调用 LLM 去“判断这个故事值不值得”。

我们只需要：

> **市场榜单已经替我们完成第一层价值过滤；采集器只负责保证 Case 有足够内容可以使用。**

---

## 去重原则

榜单位置不是数据。

同一本书同时出现在多个榜单，只算一个 Case。

默认按归一化书名去重：

```text
《某书》
某书
某 书
→ 同一 title key
```

若同名 Case 出现多个简介版本：

> **保留有效内容更长的一份。**

不要把“它同时上了几个榜”带入最终 Case。

---

## 验收

每次采集结束只关注四个数字：

```text
候选简介
→ 通过内容过滤
→ 去重
→ 最终 Case
```

例如：

```text
候选简介：760
通过内容过滤：612
去重：104
最终 Case：508
```

最终 Case 数才是这次真正取得的创作参考视频数量。

如果数量明显偏少，按顺序排查：

1. 榜单页面是否正常加载；
2. 是否被登录页 / 验证页拦截；
3. 详情页简介解析是否失效；
4. `--min-chars` 是否过高；
5. 榜单间是否高度重复。

不要为了把数字做大而允许一句话简介混进 Case 池。

---

## 继续扩大数据量

优先扩“真实榜单候选面”，不要增加无用字段。

方向包括：

```text
更多榜单
更多题材
更多分页
更多平台
不同日期重复采集后只保留新作品
```

任何扩展都必须继续满足：

> **最终交付仍然只有书名 + 完整简介。**

---

## 参考

| 文件 | 用途 |
|---|---|
| [scripts/qidian-rank-scraper.js](scripts/qidian-rank-scraper.js) | 起点榜单采集 |
| [scripts/fanqie-rank-scraper.js](scripts/fanqie-rank-scraper.js) | 番茄榜单 + 详情页简介 |
| [scripts/qimao-rank-scraper.js](scripts/qimao-rank-scraper.js) | 七猫榜单采集 |
| [scripts/case-pool-builder.js](scripts/case-pool-builder.js) | 去重、简介可用性过滤、最终 Case 池输出 |
| [references/scan-output-format.md](references/scan-output-format.md) | 各平台原始采集字段与简介保真规则 |

---

## 语言

- 跟随用户语言；
- 默认中文。
