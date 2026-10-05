# docs/dev-checks —— 动画层的验证留痕

这里的图和数据不是宣传图，是**在真实浏览器里跑出来的证据**，
由 `test/cdp-shot.mjs` / `test/cdp-eval.mjs` / `test/cdp-squish.mjs` 驱动无头 Chromium
+ 本插件真实路由取得；比例类的东西（她头顶在哪、盆该多大）另由
`tools/probe-head.mjs` 在真实浏览器里量出来。
留在这里是为了以后换素材、改节拍时有个对照基线。

| 图 | 抓取条件 | 它证明了什么 |
| --- | --- | --- |
| `idle-running.png` | `?idle=1`，等 `window.__report.showing === 'idle'` | 拆完两块之后，小女孩那块确实在播放 `idle.webm`，而且按内容贴合该块（内容高 = 该块可见高）。 |
| `idle-ab.png` | `?idle=1&ab=1` | 左「定格帧裁切」/ 中「动画素材内容框」/ 右「红=定格、青=动画」的叠加。右侧几乎全灰 —— 两者体量与站位基本重合，切换不生硬。 |
| `e2e.png` | `?idle=1` 后依次点击 ⏸ / ▶ 与重播 | 端到端状态机：排期运行中 → 按 ⏸ 暂停且画面冻住（**不露定格帧**）→ 按 ▶ 继续 → 重播后动画层退场、两块合回整体。 |
| `v060-sched.png` | `?sched=1` 跑满 34s 之后的定格 | 0.6.0 的状态机：跑完仍是「电饭煲 + 小女孩」两块、透明背景、任何时刻只有一段画面。 |
| `v070-send-flow.png` | `?send=1` 跑到 11s 的整页（开盖还在演） | 0.7.0 的发送联动：按钮已搬到电饭煲上方、小女孩已隐藏、蓝字 + 计时器 + 开盖定格都在电饭煲下方。 |
| `v070-send-zoom.png` | 上图的放大 | 看得清「肥鱼已经煮饭：」是蓝色、计时器在走字、开盖那段停在最后一帧且不压住计时器。 |
| `v072-*.png` / `v073-*.png` | 同一条件、同一时刻，分别跑 0.7.2 的包与 0.7.3 的源码 | 0.7.3 三条修复的前后对照：小女孩贴窗口边框（`fresh`）、跑出动画独占画面（`girlclip`）、开盖原地播放（`lid`）。见下面「0.7.3 的三条修复」。 |
| `v074-lid-ended.png` | `?send=1` 的 `send-lid-ended`（开盖 5.065s 播完那一刻） | 0.7.4：开盖播完之后蓝色文案与计时器一起收掉，锅与探头的她仍停在最后一帧。见下面「0.7.4：开盖播完清掉文案与计时器」。 |
| `v075-hold-thinking.png` | `?send=1&think=1` 的 `send-thinking`（推理行还 `running`、过程行已长到 90 字） | 0.7.5：**深度思索期间不播开盖、电饭煲保持原样**。见下面「0.7.5：等『深度思索』结束再开盖」。 |
| `v080-squish-cooker-before.png` / `v080-squish-cooker.png` | 同一时刻，按住 `#dshca-part-cooker` 之前 / 按住 380ms 之后 | 0.8.0 点击 Q 弹：电饭煲被压扁成 `scaleY .88 / scaleX 1.05`，**下沿一动不动**（锅的底座还在原处）。 |
| `v080-squish-girl-before.png` / `v080-squish-girl.png` | 同上，对象是小女孩（她那段待机动画正在播） | 按下即暂停 → 拿"按下那一刻那一帧"当图压扁；松手后从暂停处**接着播**。见下面「0.8.0：点击 Q 弹」。 |
| `v080-squish-basin.png` / `v080-squish-basin-stack.png` | 0.9.0：用 `__dshcaPots.drop()` 手动掉一个 / 两个，落地后**放大局部**截图 | 盆扣在她头上的样子：宽度 = 她那块的 1.08、下沿 = 块高的 0.40、顺时针倾 9°；第二个盆摞在第一个上面。见下面「0.9.0：掉盆」。 |

## 0.9.0：掉盆（按住小女孩的随机事件）

比例不是猜的，是从素材上量出来的：

```text
她的定格帧裁切（从 anim.webm 末帧裁出来）      900 × 1280
  alpha 剖面（每行内容左右边界，tools/probe-head.mjs 在真浏览器里量）
    y=0.00（最上沿）   内容只占 5.5% 宽      ← 头顶 + 呆毛
    y=0.10            43.4%                ← 头（含蕾丝头饰）
    y=0.25            75.8%
    y=0.40            89.5%                ← 大致是她的眉毛/脸颊最宽处

盆素材（basin.png，已裁掉右下角生成水印并收紧）  1006 × 577

试摆之后定下来的比例（与参考图对照着挑的）
  盆宽      = 块宽 × 1.08     ← 比她那块还宽一点，参考图里就是"整个扣住脑袋"的大盆
  盆沿下沿  = 块高 × 0.40     ← 大约落在她眉毛处，眼睛刚好露在下沿外面
  倾角      = 顺时针 9°       ← 参考图里也是右侧偏低
```

真实浏览器里的实测（同一次跑，14 条）：

```text
__dshcaPots.probe()   count=1  imageReady=true   host={w:77,h:109.5}
落地后的布局值         potLayoutWidth=83.16  (= 77 × 1.08)
                      rimFromTop=43.8      (= 109.5 × 0.40)
旋转后的包围盒         92.6  ← 比布局宽 ~11%（rotate(9deg) 撑大的），所以断言必须量
                                style.width/top 而不是 getBoundingClientRect
第二个盆              top 比第一个小一个 stacking step（0.22 × 盆高），第一个不动
拖到一旁（+150px）     count 1 → 0，剩下那个 index 退回 0（重新摞到头上）
```

一个只有真实浏览器才暴露的坑：**量盆的宽度不能看包围盒**。盆带着 `rotate(9deg)`，
`getBoundingClientRect()` 量出来的是旋转之后的盒子（真实 83.16 会量成 92.6），
第一版断言就是这么写错的 —— 现在断言量 `style.width` / `style.top`，
另外把旋转后的盒子也一并记进 `notes.basinGeometry` 留着对照。

回归防线是 `test/widget-harness.mjs` 的第 51 组（12 条）：掉落与落地音效、
**只在小女孩那一侧掉**、摞高且第一个不动、拖走与"拖不够远就弹回"、
**摘掉下面那个之后上面的重新摞下来**、盆自己吃掉按压（不会顺手把她拖走 / 压扁）、
重播清空、改显示尺寸后按比例重排、**与钢管音共用那条"同时只响一个"的 CD**、
`potChance:0` 关掉事件、以及 `window.__dshcaPots` 的 drop / clear。

客户端断言总数 151 → 163（0.8.1 的音效 151 条 + 掉盆 12 条）；真浏览器断言 26 → 40。

## 0.8.0：点击 Q 弹（按住压扁 / 松开接着播）

`test/cdp-squish.mjs` 在真实无头 Edge + 真实路由下，用**真的 `PointerEvent`** 按住
`#dshca-part-cooker` / `#dshca-part-girl`，并在按住期间读真实计算样式、真实
`getBoundingClientRect()`，还把快照 canvas 缩到 160 宽**数一遍像素**（DOM 桩里
`drawImage` 是空函数，这一条只能在这里问）。一次完整回报（视口 976×561、`width: 220`）：

```text
电饭煲那一块 rect        w=91      h=82.41   bottom=136.41
按住 380ms 的快照         w=95.55   h=72.52   bottom=136.41     ← 91×1.05 / 82.41×0.88，下沿没动
按住 40ms 的 transform    scaleX=1.029  scaleY=0.931            ← 过渡真的在跑（不是啪一下到位）
松开 40ms 的 transform    scaleX=1.012  scaleY=0.972            ← 回弹也已经起步
快照上的像素              71.4% 不透明（烤盘/锅身真的画进去了，不是一张空图）

小女孩那一段（idle.webm 正在播）
  按下前                  paused=false  t=0.115
  按下后                  paused=true   t=0.246                 ← 冻在按下那一刻那一帧
  按住 380ms 的快照        scaleX=1.05   scaleY=0.88
  快照上的像素             70.6% 不透明（她本人）
  松开 500ms 之后          paused=false  t=0.496                 ← 接着播（没有回到 0）
```

要点：

- **支点在底部中线**：快照与那一块等宽等高，`transform-origin: 50% 100%`，所以
  `scaleY .88` 之后 `bottom` 仍是 136.41 —— 锅的底座、她的脚钉在原地，只有上半身压下来。
- **被拉伸的是"按下那一刻那一帧"**：顺序是 `pause()` → 拍快照 → 压扁，所以按住期间
  画面不会继续走动；松手后 `t` 从 0.246 接着走到 0.496，**不是从 0 重播**。
- **快照按内容包围盒取源**：`drawImage(video, box.x, box.y, box.w, box.h, dx, dy, dw, dh)`
  的落点复算动画层那套"水平居中、底边对齐"（断言里比的就是这条式子），两处同源，
  按下的一瞬画面不会跳。按整幅取源会让支点落进素材下方的透明留白里，人会往上飘。

回归防线是 `test/widget-harness.mjs` 的第 49 组（15 条断言）：按下即出快照、松开回弹、
快照撤掉、画面交回；按住期间视频被暂停/恢复、`currentTime` 不被重置；本来没在播的
（已 `ended` 停在末帧）不会被接回播放；**按住期间排期器让拍、回弹之后接着走**；
按压转拖动后位置仍被记住、而"只是按了一下"什么都不写；合并态不参与；`girl.webm` 与
`lid.webm` 播放期间不参与（含"开盖接管画面时把回弹中的快照先收干净"）；控件不是画面；
`clickSquish:false` 完全关掉；同一块上的第二根手指既不重开也不误收。

客户端断言总数 128 → 143；真浏览器断言 18 条（`node test/cdp-squish.mjs`）。

### 按压音效与内置 CD（同一次交付）

普通按压音是**现场合成**的（三角波 520→170Hz + 指数衰减，0.17 秒），所以没有素材可量；
"钢管"彩蛋音是随包的 `assets/pipe.mp3`，由 `tools/audio-trim.mjs` 处理：

```text
                       原始 钢管.mp3        裁完 assets/pipe.mp3
字节                   83949                39168
ID3v2 头               45 B                 （首帧从 0 开始，ID3 一并去掉）
MP3 帧                 219                  102
起始静音（>1% 才算声） 2.840 s              0.070 s（= 声音自己的起音，不是静音段）
解码时长               5.205 s              2.448 s
采样率 / 声道          48000 / 2            同左（**没重编码**，只按帧边界切字节）
峰值                   1.0                  1.0
```

裁切点取"第一个超过 1% 的 10ms 块"往前 30ms，再**往前对齐到帧边界**（只会多留、
绝不切掉起音）。裁完再测一遍，起始静音只剩 70ms 且电平在 1% 以下 —— 那是声音本身
的淡入，听不见。

`test/cdp-squish.mjs` 在真实浏览器里接着验（同一次跑，8 条）：

```text
__dshcaPress.ready()        true
pipeSeconds                 2.448            ← 随包那个 mp3 真的能解码，裁切没把文件弄坏
AudioContext.state          "running"        ← 惰性创建 + 首次按压 resume，没被自动播放策略拦
__dshcaPress.play('synth')  true             ← 手动试听：两路都能真的起播
__dshcaPress.play('pipe')   true

真实按压（按一下 + 松开，再立刻来一次）：
  第 1 次                    plays +1  busyForMs=170  kind="synth"
  第 2 次                    plays +0  skipped +1              ← CD 生效：上一个（0.17s）还没播完
  等 busyForMs 归零后再按     plays +1  busyForMs=2447         ← 这一次真的掷中了钢管（2.42s 的 CD）
```

最后一行是运气也是证据：那一次 7% 掷中了，`busyForMs` 如实变成 2447ms（钢管音的
时长），也就是说**彩蛋音的 CD 真的按它自己的时长在挡**，而不只是一个固定值。

回归防线是 `test/widget-harness.mjs` 的第 50 组（8 条）：一次按压只出一声、合成音的
包络真的被排上、CD 挡掉紧接着的第二次按压并计入 `skipped`、CD 过后恢复、`pipeChance:1`
时电饭煲掷中而**小女孩永远不掷**、钢管音按自身时长占住 CD、`pressVolume` 真的缩放了
峰值、`pressSound:false` 连 AudioContext 都不建、素材拉不到时降级成合成音而不是静音、
以及 `window.__dshcaPress` 的 probe / play / reset。为了能这么测，DOM 桩补了一套
最小 Web Audio（振荡器 / 增益 / buffer source / decodeAudioData）与 `fetch` 记录器 ——
**只记调用、不出声**，断言的是"这一下到底响没响、响的是哪一路"。

客户端断言总数 143 → 151；真浏览器断言 18 → 26。

## 0.7.3 的三条修复（前后对照）

三条都是在**同一个无头 Edge + 同一套真实路由**下、在**同一时刻**各跑一遍 0.7.2 的包
（`dist/dsh-corner-anim-0.7.2.tgz` 解出来跑）与 0.7.3 的源码，所以差别只可能来自代码。

### ① 小女孩贴在窗口边框上（`v072-fresh-before.png` → `v073-fresh.png`）

素材画幅右侧有 320 源像素的透明留白，"帧内原位置"因此离窗口右边缘 40~50px。
0.7.3 只把她一个人顶到边框上，电饭煲仍停在帧内位置。真实浏览器实测（视口 976）：

```text
                       电饭煲 [left,right]      小女孩 [left,right]      离窗口右边缘
0.7.2（帧内位置）       [755, 846]              [851, 928]              48px
0.7.3（贴边框）         [755, 846]              [897, 974]              2px
```

那 2px 是刻意留的：她的**动画层**按内容包围盒贴合那一块，内容比裁切框宽 ~3.6%，
左右各溢出 1~2px —— 严格贴到 0 会让待机/动作动画的边被窗口边缘切掉一条。

### ② 跑出动画独占画面（`v072-girlclip-before.png` → `v073-girlclip.png`）

点发送后 1.5s（`?send=1` 的 `send-girl-playing` 那一格）。0.7.2 里能同时看到她**两张**：
跑出动画的姿势叠在"原先那张她"（待机末帧或拆分时的定格帧）上；0.7.3 只剩跑出那一段。
页面侧每 50ms 用真实计算样式数一遍，同一格的回报：

```text
0.7.3  send-girl-playing   scheduledVisible=[]   canvasVisible=false
                           visible = { what: "girl-clip", count: 1, ok: true }
```

整条 `?send=1` 流程跑完：`window.__violations = []`、`window.__fallsBack = []`
（0.7.2 在同一条件下会记下"同时两张图"的越界）。

### ③ 开盖原地播放（`v072-lid-before.png` → `v073-lid.png`）

`?send=1` 的 `send-lid` 那一格（开盖起播约 1.2s）。两次实测的几何：

```text
                   电饭煲 rect            开盖内容框                  文案/计时器列 rect      开盖的父节点
0.7.2   [755, 54, 91, 82]      [755, 182, 91, ~128]  ← 在计时器下方   [755, 142, 91, 183]    #dshca-sendbar
0.7.3   [755, 54, 91, 82]      left=755, bottom=136.4, width=91      [755, 142, 85, 38]     BODY
```

0.7.3 里开盖内容框的**左缘与宽度等于电饭煲**、**下沿等于电饭煲下沿**（54+82=136），
即原地替换那口锅；而文案/计时器那一列仍在它下方（top=142），不再被视频占着。

回归防线：`test/widget-harness.mjs` 的第 44～47 组 —— 跑出动画独占画面（两种"原先的图"
各验一遍）、小女孩贴窗口边框（含改尺寸 / 改窗口 / 文档滚动条 / 拖动过 / 很窄的窗口 /
左角落六种边界，外加"只拖过她一块时位置也要记住"）、重播之后跑出动画仍挂在新的右块上、
开盖跟随电饭煲。客户端断言总数 111 → 128。

## 0.7.4：开盖播完清掉文案与计时器

`?send=1` 新加了一格 `send-lid-ended`（开盖 5.065s 播完那一刻）：
`v074-lid-ended.png` 就是它，实测回报：

```text
stage        send-lid-ended
lidClip      ended=true  t=5.065/5.065  displayed=block  visible=true
sendbar      displayed=none        ← 蓝色文案与计时器一起收掉（DOM 里还在，只是不显示）
lid 内容框    left=1291, bottom=136.4, width=91   ← 仍原地停在电饭煲那一格
debug 末笔    { kind: "lid-ended" }
```

两件事是刻意一起做的：

- **计时器不只是藏起来**：那条每秒读一次表 + 重排一次发送列的 `setInterval` 也一并
  停掉（否则没人看得见之后还在空转）。回归断言里把时钟往前推 3 秒，读数必须不动，
  而且不许留下任何 `repeat` 定时器。
- **开盖画面不动**：锅与探头的她仍停在最后一帧，等到下一条消息才整套复位
  （复位之后文案与计时器重新出现，并从 `00:00` 开始走）。

## 0.7.5：等「深度思索」结束再开盖

判据不是猜的：DSH 的推理行（`@deepseek-ai/dsh-client-ui-chat` 的 `ReasoningRow`）就是
`<div data-variant="think" data-state={running ? 'running' : 'ok'}>`，`running` = "这一块还是
流式尾巴"；一出现正文块（或流结束）就翻成 `ok`。**data 属性、与构建哈希无关**。

为什么必须有这一条：思索期间页面上照样有文本在变 —— 除了推理预览（可以按类名排除），
还有**过程行**「正在分析请求 / 正在读取文件 / 正在调用工具」（源码里的 `message.stepProcess.*`），
它们在推理行**外面**，所以「页面文本在长」这条兜底判据会在模型还没想完时就成立。

`?send=1&think=1` 在预览页里照实机造出这两行（推理行 `data-state="running"` + 每 400ms
长一次的过程行），并且**不造 `_markdown_…` 容器**，逼判据走那条会误触发的兜底路径。
两个关键时刻的真实回报：

```text
send-thinking（5.8s，还在想）
  reasoning        running=true  state="running"  processText=90
  lidStarted=false  lidRevealed=false  cookerHidden=false      ← 电饭煲保持原样
  cookerRect       [755, 54, 91, 82]                           ← 位置尺寸都没动
  probe            reasoningRunning=true held=true armed=true usingAnswerContainer=false

send-lid（8s，想完了）
  reasoning        running=false state="ok"  processText=5
  lidStarted=true   cookerHidden=true
  lid 内容框        left=755, bottom=136.4, width=91            ← 原地替换那口锅
  debug 时间线      watch-output → output-held-reasoning → girl-ended
                    → reasoning-ended → output-detected → lid-play
```

最后那条时间线就是这次修改的全部：**先按住，等推理行翻成 `ok`，同一条判据立刻成立** ——
按住期间基线 / 峰值 / 静默时刻一个字都没改，所以开盖不会因此变晚。

回归防线是 `test/widget-harness.mjs` 的第 41 组（改写成"正文长出来但推理行还 `running`
时不许播"）与新增的第 48 组（过程行一直长也一样按住，且电饭煲那一块零变化；把推理行
翻成 `ok` 后下一拍就播）。为了能这么测，DOM stub 的选择器引擎补上了**复合属性选择器**
与**后代组合器**，并加了 `removeAttribute`（React 用 `undefined` 表达"这个 data 属性没了"）。

## 发送联动（0.7.0）

`?send=1` 会在预览页里造一个假的 DSH 编辑器（一颗 `aria-label="发送消息"` 的按钮
+ 一个 textarea）和一段会变长的"回答"，然后**用真按钮点一下**驱动整套流程。
实测（无头 Edge + 真实路由）：

```text
阶段                    phase   小女孩/开盖                          按钮            计时器   文案
send-before             idle    —                                    在女孩身上      —       —
send-girl-playing       girl    219x123 内容框=[608,38,727,960]        在女孩身上      —       —
send-after-girl         laid    已隐藏 (display:none)                搬到电饭煲上方  00:01   蓝色 rgb(59,130,246)
send-lid                lid     开盖 253x142 未静音 t=1.11            电饭煲上方      00:02   同上
send-final              lid     开盖停在最后一帧 t=4.12              电饭煲上方      00:05   同上
send-lid-ended          lid     开盖停在最后一帧 t=5.065             电饭煲上方      —       —（0.7.4 已收掉）

判断依据（window.__dshcaSend.debug()）：
  15626ms  send-signal    "click"                 ← 命中的是页面按钮，不是挂件自己的控件
  15628ms  watch-output   null                    ← 开始等"正文变长"
  15822ms  output-baseline 57                     ← 思考阶段的文本总长
  20705ms  girl-ended     null                    ← 她那段自然播完（5.042s）
  22475ms  output-detected {"from":69,"to":108}   ← 总长涨了 39 字，超过阈值 24
  22476ms  lid-play       {"muted":false}         ← 开盖起播，而且是带声的
  25997ms  lid-ended      null                    ← 开盖自然播完（5.065s）→ 收掉文案与计时器
```

这一步实测修掉了四个只有真机才暴露的问题：

1. **布局用错了坐标系**：计时器那一列原本挂在块内、用相对坐标，而拆开的瞬间
   （还没被拖过）会把 `getBoundingClientRect()` 的视口值当相对值用，于是跑到
   屏幕中间去。现在这一列挂 `<body>`、统一用视口坐标。
2. **量文本的口径太窄**：原来只量"最长的那一个文本节点"，而真实回答会被拆成很多
   节点、流式输出只让其中一个变长（实测总长 69→108，而最长节点只从 36→42），
   于是漏判。现在量**正文文本总长**。
3. **透明留白没算**：两份新素材的内容只占画幅 38% / 36% 宽，按整幅铺会小得看不见；
   现在和 `idle`/`act` 一样先量 alpha 包围盒再摆。
4. **开盖那段压住了计时器**：`margin-top` 留了负值把它往上拽。当时改成"竖直方向不留
   负值、水平方向用负 margin 抵消左右留白"；0.7.3 起这条已经作废 —— 它不再挂在那一列里，
   而是原地盖在电饭煲上的一层覆盖层（见上面「0.7.3 的三条修复」）。

回归防线是 `test/widget-harness.mjs` 的第 37～40 组：用一套"假 DSH 壳"驱动整条流程，
并覆盖判据的边界（挂件自己的点击不算、停止按钮不算、回车只在确实存在可用发送按钮时
才算、输入法组合中不算、`sendHook:false` 完全不介入、`sendSelector` 优先、
`split:false` 不炸、关闭时监听器与计时器一个不留）。

## 拿到实机 DOM 之后改掉的两条（0.7.1）

第一次交付 0.7.0 时的判据是猜的，用户把实机 Console 里的侦察结果发回来之后发现两处
必须改：

```text
实机锚点
  发送按钮  <button class="RlGAzG_primary" aria-label="发送消息">     ← 精确、稳定
  输入框    <div class="RlGAzG_input" role="textbox"
                 aria-label="发消息或创建任务, / 调用指令, @ 文件或对话">
  思考那一行 <div class="_row_jhda5_16 _3GBCTG_row" role="button">
                 <span>思考</span><span>So the desktop host se…</span>   ← 这里是流式文本！
  回答正文  由 `_markdown_…` 容器渲染
  停止按钮  实机这一版**没有**
```

1. **"开始输出"原来会提前命中**：`_3GBCTG_row` 里的推理内容**也是流式生成的**，
   而 0.7.0 的判据是"全页文本在变长" → 模型刚开口思考，开盖动画就播了。
   现在只量**回答正文容器**（`[class*="_markdown_"]`，并把它从 `_3GBCTG_` 那行里
   排除掉）。壳里也照这个结构造了 `_3GBCTG_row` + `_markdown_…` 做回归：
   推理长到 320 字都不许触发，只有正文变长才触发。
2. **顺带挖出一个更隐蔽的逻辑错**：原来用 `sendLastText === 0` 当"还没取基线"的
   哨兵，可一轮刚开始时正文**确实就是 0 个字** —— 0 是合法基线，于是
   "从零长出来的第一条回答"永远触发不了。现在用一个独立的 `sendHaveBaseline`。
3. **发送按钮改用实机的稳定锚点**：`aria-label` 精确等于"发送消息"优先，文案宽匹配
   兜底；输入框认 `role=textbox` / `contenteditable` / aria 带"发消息"。
   因为实机没有停止按钮，回车那条判据就只依赖"存在一颗可用的发送按钮"。

## 实测时间线（两条节拍）

`?idle=1` 的页面每 50ms 采样一次，只在"画面换人"时记一笔，放进 `window.__timeline`；
`window.__clipPlays` 是累计起播次数，`window.__fallsBack` 记录"动画出过画之后
又退回开场定格帧"的时刻。用 `test/cdp-eval.mjs` 取回来的一次完整记录：

```text
起播次数  idle=4  act=1

t=12.3s  idle            ← 拆完后的第一拍（idleEvery 5s）
t=17.5s  idle(holding)   ← 播完停在它自己的末帧（0.5.1 及以前这里是 frozen）
t=22.4s  idle            ← 第二拍
t=27.6s  idle(holding)
t=32.4s  idle            ← 第三拍
t=37.6s  idle(holding)
t=42.4s  idle            ← 第四拍
t=47.7s  idle(holding)
t=52.4s  act             ← 动作那一拍（与 idle 的第 8 拍同时到点 → 动作优先）

one-picture violations = []      fallsBack = []
```

要点：

- 每段都**完整播完**、播完**停在自己的末帧**，`holding` 与 `playing` 交替出现
  —— `frozen`（开场定格帧）在首拍之后就再没出现过；
- **两段从未同时出现**（`showing` 里从来没有过 `idle+act`）；
- 起播比例就是 5 秒 : 15 秒该有的样子；
- 5 秒与 15 秒每 15 秒必然同时到点，那一次固定由动作动画上（`t=52.4s` 那笔）。

## 暂停不再露馅（0.5.0 修的 bug）

`e2e.png` 对应的四步快照由页面写进 `window.__result`：

```text
步骤                层在否  该层 paused  定格帧可见
idle-running        在      false       false   ← 动画在出画
after-pause-click   在      true        false   ← 修的就是这一格：冻住，且不露下层
after-resume-click  在      false       false   ← 节拍继续（0.6.0 起画面也不撤）
after-replay-click  不在    —           —       ← 层退场，两块合回整体
```

关键在第二行：暂停时**层还在、画面冻在当前这一帧、下层的定格帧保持隐藏**。
旧实现那一格是「定格帧可见 = true」—— 画面会从"某个动作"一跳回到开场最后一帧。

## 屏幕上永远有且仅有一段画面（0.5.1 修的 bug，0.6.0 扩到"播完之后"）

用户报的现象是"按了继续之后，别的动画再也没出现过，屏幕上像是被某一格顶住了"。
根因：暂停时冻住的那一格**既不会有 `ended`（永远不会自然收工），又被判成"正在出画"**，
于是之后每一拍都被当成"已经有人在出画，跳过" —— 排期还在跑，但画面永远不动了。

修法是把"谁在屏幕上"收成唯一判据 `shownKind`，由 `showOnly()` 统一维护；
继续时放掉 `activeSlot`（不再占排期的位），下一拍照常起播。
**0.6.0 起 `showOnly()` 手里没有新画面时不再交还定格帧，而是保留上一段那格**
（它已经 `ended`、停在末帧），于是这条不变量还多覆盖了"两拍之间"。

预览页每 50ms 用**真实 `style.visibility` + canvas 状态**数一遍"屏幕上有几段画面"，
越界就记进 `window.__violations`，退回开场定格帧就记进 `window.__fallsBack`。
0.7.3 起这一遍还**算上跑出动画**（她演的时候那一格必须是 `girl-clip` 且只有一段），
而事件 1 收尾之后整个右块是 `display:none`，那一侧没有画面可言，记作 `girl-hidden`。
`?sched=1` 会在 1s / 4s / 13s / 16s 各点一次「暂停 / 继续」，跑完一条完整状态机，实测：

```text
t=12.1s  idle(playing)   ← 第 1 拍
t=16.4s  idle(paused)    ← 暂停：原样冻住，仍是这一段
t=19.4s  idle(holding)   ← 继续：排期的位放开，画面不撤（0.5.1 及以前这里是 frozen）
t=24.4s  idle(playing)   ← 节拍照常起播（修复前这里再也不会动）
t=25.2s  idle(holding)   ← 再暂停
t=25.4s  idle(holding)   ← 再继续
t=36.5s  idle(playing)
t=46.5s  act(playing)    ← 动作那一拍也照常轮到

one-picture violations = 0      fell back to the opener frame = 0      plays idle=3 act=1
```

回归防线在 `test/widget-harness.mjs`：`assertSinglePicture()` 会在每个场景
（拆分瞬间 / 起播 / 播完 / 暂停 / 继续 / 交接 / 出错 / 各开关）断言
"可见的动画数 + 定格帧可见性 == 1"，自由跑动的四分钟里还会额外断言
"刚播完的那一格仍然可见、且 `currentTime` 正好等于 `duration`、画面没有退回定格帧"。
把旧逻辑放回去，这些断言会立刻失败 —— 已实际回退验证过。

## 动画间隔（0.6.0 新增）

控制条上的 `⇄` 档位按钮与设置面板里「动画间隔」滑杆改的是同一个倍率，
两条节拍**同比缩放**（乘法），并写进 `dsh-corner-anim:speed:v1`。

`?speed=1` 会把这两条路都真点一遍，实测（无头 Edge + 真实路由）：

```text
阶段                 按钮标签   滑杆值   面板读数
speed-before         ⇄1×       500      1×（待机 5s / 动作 15s）
speed-step-2x        ⇄2×       750      2×（待机 10s / 动作 30s）      stored=2
speed-step-4x        ⇄4×       1000     4×（待机 20s / 动作 1min）      stored=4
speed-slider-min     ⇄0.25×    0        0.25×（待机 1.3s / 动作 3.8s）  stored=0.25
speed-slider-max     ⇄4×       1000     4×（待机 20s / 动作 1min）      stored=4
```

要点：

- 滑杆是**对数刻度**（0 ~ 1000，中点是 1×），所以 2× 落在 750、0.25× 落在 0；
- 0.25× 时待机 1250ms、动作 3750ms —— 下限就是宿主认可的 1 秒，读数如实反映；
- 改间隔的那一刻**只有节拍长度变**：`idle.webm` 还在原处继续播（`currentTime` 单调增），
  没有重新加载、没有被暂停；
- 重新打开页面时存储里的倍率直接生效，并决定**第一拍**的时间。

## 素材事实（ffprobe / 无头 Chromium 实测）

| | `assets/anim.webm`（开场） | `assets/idle.webm`（待机） | `assets/act.webm`（动作） |
| --- | --- | --- | --- |
| 分辨率 | 2560 × 1440 | 1440 × 1920 | 1440 × 1916 |
| 视频轨 | VP9 | VP9 | **VP8** |
| 时长 | 6.087 s | 5.048 s | 5.003 s |
| 体积 | 6 438 836 B | 5 032 886 B（抽音轨前 5 097 405） | 2 819 496 B |
| 音轨 | Vorbis（元素 `muted`） | 无（已 `-c copy -an`） | 无（素材本身无声） |
| 内容包围盒 | 拆完小女孩那块 = 源像素 `[1340, 40, 900, 1280]` | `[135, 93, 1259, 1728]` | 运行时量 |
| 浏览器 alpha | 68.34% 透明，四角 alpha=0 | 47.18% 透明，四角 alpha=0 | 透明通道有效（同左量法） |

0.8.0 / 0.9.0 新增的两条音频与那张图片（都不是 webm，所以不在上表里）：

| | `assets/pipe.mp3`（钢管） | `assets/basin.mp3`（钢盆） | `assets/basin.png`（盆） |
| --- | --- | --- | --- |
| 来源 | 用户提供的 `钢管.mp3` | 用户提供的 `钢盆.mp3` | 用户提供的 `盆（透明.png` |
| 处理 | `tools/audio-trim.mjs` 按帧边界裁掉开头 2.840s 静音 | 只去掉 50 字节 ID3 头（开头本来就没有静音） | 只保留最大连通域（去掉右下角生成水印）+ 收紧包围盒 |
| 体积 | 83 949 → 39 168 B | 25 754 → 25 704 B | 1 055×626 → 1 006×577（437 030 → 398 616 B） |
| 时长 / 尺寸 | 2.448 s（48 kHz 立体声，峰值 1.0） | 1.045 s（48 kHz 立体声，峰值 0.84） | PNG RGBA，铺进一个盒子（内容框 = 图本身） |

> 提醒：`ffmpeg` 的**解码**结果里 alpha 全是不透明的（这份构建不带 VP9/VP8 alpha
> 输出），但浏览器（Chromium 的 VP9/VP8 解码器）能正确还原透明通道 ——
> 所以判断"透明是否还在"必须用浏览器量，别只看 ffmpeg 导出的帧。

> 两条动画的时长（5.048 / 5.003）也写进了 `test/widget-harness.mjs` 的 stub，
> 所以"停在末帧"那条断言是按真实 `duration` 位置验的。
