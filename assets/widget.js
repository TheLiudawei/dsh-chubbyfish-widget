/**
 * dsh-corner-anim —— 客户端半区（Client half）
 * ---------------------------------------------------------------------------
 * 一个直接插进 DSH 页面的经典脚本（无构建步骤、零依赖、不碰 React 内部状态）。
 * 宿主半区（lib/index.js）负责注入与素材路由；本文件负责页面上的一切。
 *
 * 它做什么（按时间线）：
 *   1. 视口角落（默认右上角）挂一个透明 <video>，随 DSH 打开自动播放一次；
 *   2. 播完**停在最后一帧**（不 loop、不淡出、不自动移除）；
 *   3. 按最后一帧的 alpha 把画面**拆成「左电饭煲 / 右小女孩」**两块各自可拖的部分
 *      （电饭煲停在帧内原位，小女孩贴住窗口右边缘、整块完整可见）；
 *   4. 拆完启动**排期器**：待机动画每 5 秒、动作动画每 15 秒轮流出画，
 *      同一时刻只播一段（撞车动作优先、正在播不打断、错过的拍跳过），
 *      每段播完停在自己的末帧；间隔倍率可在控制条/面板调整；
 *   5. 「发送消息」联动：点发送 → 小女孩演一段（独占画面）→ 演完按钮搬到
 *      电饭煲上方、显示文案 + 计时器；**一轮对话完整结束**（宿主 turn/end 信号，
 *      不可用时退回正文增长探测）→ 电饭煲原位播开盖动画（带声）、收掉计时器，
 *      点击停在末帧的开盖画面则复位回拆分态；
 *   6. 拆开后的两块各带「点击 Q 弹」：按住把当前帧拍成快照压扁，松开弹回并
 *      从暂停处继续；按压出一声现场合成的软弹音，电饭煲另有 7% 概率改响
 *      随包的「钢管」彩蛋音（两者共用内置 CD，永不叠音）；
 *   7. 按压小女孩有 10% 概率**从天而降一个钢盆**扣在她头上，可以一直摞、
 *      拖动时跟着走、拖到一旁摘掉；
 *   8. 拖小女孩时循环播放「拖动动画」，松手立刻切回她原来的画面；
 *   9. 点击电饭煲先掷两个**互斥**的骰子：20% 动画1（开盖·空锅，播完倒放回原样）、
 *      10% 动画2（开盖·米饭热气：她演钢盆扣头、锅在 5 秒内追过去，
 *      逐帧判定矩形相交即接触、双方立刻复位），都没中才走点击 Q 弹。
 *
 * 三条贯穿全文件的设计约束：
 *   · 幂等 —— `window.__dshCornerAnimMounted` 守卫，脚本被注入两次也只有一个挂件；
 *   · 「屏幕上永远有且仅有一段画面」—— 唯一判据是 `shownKind`（哪一路该出画），
 *     所有显隐变化都收口在 `showOnly()`，绝不接受"层挂没挂上"之类的间接推断；
 *   · 动画的摆放一律按**内容包围盒**（读 alpha 量出来），而不是素材画幅 ——
 *     各素材的内容占比 36%~100% 不等，按画幅铺必然出错。
 *
 * 代码分节（自上而下）：
 *   §1 配置与常量        §2 本地存储        §3 样式（CSS）
 *   §4 DOM 引用与运行状态                    §5 几何工具
 *   §6 可拖动单元        §7 设置面板（大小/间隔）
 *   §8 开场动画：播放/定格/拆分入口
 *   §9 动画层与排期器（idle/act 两路节拍）
 *   §10 拆分：找分割线与两块的摆放
 *   §11 按压音效（合成音 + 钢管彩蛋 + CD）
 *   §12 点击 Q 弹（压扁/回弹快照）
 *   §13 掉盆（钢盆摞高/拖摘）
 *   §14 电饭煲的两种随机动画（动画1 倒放 / 动画2 追击）
 *   §15 拖动动画
 *   §16 发送联动（状态机 / DOM / 计时器 / 开盖）
 *   §17 turn/end 信号与正文增长兜底
 *   §18 发送按钮识别与钩子
 *   §19 发送调试入口（__dshcaSend）      §20 控制条
 *   §21 挂载/启动/销毁
 * 每个功能节的尾部各暴露一个调试入口：__dshcaPress / __dshcaPots / __dshcaRandom。
 *
 * 各版本的修复记录见仓库 README 与 package.json 的 description；
 * 代码注释只保留"为什么"（约束、坑、判据），不复述"什么时候改的"。
 */

;(function () {
  'use strict'

  if (window.__dshCornerAnimMounted) return
  window.__dshCornerAnimMounted = true

  var CFG = window.__DSH_CORNER_ANIM_CONFIG__ || {}

  var MEDIA_URL = '/dsh-corner-anim/anim.webm'
  var IDLE_URL = '/dsh-corner-anim/idle.webm'
  var ACT_URL = '/dsh-corner-anim/act.webm'
  var POS_KEY = 'dsh-corner-anim:pos:v1'
  var SIZE_KEY = 'dsh-corner-anim:size:v1'
  var PANEL_KEY = 'dsh-corner-anim:panel:v1'
  var SPEED_KEY = 'dsh-corner-anim:speed:v1'
  var PART_POS_PREFIX = 'dsh-corner-anim:pos:'

  /** 拖动时至少保留多少像素留在视口内，避免把挂件拖到完全找不回来。 */
  var MIN_VISIBLE = 56
  /**
   * 小女孩"贴住窗口右边缘"时**兜底**的那条细缝（px）。
   *
   * 她的**动画层**是按"内容包围盒"贴合那一块的，而内容通常比裁切框略宽 ——
   * 实际需要留多少由 `girlSideGap()` 按当前布局现算（溢出随显示宽度线性放大，
   * 写死 2px 在调大挂件后会让待机/动作动画被窗口边框切掉一条，0.10.2 修的漏洞）。
   * 这里保留的 2px 只是"量不到任何数据时"的兜底值。
   */
  var GIRL_EDGE_GAP = 2
  /** 位移小于该阈值视为点击而非拖动。 */
  var DRAG_THRESHOLD = 3
  /** 元数据迟迟不来时的兜底展示时间。 */
  var REVEAL_TIMEOUT = 4000
  /** 面板与视口边缘、与宿主之间留的间距。 */
  var GAP = 6
  var EDGE = 8
  /** 分割线探测用的低分辨率画布宽度（内容包围盒也用它）。 */
  var PROBE_WIDTH = 256
  /**
   * 动画间隔的倍率范围（1 = 用配置里的 idleEvery / actEvery）。
   *
   * 倍率做成**乘法**而不是直接改毫秒，有两个好处：配置改了（比如 idleEvery: 8000）
   * 倍率依然成立；用户在面板里调过之后也能一眼看出"比默认快/慢了多少"。
   * 两条节拍的 1:3 比例因此永远保持 —— 待机 5s / 动作 15s 调成 2× 就是 10s / 30s。
   */
  var SPEED_MIN = 0.25
  var SPEED_MAX = 4
  /** 控制条按钮循环的档位（从小到大，到顶回卷）。 */
  var SPEED_STEPS = [0.5, 1, 2, 4]
  var SPEED_DEFAULT = 1
  /** 周期下限/上限，与宿主里 normalizeConfig 的 idleEvery/actEvery 一致。 */
  var PERIOD_MIN = 1000
  var PERIOD_MAX = 3600000

  function num(value, fallback) {
    var n = typeof value === 'number' ? value : parseFloat(value)
    return isFinite(n) ? n : fallback
  }

  function clamp(value, min, max) {
    if (max < min) max = min
    return Math.min(Math.max(value, min), max)
  }

  function nextFrame(fn) {
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(function () { fn() })
    else fn()
  }

  /* ------------------------------------------------------------------ */
  /* §1 配置与常量                                                       */
  /* ------------------------------------------------------------------ */

  var OFFSET_X = num(CFG.offsetX, 20)
  var OFFSET_Y = num(CFG.offsetY, 20)
  var OPACITY = num(CFG.opacity, 1)
  var CORNER = typeof CFG.corner === 'string' ? CFG.corner : 'top-right'
  var DRAGGABLE = CFG.draggable !== false
  var SHOW_CONTROLS = CFG.showControls !== false
  var REMEMBER_POSITION = CFG.rememberPosition !== false
  var SPLIT = CFG.split !== false
  var SPLIT_AUTO = CFG.splitAutoDetect !== false
  var SPLIT_RATIO = clamp(num(CFG.splitRatio, 0.5), 0.05, 0.95)
  /**
   * 小女孩那块的动画排期：
   *   · 待机动画（idle.webm）每 5 秒起播一次；
   *   · 动作动画（act.webm）每 15 秒起播一次；
   *   同一时刻只播一段，撞车时动作优先，正在播的那段不被打断。
   *
   * 上面两个"每 N 秒"是**配置里的基准值**（*_BASE）；实际节拍 = 基准 × SPEED，
   * SPEED 由控制条档位按钮 / 面板滑杆调整（见「动画间隔」一节）。
   */
  var IDLE = CFG.idle !== false
  var IDLE_SCALE = clamp(num(CFG.idleScale, 1), 0.1, 10)
  var IDLE_BASE = clamp(num(CFG.idleEvery, 5000), PERIOD_MIN, PERIOD_MAX)
  var ACT = CFG.act !== false
  var ACT_SCALE = clamp(num(CFG.actScale, 1), 0.1, 10)
  var ACT_BASE = clamp(num(CFG.actEvery, 15000), PERIOD_MIN, PERIOD_MAX)

  var MIN_WIDTH = Math.round(clamp(num(CFG.minWidth, 80), 48, 2000))
  var MAX_WIDTH = Math.round(clamp(num(CFG.maxWidth, 600), MIN_WIDTH, 4000))
  /** 配置里的默认宽度：面板「重置」会回到这里。 */
  var CONFIG_WIDTH = Math.round(clamp(num(CFG.width, 220), MIN_WIDTH, MAX_WIDTH))

  /* ------------------------------------------------------------------ */
  /* 「发送消息」联动（0.7.0）                                             */
  /* ------------------------------------------------------------------ */
  /*                                                                     */
  /* 一个纯页面脚本没法读 DSH 的 React 内部状态，所以这一节全部靠**观察 DOM**。
  /* 两处关键判断与它们的兜底依次是：                                      */
  /*   ① 用户点了「发送消息」：显式选择器 → 语义打分（文案/aria/表单归属）  */
  /*      → 输入框里的回车（且确实存在一个"可用的发送按钮"）；              */
  /*   ② 模型思考完、开始输出：新出现的回答里出现**正文流式增长**。        */
  /*     思考阶段与输出阶段的区别就是"文本有没有在长"，这条不依赖任何 class */
  /*     名，所以 DSH 改版也不会让它失效。                                 */
  /* 命中不了时不会静默：`window.__dshcaSendDebug` 会留下每次判断的依据。   */
  /* ------------------------------------------------------------------ */

  var SEND_HOOK = CFG.sendHook !== false
  /** 用户给的逃生门：显式选择器（留空 = 走语义探测）。 */
  var SEND_SELECTOR = typeof CFG.sendSelector === 'string' ? CFG.sendSelector.trim() : ''
  var SEND_GIRL_SCALE = clamp(num(CFG.sendGirlScale, 1), 0.1, 10)
  var SEND_LID_SCALE = clamp(num(CFG.sendLidScale, 1), 0.1, 10)
  var SEND_LABEL = typeof CFG.sendLabel === 'string' && CFG.sendLabel ? CFG.sendLabel : '肥鱼已经煮饭：'
  var SEND_LABEL_COLOR =
    typeof CFG.sendLabelColor === 'string' && CFG.sendLabelColor ? CFG.sendLabelColor : '#3b82f6'
  /** 开盖视频是否放声（素材本身保留了音轨）。 */
  var SEND_LID_AUDIO = CFG.sendLidAudio !== false

  var GIRL_CLIP_URL = '/dsh-corner-anim/girl.webm'
  var LID_CLIP_URL = '/dsh-corner-anim/lid.webm'

  /* --- 0.10.2：「一轮对话完整结束」信号（turn.json 轮询） ----------------- */
  /**
   * 开盖动画的触发条件从"正文开始增长"改为「**这一轮完整结束**」——
   * 与 dsh-whale-widget 弹「本次消费金额」泡泡是同一个触发点：宿主监听
   * `session/event`，看到 `turn/end` 就把 `seq` +1；这里每秒轮询一次
   * `/dsh-corner-anim/turn.json`，`seq` 变大即触发。
   *
   * 为什么换触发点：正文开始增长只说明"开始写答案"，之后还有工具调用、
   * 多步推理，正文一停（甚至短回答一冒头）旧判据就开盖 —— 饭还没焖好就把锅
   * 掀了。turn/end 才是"这一轮真的结束了"（whale 的消耗金额也只在那一刻结算），
   * 计时器从发送一直跑到那一刻，开盖即收工。
   *
   * 兜底：路由连续不可达（旧宿主 / 事件流缺失）时，退回旧的"正文增长"探测，
   * 开盖不会永远不播（见 armTurnWatch / startLegacyOutputWatch）。
   */
  var TURN_URL = '/dsh-corner-anim/turn.json'
  var TURN_POLL_MS = 1000
  /** 轮询连续失败这么多次才判定"宿主给不了信号"，退回旧探测。 */
  var TURN_FAIL_LIMIT = 3

  /* --- 0.10.0 的三份新素材 ------------------------------------------- */
  /** 拖动动画（用户给的 transparent_chibi，1112x834，5.542s）：拖小女孩时循环出画。 */
  var DRAG_URL = '/dsh-corner-anim/drag.webm'
  /** 动画1 电饭煲开盖 · 空锅（960x960，5.065s，**带原始音轨**）。 */
  var LID_EMPTY_URL = '/dsh-corner-anim/lid-empty.webm'
  /** 动画2 电饭煲开盖 · 米饭热气（960x960，5.065s，**带原始音轨**）。 */
  var LID_RICE_URL = '/dsh-corner-anim/lid-rice.webm'
  /** 动画2 里小女孩那一段（1280x720，5.042s，无声）：钢盆扣头 + 张望。 */
  var GIRL_BASIN_URL = '/dsh-corner-anim/girl-basin.webm'

  /** 点发送之后到"开始输出"之间，最多等这么久（毫秒），超时就放弃这一轮。 */
  var SEND_OUTPUT_TIMEOUT = 600000
  /** 观察输出阶段的采样间隔：太小会拖慢页面，太大就抓不到"刚开始输出"。 */
  var SEND_WATCH_INTERVAL = 180
  /**
   * 正文"有变化之后静了这么久"就算开始输出（见 checkForOutput 的判据 ②）。
   * 这一条是为**短回答**准备的：它可能永远长不到阈值那么多字。
   */
  var SEND_SETTLE_MS = 1200
  /**
   * 一次"正文在长"至少要长这么多字符才算输出。
   *
   * 刻意取小（2）：它只是个"确实有输出"的门槛，**时机**交给静默窗口决定。
   * 取大（原来的 24）会让"只回一句短话"的那一轮永远不触发 —— 用户报的问题 1。
   */
  var SEND_TEXT_GROWTH = 2

  /* ------------------------------------------------------------------ */
  /* 点击 Q 弹（按住压扁 / 松开弹回）                                       */
  /* ------------------------------------------------------------------ */
  /*                                                                     */
  /* 与 dsh-whale-widget 的「按压 Q 弹」同一套做法：按下时把画面压扁        */
  /* （scaleY .88 / scaleX 1.05，支点在底部中线），松开时用一条带回弹的     */
  /* 缓动弹回原状。                                                        */
  /*                                                                     */
  /* 与被拉伸的"那一帧"的关系（需求里明确的一条）：按下那一刻**先把当前     */
  /* 视频暂停**、把它正显示的那一帧拍进一张快照 canvas —— 于是按住期间被     */
  /* 拉伸的永远只是"按下时的画面"，不会继续走动；松开（回弹过渡结束）之后   */
  /* 再把快照撤掉、把原来的画面放回来，并**从暂停处继续播放**（按下那一刻   */
  /* 本来就没在播的，就不接）。                                            */
  /*                                                                     */
  /* 两条刻意划出的边界（用户明确选的）：                                   */
  /*   · 只对拆分后的「左电饭煲 / 右小女孩」两块生效，合并态不参与；         */
  /*   · 发送联动的两段（girl.webm 跑出 / lid.webm 开盖）播放期间不参与 ——   */
  /*     那两段有自己的时序（演完要搬按钮 / 收计时器），点按不该把它们按住。 */
  /* ------------------------------------------------------------------ */

  var CLICK_SQUISH = CFG.clickSquish !== false
  /** 压扁的形状与支点：与鲸鱼挂件一致（底部不动，横向微微胀开）。 */
  var SQUISH_DEPTH = 'scaleY(0.88) scaleX(1.05)'
  var SQUISH_ORIGIN = '50% 100%'
  /**
   * 回弹过渡的时长（毫秒）。比 CSS 里的 .22s 略长一点：
   * 到点才把快照撤掉、把视频接回去，宁可晚一帧也不要在回弹途中露出硬边。
   */
  var SQUISH_SETTLE_MS = 260

  /* ------------------------------------------------------------------ */
  /* 按压音效（0.8.0）                                                     */
  /* ------------------------------------------------------------------ */
  /*                                                                     */
  /* 两个音源，一次按压只会响其中一个：                                     */
  /*   · 普通：**现场合成**的短促"软弹"音（一段快速下滑的音高 + 指数衰减），  */
  /*     不需要素材 —— 只用 Web Audio 的振荡器与增益节点；                  */
  /*   · 彩蛋：电饭煲那一侧有 pipeChance 的概率改放 `pipe.mp3`（"钢管"）。   */
  /*                                                                     */
  /* **内置 CD**（用户要求"避免多个音效叠加播放"）由两条判据合起来实现：      */
  /*   ① 上一个音还在响（`soundBusyUntil`）→ 这一次直接不出声；             */
  /*   ② 距上一次**起播**不足 PRESS_SOUND_GAP → 也不出声（防抖：合成音只有  */
  /*      0.17 秒，没有这一条就能被连点成机关枪）。                        */
  /* 两条都是"整次按压静音"，不会出现半声、也不会重叠。                      */
  /*                                                                     */
  /* 自动播放策略：AudioContext 在**第一次按压时**才创建并 resume —— 那一刻  */
  /* 就是用户手势，所以不会被拦；也避免开页面就建上下文的控制台警告。        */
  /* ------------------------------------------------------------------ */

  var PRESS_SOUND = CFG.pressSound !== false
  /** 音效总音量（0~1）：合成音的峰值与钢管音的 gain 都乘它。 */
  var PRESS_VOLUME = clamp(num(CFG.pressVolume, 0.6), 0, 1)
  /** 按压电饭煲时改用"钢管"那条彩蛋音的概率（0 = 永远不用，1 = 每次都用）。 */
  var PIPE_CHANCE = clamp(num(CFG.pipeChance, 0.07), 0, 1)
  /** 两条 CD 判据之一：两次**起播**之间的最小间隔（毫秒）。 */
  var PRESS_SOUND_GAP = 150
  /** 合成音从起播到衰减结束的时长（毫秒），也当作它占用 CD 的时间。 */
  var PRESS_SYNTH_MS = 170
  var PIPE_URL = '/dsh-corner-anim/pipe.mp3'
  /**
   * "钢管"彩蛋音相对 `pressVolume` 的倍率（用户要求"调小一半" → 0.5）。
   *
   * 单独给它一个倍率而不是直接压低 `pressVolume`：普通按压的合成音本来就做得
   * 很轻（峰值 0.22），而钢管素材的峰值是 1.0 满刻度 —— 两个一起调小会把普通
   * 按压音直接调没。
   */
  var PIPE_GAIN = PRESS_VOLUME * clamp(num(CFG.pipeVolume, 0.5), 0, 1)

  /* ------------------------------------------------------------------ */
  /* 掉盆：点击小女孩的随机事件（0.9.0）                                    */
  /* ------------------------------------------------------------------ */
  /*                                                                     */
  /* 按压小女孩时掷 POT_CHANCE；掷中就让一个倒扣的钢盆从天而降、扣在她头上， */
  /* 盆到头顶那一刻响 `basin.mp3`。盆可以不断摞高（每个比下面那个高一点、   */
  /* 带一点随机偏移与倾角），也可以拖到一旁摘掉（离原位够远就消失，剩下的   */
  /* 重新摞下去）。                                                        */
  /*                                                                     */
  /* 几何全部**按小女孩那一块的宽高比例**算（实测自真实素材，见             */
  /* tools/probe-head.mjs）：她的定格帧裁切是 900×1280、头顶就在最上沿，    */
  /* 所以盆比那一块还宽一点（108%）—— 参考图里就是一只"整个扣住脑袋"的大盆， */
  /* 下沿落在块高的 40%（大约在她眉毛处），再顺时针倾 9°（参考图里右侧偏低）。 */
  /* 这样换显示尺寸 / 换窗口都不需要重算常量。                              */
  /* ------------------------------------------------------------------ */

  var POT_CHANCE = clamp(num(CFG.potChance, 0.1), 0, 1)
  var POT_URL = '/dsh-corner-anim/basin.png'
  var POT_SOUND_URL = '/dsh-corner-anim/basin.mp3'
  /** 盆素材的宽高比（裁剪后的 1006×577）。 */
  var POT_ASPECT = 1006 / 577
  /** 盆宽 = 小女孩那一块的宽度 × 它（>1 = 比她那一块还宽，盆沿会飞出去）。 */
  var POT_WIDTH_RATIO = 1.08
  /** 盆的**下沿**落在那块高度的这个比例处（从顶往下量，0.40 ≈ 她的眉毛）。 */
  var POT_RIM_RATIO = 0.4
  /** 基础倾角（度，正值 = 右侧偏低，与参考图一致）。 */
  var POT_TILT = 9
  /** 每次落点的倾角 / 水平抖动 —— 摞起来才不像复制粘贴。 */
  var POT_TILT_JITTER = 5
  var POT_OFFSET_JITTER = 0.035
  /** 摞盆时每多一个往上抬多少（相对盆高）。 */
  var POT_STACK_STEP = 0.22
  /** 最多同时挂几个（挡住"被脚本点到几十个"这种情况）。 */
  var POT_MAX = 12
  /** 掉落时长（毫秒）与起点在头顶上方多高（相对盆高）。 */
  var POT_FALL_MS = 420
  var POT_FALL_RATIO = 3.4
  /** 拖离原位超过"块宽 × 它"就算摘掉；不到就弹回原位。 */
  var POT_REMOVE_RATIO = 0.6
  /** 摘掉时的淡出时长（毫秒）。 */
  var POT_REMOVE_MS = 220

  /* ------------------------------------------------------------------ */
  /* 电饭煲的两种随机动画 + 拖动动画（0.10.0）                              */
  /* ------------------------------------------------------------------ */
  /*                                                                     */
  /* 一次"点击电饭煲"最多触发一件事，三个结果的概率加起来是 1：            */
  /*   · 动画1（随机动画 A）：概率 RANDOM_A_CHANCE，默认 20%               */
  /*   · 动画2（随机动画 B）：概率 RANDOM_B_CHANCE，默认 10%               */
  /*   · 剩下的 70%：什么都没掷中 —— 走 0.8.0 那套"点击 Q 弹 + 按压音效"。 */
  /* 两者天然互斥：第一次骰子先决定"是不是 A"，只有不是 A 才去问 B。       */
  /*                                                                     */
  /* 动画1：正常播放，播完**立即倒放回第 0 帧**（倒放本身就是要的"变回原样" */
  /*        的过程），倒放一结束就把画面交回电饭煲原来那格定格图。          */
  /* 动画2：小女孩演 girl-basin 那段（钢盆扣在头上、左右张望），**同时**    */
  /*        电饭煲在 RANDOM_FLIGHT_MS 之内沿直线向她移动；两块矩形一相交    */
  /*        就算接触 —— 那一刻电饭煲立刻归位、她也交回自己的定格图。        */
  /*        接触判据是**逐帧**算的（rAF），所以"移动是渐进的、接触是瞬时的" */
  /*        这件事在时间轴上真的成立，而不是靠一个定时器假装。              */
  /* ------------------------------------------------------------------ */

  /** 两份随机动画素材在这一块上的显示倍率（1 = 内容宽贴齐这一块的宽）。 */
  var RANDOM_A_CHANCE = clamp(num(CFG.randomAChance, 0.2), 0, 1)
  var RANDOM_B_CHANCE = clamp(num(CFG.randomBChance, 0.1), 0, 1)
  var RANDOM_ENABLED = CFG.randomAnims !== false
  /** 小女孩那段在**接触时刻**相对她自己那一块的高度比例（"移动 = 降采样"）。 */
  var RANDOM_CONTACT_SCALE = clamp(num(CFG.randomContactScale, 0.95), 0.3, 2)
  var RANDOM_A_SCALE = clamp(num(CFG.randomEmptyScale, 1), 0.1, 10)
  var RANDOM_B_SCALE = clamp(num(CFG.randomRiceScale, 1), 0.1, 10)
  /** 电饭煲飞过去的上限时长（毫秒）。接触更早发生就提前收工。 */
  var RANDOM_FLIGHT_MS = Math.round(clamp(num(CFG.randomFlightMs, 5000), 600, 20000))
  /** 直线上采样多少个点找"最接近她"的时刻（移动 = 降采样，见 flightTransform）。 */
  var RANDOM_FLIGHT_SAMPLES = 160
  /** 倒放的时长（毫秒）：比正向短一点，手感上更像"迅速合回来"。 */
  var RANDOM_REVERSE_MS = Math.round(clamp(num(CFG.randomReverseMs, 1200), 300, 8000))
  /** 倒放之外的兜底：素材异常时也要把画面交回去（原时长 + 这个余量）。 */
  var RANDOM_REVERSE_GUARD_MS = 3000

  /* ------------------------------------------------------------------ */
  /* 拖动动画（0.10.0）                                                    */
  /* ------------------------------------------------------------------ */
  /*                                                                     */
  /* 参考 VPet 的拖动状态机（`MainDisplay.DisplayRaising`）：拖动期间画面上 */
  /* 是 Raised_Dynamic 那一套（动态），松手后走 C_End 回静态。这里用一段   */
  /* 循环视频对应"动态"：按下（还没越过拖动阈值）就起播、循环着等松手，    */
  /* 一松手立刻把画面交回她原来那一格（用户选的"立刻切回"，不做 C_End）。  */
  /*                                                                     */
  /* 与其它状态的关系：                                                   */
  /*   · 只在拆分态、且这一块**没有**别的专门动画时参与（girlClip /        */
  /*     girl-basin / 发送联动的两段都自动让开）；                        */
  /*   · 拖动期间她的头顶**不放盆**（那段素材自己画着"被拎起来"的样子，    */
  /*     浮在半空的盆会穿帮）；                                           */
  /*   · 排期器这一拍照旧让过去（复用 squishHolding 那条判据），所以松手   */
  /*     之后露出来的不会是"一段已经跳过去的动画"。                       */
  /* ------------------------------------------------------------------ */

  var DRAG_ANIM = CFG.dragAnim !== false
  var DRAG_ANIM_SCALE = clamp(num(CFG.dragScale, 1), 0.1, 10)
  /** 拖动动画的播放倍速（1 = 素材原速）。 */
  var DRAG_ANIM_RATE = clamp(num(CFG.dragRate, 1), 0.25, 4)

  /* ------------------------------------------------------------------ */
  /* 动画间隔（倍率 → 毫秒）                                              */
  /* ------------------------------------------------------------------ */
  /*                                                                     */
  /* 只有两个数：基准（来自配置）与倍率（来自用户）。所有"每 N 秒"的地方   */
  /* 都必须走 effectivePeriod()，绝不能直接用基准值 —— 否则调了档位之后     */
  /* 屏幕上的读数与实际节拍会对不上。                                      */
  /* ------------------------------------------------------------------ */

  /** 倍率标签：`1×` / `2.5×`（小数位按需，最多两位）。 */
  function speedLabelOf(value) {
    var rounded = Math.round(value * 100) / 100
    return String(rounded) + '×'
  }

  /** 毫秒 → 人读的时长：`5s` / `7.5s` / `90s` / `2min`。 */
  function formatMs(ms) {
    var s = Math.round(ms / 100) / 10
    if (s < 60) return s + 's'
    return Math.round((s / 60) * 10) / 10 + 'min'
  }

  /** 实际节拍 = 基准 × 倍率，夹在宿主认可的 [1s, 1h] 之内。 */
  function effectivePeriod(kind) {
    var base = kind === 'idle' ? IDLE_BASE : ACT_BASE
    return Math.round(clamp(base * SPEED, PERIOD_MIN, PERIOD_MAX))
  }

  /* ------------------------------------------------------------------ */
  /* §2 本地存储                                                         */
  /* ------------------------------------------------------------------ */

  function readStored(key) {
    try {
      return window.localStorage.getItem(key)
    } catch (err) {
      return null
    }
  }

  function writeStored(key, value) {
    try {
      window.localStorage.setItem(key, String(value))
    } catch (err) {
      /* storage unavailable — 记住只在本次会话有效 */
    }
  }

  function removeStored(key) {
    try {
      window.localStorage.removeItem(key)
    } catch (err) {
      /* ignore */
    }
  }

  function readStoredPos(key) {
    if (!REMEMBER_POSITION) return null
    var raw = readStored(key)
    if (!raw) return null
    try {
      var parsed = JSON.parse(raw)
      if (parsed && isFinite(parsed.x) && isFinite(parsed.y)) return parsed
    } catch (err) {
      /* corrupted value */
    }
    return null
  }

  function partPosKey(key) {
    return PART_POS_PREFIX + key + ':v1'
  }

  // 记住的尺寸优先于配置默认值，但始终夹在 [MIN_WIDTH, MAX_WIDTH] 内。
  var WIDTH = Math.round(clamp(num(readStored(SIZE_KEY), CONFIG_WIDTH), MIN_WIDTH, MAX_WIDTH))
  var PANEL_OPEN = SHOW_CONTROLS && readStored(PANEL_KEY) === '1'
  // 动画间隔：记住的倍率优先于默认值，始终夹在 [SPEED_MIN, SPEED_MAX] 内。
  // 坏值（"abc" / null）由 num() 吃掉，退回 1×。
  var SPEED = clamp(num(readStored(SPEED_KEY), SPEED_DEFAULT), SPEED_MIN, SPEED_MAX)

  /* ------------------------------------------------------------------ */
  /* §3 样式（CSS）                                                      */
  /* ------------------------------------------------------------------ */

  var STYLE_ID = 'dshca-style'
  var CSS = [
    '#dshca-root,#dshca-root *,.dshca-part,.dshca-part *{box-sizing:border-box}',

    /* 宿主：合并态是 #dshca-root，拆分后是两个 .dshca-part —— 共用同一套定位样式 */
    '.dshca-host{position:fixed;z-index:2147483000;margin:0;padding:0;border:0;',
    'background:transparent;pointer-events:auto;touch-action:none;visibility:hidden;',
    'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;',
    'filter:drop-shadow(0 6px 16px rgba(0,0,0,.28));will-change:left,top}',
    '.dshca-host.dshca-ready{visibility:visible}',
    '.dshca-host.dshca-draggable{cursor:grab}',
    '.dshca-host.dshca-dragging{cursor:grabbing}',

    /* 画面：合并态是 <video>，拆分后是各部分的 <canvas> */
    '#dshca-video,.dshca-part canvas{display:block;width:100%;height:auto;margin:0;',
    'padding:0;border:0;background:transparent;outline:none;pointer-events:none;',
    '-webkit-user-drag:none;user-select:none}',

    /* 播放层：盖在小女孩那块的 canvas 之上（每路一个 <video>），由脚本按
       alpha 包围盒定位。自己绝不接指针事件 —— 拖动仍由整块容器负责。 */
    '.dshca-anim{position:absolute;margin:0;padding:0;border:0;background:transparent;',
    'outline:none;pointer-events:none;-webkit-user-drag:none;user-select:none;',
    'object-fit:fill;display:block}',

    /* 点击 Q 弹的快照层：按下那一刻把"当前这一帧"拍成的一张 canvas，
       与它所在的那一块等大、盖在画面层之上（控制条之下，见 startSquish）。
       自己被压扁 / 弹回全靠 transform，支点固定在底部中线 —— 于是电饭煲
       与小女孩都是"底不动、上面压下去"，跟鲸鱼挂件的手感一致。
       transition 刻意写成回弹曲线（超调后再落回），而不是线性。 */
    '.dshca-squish{position:absolute;left:0;top:0;display:block;margin:0;padding:0;',
    'border:0;background:transparent;pointer-events:none;-webkit-user-drag:none;',
    'user-select:none;transform-origin:' + SQUISH_ORIGIN + ';',
    'transform:scaleY(1) scaleX(1);',
    'transition:transform .22s cubic-bezier(.34,1.56,.64,1)}',
    '.dshca-squish.dshca-squished{transform:' + SQUISH_DEPTH + '}',

    /* 掉盆（0.9.0）：容器整个盖在小女孩那一块上，但它自己**不接指针事件**，
       只有盆本体接 —— 于是"拖盆"与"拖 / 压小女孩"互不打扰。
       z-index 是这套叠放的关键：画面层与点击 Q 弹的快照都是 auto(0)，
       容器是 1（盆永远盖在画面与快照之上 —— 快照里没有盆），控制条 2。 */
    '#dshca-pots{position:absolute;left:0;top:0;width:100%;height:100%;z-index:1;',
    'pointer-events:none}',
    '.dshca-pot{position:absolute;display:block;margin:0;padding:0;border:0;',
    'background-image:url(' + POT_URL + ');background-size:100% 100%;background-repeat:no-repeat;',
    'transform-origin:50% 100%;pointer-events:auto;cursor:grab;',
    'transform:rotate(var(--dshca-pot-tilt,0deg));',
    '-webkit-user-drag:none;user-select:none}',
    '.dshca-pot.dshca-pot-dragging{cursor:grabbing}',

    '#dshca-bar{position:absolute;top:4px;right:4px;display:flex;gap:4px;opacity:0;',
    'z-index:2;transition:opacity .16s ease;pointer-events:none}',
    '.dshca-host:hover #dshca-bar,.dshca-host.dshca-open #dshca-bar{opacity:1;pointer-events:auto}',
    '#dshca-bar button{appearance:none;-webkit-appearance:none;border:0;border-radius:999px;',
    'width:22px;height:22px;padding:0;font-size:11px;line-height:1;cursor:pointer;color:#fff;',
    'background:rgba(20,20,24,.62);display:flex;align-items:center;justify-content:center}',
    '#dshca-bar button:hover{background:rgba(20,20,24,.88)}',
    /* 待机按钮：正在循环时高亮，一眼能看出挂件处在哪个状态。 */
    '#dshca-bar button.dshca-on{background:rgba(94,178,255,.92);color:#08131f}',
    '#dshca-bar button.dshca-on:hover{background:rgba(120,195,255,1)}',

    '#dshca-hint{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;',
    'align-items:center;justify-content:center;cursor:pointer}',
    '#dshca-hint span{width:46px;height:46px;border-radius:999px;background:rgba(20,20,24,.66);',
    'color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;',
    'padding-left:3px;box-shadow:0 2px 10px rgba(0,0,0,.25)}',

    /* 折叠面板 */
    '#dshca-panel{position:absolute;display:none;z-index:2;width:212px;padding:10px;border-radius:12px;',
    'background:rgba(24,24,28,.94);color:#fff;font:12px/1.45 system-ui,-apple-system,',
    '"Segoe UI",Roboto,"Helvetica Neue",sans-serif;text-align:left;',
    'box-shadow:0 10px 28px rgba(0,0,0,.38);border:1px solid rgba(255,255,255,.10);',
    'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);',
    'touch-action:auto;user-select:none;cursor:default}',
    '.dshca-host.dshca-open #dshca-panel{display:block}',
    '#dshca-panel .dshca-head{display:flex;align-items:baseline;justify-content:space-between;',
    'margin:0 0 7px;font-weight:500}',
    '#dshca-panel .dshca-value{opacity:.72;font-variant-numeric:tabular-nums;font-size:11px}',
    '#dshca-panel .dshca-hintline{opacity:.55;font-size:10px;line-height:1.35;margin:-4px 0 4px}',
    '#dshca-panel input[type=range]{-webkit-appearance:none;appearance:none;display:block;',
    'width:100%;height:4px;margin:0 0 9px;padding:0;border:0;border-radius:999px;',
    'background:rgba(255,255,255,.22);outline:none;cursor:pointer}',
    '#dshca-panel input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;',
    'width:14px;height:14px;border:0;border-radius:999px;background:#fff;cursor:pointer}',
    '#dshca-panel input[type=range]::-moz-range-thumb{width:14px;height:14px;border:0;',
    'border-radius:999px;background:#fff;cursor:pointer}',
    '#dshca-panel input[type=range]:focus-visible{outline:2px solid rgba(255,255,255,.55);',
    'outline-offset:3px}',
    '.dshca-presets{display:flex;gap:5px}',
    '.dshca-presets + .dshca-head{margin-top:9px}',
    '.dshca-presets button{flex:1 1 0;appearance:none;-webkit-appearance:none;border:0;',
    'border-radius:8px;padding:5px 0;font-size:11px;line-height:1.3;color:#fff;cursor:pointer;',
    'background:rgba(255,255,255,.12)}',
    '.dshca-presets button:hover{background:rgba(255,255,255,.24)}',
    '.dshca-presets button.dshca-active{background:rgba(255,255,255,.32)}',
    /* 间隔档位按钮比其他按钮宽一点：它显示的是「⇄2×」这种带数字的标签。 */
    '#dshca-bar button.dshca-speed{width:auto;min-width:22px;padding:0 5px;font-size:10px;',
    'font-variant-numeric:tabular-nums}',

    /* ---- 0.7.0：点「发送消息」之后的联动 -------------------------------- */

    /* 小女孩那一段（girl.webm）：按「她原来站的位置」盖在右块之上。 */
    '#dshca-girl{position:absolute;margin:0;padding:0;border:0;background:transparent;',
    'outline:none;pointer-events:none;-webkit-user-drag:none;user-select:none;',
    'object-fit:fill;display:block;visibility:hidden}',
    '#dshca-girl.dshca-showing{visibility:visible}',

    /* 按钮搬到电饭煲上方时用的容器：定宽 + 右对齐，观感与原先挂在块内一致。 */
    '#dshca-bar.dshca-detached{position:fixed;top:0;left:0;display:flex;justify-content:flex-end;',
    'align-items:center;height:26px;opacity:1;pointer-events:auto;z-index:2147483001}',
    '.dshca-host.dshca-open #dshca-bar.dshca-detached{opacity:1}',

    /* 计时器 + 文案（「肥鱼已经煮饭：」）：挂在电饭煲下方（视口坐标，见 layoutSendBar）。 */
    '#dshca-sendbar{position:fixed;display:none;flex-direction:column;align-items:flex-start;',
    'gap:2px;font:12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;',
    'pointer-events:none;white-space:nowrap;z-index:2147483001}',
    '#dshca-sendbar.dshca-send-on{display:flex}',
    '#dshca-sendlabel{font-weight:600;letter-spacing:.2px;',
    'text-shadow:0 1px 3px rgba(0,0,0,.35)}',
    '#dshca-timer{font-variant-numeric:tabular-nums;color:#fff;background:rgba(20,20,24,.62);',
    'border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600;',
    'box-shadow:0 2px 8px rgba(0,0,0,.28)}',

    /* 开盖视频：**原地**盖在电饭煲那一块的位置上（0.7.3 起不再挂在计时器下方
       的那一列里），所以是 position:fixed + 视口坐标，见 layoutLid()。
       播放期间原来那口锅被藏起来，于是屏幕上始终只有一口锅。
       z-index 刻意比挂件宿主低 1：真被自动播放策略拦下时，那颗"点一下放声"的小
       喇叭挂在电饭煲那一块里，必须还能被点到。 */
    '#dshca-lid{position:fixed;left:0;top:0;display:none;margin:0;padding:0;border:0;',
    'background:transparent;outline:none;pointer-events:none;-webkit-user-drag:none;',
    'user-select:none;object-fit:fill;z-index:2147482999}',
    '#dshca-lid.dshca-lid-on{display:block}',
    /* 开盖停在最后一帧（0.7.4）之后：这一格现在是"可以点的" —— 点击它就把
       整个发送联动复位回「电饭煲 / 小女孩」各自可拖的状态（0.10.2 修的漏洞3）。
       播放中保持 pointer-events:none，别让起播的头几帧把点击吃掉。 */
    '#dshca-lid.dshca-lid-frozen{pointer-events:auto;cursor:pointer}',

    /* 开盖那段自己画着一口完整的锅，所以播放期间把原来那口藏起来 ——
       用 visibility（不是 display）以保住它的盒子，布局与拖动都不会跳。 */
    '.dshca-part.dshca-cooker-hidden>canvas{visibility:hidden!important}',
    /* 0.10.2：藏锅期间（开盖播放 / 停在末帧）这一块不再截获指针 —— 否则点击
       「开盖动画最后一帧」时，落在锅块矩形里的那部分会被一块"看不见的锅"
       吃掉（拖动一个隐形的东西），只有锅块外的部分点得到。放行之后整个
       开盖画面都可以点（还原到拆分态）；被拦的自动播放小喇叭有自己的
       pointer-events:auto，不受影响。 */
    '.dshca-part.dshca-cooker-hidden{pointer-events:none}',

    /* ---- 0.10.0：拖动动画 + 电饭煲的两种随机动画 ------------------------- */

    /* 动画2 里小女孩那一段（girl-basin）：同样是"盖在她那块之上"的一层。
       **必须绝对定位**（与 #dshca-girl 同规矩）——它是 video，一旦留在正常流里，
       内联的像素宽高就会把那一块**撑高**，于是"单位高度"越量越大、scale 越算越
       离谱（自检实测：77x110 的那块被撑到 77x1726，素材放大 36 倍飞出屏幕）。 */
    '#dshca-girlbasin{position:absolute;margin:0;padding:0;border:0;background:transparent;',
    'outline:none;pointer-events:none;-webkit-user-drag:none;user-select:none;',
    'object-fit:fill;display:block;visibility:hidden;z-index:1}',
    /* 她那段"出画"的开关（与 #dshca-girl 同一套）。少了这一条，元素永远停在
       `visibility:hidden` 上：脚本以为她已经出画、把定格图让了出来，屏幕上却是
       什么都不剩（自检里 count=0 的那一条不变量违规就是这么来的）。 */
    '#dshca-girlbasin.dshca-showing{visibility:visible}',

    /* 拖动动画：挂在**小女孩那一块**里的 <video>（与 idle/act 同一套"按内容
       包围盒摆放"的写法），拖动期间循环出画、挡住她的定格 canvas。
       "出画"由脚本写**内联 `display`**（`display:none` ↔ `block`）——
       与 idle/act 用内联 `visibility` 是同一个理由：自检要能从 DOM 上直接读出
       "它在不在屏幕上"，而 CSS 里的默认值脚本读不到。
       z-index 1 = 与掉盆容器同层、在画面与 Q 弹快照之上、控制条(2)之下。 */
    '#dshca-drag{position:absolute;display:none;margin:0;padding:0;border:0;',
    'background:transparent;outline:none;pointer-events:none;-webkit-user-drag:none;',
    'user-select:none;object-fit:fill;z-index:1}',

    /* 随机动画1/2：换掉电饭煲那一块的画面（它自己画着一口完整的锅 + 开盖）。
       与发送联动的开盖同一套做法 —— 用 visibility 藏画面、保住盒子，
       所以拖动 / 布局 / 点按的几何都不会跳。
       z-index 1：与"控制条(2)"错开，播放期间那颗小喇叭仍然点得到。 */
    '#dshca-cooker-a,#dshca-cooker-b{position:absolute;display:none;margin:0;padding:0;',
    'border:0;background:transparent;outline:none;pointer-events:none;',
    '-webkit-user-drag:none;user-select:none;object-fit:fill;z-index:1}',
    '#dshca-cooker-a.dshca-cooker-on,#dshca-cooker-b.dshca-cooker-on{display:block}',
    '.dshca-part.dshca-random-hidden>canvas{visibility:hidden!important}',

    /* "飞过去"那一层：只在移动期间挂上。几何写进 CSS 变量（逐帧更新），
       这里的 transform **消费**那两个变量 —— 0.10.1 修的漏洞1：早先只有
       transition 与 will-change、没有 transform 声明，变量写了没人读，
       于是 JS 侧的逐帧接触判定一直在跑、锅在画面上却一动不动。
       过渡只负责抹平两次 rAF 之间的步子 —— 移动本身是脚本算的，因为
       "接触"必须逐帧判定。收工时 clearFlight() 把 class 与变量一起摘掉，
       transform 立刻回到 none，锅瞬时就地归位（"一接触立刻复位"）。 */
    '.dshca-part.dshca-flying{transform:translate(var(--dshca-fly-x,0px),var(--dshca-fly-y,0px));',
    'transition:transform .12s linear;will-change:transform}',

    /* 自动放声被拦时的小喇叭兜底（只有这一种情况会出现）。 */
    '#dshca-unmute{position:absolute;right:2px;bottom:2px;appearance:none;-webkit-appearance:none;',
    'border:0;border-radius:999px;width:24px;height:24px;padding:0;font-size:12px;cursor:pointer;',
    'color:#fff;background:rgba(20,20,24,.72);display:none;align-items:center;justify-content:center;',
    'pointer-events:auto;z-index:2147483002}',
    '#dshca-unmute.dshca-showing{display:flex}',
  ].join('')

  function insertStyles() {
    if (document.getElementById(STYLE_ID)) return
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    ;(document.head || document.documentElement).appendChild(style)
  }

  /* ------------------------------------------------------------------ */
  /* §4 DOM 引用与运行状态                                               */
  /* ------------------------------------------------------------------ */

  var root = null
  var video = null
  var bar = null
  var panel = null
  var hint = null
  var sizeInput = null
  var sizeLabel = null
  var collapseButton = null
  var presetButtons = []
  /** 「动画间隔」那一行：滑杆、读数、档位预设、控制条上的档位按钮。 */
  var speedInput = null
  var speedLabel = null
  var speedButton = null
  var speedButtons = []
  /* --- 0.7.0 「发送消息」联动 --- */
  /** 小女孩那一段（girl.webm），挂在右块上。 */
  var girlClip = null
  /**
   * 小女孩那一段（girl.webm）当前是不是**独占画面**（0.7.3）。
   *
   * 她那段素材的画面大部分是透明的：底下只要还有别的东西亮着（她自己的定格
   * canvas，或者 idle / act 那一路停下的末帧），屏幕上就会同时出现两个她 ——
   * 用户报的"原先的图像错误地停在屏幕上，跑出动画没法正确播出"就是这个。
   * 所以这一段在演的时候，其余所有画面一律让位，判据收在下面两处：
   *   · `isClipShown()`：两路节拍全部返回假（连带 pause()）；
   *   · `syncCanvasVisibility()`：定格 canvas 同样藏起来。
   * 开关只有 `setGirlClipShown()` 一个落点。
   */
  var girlClipOn = false
  /** 电饭煲下方那一列：蓝色文案 + 计时器（0.7.3 起开盖那段不再挂在这里）。 */
  var sendBar = null
  var sendLabelEl = null
  var timerEl = null
  var lidClip = null
  var unmuteButton = null
  /** 两份新素材的**内容**包围盒（读 alpha 量出来的），用于摆正。 */
  var girlBox = null
  var lidBox = null
  /* --- 0.10.0：拖动动画 + 电饭煲的两种随机动画 --- */
  /** 拖动动画那段（挂在右块上；拖动期间循环出画）。 */
  var dragClip = null
  /** 拖动动画的内容包围盒（读 alpha 量出来的，量一次就缓存）。 */
  var dragBox = null
  var dragAnimOn = false
  /** 两道随机动画（各挂在电饭煲那一块上；谁在演由 randomAnim 说了算）。 */
  var cookerClipA = null
  var cookerClipB = null
  var cookerBoxA = null
  var cookerBoxB = null
  /** 随机动画里小女孩那一段（挂在右块上，与 girlClip 分开）。 */
  var girlBasinClip = null
  var girlBasinBox = null
  /** 小女孩那段的内容框（内容漂移，所以取"贴片包围盒 + 帧内矩形"的交集）。 */
  var basinRect = null
  /** 这一刻电饭煲与她那块的矩形相交多少（0~1）—— 接触时刻的那个比例。 */
  var basinContactScale = 1
  /** 她那段的内容框量过了没有 —— 每个元素只量一次（量法会 seek，不能反复来）。 */
  var girlBasinMeasured = false
  /** null = 没有随机动画在演；否则是 'lid1'（空锅）/ 'lid2'（米饭热气）。 */
  var randomAnim = null
  /** 0.8.0 那套"点击 Q 弹"的接管标志：随机动画播放期间它不参与。 */
  var randomHijack = false
  /** 诊断：最近 40 次"她那一格该不该出画"的判定（见 syncCanvasVisibility）。 */
  var canvasVisLog = []
  /** 倒放 / 移动用到的定时器与 rAF 句柄（0 = 没有）。 */
  var lidReverseTimer = 0
  var lidGuardTimer = 0
  var basinFlightFrame = 0
  var basinGuardTimer = 0
  var basinEndTimer = 0
  /** 逐帧采样出来的"最接近她"那一刻的电饭煲移动量（px）。 */
  var basinFlight = null
  var revealed = false
  var panelOpen = false
  var destroyed = false

  var units = []
  var rootUnit = null
  /** 拆分后的两个部分：[电饭煲(左), 小女孩(右)]，未拆分时为 null。 */
  var partUnits = null
  /**
   * 小女孩那一块当前是不是"被自动贴到窗口右边缘"的状态（0.7.3）。
   *
   * 只在**没人摆过她**、且挂件本身落在窗口右半边时才为真：改显示尺寸 / 改窗口
   * 大小之后按它重新贴边；用户一旦自己拖动过她（见 `unitSave`）就置假，
   * 之后再也不跟她抢位置。
   */
  var girlHugged = false
  /** 当前承载控制条 / 面板的宿主（合并态是 root，拆分后是小女孩）。 */
  var panelHost = null
  /** 面板尺寸只跟内容有关，量一次就缓存，避免拖动时反复触发重排。 */
  var panelBox = null
  /**
   * 用户正在**操作面板**（面板里任意位置的指针从按下到松开）。
   *
   * 0.10.2 修的漏洞：拖「显示大小」滑杆时，滑块所在的挂件块每收到一次 input
   * 就变一次宽高（贴边/绕中心缩放还会挪动整块），面板跟着一路追逐，滑块不断
   * 从光标底下溜走，"调整大小"变得异常困难。所以只要指针还按在面板上：
   *   · `layoutPanel()` 不再按"块的下方/上方"重摆（不再翻转、不再夹取）；
   *   · 同时把面板**锚定在按下那一刻的视口位置** —— 面板是块内的绝对定位元素，
   *     块动了它就被动跟着动，所以每次重算都把块产生的位移反向补回来
   *     （`panelAnchor`）。两者合起来：整个手势期间面板（连同滑杆）在屏幕上
   *     纹丝不动，松手后再摆一次到位。
   */
  var panelLocked = false
  /** 锁定那一刻面板的视口位置（锚点），锁定期间一直补偿回这里。 */
  var panelAnchor = null

  /** 指针松开 / 被系统取消：解锁面板并按当前布局重新摆一次。 */
  function unlockPanel() {
    if (!panelLocked) return
    panelLocked = false
    panelAnchor = null
    layoutPanel()
  }

  /* --- 小女孩那块的动画层（见下面「动画层 + 排期器」一节） --- */
  /** 每路一个 <video>：kind -> { kind, el, box, loaded }。 */
  var animSlots = {}
  /** 控制条上那颗 Debug 按键（暂停 / 继续排期）。 */
  var animButton = null
  /** 播放层的宿主 = 小女孩那一块；null = 没有播放层。 */
  var overlayHost = null
  /**
   * 播放层当前**是否真的在出画**。
   *
   * 注意它和 overlayHost 是两件事：层是随拆分一起挂上的（空 <video>，等各自的
   * 节拍到点），那一小段时间里画面上仍然该是第一段的定格图。只有真的起播了
   * 才把定格图让出来；暂停时保持 true（画面冻住，绝不露出下层）；收工或出错
   * 才回到 false。
   *
   * `shownKind` 是它的**唯一来源**：当前该出画的是哪一路（null = 谁都不出画，
   * 画面归定格 canvas）。两者都由 `showOnly()` 统一维护。
   */
  var overlayShown = false
  var shownKind = null
  /** 用户按了暂停：画面冻在当前这一帧，排期停摆。 */
  var overlayFrozen = false
  /** 各路的节拍（毫秒 + 下次到点时刻），由排期器维护。 */
  var periods = []
  var paused = false

  /* ------------------------------------------------------------------ */
  /* §5 几何工具（视口 / 矩形 / 重叠率）                                  */
  /* ------------------------------------------------------------------ */

  /**
   * 视口尺寸：窗口形态下就是 DSH 窗口的内容区，也是"窗口边框"所在的那一圈。
   *
   * 取 `innerWidth/innerHeight` 与 `documentElement.clientWidth/clientHeight` 里
   * **小的那个**：文档级滚动条会占掉一条，而固定定位的参考系是内容区 ——
   * 用含滚动条的宽度去"贴右边框"，她会正好被那条滚动条压住（0.7.3 贴边修的就是
   * "别被边框吃掉"，所以这里必须按内容区算）。没有滚动条时两者相等。
   */
  /** innerWidth 与文档内容区宽里取小（滚动条属于"窗口边框"的一部分）。 */
  function viewportDim(inner, client) {
    if (inner > 0 && client > 0) return Math.min(inner, client)
    return client || inner || 0
  }

  function viewportWidth() {
    return viewportDim(window.innerWidth || 0, document.documentElement ? document.documentElement.clientWidth : 0)
  }

  function viewportHeight() {
    return viewportDim(window.innerHeight || 0, document.documentElement ? document.documentElement.clientHeight : 0)
  }

  /**
   * 把一整块**完整**塞进视口里（与 `clampPos` 是两件事）。
   *
   * `clampPos` 允许最多 (w - MIN_VISIBLE) 露在窗口外 —— 那是给"拖动"用的：
   * 用户故意把某一块拖到边上时不该被硬拽回来。但**摆放**（拆分、贴边、改尺寸、
   * 改窗口大小）绝不能沿用这条：那样小女孩就会有一部分被窗口边框吃掉，
   * 而"停在边框处、不被边框遮挡"正是 0.7.3 要保证的事。
   */
  function clampInside(x, y, w, h) {
    var vw = viewportWidth()
    var vh = viewportHeight()
    return {
      x: clamp(x, 0, Math.max(0, vw - w)),
      y: clamp(y, 0, Math.max(0, vh - h)),
    }
  }

  /** 把坐标夹到「至少 MIN_VISIBLE 像素可见」的范围里。 */
  function clampPos(x, y, w, h) {
    var vw = viewportWidth()
    var vh = viewportHeight()
    var minX = MIN_VISIBLE - w
    var maxX = vw - MIN_VISIBLE
    var minY = 0
    var maxY = vh - MIN_VISIBLE
    if (maxX < minX) maxX = minX
    if (maxY < minY) maxY = minY
    return {
      x: Math.min(Math.max(x, minX), maxX),
      y: Math.min(Math.max(y, minY), maxY),
    }
  }

  function sizeOf(el) {
    var rect = el.getBoundingClientRect()
    return { w: rect.width || el.offsetWidth || 0, h: rect.height || el.offsetHeight || 0 }
  }

  /**
   * 某个元素左上角在**视口坐标**里的位置（不受它自己 / 祖先的 transform 影响）。
   *
   * 拖动动画与"飞过去的锅"都靠 transform 移动，而 `getBoundingClientRect()` 量的
   * 是**变换之后**的盒子 —— 用它去算"该飞多远"会把自己的移动量算进去，越飞越偏。
   * 所以几何一律走这一对函数（读内联 left/top，那是真值，见 unitApply）。
   */
  function viewportOrigin(el) {
    if (!el) return null
    var left = parseFloat(el.style.left)
    var top = parseFloat(el.style.top)
    if (isFinite(left) && isFinite(top)) return { x: left, y: top }
    var rect = el.getBoundingClientRect()
    return { x: rect.left, y: rect.top }
  }

  function viewportRect(el, w, h) {
    var origin = viewportOrigin(el)
    if (!origin) return null
    var size = w && h ? { w: w, h: h } : sizeOf(el)
    if (!(size.w > 0) || !(size.h > 0)) return null
    return { left: origin.x, top: origin.y, right: origin.x + size.w, bottom: origin.y + size.h }
  }

  /** 两个矩形相交多少（面积比，0 = 不挨着，1 = 完全重合）。 */
  function overlapRatio(a, b) {
    if (!a || !b) return 0
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    if (!(w > 0) || !(h > 0)) return 0
    var small = Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top))
    if (!(small > 0)) return 0
    return Math.min(1, (w * h) / small)
  }

  /* ------------------------------------------------------------------ */
  /* §6 可拖动单元（指针手势：拖动 + 按压是同一手势的两面）                */
  /* ------------------------------------------------------------------ */

  function createUnit(key, el) {
    var unit = { key: key, el: el, pos: null, drag: null, box: null }
    units.push(unit)
    el.addEventListener('pointerdown', function (event) {
      unitPointerDown(unit, event)
    })
    el.addEventListener('pointermove', function (event) {
      unitPointerMove(unit, event)
    })
    el.addEventListener('pointerup', function (event) {
      unitPointerUp(unit, event)
    })
    el.addEventListener('pointercancel', function (event) {
      unitPointerUp(unit, event)
    })
    return unit
  }

  function releaseUnit(unit) {
    var index = units.indexOf(unit)
    if (index >= 0) units.splice(index, 1)
  }

  function unitPosKey(unit) {
    return unit.key === 'merged' ? POS_KEY : partPosKey(unit.key)
  }

  function unitApply(unit) {
    if (!unit.pos) return
    unit.el.style.left = Math.round(unit.pos.x) + 'px'
    unit.el.style.top = Math.round(unit.pos.y) + 'px'
    unit.el.style.right = 'auto'
    unit.el.style.bottom = 'auto'
    if (panelOpen && panelHost === unit.el) layoutPanel()
    // 0.7.0：拖动电饭煲时，挂在它上方/下方的控制条与计时器列要跟着走。
    // 0.7.3：开盖那段现在**原地**盖在电饭煲上，所以也要跟着它走。
    var key = unit.key
    if (key === 'cooker') {
      layoutDetachedBar()
      layoutSendBar()
      layoutLid()
      // 0.10.0：移动期间几何变了，那个缓存下来的移动量就失效了 —— 丢掉它。
      // （飞行中用户去拖锅是罕见路径，丢掉只会让这一次移动提前收工。）
      basinFlight = null
      layoutCookerLidAnims()
    } else if (key === 'girl') {
      layoutGirlClip()
      layoutGirlBasinClip()
    }
  }

  function unitClamp(unit) {
    if (!unit.pos) return
    var size = sizeOf(unit.el)
    unit.pos = clampPos(unit.pos.x, unit.pos.y, size.w, size.h)
    unitApply(unit)
  }

  function unitSave(unit) {
    if (!unit.pos) return
    writeStored(unitPosKey(unit), JSON.stringify({ x: Math.round(unit.pos.x), y: Math.round(unit.pos.y) }))
    // 整体被移动过 → 之前摆好的拆分位置不再适用，下次拆分重新从整体位置推导。
    if (unit.key === 'merged') clearPartPositions()
    // 用户自己把小女孩拖走了 → 从此不再自动把她贴回窗口右边缘，
    // 否则"我明明拖开了、一改窗口大小又跳回边上"会变成新的 bug。
    if (unit.key === 'girl') girlHugged = false
  }

  /** 合并态首次定位：优先记忆位置，否则按配置的角落贴边。 */
  function placeRoot() {
    var size = sizeOf(root)
    var stored = readStoredPos(POS_KEY)
    if (stored) {
      rootUnit.pos = clampPos(stored.x, stored.y, size.w, size.h)
    } else {
      var isLeft = CORNER.indexOf('left') !== -1
      var isBottom = CORNER.indexOf('bottom') !== -1
      var vw = window.innerWidth || document.documentElement.clientWidth || 0
      var vh = window.innerHeight || document.documentElement.clientHeight || 0
      var x = isLeft ? OFFSET_X : vw - size.w - OFFSET_X
      var y = isBottom ? vh - size.h - OFFSET_Y : OFFSET_Y
      rootUnit.pos = clampPos(x, y, size.w, size.h)
    }
    unitApply(rootUnit)
  }

  function unitPointerDown(unit, event) {
    if (typeof event.button === 'number' && event.button !== 0) return
    // 控件区域（含折叠面板与滑杆）既不参与拖动、也不参与按压拉伸，
    // 否则一点滑杆挂件就跑了 / 就被压扁了。
    if (isControlTarget(event.target)) return
    // 盆是"自己的东西"：按在盆上只会拖那个盆（它自己的监听里已经 stopPropagation，
    // 这里再兜一道，免得某一版浏览器的事件顺序把它漏过来）。
    if (isPotTarget(event.target)) return
    // 这一块现在能不能被按压拉伸（合并态、发送联动的两段都返回 null）。
    var squishable = !!squishSourceFor(unit)
    if (!DRAGGABLE && !squishable) return
    if (!unit.pos) placeRoot()

    // 0.10.0：电饭煲上的这一次点击**先**掷那两道随机动画。掷中的话整次按压
    // 都交给它 —— 不起快照、不出按压音（那两段的素材本来就带声音），否则
    // "点一下"会同时冒出两个画音来源。
    if (squishable && maybePlayRandomCooker(unit)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    // 拖动与按压是同一个手势的两面：**按下即压扁**（与鲸鱼挂件一致），
    // 指针移动超过阈值就成了一次拖动 —— 压扁着的那一块跟着一起走。
    if (squishable) startSquish(unit, event.pointerId)

    if (DRAGGABLE) {
      unit.drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: unit.pos.x,
        originY: unit.pos.y,
        moved: false,
      }
      unit.el.classList.add('dshca-dragging')
    }

    try {
      unit.el.setPointerCapture(event.pointerId)
    } catch (err) {
      /* capture is a nicety, dragging still works without it */
    }
    event.preventDefault()
    event.stopPropagation()
  }

  function unitPointerMove(unit, event) {
    var drag = unit.drag
    if (!drag || event.pointerId !== drag.id) return

    var dx = event.clientX - drag.startX
    var dy = event.clientY - drag.startY

    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
      drag.moved = true
      // 0.10.0：真的成了"一次拖动"（而不是一次点击）才起播拖动动画。
      // 放在这里而不是 pointerdown 里，是为了让"按住不动"仍旧走点击那套
      // （点击 Q 弹 / 随机动画），不会因为手指抖一下就把拖动动画点出来。
      startDragAnim(unit)
    }

    var size = sizeOf(unit.el)
    unit.pos = clampPos(drag.originX + dx, drag.originY + dy, size.w, size.h)
    unitApply(unit)

    event.preventDefault()
    event.stopPropagation()
  }

  function unitPointerUp(unit, event) {
    var drag = unit.drag
    if (drag && event.pointerId === drag.id) {
      var moved = drag.moved
      try {
        unit.el.releasePointerCapture(drag.id)
      } catch (err) {
        /* already released */
      }
      unit.drag = null
      unit.el.classList.remove('dshca-dragging')

      if (moved) unitSave(unit)
      // 0.10.0：松手就切回她原来那一格（用户选的是"立刻切回"）。
      // 顺序：先 stop（它会重新收敛一次显隐），再 endSquish 去接回画面。
      if (moved) stopDragAnim()
    }
    // 松开（或指针被系统取消）→ 弹回原状，并把按下时暂停的那段接回去。
    // 认 pointerId：同一块上多指时，另一根手指抬起不该把这一次按压收掉。
    if (squish && squish.unit === unit && squish.pointerId === event.pointerId) endSquish(false)
    event.stopPropagation()
  }

  function isControlTarget(target) {
    if (bar && bar.contains(target)) return true
    if (panel && panel.contains(target)) return true
    if (hint && hint.contains(target)) return true
    return false
  }

  /* ------------------------------------------------------------------ */
  /* §7 设置面板（显示大小 / 动画间隔）                                   */
  /* ------------------------------------------------------------------ */

  function measurePanel() {
    if (!panelBox && panel) {
      panelBox = { w: panel.offsetWidth || 212, h: panel.offsetHeight || 0 }
    }
    return panelBox
  }

  /**
   * 把面板摆在宿主旁边：默认在下方、与宿主右缘对齐；
   * 下方放不下就翻到上方，水平方向则夹进视口。
   *
   * `panelLocked`（用户正按着面板）时不走这套规则，而是把面板钉在手势开始的
   * 视口位置上（`panelAnchor`）—— 面板随块的缩放/贴边移动会被逐次抵消，
   * 滑杆不会在光标底下溜走；翻转与夹取也一并跳过，松手后再恢复常规摆放。
   */
  function layoutPanel() {
    if (!panel || !panelOpen || !panelHost) return
    var box = measurePanel()
    var rect = panelHost.getBoundingClientRect()
    var vw = window.innerWidth || document.documentElement.clientWidth || 0
    var vh = window.innerHeight || document.documentElement.clientHeight || 0

    var left = rect.width - box.w
    if (rect.left + left + box.w > vw - EDGE) left = vw - EDGE - box.w - rect.left
    if (rect.left + left < EDGE) left = EDGE - rect.left

    var top = rect.height + GAP
    var fitsBelow = rect.bottom + GAP + box.h <= vh - EDGE
    var fitsAbove = rect.top - GAP - box.h >= EDGE
    if (!fitsBelow && fitsAbove) top = -box.h - GAP

    // 锁定中：把面板钉在手势开始时的**视口位置**上 —— 面板是块内的绝对定位
    // 元素，块的缩放/贴边移动都会把它一起搬走；这里直接按"锚点 − 块当前
    // 位置"反算内联偏移，块动多少就抵消多少。滑杆因此在整个手势期间
    // 纹丝不动；松手后由 unlockPanel 按常规规则（含翻转与夹取）重摆归位。
    if (panelLocked && panelAnchor) {
      left = panelAnchor.left - rect.left
      top = panelAnchor.top - rect.top
    }

    panel.style.left = Math.round(left) + 'px'
    panel.style.top = Math.round(top) + 'px'
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
  }

  function updateSizeReadout() {
    if (sizeLabel) sizeLabel.textContent = WIDTH + ' px'
    for (var i = 0; i < presetButtons.length; i += 1) {
      var button = presetButtons[i]
      var active = Math.round(num(button.getAttribute('data-size'), -1)) === WIDTH
      if (active) button.classList.add('dshca-active')
      else button.classList.remove('dshca-active')
    }
  }

  /* --- 动画间隔：读数 + 档位按钮标签 + 工具提示 ------------------------- */

  /** 面板读数：`1×（待机 5s / 动作 15s）` —— 永远显示**实际**节拍。 */
  function updateSpeedReadout() {
    if (speedLabel) {
      speedLabel.textContent =
        speedLabelOf(SPEED) +
        '（待机 ' +
        formatMs(effectivePeriod('idle')) +
        ' / 动作 ' +
        formatMs(effectivePeriod('act')) +
        '）'
    }
    if (speedInput) speedInput.value = String(sliderFromSpeed(SPEED))
    if (speedButton) {
      speedButton.textContent = '⇄' + speedLabelOf(SPEED)
      speedButton.title = speedTitle()
      speedButton.setAttribute('aria-label', speedTitle())
    }
    for (var i = 0; i < speedButtons.length; i += 1) {
      var button = speedButtons[i]
      var active = Math.abs(num(button.getAttribute('data-speed'), -1) - SPEED) < 0.01
      if (active) button.classList.add('dshca-active')
      else button.classList.remove('dshca-active')
    }
  }

  /** 控制条按钮的提示：两种节拍的实际长度 + 下一档 + 面板里还有精细滑杆。 */
  function speedTitle() {
    var current = speedLabelOf(SPEED)
    var steps = []
    for (var i = 0; i < SPEED_STEPS.length; i += 1) steps.push(speedLabelOf(SPEED_STEPS[i]))
    return (
      '动画间隔：待机 ' +
      formatMs(effectivePeriod('idle')) +
      ' / 动作 ' +
      formatMs(effectivePeriod('act')) +
      '（' +
      current +
      '）。点击切到 ' +
      speedLabelOf(nextSpeedStep()) +
      '；档位 ' +
      steps.join(' / ') +
      '，面板里可精细调整'
    )
  }

  /** 循环档位里的下一档（到顶回卷到第一档）。 */
  function nextSpeedStep() {
    for (var i = 0; i < SPEED_STEPS.length; i += 1) {
      if (SPEED_STEPS[i] > SPEED + 0.001) return SPEED_STEPS[i]
    }
    return SPEED_STEPS[0]
  }

  /**
   * 改动画间隔倍率。
   *
   * 两件事必须一起做，否则"调了间隔却没反应"：
   *   ① 各路的节拍表要跟着重建（`animationConfigs()` 现算，所以改完再上表即可）；
   *   ② 正在跑的排期要**从当下重新上表** —— 否则已经排出去的那个定时器还是旧间隔，
   *      要等它到点之后新间隔才生效。正在播的那一段不打断（跟"到点撞车"同一原则）。
   *
   * 注意这里是"两条节拍一起从当下重新起算"（`rearm`），不是"保留原来的相位再
   * 按新间隔外推"：后者会让两路各自带着旧间隔攒下的相位漂移走，1:3 的比例很快
   * 就不再成立；而"到点撞车"的判定恰恰依赖这个比例。改间隔等于重新定拍，
   * 相位归零是符合直觉的。
   *
   * `persist === false` 用于"重置"（清掉记忆值）；默认写入 localStorage。
   */
  function applySpeed(value, persist) {
    var next = clamp(num(value, SPEED), SPEED_MIN, SPEED_MAX)
    // 夹到两位小数：滑杆的对数刻度会算出 1.4142… 这种值。
    next = Math.round(next * 100) / 100
    var changed = next !== SPEED
    SPEED = next

    if (persist === false) removeStored(SPEED_KEY)
    else if (persist) writeStored(SPEED_KEY, SPEED)

    updateSpeedReadout()
    if (!changed || destroyed) return

    if (scheduleOn) {
      // 运行中：两张表按新间隔重建，并从现在起一起重新上表。
      periods = []
      var cfgList = animationConfigs()
      for (var i = 0; i < cfgList.length; i += 1) setPeriod(cfgList[i].kind, cfgList[i].period)
      rearm(Date.now())
      scheduleNext()
    } else {
      // 暂停中：只把"下次到点"作废，等用户继续时再按新间隔上表。
      for (var j = 0; j < periods.length; j += 1) periods[j].dueAt = 0
    }
  }

  /** 控制条上的档位按钮：点一下切到下一档（到顶回卷）。 */
  function cycleSpeed() {
    applySpeed(nextSpeedStep(), true)
  }

  /** 面板滑杆：对数刻度 0..1000 → [SPEED_MIN, SPEED_MAX]，中点正好是 1×。 */
  function speedFromSlider(raw) {
    var t = clamp(num(raw, 500), 0, 1000) / 1000
    return clamp(SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, t), SPEED_MIN, SPEED_MAX)
  }

  function sliderFromSpeed(value) {
    var ratio = clamp(num(value, 1), SPEED_MIN, SPEED_MAX) / SPEED_MIN
    return Math.round((Math.log(ratio) / Math.log(SPEED_MAX / SPEED_MIN)) * 1000)
  }

  /**
   * 改显示大小。宽度是唯一的自由度 —— 高度按素材宽高比自动跟随。
   * 拆分状态下两个部分同比缩放，各自绕中心缩放，免得相互挤压。
   */
  function setWidth(value, persist) {
    var previous = WIDTH
    WIDTH = Math.round(clamp(num(value, WIDTH), MIN_WIDTH, MAX_WIDTH))
    root.style.width = WIDTH + 'px'

    if (partUnits && previous > 0 && previous !== WIDTH) {
      for (var i = 0; i < partUnits.length; i += 1) {
        var unit = partUnits[i]
        var before = sizeOf(unit.el)
        applyPartWidth(unit)
        var after = sizeOf(unit.el)
        if (unit.pos) {
          unit.pos = clampPos(
            unit.pos.x + (before.w - after.w) / 2,
            unit.pos.y + (before.h - after.h) / 2,
            after.w,
            after.h,
          )
          unitApply(unit)
        }
      }
    }

    if (sizeInput) sizeInput.value = String(WIDTH)
    updateSizeReadout()
    if (persist) writeStored(SIZE_KEY, WIDTH)

    for (var u = 0; u < units.length; u += 1) unitClamp(units[u])
    // 缩放是"绕各自的中心"做的，所以贴边的那一块会离开边框一点点 —— 拉回来。
    rehugGirl()
    // 播放层按"内容"贴合小女孩那块，所以尺寸一变就得跟着重排。
    layoutOverlay()
    // 头上的盆同理：它的尺寸与落点全是"块宽 / 块高的比例"，也得跟着重排。
    layoutPots()
    layoutPanel()
  }

  function setPanelHost(el) {
    if (panelHost === el) return
    if (panelHost) panelHost.classList.remove('dshca-open')
    panelHost = el
    if (panelOpen && panelHost) panelHost.classList.add('dshca-open')
    layoutPanel()
  }

  function syncPanel(open, persist) {
    if (!panel) return
    panelOpen = !!open
    if (panelHost) {
      if (panelOpen) panelHost.classList.add('dshca-open')
      else panelHost.classList.remove('dshca-open')
    }
    if (panelOpen) layoutPanel()
    if (collapseButton) {
      collapseButton.textContent = panelOpen ? '▴' : '▾'
      var title = panelOpen ? '收起设置' : '展开设置'
      collapseButton.title = title
      collapseButton.setAttribute('aria-label', title)
      collapseButton.setAttribute('aria-expanded', panelOpen ? 'true' : 'false')
    }
    if (persist) writeStored(PANEL_KEY, panelOpen ? '1' : '0')
  }

  function buildPanel() {
    panel = document.createElement('div')
    panel.id = 'dshca-panel'
    panel.setAttribute('role', 'group')
    panel.setAttribute('aria-label', '挂件设置')

    // 操作面板 = 锁定面板（0.10.2 修的漏洞）。必须挂在**捕获阶段**：
    // 滑杆 / 预设按钮自己会在 pointerdown 里 stopPropagation（防止把挂件拖走），
    // 冒泡阶段的监听永远轮不到 —— 而那恰恰是最需要锁定的目标。
    // 锚点取"按下这一刻面板在屏幕上的位置"，整个手势期间补偿回这里。
    panel.addEventListener(
      'pointerdown',
      function () {
        panelLocked = true
        var r = panel.getBoundingClientRect()
        panelAnchor = { left: r.left, top: r.top }
      },
      true,
    )

    var head = document.createElement('div')
    head.className = 'dshca-head'
    var caption = document.createElement('span')
    caption.textContent = '显示大小'
    sizeLabel = document.createElement('span')
    sizeLabel.className = 'dshca-value'
    head.appendChild(caption)
    head.appendChild(sizeLabel)
    panel.appendChild(head)

    sizeInput = document.createElement('input')
    sizeInput.type = 'range'
    sizeInput.id = 'dshca-size'
    sizeInput.min = String(MIN_WIDTH)
    sizeInput.max = String(MAX_WIDTH)
    sizeInput.step = '10'
    sizeInput.value = String(WIDTH)
    sizeInput.setAttribute('aria-label', '动画显示大小')
    sizeInput.addEventListener('input', function () {
      setWidth(sizeInput.value, true)
    })
    sizeInput.addEventListener('pointerdown', function (event) {
      event.stopPropagation()
    })
    panel.appendChild(sizeInput)

    var presets = document.createElement('div')
    presets.className = 'dshca-presets'
    var options = [
      ['小', Math.round(CONFIG_WIDTH * 0.6)],
      ['中', CONFIG_WIDTH],
      ['大', Math.round(CONFIG_WIDTH * 1.5)],
    ]
    for (var i = 0; i < options.length; i += 1) {
      ;(function (text, target) {
        var button = document.createElement('button')
        button.type = 'button'
        button.textContent = text
        button.setAttribute('data-size', String(clamp(target, MIN_WIDTH, MAX_WIDTH)))
        button.addEventListener('pointerdown', function (event) {
          event.stopPropagation()
        })
        button.addEventListener('click', function (event) {
          event.stopPropagation()
          setWidth(button.getAttribute('data-size'), true)
        })
        presets.appendChild(button)
        presetButtons.push(button)
      })(options[i][0], options[i][1])
    }

    var reset = document.createElement('button')
    reset.type = 'button'
    reset.textContent = '重置'
    reset.id = 'dshca-reset'
    reset.title = '恢复默认大小与默认动画间隔，并让拆分位置重新对齐'
    reset.addEventListener('pointerdown', function (event) {
      event.stopPropagation()
    })
    reset.addEventListener('click', function (event) {
      event.stopPropagation()
      removeStored(SIZE_KEY)
      clearPartPositions()
      if (partUnits) {
        var base = rootUnit && rootUnit.pos ? rootUnit.pos : { x: 0, y: 0 }
        layOutParts(base, true)
      }
      setWidth(CONFIG_WIDTH, false)
      applySpeed(SPEED_DEFAULT, false)
    })
    presets.appendChild(reset)
    panel.appendChild(presets)

    /* --- 动画间隔：控制条上有档位按钮，这里是精细滑杆 + 同档位预设 --- */
    var speedHead = document.createElement('div')
    speedHead.className = 'dshca-head'
    var speedCaption = document.createElement('span')
    speedCaption.textContent = '动画间隔'
    speedLabel = document.createElement('span')
    speedLabel.className = 'dshca-value'
    speedHead.appendChild(speedCaption)
    speedHead.appendChild(speedLabel)
    panel.appendChild(speedHead)

    speedInput = document.createElement('input')
    speedInput.type = 'range'
    speedInput.id = 'dshca-speed'
    // 对数刻度：滑杆中点是 1×，0.25× 与 4× 对称地落在两端。
    speedInput.min = '0'
    speedInput.max = '1000'
    speedInput.step = '1'
    speedInput.value = String(sliderFromSpeed(SPEED))
    speedInput.setAttribute('aria-label', '动画间隔倍率')
    speedInput.addEventListener('input', function () {
      applySpeed(speedFromSlider(speedInput.value), true)
    })
    speedInput.addEventListener('pointerdown', function (event) {
      event.stopPropagation()
    })
    panel.appendChild(speedInput)

    var note = document.createElement('div')
    note.className = 'dshca-hintline'
    note.textContent = '待机与动作同比增减；每段动画播完都停在它的末帧。'
    panel.appendChild(note)

    var speedPresets = document.createElement('div')
    speedPresets.className = 'dshca-presets'
    for (var s = 0; s < SPEED_STEPS.length; s += 1) {
      ;(function (step) {
        var button = document.createElement('button')
        button.type = 'button'
        button.textContent = speedLabelOf(step)
        button.setAttribute('data-speed', String(step))
        button.addEventListener('pointerdown', function (event) {
          event.stopPropagation()
        })
        button.addEventListener('click', function (event) {
          event.stopPropagation()
          applySpeed(step, true)
        })
        speedPresets.appendChild(button)
        speedButtons.push(button)
      })(SPEED_STEPS[s])
    }
    panel.appendChild(speedPresets)

    root.appendChild(panel)
    updateSizeReadout()
    updateSpeedReadout()
  }

  /* ------------------------------------------------------------------ */
  /* §8 开场动画：播放 / 停在末帧 / 拆分入口                              */
  /* ------------------------------------------------------------------ */

  function showPlayHint() {
    if (!root || hint) return
    hint = document.createElement('div')
    hint.id = 'dshca-hint'
    hint.title = '播放动画'
    var glyph = document.createElement('span')
    glyph.textContent = '▶'
    hint.appendChild(glyph)
    hint.addEventListener('pointerdown', function (event) {
      event.stopPropagation()
    })
    hint.addEventListener('click', function (event) {
      event.stopPropagation()
      start()
    })
    root.appendChild(hint)
  }

  function hidePlayHint() {
    if (!hint) return
    if (hint.parentNode) hint.parentNode.removeChild(hint)
    hint = null
  }

  function start() {
    hidePlayHint()
    var attempt = video.play()
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(function () {
        // 自动播放被策略拦下（理论上 muted 不会被拦）：给一个点击入口。
        showPlayHint()
        reveal()
      })
    }
  }

  /**
   * 「停在最后一帧」。
   *
   * 标准行为是：不设 loop 的 <video> 播放结束后，元素继续显示最后一帧。
   * 这里只做两件不改变该行为的事：
   *   ① 显式 pause()，避免个别实现把 ended 当成还需要推进的状态；
   *   ② 只有当 currentTime 真的被谁重置回开头时，才把它拨回末尾 —— 这是
   *      纯粹的兜底，正常路径下不会触发，因此不会引入任何跳帧闪烁。
   */
  function holdLastFrame() {
    try {
      video.pause()
    } catch (err) {
      /* ignore */
    }
    var duration = video.duration
    if (!isFinite(duration) || duration <= 0) return
    if (video.currentTime < duration - 0.25) {
      try {
        video.currentTime = Math.max(0, duration - 0.05)
      } catch (err) {
        /* ignore */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* §9 动画层与排期器（idle/act 两路节拍，同屏只一段）                   */
  /* ------------------------------------------------------------------ */
  /*                                                                     */
  /* 第一段视频播完、拆成两块之后，小女孩那块按两条独立的节拍轮流出画：   */
  /*   · idle（待机）：每 ANIM_PERIOD_IDLE 毫秒起播一次                    */
  /*   · act （动作）：每 ANIM_PERIOD_ACT  毫秒起播一次                    */
  /* 两条节拍各自计时，**同一时刻只允许一段动画在播**：谁的表先到点谁上，  */
  /* 两边同时到点则动作优先；正在播时不被打断，错过的这一拍直接跳过       */
  /* （跳过而不是排队 —— 排队会让动画越积越多，永远追不上节拍）。         */
  /* 两段之间回到"第一段的定格帧"，所以小女孩那块永远不会空。             */
  /* ------------------------------------------------------------------ */

  /**
   * 哪些激活、素材在哪、每多少毫秒起播一次、相对该块的大小再乘多少。
   *
   * 节拍一律现算（`effectivePeriod`），所以调档位 / 拉滑杆之后重建这张表就生效。
   */
  function animationConfigs() {
    var list = []
    if (IDLE) list.push({ kind: 'idle', url: IDLE_URL, period: effectivePeriod('idle'), scale: IDLE_SCALE })
    if (ACT) list.push({ kind: 'act', url: ACT_URL, period: effectivePeriod('act'), scale: ACT_SCALE })
    return list
  }

  function animCfg(kind) {
    var list = animationConfigs()
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].kind === kind) return list[i]
    }
    return null
  }

  /**
   * 量出某段素材里"内容"的包围盒（素材原始像素）。
   *
   * 两段素材都有透明留白，而画幅比例各不相同（开场那块 900x1280、
   * 待机素材 1440x1920、动作素材 1440x1916）。直接把 <video> 铺满小女孩那块
   * 只能保证"等比"，一旦人像在画幅里的占比不同，小女孩就会明显变大或变小。
   * 所以这里读一次 alpha，拿到真实内容的宽高，后面按"内容"而不是"画幅"定尺寸。
   *
   * 读不到像素（跨源污染 / canvas 不可用）时返回 null，调用方退回整幅等比。
   */
  function measureContent(el) {
    var vw = el.videoWidth
    var vh = el.videoHeight
    if (!vw || !vh) return null

    var pw = Math.min(PROBE_WIDTH, vw)
    var ph = Math.max(1, Math.round((pw * vh) / vw))
    var probe = document.createElement('canvas')
    probe.width = pw
    probe.height = ph
    var ctx = probe.getContext && probe.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(el, 0, 0, pw, ph)

    var data
    try {
      data = ctx.getImageData(0, 0, pw, ph).data
    } catch (err) {
      // 跨源素材把画布标记为 tainted —— 画面没问题，只是量不了。
      return null
    }

    // 阈值比分割探测高：抗锯齿边缘的 alpha 往往只有个位数，
    // 算进来会让人像包围盒虚胖一圈。
    var ALPHA = 24
    var minX = -1
    var maxX = -1
    var minY = -1
    var maxY = -1
    for (var y = 0; y < ph; y += 1) {
      var base = y * pw * 4
      for (var x = 0; x < pw; x += 1) {
        if (data[base + x * 4 + 3] <= ALPHA) continue
        if (minX < 0 || x < minX) minX = x
        if (x > maxX) maxX = x
        if (minY < 0 || y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    if (minX < 0 || maxX < minX || maxY < minY) return null

    var x0 = Math.round((minX / pw) * vw)
    var x1 = Math.round(((maxX + 1) / pw) * vw)
    var y0 = Math.round((minY / ph) * vh)
    var y1 = Math.round(((maxY + 1) / ph) * vh)
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
  }

  /* --- 三个共用的装配助手（各段素材的"造元素 / 标注 / 摆放"都长一样） --- */

  /**
   * 造一个本插件的 <video> 播放元素。所有素材段的创建都走这里，保证：
   * 不循环（loop 由调用方决定）、不接焦点、不接指针、带齐抗拖拽 / 隐身属性。
   * 默认静音；`muted: false` 用于两段带声的开盖动画（起点都是用户手势）。
   */
  function createClipVideo(opts) {
    var el = document.createElement('video')
    if (opts.id) el.id = opts.id
    if (opts.className) el.className = opts.className
    el.src = opts.url
    el.muted = opts.muted !== false
    el.defaultMuted = opts.muted !== false
    if (opts.muted !== false) el.setAttribute('muted', '')
    el.playsInline = true
    el.loop = !!opts.loop
    el.preload = 'auto'
    el.tabIndex = -1
    el.controls = false
    el.setAttribute('playsinline', '')
    el.setAttribute('preload', 'auto')
    el.setAttribute('draggable', 'false')
    el.setAttribute('aria-hidden', 'true')
    el.setAttribute('disablepictureinpicture', '')
    el.setAttribute('disableremoteplayback', '')
    return el
  }

  /** 把"这次排版用的内容框"写回 DOM（排查"她怎么这么大/这么偏"时一眼可见）。 */
  function markContentBox(el, content) {
    el.setAttribute(
      'data-content-box',
      Math.round(content.x) + ',' + Math.round(content.y) + ',' + Math.round(content.w) + ',' + Math.round(content.h),
    )
  }

  /**
   * 内容框摆放公式（全插件唯一定义一次）：
   * 内容**水平居中**、**底边对齐**宿主盒子；元素自身的 CSS 尺寸 = 素材画幅 ×
   * scale，偏移把画幅里的透明留白排到框外。
   * `scale` 由调用方决定（贴高度还是贴宽度、乘不乘手动旋钮），这里只管落点。
   */
  function placeContentBox(el, vw, vh, content, scale, host) {
    el.style.width = (vw * scale).toFixed(2) + 'px'
    el.style.height = (vh * scale).toFixed(2) + 'px'
    el.style.left = ((host.w - content.w * scale) / 2 - content.x * scale).toFixed(2) + 'px'
    el.style.top = (host.h - (content.y + content.h) * scale).toFixed(2) + 'px'
  }

  /**
   * 三段"挂在小女孩那块上"的素材（跑出 girl / 拖动 drag / 动画2 里她那段）
   * 共用的摆放流程：量宿主盒子 → 标注内容框 → 内容高贴齐块高（量不到高就贴宽）
   * × 手动旋钮 → placeContentBox 落位。
   * 返回 `{ box, content, scale, vw, vh }` 供调用方做附加计算（动画2 要用它维护
   * 接触判定用的 basinRect）；量不出尺寸 / scale 非法时返回 null，绝不安排一个
   * 坏布局。
   */
  function fitClipToGirlPart(el, measuredBox, knob) {
    if (!el || !partUnits) return null
    var girl = partUnits[1]
    var box = sizeOf(girl.el)
    if (!(box.w > 0)) return null
    var vw = el.videoWidth
    var vh = el.videoHeight
    if (!vw || !vh) return null
    var content = measuredBox || { x: 0, y: 0, w: vw, h: vh }
    markContentBox(el, content)
    var scale = (box.h > 0 ? box.h / content.h : box.w / content.w) * knob
    if (!isFinite(scale) || scale <= 0) return null
    placeContentBox(el, vw, vh, content, scale, box)
    return { box: box, content: content, scale: scale, vw: vw, vh: vh }
  }

  /** 每段素材一个 <video>（各自只创建一次，各自只量一次包围盒）。 */
  function ensureVideo(kind) {
    if (destroyed) return null
    var cfg = animCfg(kind)
    if (!cfg) return null
    if (animSlots[kind]) return animSlots[kind].el

    var el = createClipVideo({ id: 'dshca-anim-' + kind, className: 'dshca-anim', url: cfg.url })

    var slot = { kind: kind, el: el, box: null, loaded: false }
    animSlots[kind] = slot

    var onMeta = function () {
      slot.loaded = true
      if (!slot.box) slot.box = measureContent(el)
      layoutOverlay()
      // 0.10.2：内容框量到了，贴边间隙可能要变大 —— 把她重新贴一次边。
      rehugGirl()
    }
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('loadeddata', function () {
      if (!slot.box) slot.box = measureContent(el)
      layoutOverlay()
      rehugGirl()
    })
    // 播完就停在最后一帧：交给引擎处理"要不要撤层"，
    // 这样连续两拍之间不会闪回下面的定格帧。
    el.addEventListener('ended', function () {
      onClipEnded(slot)
    })
    el.addEventListener('error', function () {
      // 素材读不出来不该让小女孩消失，也不该拖垮另一路：
      // 只把这一路彻底摘掉（节点 + 节拍表），剩下那一路照常轮播。
      var wasActive = activeSlot === slot
      if (wasActive) {
        activeSlot = null
        overlayFrozen = false
      }
      dropClip(kind)
      if (el.parentNode) el.parentNode.removeChild(el)
      if (wasActive) settleVisibility()
      syncCanvasVisibility()
      updateAnimButton()
    })
    el.addEventListener('playing', function () {
      // 真正出画的那一刻才把它推上来：这样"上一段的最后一帧"会一直垫到
      // 新的一帧就绪，交接处既不会闪白，也不会两段同时可见。
      overlayFrozen = false
      showOnly(kind)
      syncCanvasVisibility()
      updateAnimButton()
    })
    return el
  }

  /**
   * 某一格该不该出现在屏幕上。
   *
   * 判据只有一条：**它是不是当前该出画的那一路**（`shownKind === kind`）。
   * 不再用"元素挂没挂上 / 排期器开没开 / 谁先 append"这些间接条件去推断 ——
   * 那些正是"暂停后露出下层""恢复后另一段被顶上来"这类 bug 的温床。
   *
   * 注意**没有 `!destroyed` 这一项**：拆掉挂件时 `overlayHost` 已经清空，
   * `girlTarget()` 自然为假；留着 `destroyed` 反而会在退场途中把定格 canvas
   * 闪回来一下。
   */
  function isClipShown(kind) {
    // 小女孩那段（girl.webm）在演：两路节拍照样挂在块上，但一律不出画。
    if (girlClipOn) return false
    // 0.10.0：拖动动画（drag.webm）与动画2 里她那段（girl-basin）同样**独占画面**。
    if (dragAnimShowing()) return false
    if (basinClipShown()) return false
    return shownKind === kind && !!girlTarget()
  }

  /**
   * 「屏幕上永远有且仅有一段画面」的唯一落点。
   *
   * 每次状态变化（起播 / 播完 / 暂停 / 继续 / 出错 / 尺寸变化）都调它，
   * 由它一次性决定：哪一格可见、其余全部隐掉、定格 canvas 要不要让位。
   *
   * - 隐掉的那几路同时 `pause()`：既省解码，也保证它们不会偷偷继续播。
   * - 还要把当前这一路 appendChild 到末尾：同层绝对定位的堆叠顺序就是 DOM
   *   顺序，只靠"谁后挂上"来保证在上层是不牢靠的（重播、换素材、丢失一路之后
   *   顺序都会变），这里显式摆正。
   *
   * `kind` 为空 = "这一拍没有新的动画要出画"。这时**不能**把画面交还给定格
   * canvas（0.6.0 的行为）：上一段那格已经 `ended`、停在它自己的末帧上，它就是
   * 那"唯一一段画面"，原样留着即可 —— 于是小女孩永远停在她动画结束的地方，
   * 而不是每次播完都一跳回到开场的姿势。谁都没有可显示的画面（首拍之前）时
   * `shownKind` 本来就是 null，canvas 依然是那唯一一段画面。
   */
  function showOnly(kind) {
    if (!kind && !shownKind) {
      // 手里没有可显示的一格：画面归定格 canvas（仅在首拍之前会走到这里）。
      overlayShown = false
      syncCanvasVisibility()
      updateAnimButton()
      return
    }
    shownKind = kind || shownKind
    var visible = 0
    for (var k in animSlots) {
      if (!Object.prototype.hasOwnProperty.call(animSlots, k)) continue
      var slot = animSlots[k]
      var el = slot && slot.el
      if (!el) continue
      if (isClipShown(k)) {
        visible += 1
        if (overlayHost && el.parentNode === overlayHost && overlayHost.lastChild !== el) {
          overlayHost.appendChild(el) // 只挪位置，不重新加载
        }
        el.style.visibility = ''
      } else {
        el.style.visibility = 'hidden'
        try {
          el.pause()
        } catch (err) {
          /* ignore */
        }
      }
    }
    overlayShown = visible > 0
    // 点击拉伸进行中（含松手后正在回弹的那一段）：被快照顶掉的那一层必须继续
    // 让位。放在最后，是因为这一段里任何一次赋值都可能把它写成可见 —— 包括
    // 暂停 / 继续经 settleVisibility() 进来的那几次。
    var held = squishHeldSource()
    if (held) held.style.visibility = 'hidden'
    syncCanvasVisibility()
    updateAnimButton()
  }

  /**
   * 收口：把"当前该出画的那一路"重新算一遍。
   *
   * 判据只有 `activeSlot` —— 正在播 / 刚播完停在最后一帧的那一路。
   * 没有它（首拍之前的空档、或某一路素材坏掉被摘掉），`showOnly(null)` 会
   * 保留当前画面；真正什么都不显示只有"还没有任何动画出过画"这一种情况。
   *
   * 这里**故意不做"挑一路还在的顶上"那种兜底**：那正是"另一段被错误顶上来"
   * 的来源。某一路素材坏掉时，正确的反应是让它自己那格定格，不是换一段播。
   */
  function settleVisibility() {
    showOnly(activeSlot && activeSlot.el ? activeSlot.kind : null)
  }

  /** 小女孩那一块（存在且还挂在页面上的时候）。 */
  function girlTarget() {
    var girl = partUnits && partUnits[1] ? partUnits[1].el : null
    if (!girl || !girl.parentNode) return null
    return girl
  }

  /** 只建出"随包有这一路"的 <video>，并挂到小女孩那块上（默认都隐着）。 */
  function attachOverlay() {
    var host = girlTarget()
    if (!host) return false
    var cfgList = animationConfigs()
    if (!cfgList.length) return false
    overlayHost = host
    for (var i = 0; i < cfgList.length; i += 1) {
      var el = ensureVideo(cfgList[i].kind)
      if (el && el.parentNode !== host) {
        // 新挂上的一律先隐着：它还没有要出的画面，不能盖住当前这一格。
        el.style.visibility = 'hidden'
        host.appendChild(el)
      }
    }
    showOnly(shownKind)
    return true
  }

  /**
   * 播放层整体退场：暂停全部素材、移除节点、把"定格图"放回来。
   *
   * 只管"层"，**绝不动节拍器的定时器** —— 层收工之后节拍还要继续走
   * （下一拍再把层挂回来）。故意不清 overlayTimer：那个定时器有可能正是
   * 调用本函数的上下文，而它已经被排给"下一拍"了；`scheduleOn` 为假时
   * `tick()` 自己会退出。这一点踩过坑：早先这里顺手 clear 了一下，
   * 结果一段动画播完，整个排期就静悄悄地死了。
   *
   * 注意它和"一段动画播完"是两件事：播完**不退场**（0.6.0 起），只有重播 /
   * 关闭 / 素材报错才走这里，那时画面本来就该回整体或消失。
   */
  function detachOverlay() {
    for (var kind in animSlots) {
      if (!Object.prototype.hasOwnProperty.call(animSlots, kind)) continue
      var slot = animSlots[kind]
      var el = slot && slot.el
      if (!el) continue
      try {
        el.pause()
      } catch (err) {
        /* ignore */
      }
      if (el.parentNode) el.parentNode.removeChild(el)
    }
    animSlots = {}
    activeSlot = null
    overlayHost = null
    shownKind = null
    overlayShown = false
    overlayFrozen = false
    // 层都撤了，"她独占画面"这件事自然也不存在了（重播 / 关闭走的都是这里）。
    girlClipOn = false
    syncCanvasVisibility()
    updateAnimButton()
  }

  /**
   * 小女孩那块现在是不是"被播放层占着"。
   *
   * 判据是**它到底有没有在出画**（overlayShown），而不是"层挂没挂上"、
   * 更不是"排期器开没开"：层随拆分就挂上了（空 <video>，等节拍），
   * 那时候画面上还是定格图，不能把它藏起来。
   *
   * 早先的 bug 就是把这几件事混在一起 —— 暂停会把层撤掉/让位，于是下面那张
   * 定格帧直接露了出来，画面从"某个动作"跳回了"开场最后一帧"。
   *
   * 0.7.3 再加一条：小女孩那段（girl.webm）在演的时候，定格 canvas 也必须让位 ——
   * 否则那张静止的她会在半透明的跑出动画底下露出来，屏幕上就是两个她。
   */
  function syncCanvasVisibility() {
    var canvas = partUnits && partUnits[1] ? partUnits[1].canvas : null
    if (!canvas) return
    // 0.10.0：拖动动画在出画时她那格定格图必须让位 —— 那段素材也是"整幅替换"
    // 她的，底下只要还亮着就会同时出现两个她。
    //
    // 注意这里**没有** `randomAnim`：两道随机动画只换电饭煲那一侧的画面，她
    // 那一侧照旧（动画2 里她本人换成了 girl-basin，那由 `basinClipShown()` 管）。
    // 曾经把 `randomAnim` 也算进来，结果是动画1 播放期间她整个人凭空消失 5 秒 ——
    // 而"电饭煲开自己的盖"这件事跟她本来毫无关系。
    var canvasHidden =
      girlClipOn || basinClipShown() || dragAnimShowing() || (overlayShown && overlayHost)
    canvas.style.visibility = canvasHidden ? 'hidden' : ''
    // 诊断账本：每一次"她那一格该不该出画"的判定都留一笔（排查"她凭空消失"
    // 这类问题时，只有这一份能说清是谁写的、当时四个判据各是什么）。
    canvasVisLog.push({
      t: Math.round(now()),
      hidden: !!canvasHidden,
      girlClipOn: girlClipOn,
      basin: basinClipShown(),
      drag: dragAnimShowing(),
      overlayShown: overlayShown,
      hasHost: !!overlayHost,
      randomAnim: randomAnim,
    })
    if (canvasVisLog.length > 40) canvasVisLog.shift()
  }

  /**
   * 「小女孩那段（girl.webm）独占画面」这一个开关的唯一落点。
   *
   * 打开时：两路节拍的 <video> 与她的定格 canvas 全部让位，屏幕上只剩她这一段
   * （连带把她自己 appendChild 到末尾，同层绝对定位下 DOM 顺序才是堆叠顺序）；
   * 关闭时：把画面交回 `shownKind` 记着的那一路（没有就是定格 canvas），
   * 于是"新的一轮开始""演完了""复位"三种收场都自动回到原来那一格。
   */
  function setGirlClipShown(on) {
    girlClipOn = !!on
    if (girlClipOn && girlClip) {
      var girl = girlTarget()
      if (girl && girlClip.parentNode === girl && girl.lastChild !== girlClip) girl.appendChild(girlClip)
    }
    // showOnly() 同时负责"其余全部隐掉 + pause()"与 overlayShown 的收敛，
    // 而 syncCanvasVisibility 已经认识 girlClipOn，所以这里一步到位。
    showOnly(shownKind)
    // 她那段跑出动画是**替换**她的（原画已经不在了），浮在半空的盆要一起让位。
    // 0.10.0 起这条判据收在 refreshPotsVisible() 里（拖动动画 / 动画2 同样算）。
    refreshPotsVisible()
  }

  /** 播放层的显示尺寸：按"内容"对齐小女孩那块，底边对齐、水平居中。 */
  function layoutOverlay() {
    // 注意**不能**要求 overlayHost.parentNode：事件 1 收尾会把小女孩那块整个
    // display:none 藏起来（它还挂在页面上，只是不显示），那时两路动画层照样要
    // 按原尺寸排好版，否则下一次显示出来会是错的。
    if (!overlayHost) return
    var host = sizeOf(overlayHost)
    if (host.w <= 0) return

    for (var kind in animSlots) {
      if (!Object.prototype.hasOwnProperty.call(animSlots, kind)) continue
      var slot = animSlots[kind]
      var el = slot && slot.el
      if (!el) continue
      var vw = el.videoWidth
      var vh = el.videoHeight
      if (!vw || !vh) continue
      var cfg = animCfg(kind)
      var box = slot.box || { x: 0, y: 0, w: vw, h: vh }

      // 内容高度对齐宿主可见高度；scale 是"看着还是偏小/偏大"的手动旋钮。
      var scale = host.w / box.w
      if (host.h > 0) scale = host.h / box.h
      scale *= cfg ? cfg.scale : 1
      if (!isFinite(scale) || scale <= 0) continue

      placeContentBox(el, vw, vh, box, scale, host)
    }
  }

  /**
   * 这一路是不是"正在出画、不该被打断"。
   *
   * 只认两件事：它是不是当前显示的那一路（`shownKind`），以及它还在不在播
   * （`ended` 就算播完了，可以交接）。**不再看 `currentTime > 0`** ——
   * 那个条件会把"暂停在中间的一格"永久算成占用，正是"继续之后再也不出画"
   * 那条死路的成因。
   */
  function isSlotLive(slot) {
    if (!slot || !slot.el) return false
    if (shownKind !== slot.kind) return false
    var el = slot.el
    if (el.ended) return false
    return !el.paused
  }

  /** 起播某一路。已挂载的层在起播前先"上膛"，避免第一帧闪一下。 */
  function startAnimation(kind) {
    if (destroyed) return false
    var slot = animSlots[kind]
    if (!slot || !slot.el) return false

    var el = slot.el
    activeSlot = slot
    overlayFrozen = false
    // 先摆正"屏幕归谁"：这一路占上，其余全部隐掉。
    // 注意此刻新的一路可能还没画出第一帧 —— `playing` 事件会再调一次 showOnly，
    // 所以这里与那一刻之间不会出现"两段同时可见"（隐掉别的、只留它本身）。
    showOnly(kind)

    var go = function () {
      if (destroyed || activeSlot !== slot || !slot.el) return
      try {
        if (el.ended) el.currentTime = 0
      } catch (err) {
        /* seek may fail before metadata */
      }
      var attempt = el.play()
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(function () {
          // 自动播放被拦（理论上 muted 不会被拦）：只让这一路歇着，
          // 排期器继续走，绝不会因为一次失败就把整块画面清空。
          if (activeSlot !== slot) return
          overlayFrozen = true
          syncCanvasVisibility()
          updateAnimButton()
        })
      }
      updateAnimButton()
    }

    if (el.videoWidth && el.videoHeight) {
      go()
      return true
    }
    // 元数据还没到：挂一次性监听，到了再起播；排期器不受影响。
    var onData = function () {
      el.removeEventListener('loadedmetadata', onData)
      el.removeEventListener('loadeddata', onData)
      go()
    }
    el.addEventListener('loadedmetadata', onData)
    el.addEventListener('loadeddata', onData)
    updateAnimButton()
    return true
  }

  /**
   * 当前这一路播完了：**就停在这一格上**，什么都不用做。
   *
   * 0.6.0 的行为变更（这是"停在动画结束的地方"的落点）：早先这里会排一个
   * 200ms 的"收工"定时器，到点把播放层撤掉、画面交还开场那张定格帧 ——
   * 结果每段动画一播完，小女孩就一跳回到开场的姿势。
   *
   * 现在不再收工：`<video>`（`loop = false`）在 `ended` 后本来就继续显示最后一帧，
   * 它继续占着"唯一一段画面"的位置，直到下一拍到点被下一段动画接走。
   * `activeSlot` 也**故意留着**（它已经 `ended`，`isSlotLive()` 会判为不忙，
   * 所以不会挡住下一拍），由它兜着"这一格现在归谁"。
   */
  function onClipEnded(slot) {
    if (activeSlot !== slot) return
    if (destroyed) return
    settleVisibility()
    updateAnimButton()
  }

  /* ------------------------------------------------------------------ */
  /* §9·排期器：谁先到点谁上，正在播的不打断，错过的拍跳过                 */
  /* ------------------------------------------------------------------ */

  /** 排期器是否在跑（false = 用户按了暂停）。 */
  var scheduleOn = false
  /**
   * 正在被排期器占用的那一路；null = 还没有任何动画出过画。
   *
   * 一段播完之后它**不归零**：那一路（已经 `ended`、停在末帧）继续占着屏幕，
   * 直到下一拍把它换掉。`isSlotLive()` 已经把 `ended` 判为"不忙"，所以它不会
   * 挡住下一拍。
   */
  var activeSlot = null
  var overlayTimer = 0

  function clearOverlayTimer() {
    if (overlayTimer) {
      if (typeof window.clearTimeout === 'function') window.clearTimeout(overlayTimer)
      overlayTimer = 0
    }
  }

  function stopAllTimers() {
    clearOverlayTimer()
    // 0.10.0 踩过的坑（别再把它挪回来）：随机动画的两条定时器**不能**挂在这里。
    // 随机动画一开始就会 `pauseSchedule()` 把排期停掉，而 `resumeAfterRandom()`
    // 在收工时又要把它开回来 —— 如果那些句柄挂在 stopAllTimers 里，"开排期"
    // 这一步会顺手把**正在跑的倒放 / 飞行**一起清掉，动画就会永远停在中途。
    // 它们的正确归属是 stopRandomAnims()（重播 / 关闭 / 新一轮发送）。

    // 但排期的"暂停"确实要挡住正在跑的倒放 / 飞行：用户按了 ⏸ 之后，屏幕上
    // 那口锅不该继续偷偷往回倒。判据放在 pauseSchedule() 里，见那里的注释。
  }

  function setPeriod(kind, value) {
    for (var i = 0; i < periods.length; i += 1) {
      if (periods[i].kind === kind) {
        periods[i].ms = Math.max(1, Math.round(value))
        return
      }
    }
    periods.push({ kind: kind, ms: Math.max(1, Math.round(value)) })
  }

  /** 从"现在"起把两条节拍都重新上表（此刻不算到期，所以不会立刻起播）。 */
  function rearm(now) {
    for (var i = 0; i < periods.length; i += 1) {
      periods[i].dueAt = now + periods[i].ms
    }
  }

  /** 把某个时刻往后推到"不为过去"的第一个周期点（保持原来的相位）。 */
  function alignFuture(at, period, now) {
    if (at > now) return at
    var missed = Math.floor((now - at) / period) + 1
    return at + missed * period
  }

  /**
   * 排到"下一个到点的那一拍"。
   *
   * 先撤掉手上的定时器，再决定要不要排新的 —— 顺序反了就会留下幽灵定时器：
   * 同一个到期时刻上会存在两个排期回调，后到的那个又看到"已经播完了"，
   * 于是把另一段动画挤进来（实测踩过）。
   *
   * 用 next.dueAt - now 当等待时长是不安全的：一旦某一拍的 dueAt 落在过去
   * （比如两段动画交替时被挤掉的那一拍），差值为负会被 setTimeout 当成 0，
   * 于是**同一时刻反复到点**，动画被连环起播。所以这里先把 dueAt 拨到未来。
   */
  function scheduleNext() {
    clearOverlayTimer()
    if (!scheduleOn || destroyed || !girlTarget()) return
    var next = null
    var now = Date.now()
    for (var i = 0; i < periods.length; i += 1) {
      var entry = periods[i]
      if (entry.dueAt === 0) continue
      if (entry.dueAt <= now) entry.dueAt = alignFuture(entry.dueAt, entry.ms, now)
      if (next === null || entry.dueAt < next.dueAt) next = entry
    }
    if (!next) return
    overlayTimer = window.setTimeout(tick, Math.max(0, next.dueAt - now))
  }

  /**
   * 把一路彻底摘掉：节点、`animSlots` 里的格子、以及**节拍表里的那一项**。
   *
   * 只摘 `animSlots` 是不够的（0.6.0 修的一个 bug）：排期器按 `periods` 里的
   * 到期时刻定下一次唤醒，如果那一项还留着，排期就会一直为一段**已经不存在的**
   * 动画空转 —— 到点发现没得播、再把这一拍往后推，无限重复；更要命的是它还会
   * 把"下一次唤醒"定在一个比另一路真正该播的时刻更早的时间上。
   *
   * 摘干净之后：还有别的路就照常往下排，一路都不剩就把排期关掉。
   */
  function dropClip(kind) {
    delete animSlots[kind]
    var kept = []
    for (var i = 0; i < periods.length; i += 1) {
      if (periods[i].kind !== kind) kept.push(periods[i])
    }
    periods = kept
    if (!periods.length) {
      scheduleOn = false
      stopAllTimers()
      return
    }
    scheduleNext()
  }

  /**
   * 一拍。到点的两路里挑一路起播：
   *   · 正在播（或暂停中）→ 这一拍全体跳过，什么都不打断；
   *   · 两路同时到点 → 动作优先；
   *   · 起播的那一路，下一次到点 = 本次起播时刻 + 周期。
   */
  function tick() {
    overlayTimer = 0
    if (!scheduleOn || destroyed) return
    if (!girlTarget()) return
    // 上一段播完会把层撤掉，但节拍还得继续：这里先把各路的 <video> 挂回来
    // （挂上 ≠ 出画，overlayShown 仍为假，所以空档里画面还是定格图），
    // 否则下面的"到点"判断会因为找不到对应元素而把这一拍白白吞掉。
    attachOverlay()

    var now = Date.now()

    // 小女孩正被按住（或刚松手、快照还在回弹）：这一拍**先不接走画面**。
    // 她那一层此刻被快照顶着，起播会立刻换掉快照底下的东西（松手时会露出
    // 一段已经跳过去的动画）。处理方式与"正在播的不打断"完全一样：
    // 把到点的这一拍按原相位往后挪一拍。
    // 0.10.0：正在拖她（拖动动画在出画）时同理 —— 松手那一下必须是"她自己"。
    if ((partUnits && squishHolding(partUnits[1])) || dragAnimShowing() || basinClipShown()) {
      for (var s = 0; s < periods.length; s += 1) {
        if (periods[s].dueAt !== 0 && periods[s].dueAt <= now) periods[s].dueAt = now + periods[s].ms
      }
      scheduleNext()
      return
    }

    var due = null
    for (var i = 0; i < periods.length; i += 1) {
      var entry = periods[i]
      if (entry.dueAt === 0 || entry.dueAt > now) continue
      var slot = animSlots[entry.kind]
      if (!slot || !slot.el) {
        // 这一路已经被丢掉（素材坏了 / 关掉了），别再让它占坑。
        entry.dueAt = now + entry.ms
        continue
      }
      if (due === null || (entry.kind === 'act' && due.kind !== 'act')) due = entry
    }

    if (due === null) {
      scheduleNext()
      return
    }

    var playing = activeSlot && isSlotLive(activeSlot)
    if (playing) {
      // 正在出画：不打断。这一拍就算错过，直接往后排。
      due.dueAt = now + due.ms
      scheduleNext()
      return
    }

    // 顺序很重要：先把这一拍往后挪、把旧定时器撤掉，最后才起播。
    // 反过来的话，起播过程中排出去的新定时器 ID 会被 clearOverlayTimer()
    // 当成"上一个"撤掉，而真正要撤的那个反而活着 —— 结果同一时刻会到点两拍，
    // 第二拍就会在"正在播"的空隙里挤进另一段动画（实测踩过）。
    due.dueAt = now + due.ms
    clearOverlayTimer()
    attachOverlay()
    startAnimation(due.kind)
    scheduleNext()
  }

  /** 启动排期器（拆分完成后调用）。重复调用只是把节拍重新上表，不会叠出两套。 */
  function startSchedule() {
    if (destroyed) return
    if (!attachOverlay()) return
    // 按当前配置重建两张表：每一路一个周期。
    periods = []
    var cfgList = animationConfigs()
    for (var i = 0; i < cfgList.length; i += 1) setPeriod(cfgList[i].kind, cfgList[i].period)
    scheduleOn = true
    paused = false
    rearm(Date.now())
    scheduleNext()
    updateAnimButton()
  }

  /**
   * 用户按了暂停：节拍停摆，画面**原样冻住**。
   *
   * 只做三件事：停表、`pause()` 当前这一路、别的都不碰。层留着、定格 canvas
   * 继续让位，所以屏幕上还是那一段画面（现在不动了），不会露出下层。
   */
  function pauseSchedule() {
    if (!scheduleOn) return
    scheduleOn = false
    paused = true
    // 撤掉待播的那一拍：暂停期间它到点会起播下一段动画。
    stopAllTimers()
    var el = activeSlot && activeSlot.el
    if (el) {
      try {
        el.pause()
      } catch (err) {
        /* ignore */
      }
      // 正在播的时候按暂停：画面就停在当前这一帧（层留着，绝不露下层）。
      overlayFrozen = !el.ended
    } else {
      overlayFrozen = false
    }
    // 统一收敛一次：该出的那一格留着，其余隐掉。
    settleVisibility()
  }

  /**
   * 用户按了继续：从"现在"重新上表，节拍继续（不会补播错过的那些拍）。
   *
   * 关键：**暂停时冻住的那一格不再算"在出画"**。
   *
   * 否则会出现这样一条死路：暂停在一个刚播到一半的片段上 → 那一格被冻住 →
   * 继续之后它既没有 `ended`（永远不会自然收工），又被当成"正在播"占着画面，
   * 于是排期每一拍都被判成"有人在出画，跳过" —— 屏幕上永远只有那张冻住的图，
   * 看起来就是"继续之后别的动画再也没出现过"。
   *
   * 所以继续时把 `activeSlot` 清空、让 `isSlotLive()` 判它"不忙"：
   * 那一格**留在屏幕上**（0.6.0 起不再撤层、也不再把画面交还开场定格帧），
   * 但已经不占排期的位，下一拍到点就会正常起播。屏幕上任何时刻依然只有一段画面。
   *
   * 另外把暂停期间积压的 `dueAt` 作废（置 0 表示"没上表"）：它们全都落在过去，
   * 不作废就要靠 `alignFuture()` 兜，等于白白多绕一圈。
   */
  function resumeSchedule() {
    if (destroyed || scheduleOn) return
    if (!attachOverlay()) return
    periods = []
    var cfgList = animationConfigs()
    for (var i = 0; i < cfgList.length; i += 1) {
      setPeriod(cfgList[i].kind, cfgList[i].period)
      periods[periods.length - 1].dueAt = 0
    }
    scheduleOn = true
    paused = false
    // 解冻，但画面不动：冻住的那一格继续当"这一段画面"。
    overlayFrozen = false
    activeSlot = null
    settleVisibility()
    rearm(Date.now())
    scheduleNext()
    updateAnimButton()
  }

  /**
   * 控制条上的 Debug 按键：⏸ = 节拍在跑（点了暂停并冻住画面），
   * ▶ = 已暂停（点了继续）。保留这颗按钮，是为了不重启也能立刻看下一段动画。
   */
  function updateAnimButton() {
    if (!animButton) return
    var running = scheduleOn
    var title = running ? '暂停动画排期（Debug）' : '继续动画排期（Debug）'
    animButton.textContent = running ? '⏸' : '▶'
    animButton.title = title
    animButton.setAttribute('aria-label', title)
    animButton.setAttribute('aria-pressed', running ? 'true' : 'false')
    if (running) animButton.classList.add('dshca-on')
    else animButton.classList.remove('dshca-on')
  }

  /** Debug 开关：暂停 / 继续两条节拍。 */
  function toggleSchedule() {
    if (scheduleOn) pauseSchedule()
    else resumeSchedule()
  }

  /* ------------------------------------------------------------------ */
  /* §10 拆分：找分割线 + 两块的摆放（贴边/缩放/记忆）                     */
  /* ------------------------------------------------------------------ */

  function clearPartPositions() {
    removeStored(partPosKey('cooker'))
    removeStored(partPosKey('girl'))
  }

  /**
   * 分析最后一帧，得出「怎么拆」。
   *
   * 返回 { splitX, cooker:{x,y,w,h}, girl:{x,y,w,h} }（都是素材原始像素坐标），
   * 或者 null（画布被跨源污染 / 读不到像素 / 没找到合适缝隙）——
   * 调用方会退回配置的 splitRatio 与整幅切分。
   *
   * 找分割线的规则不是「最宽的空列」——**那样会挑中画面右侧的空白边距**。
   * 真正的缝隙必须满足两个条件：
   *   ① 不贴画面左右边缘（贴边的空白是留白，不是两个主体之间的缝）；
   *   ② 两侧都还有足够分量的内容（避免把孤零零一小块切出去，或把边距当缝）。
   * 找到缝隙后，左右两块再各自收紧到自己内容的包围盒，这样每一块的可拖区域
   * 就是电饭煲 / 小女孩本身，而不是一大片透明留白。
   */
  function analyseFrame() {
    var vw = video.videoWidth
    var vh = video.videoHeight
    if (!vw || !vh) return null

    var pw = PROBE_WIDTH
    var ph = Math.max(1, Math.round((pw * vh) / vw))
    var probe = document.createElement('canvas')
    probe.width = pw
    probe.height = ph
    var ctx = probe.getContext && probe.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, pw, ph)

    var data
    try {
      data = ctx.getImageData(0, 0, pw, ph).data
    } catch (err) {
      // 跨源素材会把画布标记为 tainted —— 只是读不了像素，画面本身没问题。
      return null
    }

    var colCoverage = new Array(pw)
    var x
    var y
    for (x = 0; x < pw; x += 1) colCoverage[x] = 0
    for (y = 0; y < ph; y += 1) {
      var row = y * pw * 4
      for (x = 0; x < pw; x += 1) colCoverage[x] += data[row + x * 4 + 3] / 255
    }

    var emptyLimit = ph * 0.005 // 覆盖不足 0.5% 就算空列
    var total = 0
    for (x = 0; x < pw; x += 1) total += colCoverage[x]
    if (total <= 0) return null

    // 找出所有被内容夹住、且两侧都有分量的空列区间，取最宽的那个。
    var bestStart = -1
    var bestLen = 0
    var runStart = -1
    var minMass = total * 0.15
    for (x = 0; x <= pw; x += 1) {
      var empty = x < pw && colCoverage[x] <= emptyLimit
      if (empty) {
        if (runStart < 0) runStart = x
        continue
      }
      if (runStart < 0) continue
      var runEnd = x
      var runLen = runEnd - runStart
      if (runStart > 0 && runEnd < pw && runLen > bestLen) {
        var leftMass = 0
        var rightMass = 0
        var k
        for (k = 0; k < runStart; k += 1) leftMass += colCoverage[k]
        for (k = runEnd; k < pw; k += 1) rightMass += colCoverage[k]
        if (leftMass >= minMass && rightMass >= minMass) {
          bestLen = runLen
          bestStart = runStart
        }
      }
      runStart = -1
    }
    if (bestStart < 0 || bestLen < 2) return null

    var splitX = Math.round(clamp((bestStart + bestLen / 2) / pw, 0.05, 0.95) * vw)

    /** 把某一侧的列范围收紧成内容的包围盒（原始像素）。 */
    function contentBox(fromCol, toCol) {
      var first = -1
      var last = -1
      var i
      for (i = fromCol; i < toCol; i += 1) {
        if (colCoverage[i] > emptyLimit) {
          if (first < 0) first = i
          last = i
        }
      }
      if (first < 0) return null

      // 行方向也只看**这一侧自己的列**，否则另一侧的内容会把这一侧的上下边界撑开。
      var top = -1
      var bottom = -1
      for (var row = 0; row < ph; row += 1) {
        var sum = 0
        var base = row * pw * 4
        for (i = fromCol; i < toCol; i += 1) sum += data[base + i * 4 + 3] / 255
        if (sum > emptyLimit) {
          if (top < 0) top = row
          bottom = row
        }
      }
      if (top < 0) return null

      var sx = Math.round((first / pw) * vw)
      var sw = Math.round(((last + 1) / pw) * vw) - sx
      var sy = Math.round((top / ph) * vh)
      var sh = Math.round(((bottom + 1) / ph) * vh) - sy
      return { x: sx, y: sy, w: Math.max(1, sw), h: Math.max(1, sh) }
    }

    var splitCol = Math.max(1, Math.min(pw - 1, Math.round((splitX / vw) * pw)))
    var leftBox = contentBox(0, splitCol)
    var rightBox = contentBox(splitCol, pw)
    if (!leftBox || !rightBox) return null

    return { splitX: splitX, cooker: leftBox, girl: rightBox }
  }

  /** 兜底切分：按比例对半切，不做内容收紧。 */
  function fallbackFrame() {
    var vw = video.videoWidth
    var vh = video.videoHeight
    var splitX = Math.round(clamp(vw * SPLIT_RATIO, 1, vw - 1))
    return {
      splitX: splitX,
      cooker: { x: 0, y: 0, w: splitX, h: vh },
      girl: { x: splitX, y: 0, w: vw - splitX, h: vh },
    }
  }

  /** 当前显示比例：素材像素 → CSS 像素。合并态与拆分态共用同一个 k。 */
  function displayScale() {
    return WIDTH / video.videoWidth
  }

  function applyPartWidth(unit) {
    unit.el.style.width = Math.round(unit.box.w * displayScale()) + 'px'
  }

  /** 给拆分后的两个部分定尺寸与位置。 */
  function layOutParts(base, force) {
    if (!partUnits) return
    var cooker = partUnits[0]
    var girl = partUnits[1]

    applyPartWidth(cooker)
    applyPartWidth(girl)

    var storedCooker = force ? null : readStoredPos(unitPosKey(cooker))
    var storedGirl = force ? null : readStoredPos(unitPosKey(girl))
    var k = displayScale()

    if (storedCooker) {
      // 用户摆过位置 → 尊重它，别在重播后把人摆好的布局抖掉。
      cooker.pos = { x: storedCooker.x, y: storedCooker.y }
      unitClamp(cooker)
    } else {
      // 没摆过 → 电饭煲落在整体里原来的位置，所以拆开前后完全重合；
      // 位置一律用 clampInside（整块完整落在视口内），摆放阶段绝不允许
      // 有任何一块被窗口边框吃掉。
      var cookerSize = sizeOf(cooker.el)
      cooker.pos = clampInside(
        base.x + cooker.box.x * k,
        base.y + cooker.box.y * k,
        cookerSize.w,
        cookerSize.h,
      )
      unitApply(cooker)
    }

    if (storedGirl) {
      // 她自己被摆过 → 同样尊重，并且从此不再自动贴边（"我拖开了"就是"别再动她"）。
      // 注意这两块是**各自**判断的：只拖过其中一块时，另一块照旧自动摆放 ——
      // 早先要求"两块都存过"才生效，于是只拖过小女孩的位置会被悄悄忽略。
      girlHugged = false
      girl.pos = { x: storedGirl.x, y: storedGirl.y }
      unitClamp(girl)
      return
    }

    // 小女孩那一块按 0.7.3 的要求**贴住窗口右边缘**：素材画幅右侧有 320 源像素的
    // 透明留白（2560 的 12.5%），照搬"原位"她会停在离窗口边框 40~50px 的地方，
    // 看着像悬在空中。这里只挪她、不动电饭煲，并且整块完整落在视口内 ——
    // 于是"停在窗口边框处"与"不被边框遮挡"同时成立。
    // 0.10.2：间隙按 `girlSideGap()` 现算（动画内容比裁切框宽，宽度大时若仍
    // 只留 2px，她的动画层会被窗口右边框切掉一条），见 girlSideGap 的注释。
    var girlSize = sizeOf(girl.el)
    var girlAt = { x: base.x + girl.box.x * k, y: base.y + girl.box.y * k }
    girlHugged = girlSize.w > 0 && girlAt.x + girlSize.w / 2 > viewportWidth() / 2
    girl.pos = clampInside(
      girlHugged ? viewportWidth() - girlSize.w - girlSideGap() : girlAt.x,
      girlAt.y,
      girlSize.w,
      girlSize.h,
    )
    unitApply(girl)
  }

  /**
   * 小女孩那一块贴住窗口右边缘时，两侧各需要留多少空隙（0.10.2 修的漏洞）。
   *
   * 旧的实现写死 `GIRL_EDGE_GAP = 2`：当初按"动画内容比裁切框左右各宽 1~2px"量
   * 出来的。但这个溢出量**随显示宽度线性放大** —— 溢出 = (内容宽×缩放 − 块宽)/2，
   * 缩放跟着块走。在默认 220px 下刚好擦边不裁；用户把挂件调大之后（实测 300px
   * 起），待机 / 动作动画的内容右沿就越过窗口右边框 1~11px，小女孩的身子被
   * DSH 的窗口边框切掉一条 —— 这正是"主体没有完全露出"的成因。
   *
   * 所以这里**按当前布局现算**：把每一路"内容高贴合块高、水平居中"的动画层
   * （待机 / 动作 / 拖动 / 发送联动跑出 / 动画2 她那段）的内容宽度算出来，取
   * 最大的左右溢出，再留 2px 安全余量。这样无论挂件多大、无论哪段在演，
   * 她的主体都完整落在视口里；同时仍然尽量贴边（溢出为零时就是原来的 2px）。
   */
  function girlSideGap() {
    var gap = GIRL_EDGE_GAP
    var girl = girlTarget()
    if (!girl) return gap
    var host = sizeOf(girl)
    if (!(host.w > 0) || !(host.h > 0)) return gap

    /** 某一路的左右溢出：内容宽（按"内容高贴合块高"的缩放）超出块宽的一半。 */
    function layerOverflow(content, vw, vh, scaleKnob) {
      if (!content || !vw || !vh || !content.h) return 0
      var scale = (host.h / content.h) * scaleKnob
      if (!isFinite(scale) || scale <= 0) return 0
      return Math.max(0, (vw * scale * (content.w / vw) - host.w) / 2)
    }

    var overflow = 0
    for (var kind in animSlots) {
      if (!Object.prototype.hasOwnProperty.call(animSlots, kind)) continue
      var slot = animSlots[kind]
      var el = slot && slot.el
      if (!el || !el.videoWidth) continue
      var cfg = animCfg(kind)
      overflow = Math.max(
        overflow,
        layerOverflow(slot.box, el.videoWidth, el.videoHeight, cfg ? cfg.scale : 1),
      )
    }
    if (dragClip && DRAG_ANIM) {
      overflow = Math.max(
        overflow,
        layerOverflow(dragBox, dragClip.videoWidth, dragClip.videoHeight, DRAG_ANIM_SCALE),
      )
    }
    if (girlClip) {
      overflow = Math.max(
        overflow,
        layerOverflow(girlBox, girlClip.videoWidth, girlClip.videoHeight, SEND_GIRL_SCALE),
      )
    }
    if (girlBasinClip) {
      overflow = Math.max(
        overflow,
        layerOverflow(girlBasinBox, girlBasinClip.videoWidth, girlBasinClip.videoHeight, RANDOM_CONTACT_SCALE),
      )
    }
    // 头上摞着的盆比块宽 8%（POT_WIDTH_RATIO），同样要留在视口里。
    if (potItems.length) overflow = Math.max(overflow, (host.w * (POT_WIDTH_RATIO - 1)) / 2)

    if (overflow <= 0) return gap
    return Math.max(gap, Math.ceil(overflow) + 2)
  }

  /**
   * 按当前尺寸重新把小女孩贴回窗口右边缘（改显示尺寸 / 改窗口大小之后调用）。
   *
   * 只在"上一次是自动贴的边"（`girlHugged`）且用户没有正在拖她的时候动手 ——
   * 她自己摆过的位置、或者正在被拖的位置，一律不抢。竖直位置保持不动，
   * 只把水平那一维顶到边框上。
   *
   * 0.10.2：间隙不再写死 2px，而是 `girlSideGap()` 按当前动画层的实际溢出现算，
   * 保证她的**主体**完整落在窗口内（见上面的漏洞说明）。每一路素材量出内容框
   * 的地方也会回来调一次本函数，让间隙跟着新数据收紧。
   */
  function rehugGirl() {
    if (!girlHugged || !partUnits) return
    var girl = partUnits[1]
    if (!girl || girl.drag) return
    var size = sizeOf(girl.el)
    if (!(size.w > 0)) return
    girl.pos = clampInside(
      viewportWidth() - size.w - girlSideGap(),
      girl.pos ? girl.pos.y : 0,
      size.w,
      size.h,
    )
    unitApply(girl)
  }

  /**
   * 把最后一帧的某个矩形区域裁成一块 canvas。直接用 video 当 drawImage 源、
   * 只取自己那块区域，所以不需要全尺寸中间画布。
   */
  function buildPart(key, box) {
    var label = key === 'cooker' ? '电饭煲' : '小女孩'
    var el = document.createElement('div')
    el.id = 'dshca-part-' + key
    el.className = 'dshca-part dshca-host dshca-ready dshca-draggable'
    el.setAttribute('role', 'img')
    el.setAttribute('aria-label', label)
    // Diagnostic: the source-pixel box this part was cropped from.
    el.setAttribute('data-src-box', box.x + ',' + box.y + ',' + box.w + ',' + box.h)

    var canvas = document.createElement('canvas')
    canvas.width = box.w
    canvas.height = box.h
    canvas.setAttribute('aria-hidden', 'true')
    var ctx = canvas.getContext('2d')
    if (ctx) ctx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h)
    el.appendChild(canvas)

    var unit = createUnit(key, el)
    unit.box = box
    unit.canvas = canvas
    return unit
  }

  function split() {
    if (!SPLIT || partUnits || destroyed) return
    if (!video.videoWidth || !video.videoHeight) return

    var frame = SPLIT_AUTO ? analyseFrame() : null
    if (!frame) frame = fallbackFrame()

    var base = rootUnit && rootUnit.pos ? rootUnit.pos : { x: 0, y: 0 }

    var cooker = buildPart('cooker', frame.cooker)
    var girl = buildPart('girl', frame.girl)
    partUnits = [cooker, girl]
    // 先把播放层（都是空 <video>，还没起播）挂到小女孩那块，随后 layOutParts
    // 定尺寸时它会跟着一起排布 —— 否则首帧会先按默认尺寸闪一下。
    attachOverlay()

    // 先挂到 DOM 再算位置，否则量不到尺寸。
    var body = document.body || document.documentElement
    body.appendChild(cooker.el)
    body.appendChild(girl.el)

    // 控制条与面板**留在小女孩一侧**。
    if (bar) {
      // 0.10.2 的防御：控制条绝不能带着「发送联动」的分离态进块 ——
      // `dshca-detached` 是 position:fixed + 视口内联坐标，而块的 filter 会让它
      // 改以块为包含块，旧坐标被二次平移，控制条直接飞出视口（漏洞4 的根因）。
      bar.classList.remove('dshca-detached')
      bar.style.width = ''
      bar.style.left = ''
      bar.style.top = ''
      girl.el.appendChild(bar)
    }
    if (panel) girl.el.appendChild(panel)
    panelBox = null
    setPanelHost(girl.el)

    layOutParts(base, false)

    root.style.display = 'none'
    layoutPanel()
    layoutOverlay()
    syncCanvasVisibility()
  }

  /** 撤回拆分：移除两个部分，控制条与面板回到整体上。 */
  function merge() {
    if (!partUnits) return
    // 0.10.2 修的漏洞4：重播必须先把「发送联动」整套复位 —— 否则停留在末帧的
    // 开盖画面会一直留在屏幕上（它挂在 body 上、不在两块里，摘块清不掉它），
    // sendPhase 卡死在 'lid'（锅不再接受点击 Q 弹 / 随机动画），搬走过的控制条
    // 带着 `dshca-detached`（position:fixed）+ 旧视口内联回到 root/小女孩块里，
    // 被它们的 filter 包含块二次平移，整个 UI 飞出视口右下角。
    // resetSendFlow 会收掉冻结帧、停掉计时器、把控制条归位成普通块内元素。
    resetSendFlow(false)
    // 两个部分马上要从页面上摘掉：先把还在进行的那次按压干净地收掉，
    // 否则快照会跟着块一起消失，而"被暂停的那段"永远接不回去。
    endSquish(true)
    // 0.10.0：两道随机动画与拖动动画也一起收（它们的画面层挂在马上要摘掉的两块
    // 上，定时器 / rAF 不先停掉就会在节点消失之后继续跑）。
    stopRandomAnims(true)
    dragAnimOn = false
    if (dragClip) dragClip.classList.remove('dshca-drag-on')
    clearLidReverseTimers()
    clearFlightArtifacts()
    // 头上的盆也一起清掉：重播是从头演一遍，不该带着上一轮的盆回来。
    clearPots()
    // 播放层属于"小女孩那一块"，先撤掉，否则它会被留在页面上。
    paused = false
    detachOverlay()
    for (var i = 0; i < partUnits.length; i += 1) {
      var unit = partUnits[i]
      releaseUnit(unit)
      if (unit.el.parentNode) unit.el.parentNode.removeChild(unit.el)
      unit.canvas = null
    }
    partUnits = null

    if (bar) root.appendChild(bar)
    if (panel) root.appendChild(panel)
    root.style.display = ''
    setPanelHost(root)
    layoutPanel()
  }

  /* ==================================================================== */
  /* §11 按压音效：合成"软弹" + 钢管彩蛋 + 内置 CD                          */
  /* ==================================================================== */
  /*                                                                      */
  /* 为什么普通音要**现场合成**而不是再来一个素材：省一次请求、也不用为 0.17   */
  /* 秒的"啪"多背一个文件；而且音量可以直接乘 PRESS_VOLUME，不需要重新编码。  */
  /* 合成的那一下刻意做成"音高快速下滑 + 指数衰减"：听感上是"软软地弹一下"，  */
  /* 和 Q 弹的形变对得上，也不会像上限幅的爆音。                             */
  /*                                                                      */
  /* 为什么 AudioContext 不在这里就建：浏览器要求"有用户手势"才让音频出声，  */
  /* 而本脚本是在页面加载时跑的。所以它**惰性创建**，触发点就是第一次按压 ——  */
  /* 那时手势刚刚发生，既不会被自动播放策略拦下，也不会在控制台留下告警。     */
  /* ==================================================================== */

  /** 惰性创建的 AudioContext（null = 还没建 / 建不起来）。 */
  var audioCtx = null
  /**
   * 两个"素材音"的槽位：`pipe` = 钢管彩蛋音，`pot` = 掉盆砸到头顶那一下。
   * 普通按压音是现场合成的，没有槽位。
   */
  var pipeClip = { url: PIPE_URL, buffer: null, loading: false, failed: false }
  var potClip = { url: POT_SOUND_URL, buffer: null, loading: false, failed: false }
  /** CD 判据①：这个时刻之前一律不出声（上一个音还没播完）。 */
  var soundBusyUntil = 0
  /** CD 判据②：上一次**起播**的时刻（防抖，见 PRESS_SOUND_GAP）。 */
  var soundLastAt = -1e9
  var soundPlays = 0
  var soundSkipped = 0
  var soundLastKind = ''

  function pressSoundEnabled() {
    return PRESS_SOUND && !destroyed
  }

  function audioContext() {
    if (audioCtx) return audioCtx
    if (!pressSoundEnabled()) return null
    var Ctor = window.AudioContext || window.webkitAudioContext
    if (typeof Ctor !== 'function') return null
    try {
      audioCtx = new Ctor()
    } catch (err) {
      audioCtx = null
    }
    return audioCtx
  }

  /**
   * 预热一个素材音（fetch → decodeAudioData），每个槽位只做一次。
   *
   * 在**用到它的那次按压**时顺手发起，不占首屏。任何一步失败都只把这一路标记成
   * 不可用（`failed`）—— 素材问题绝不能让"点一下没有反应"。
   */
  function preloadClip(clip) {
    if (clip.buffer || clip.loading || clip.failed || !pressSoundEnabled()) return
    var ctx = audioContext()
    if (!ctx) return
    var fetcher = window.fetch
    if (typeof fetcher !== 'function') return
    clip.loading = true
    try {
      var pending = fetcher(clip.url)
      if (!pending || typeof pending.then !== 'function') {
        clip.loading = false
        return
      }
      pending
        .then(function (res) {
          if (!res || res.ok === false || typeof res.arrayBuffer !== 'function') {
            throw new Error(clip.url + ' unavailable')
          }
          return res.arrayBuffer()
        })
        .then(function (raw) {
          return ctx.decodeAudioData(raw)
        })
        .then(function (decoded) {
          clip.buffer = decoded
          clip.loading = false
        })
        .catch(function () {
          clip.failed = true
          clip.loading = false
        })
    } catch (err) {
      clip.failed = true
      clip.loading = false
    }
  }

  function preloadPipe() {
    preloadClip(pipeClip)
  }

  function preloadPotSound() {
    preloadClip(potClip)
  }

  /** 合成音：一段快速下滑的音高 + 指数衰减包络（"软弹"一下）。 */
  function playSynth(ctx) {
    var at = ctx.currentTime
    var osc = ctx.createOscillator()
    var gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(520, at)
    osc.frequency.exponentialRampToValueAtTime(170, at + 0.085)
    // 指数斜坡不能到 0：起落都用 0.0001 这种"听不见但不为零"的值。
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.22 * PRESS_VOLUME), at + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(at)
    osc.stop(at + PRESS_SYNTH_MS / 1000)
  }

  /** 把一个槽位里解码好的素材播一遍（音量由调用方给）。 */
  function playClip(ctx, clip, gainValue) {
    var src = ctx.createBufferSource()
    var gain = ctx.createGain()
    src.buffer = clip.buffer
    gain.gain.value = gainValue
    src.connect(gain)
    gain.connect(ctx.destination)
    src.start()
  }

  /** 钢管彩蛋音：素材峰值是满刻度，所以按 PIPE_GAIN（= pressVolume × pipeVolume）。 */
  function playPipe(ctx) {
    playClip(ctx, pipeClip, PIPE_GAIN)
  }

  /** 盆砸到头那一下：走 pressVolume。 */
  function playPot(ctx) {
    playClip(ctx, potClip, PRESS_VOLUME)
  }

  /** 这一声要占用 CD 多久（毫秒）—— 素材音按它自己的时长，合成音按包络长度。 */
  function soundLengthMs(kind) {
    var clip = kind === 'pipe' ? pipeClip : kind === 'pot' ? potClip : null
    if (clip && clip.buffer && isFinite(clip.buffer.duration) && clip.buffer.duration > 0) {
      return clip.buffer.duration * 1000
    }
    return PRESS_SYNTH_MS
  }

  /**
   * CD 闸门：**现在允许出声吗**。两条判据都在这里，只有这一处。
   *
   * 被挡掉的那一次会记进 `soundSkipped`（自检时能看到"挡了几次"）。注意它只
   * **问**，不记账 —— 真正响过之后才由 `soundStarted()` 占住 CD，否则"想响但
   * 播失败"也会白白占掉一段静默。
   */
  function soundGateOpen() {
    if (!pressSoundEnabled()) return false
    var ctx = audioContext()
    if (!ctx) return false
    var t = now()
    if (t < soundBusyUntil || t - soundLastAt < PRESS_SOUND_GAP) {
      soundSkipped += 1
      return false
    }
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume()
    } catch (err) {
      /* 解不开就按静音走，不影响画面 */
    }
    return true
  }

  /** 响过一声之后的记账：CD 占到这个音播完为止。 */
  function soundStarted(kind) {
    var t = now()
    soundLastAt = t
    soundPlays += 1
    soundLastKind = kind
    soundBusyUntil = t + soundLengthMs(kind)
  }

  /**
   * 一次按压的出声入口；返回实际响的是哪一种（`'pipe'` / `'synth'` / `''` = 没响）。
   *
   * 顺序是刻意的：**先判 CD、再掷骰子**。被 CD 吃掉的那一次按压不该消耗掉一次
   * 7% 的机会 —— 否则连点两下就把彩蛋概率翻倍了。
   */
  function playPressSound(unit) {
    if (!soundGateOpen()) return ''
    var ctx = audioCtx
    var rare = PIPE_CHANCE > 0 && !!partUnits && unit === partUnits[0] && Math.random() < PIPE_CHANCE
    var kind = 'synth'
    try {
      if (rare && pipeClip.buffer) {
        playPipe(ctx)
        kind = 'pipe'
      } else {
        playSynth(ctx)
      }
    } catch (err) {
      return ''
    }
    // 掷中了彩蛋但素材还没解码好：这一次先用合成音顶上（已经响过了），
    // 顺手把预热继续下去 —— 下一次掷中就是真的钢管音。
    if (!pipeClip.buffer) preloadPipe()
    soundStarted(kind)
    return kind
  }

  /**
   * 盆砸到头顶那一下（由掉落动画收尾时调用）。
   *
   * 与按压音共用同一条 CD。素材还没就绪 / 建不起上下文时**这一次静默** ——
   * 不用合成音顶替：那一下听起来会变成"又按了一次"，与画面（盆砸到头）对不上。
   */
  function playPotSound() {
    if (!potClip.buffer) {
      preloadPotSound()
      return ''
    }
    if (!soundGateOpen()) return ''
    try {
      playPot(audioCtx)
    } catch (err) {
      return ''
    }
    soundStarted('pot')
    return 'pot'
  }

  /** 试听 / 自检用的小 API：`window.__dshcaPress.*`（只读状态 + 手动响一次）。 */
  function exposePressApi() {
    window.__dshcaPress = {
      version: '0.9.0',
      /** 当前音效状态：CD 还剩多久、两个素材就绪没有、上一次响的是哪一种。 */
      probe: function () {
        return {
          enabled: pressSoundEnabled(),
          volume: PRESS_VOLUME,
          pipeChance: PIPE_CHANCE,
          pipeGain: PIPE_GAIN,
          potChance: POT_CHANCE,
          context: audioCtx ? audioCtx.state : null,
          pipeReady: !!pipeClip.buffer,
          pipeSeconds: pipeClip.buffer ? pipeClip.buffer.duration : null,
          potReady: !!potClip.buffer,
          potSeconds: potClip.buffer ? potClip.buffer.duration : null,
          busyForMs: Math.max(0, Math.round(soundBusyUntil - now())),
          lastKind: soundLastKind || null,
          plays: soundPlays,
          skipped: soundSkipped,
        }
      },
      /** 手动听一遍（**不受 CD 限制**）：`__dshcaPress.play('pipe')` / `('pot')`。 */
      play: function (kind) {
        var ctx = audioContext()
        if (!ctx) return false
        try {
          if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume()
          if (kind === 'pipe') {
            preloadPipe()
            if (!pipeClip.buffer) return false
            playPipe(ctx)
          } else if (kind === 'pot') {
            preloadPotSound()
            if (!potClip.buffer) return false
            playPot(ctx)
          } else {
            playSynth(ctx)
          }
        } catch (err) {
          return false
        }
        return true
      },
      /** 清掉 CD（试听 / 自检用）。 */
      reset: function () {
        soundBusyUntil = 0
        soundLastAt = -1e9
      },
      /**
       * 等两个素材就绪（自检脚本用）；返回 `{ pipe, pot }` 各自能不能用。
       * `which` 可以是 `'pipe'` / `'pot'`，缺省两个都等。
       */
      ready: function (which) {        if (which !== 'pot') preloadPipe()
        if (which !== 'pipe') preloadPotSound()
        return new Promise(function (resolve) {
          var tries = 0
          var tick = function () {
            var pipeDone = !!pipeClip.buffer || pipeClip.failed
            var potDone = !!potClip.buffer || potClip.failed
            if ((pipeDone && potDone) || tries > 120) {
              resolve({ pipe: !!pipeClip.buffer, pot: !!potClip.buffer })
              return
            }
            tries += 1
            if (typeof window.setTimeout === 'function') window.setTimeout(tick, 50)
            else resolve({ pipe: !!pipeClip.buffer, pot: !!potClip.buffer })
          }
          tick()
        })
      },
    }
  }

  /** 掉盆的排查 / 自检入口：`window.__dshcaPots.*`（只读状态 + 两个手动动作）。 */
  function exposePotApi() {
    window.__dshcaPots = {
      version: '0.9.0',
      /** 现在头上有几个盆、各自落在哪、骰子是什么概率。 */
      probe: function () {
        var host = potHost()
        var size = host ? sizeOf(host) : { w: 0, h: 0 }
        var items = []
        for (var i = 0; i < potItems.length; i += 1) {
          var item = potItems[i]
          items.push({
            index: item.index,
            landed: item.landed,
            dragging: !!item.drag,
            fallFrom: item.fallFrom === undefined ? null : Math.round(item.fallFrom),
            left: parseFloat(item.el.style.left) || 0,
            top: parseFloat(item.el.style.top) || 0,
            tilt: Math.round(item.tilt * 100) / 100,
          })
        }
        return {
          enabled: !destroyed && POT_CHANCE > 0,
          chance: POT_CHANCE,
          max: POT_MAX,
          count: potItems.length,
          imageReady: potImageReady,
          imageFailed: potImageFailed,
          host: { w: Math.round(size.w), h: Math.round(size.h) },
          items: items,
        }
      },
      /** 手动掉一个（不受骰子限制，调试用）；返回到底掉没掉。 */
      drop: function () {
        return spawnPot()
      },
      /** 清空所有盆。 */
      clear: function () {
        clearPots()
        return true
      },
    }
  }

  /* ==================================================================== */
  /* §12 点击 Q 弹：按下把"当前这一帧"拍成快照并压扁，松开弹回并继续播放     */
  /* ==================================================================== */
  /*                                                                      */
  /* 这一段要解决的问题只有一个：**被拉伸的到底是哪一张图**。               */
  /*   · 视频还在播 → 按下那一刻先 pause()，这就冻住了"点击发生时所在帧"；  */
  /*     再把这一帧画进一张与这一块等大的 canvas，由它出面被压扁；           */
  /*   · 小女孩那两段素材（idle / act）与电饭煲的定格帧都带大片透明留白，   */
  /*     所以快照按**内容包围盒**取，且落点与动画层用的是同一套"水平居中、   */
  /*     底边对齐"，压扁的支点才正好落在她的脚 / 锅的底座上。                */
  /*                                                                      */
  /* "接着播"的语义（需求原文）：松开之后**回弹过渡走完**才把快照撤掉、把    */
  /* 原来那一层放回来，并从暂停处 play() 续上；按下时本来就没在播（定格帧、 */
  /* 已 ended 停住的末帧、被 ⏸ 冻住的那一格）就只放回画面、不接播放。        */
  /* ==================================================================== */

  /** 正在被按着的那一次（指针还没松开）。 */
  var squish = null
  /**
   * 已经松手、正在回弹、但还没收回的那一次。
   *
   * 单独记它，是因为"回弹"跨了 260ms：这期间如果发生重播 / 关闭 / 发送联动
   * 接管画面（都会调 `endSquish(true)`），那一次也必须被立刻收干净 —— 否则
   * 定时器到点时会去动一个已经不在页面上的节点，还会把一段已经被丢掉的视频
   * 接回播放。`showOnly()` 与排期器也都要认它（见 squishHolding / squishHeldSource）。
   */
  var squishSettling = null

  /**
   * 这一块此刻有没有"快照顶着画面"（按着 / 正在回弹都算）。
   *
   * 排期器用它挡拍：快照还在的时候起播下一段，松手后露出来的会是另一段
   * 已经跳过去的动画。
   */
  function squishHolding(unit) {
    if (squish && squish.unit === unit) return true
    if (squishSettling && squishSettling.unit === unit) return true
    return false
  }

  /**
   * 此刻被快照顶掉的那一层（没有就是 null）。
   *
   * 任何一次"重算谁该出画"（showOnly）之后都要再把它按回 hidden ——
   * 否则暂停 / 继续那条路径会让原来那一层从半透明的快照底下透出来。
   */
  function squishHeldSource() {
    if (squish && squish.source) return squish.source
    if (squishSettling && squishSettling.source) return squishSettling.source
    return null
  }

  /**
   * 这一块此刻"在出画"的那一层；返回 null = 这一块不参与点击拉伸。
   *
   * 判据与 `isClipShown()` 同源：小女孩那边有动画在出画就拉那一层，
   * 否则拉她那张定格 canvas；电饭煲那边只有定格 canvas 一层。
   * 两个"不参与"的时机（用户明确要求）：
   *   · 小女孩：`girlClipOn`（girl.webm 跑出动画正在演）；
   *   · 电饭煲：开盖那段正挂在它位置上（lid.webm 播放中 / 定格在末帧）。
   * 合并态（那一整块 `dshca-root`）从来不在候选里。
   */
  function squishSourceFor(unit) {
    if (!CLICK_SQUISH || destroyed || !partUnits || !unit || !unit.el) return null
    var isGirl = unit === partUnits[1]
    var isCooker = unit === partUnits[0]
    if (!isGirl && !isCooker) return null
    // 整块被藏起来的那一阶段（发送联动收尾后小女孩那块）没有可点的画面。
    if (unit.el.style.display === 'none') return null

    if (isCooker) {
      if (lidClip && lidClip.classList.contains('dshca-lid-on')) return null
      // 0.10.0：两道随机动画播放期间锅的画面归它们，点按不参与（按压音也不出，
      // 那两段素材本来就带声音）。放在最前面，因为它同时也挡住"再点一次重播"。
      if (randomAnim) return null
      return unit.canvas ? { el: unit.canvas, kind: 'canvas', slot: null } : null
    }

    if (girlClipOn) return null
    // 0.10.0：拖动动画与动画2 里她那段同样是"整幅替换她"的两段，也不参与 Q 弹。
    if (dragAnimShowing()) return null
    if (basinClipShown()) return null
    if (shownKind && animSlots[shownKind] && animSlots[shownKind].el && isClipShown(shownKind)) {
      return { el: animSlots[shownKind].el, kind: 'clip', slot: animSlots[shownKind] }
    }
    return unit.canvas ? { el: unit.canvas, kind: 'canvas', slot: null } : null
  }

  /**
   * 把"当前这一帧"画进快照 canvas。
   *
   * 快照与**所在的那一块**等大，画的时候让内容落在它真正显示的位置上：
   *   · 定格 canvas 本身就是那一块的整幅，直接铺满；
   *   · 动画层按 `slot.box`（内容包围盒）取源，落点复算 layoutOverlay 的
   *     "内容宽 = 块宽、水平居中、底边对齐" —— 两边必须同源，否则按下的一瞬
   *     画面会跳一下（内容的 scale 由元素自己的内联宽度反推，不重复测量）。
   *
   * 返回 false = 这一帧现在还拍不到（元数据没到 / 尺寸为 0），调用方直接放弃
   * 这次拉伸 —— 宁可这次点击没有反应，也绝不出现"压扁了一张空图"。
   */
  function paintSquishFrame(source, hostSize, snap) {
    var ctx = snap.getContext && snap.getContext('2d')
    if (!ctx) return false
    var el = source.el
    var sx = 0
    var sy = 0
    var sw = 0
    var sh = 0
    var dx = 0
    var dy = 0
    var dw = hostSize.w
    var dh = hostSize.h

    if (source.kind === 'clip') {
      var box = source.slot && source.slot.box
      var vw = el.videoWidth
      var vh = el.videoHeight
      if (!box || !vw || !vh) return false
      var elWidth = parseFloat(el.style.width)
      if (!isFinite(elWidth) || elWidth <= 0) return false
      var scale = elWidth / vw
      if (!isFinite(scale) || scale <= 0) return false
      sx = box.x
      sy = box.y
      sw = box.w
      sh = box.h
      dw = box.w * scale
      dh = box.h * scale
      dx = (hostSize.w - dw) / 2
      dy = hostSize.h - dh
    } else {
      sw = el.width
      sh = el.height
      if (!sw || !sh) return false
    }

    try {
      ctx.drawImage(el, sx, sy, sw, sh, dx, dy, dw, dh)
    } catch (err) {
      // 素材读不出来（理论上只有跨源素材）：放弃这次拉伸，别把画面弄丢。
      return false
    }
    return true
  }

  /**
   * 按下：拍下当前这一帧 → 暂停原来那一段 → 用快照接管画面 → 压扁。
   *
   * "压扁"分两帧完成（先挂上快照、下一帧再加 `.dshca-squished`），否则
   * 元素带着初始 transform 一起被插进 DOM，浏览器不会为它播放过渡 ——
   * 表现就是"按下去了但看起来是啪一下变的"，没有回弹。
   */
  function startSquish(unit, pointerId) {
    if (!CLICK_SQUISH || destroyed) return
    // 同一块上的第二根手指：这一块已经在被按压了，保持第一次那一下。
    if (squish && squish.unit === unit) return
    var source = squishSourceFor(unit)
    if (!source) return
    var hostSize = sizeOf(unit.el)
    if (!(hostSize.w > 0) || !(hostSize.h > 0)) return

    // 先把候选快照拍出来：拍不到就整个不参与，绝不压一张空图。
    var ratio = Math.min(2, num(window.devicePixelRatio, 1) || 1)
    var snap = document.createElement('canvas')
    snap.className = 'dshca-squish'
    snap.width = Math.max(1, Math.round(hostSize.w * ratio))
    snap.height = Math.max(1, Math.round(hostSize.h * ratio))
    snap.style.width = hostSize.w + 'px'
    snap.style.height = hostSize.h + 'px'
    snap.setAttribute('aria-hidden', 'true')
    if (!paintSquishFrame(source, hostSize, snap)) return

    // 按压音效：合成"软弹"；电饭煲那一侧有 pipeChance 的概率改响"钢管"。
    // 出声与否由内置 CD 决定（上一个没播完、或距上次起播太近，就整次静音）。
    // 放在这里 = 与画面同时成立：没压扁的按压（发送联动期间 / 合并态）也不出声。
    playPressSound(unit)

    // 掉盆（0.9.0）：同一次按压里，小女孩那一侧另有 potChance 的概率掉一个盆。
    // 两件事互不影响 —— 压扁、按压音照常，盆只是额外从天上下来。
    maybeDropPot(unit)

    // 同一时刻只允许一块被快照顶着（换手 / 两块上各一根手指 / 上一次还在回弹）：
    // 把上一次立刻收干净再上新的。
    endSquish(true)

    var wasPlaying = false
    if (source.el.tagName === 'VIDEO' && !source.el.paused && !source.el.ended) {
      wasPlaying = true
      try {
        source.el.pause()
      } catch (err) {
        /* ignore */
      }
    }

    squish = {
      unit: unit,
      pointerId: pointerId,
      source: source.el,
      snapshot: snap,
      wasPlaying: wasPlaying,
      timer: 0,
    }

    // 画面层之上、控制条之下：悬浮按钮仍然点得到，也不会跟着一起被压扁。
    if (bar && bar.parentNode === unit.el) unit.el.insertBefore(snap, bar)
    else unit.el.appendChild(snap)
    // 快照接管画面的这一刻，原来那一层让位 —— 否则半透明处会叠出两层。
    source.el.style.visibility = 'hidden'

    // 强制一次样式/布局刷新，让浏览器先把"插入时那一格"（transform 为恒等）
    // 算成初始值，再压下去 —— 只有这样按下才会走 CSS 过渡。
    // 少了这一行，插入与改 class 落在同一次样式计算里，浏览器没有可比的
    // 初始值，表现就是"啪一下到位"（真实浏览器实测踩到，桩里看不出来）。
    void snap.offsetWidth
    snap.classList.add('dshca-squished')
  }

  /**
   * 松开：`force` = 立刻收回（重播 / 关闭 / 发送联动接管时用），
   * 否则先把快照弹回原状，等回弹过渡走完再收回并把视频接回去。
   *
   * 两种"已经在回弹"的情形都在这里收口：强制调用会把回弹中的那一次也立刻
   * 收干净，于是"接管画面"的几处入口永远不必关心当前处在哪个阶段。
   */
  function endSquish(force) {
    if (squishSettling) {
      var settling = squishSettling
      squishSettling = null
      if (settling.timer) {
        if (typeof window.clearTimeout === 'function') window.clearTimeout(settling.timer)
        settling.timer = 0
      }
      finishSquish(settling)
    }
    if (!squish) return
    var state = squish
    squish = null
    if (state.timer) {
      if (typeof window.clearTimeout === 'function') window.clearTimeout(state.timer)
      state.timer = 0
    }
    if (force) {
      finishSquish(state)
      return
    }
    state.snapshot.classList.remove('dshca-squished')
    squishSettling = state
    state.timer = window.setTimeout(function () {
      state.timer = 0
      if (squishSettling === state) squishSettling = null
      finishSquish(state)
    }, SQUISH_SETTLE_MS)
  }

  /** 收回快照、把画面还给原来那一层，并按需从暂停处继续播放。 */
  function finishSquish(state) {
    if (state.snapshot && state.snapshot.parentNode) state.snapshot.parentNode.removeChild(state.snapshot)
    if (state.source) {
      state.source.style.visibility = ''
      if (state.wasPlaying) {
        try {
          var attempt = state.source.play()
          if (attempt && typeof attempt.catch === 'function') attempt.catch(function () {})
        } catch (err) {
          /* ignore */
        }
      }
    }
    // 把画面放回去之后立刻收敛一次：谁该出画仍然由 shownKind / overlayShown
    // 说了算，不会因为"刚被按过"而让某一层错误地留在屏幕上。
    settleVisibility()
    syncCanvasVisibility()
  }

  /* ==================================================================== */
  /* §13 掉盆：按压小女孩时的随机事件（钢盆从天而降、可摞高、可拖摘）        */
  /* ==================================================================== */
  /*                                                                      */
  /* 一次按压（也就是一次点击 Q 弹）里，小女孩那一侧多掷一个 POT_CHANCE：    */
  /* 掷中就让一个倒扣的钢盆从天而降、扣在她头上，**盆沿碰到头顶那一刻**响    */
  /* `basin.mp3`，同时"哐"地压一下再弹回。                                  */
  /*                                                                      */
  /* 几条结构上的选择：                                                     */
  /*   · 盆挂在**小女孩那一块里的一个容器**上（`#dshca-pots`），所以拖动她、   */
  /*     改显示尺寸、挪窗口，盆全都跟着走 —— 不需要任何同步代码；            */
  /*   · 容器自己不接指针事件，只有盆本体接：于是"拖盆"与"拖 / 压小女孩"      */
  /*     天然互不打扰（盆的 pointerdown 里还会 stopPropagation 兜一道）；     */
  /*   · 盆的叠放层级在**画面之上、控制条之下**（z-index 1 vs 2）—— 所以       */
  /*     点击 Q 弹拍快照时盆不会被拍进去、也不会被压扁（它是硬的），而悬浮     */
  /*     按钮仍然点得到；                                                  */
  /*   · 摞在第几个 = 在数组里的下标：每个盆往上抬 POT_STACK_STEP 个盆高，    */
  /*     再带一点固定的随机水平偏移与倾角（生成时定下，之后不变）。          */
  /* ==================================================================== */

  /** 装盆的容器（挂在小女孩那块里）；null = 还没建 / 还没有那块。 */
  var potLayer = null
  /** 从下往上：`[{ el, index, jitterX, tilt, landed, drag, timer }]`。 */
  var potItems = []
  var potImageReady = false
  var potImageFailed = false

  /**
   * 预热盆的图片（只做一次）。
   *
   * 在挂载时就开始拉：它只有 ~400KB，而第一次按压至少发生在开场动画（6 秒）之后，
   * 所以真正用到时一定已经在缓存里 —— 掉下来的盆不会先空一下再出现。
   * 失败也无所谓：盆仍然会生成，只是那一次看不见图（不影响任何逻辑）。
   */
  function preloadPotImage() {
    if (potImageReady || potImageFailed) return
    var Img = window.Image
    if (typeof Img !== 'function') return
    try {
      var img = new Img()
      img.onload = function () {
        potImageReady = true
      }
      img.onerror = function () {
        potImageFailed = true
      }
      img.src = POT_URL
    } catch (err) {
      potImageFailed = true
    }
  }

  /** 小女孩那一块（还挂在页面上、且没被 display:none 藏起来时）。 */
  function potHost() {
    var girl = girlTarget()
    if (!girl) return null
    return girl
  }

  /** 保证容器存在并挂对位置（画面层之上、控制条之下）。 */
  function ensurePotLayer() {
    var host = potHost()
    if (!host) return null
    if (!potLayer) {
      potLayer = document.createElement('div')
      potLayer.id = 'dshca-pots'
      potLayer.setAttribute('aria-hidden', 'true')
    }
    if (potLayer.parentNode !== host) {
      if (bar && bar.parentNode === host) host.insertBefore(potLayer, bar)
      else host.appendChild(potLayer)
    }
    return potLayer
  }

  /**
   * 第 `index` 摞上那个盆的尺寸与落点（都在小女孩那一块的局部坐标里）。
   *
   * 尺寸跟着块走（宽 = 块宽 × POT_WIDTH_RATIO），落点 = 水平居中 + 下沿落在
   * 块高的 POT_RIM_RATIO 处，再按摞数往上抬 —— 所以改显示尺寸 / 挪窗口之后
   * 只需要重跑一遍这个函数，不需要任何常量重算。
   */
  function potSlot(index) {
    var host = potHost()
    if (!host) return null
    var size = sizeOf(host)
    if (!(size.w > 0) || !(size.h > 0)) return null
    var item = potItems[index]
    var w = size.w * POT_WIDTH_RATIO
    var h = w / POT_ASPECT
    var jitterX = item ? item.jitterX : 0
    var tilt = item ? item.tilt : POT_TILT
    return {
      w: w,
      h: h,
      x: (size.w - w) / 2 + jitterX * size.w,
      y: size.h * POT_RIM_RATIO - index * h * POT_STACK_STEP - h,
      tilt: tilt,
      fall: h * POT_FALL_RATIO,
    }
  }

  /** 把某个盆摆到它的槽位上（只写几何，不动掉落 / 拖拽用的 transform 与过渡）。 */
  function applyPotSlot(item, index) {
    var slot = potSlot(index)
    if (!slot) return null
    item.index = index
    item.el.style.width = slot.w.toFixed(2) + 'px'
    item.el.style.height = slot.h.toFixed(2) + 'px'
    item.el.style.left = slot.x.toFixed(2) + 'px'
    item.el.style.top = slot.y.toFixed(2) + 'px'
    item.el.style.setProperty('--dshca-pot-tilt', slot.tilt.toFixed(2) + 'deg')
    return slot
  }

  /**
   * 尺寸变化后把所有盆重排一遍（正在拖的那个不动）。
   *
   * 同时也在这里刷新每个盆的**下标** —— 摘掉中间一个之后，上面那些要重新摞下来。
   */
  function layoutPots() {
    if (!potItems.length) return
    for (var i = 0; i < potItems.length; i += 1) {
      var item = potItems[i]
      item.index = i
      if (item.drag || !item.landed) continue
      applyPotSlot(item, i)
    }
  }

  /** 掷一次骰子；返回 true = 这一次真的掉了一个盆。 */
  function maybeDropPot(unit) {
    if (!partUnits || unit !== partUnits[1]) return false
    if (POT_CHANCE <= 0 || Math.random() >= POT_CHANCE) return false
    return spawnPot()
  }

  /**
   * 生成一个盆并让它掉下来。
   *
   * 掉落分两帧：先摆到"天上"（transform 里的 translateY），强制一次样式刷新，
   * 再改回落点并带上过渡 —— 少了那次强制刷新，插入与改动落在同一次样式计算里，
   * 浏览器没有可比的初始值，盆会"啪"地直接出现在头上（点击 Q 弹那边踩过同一个坑）。
   */
  function spawnPot() {
    var layer = ensurePotLayer()
    if (!layer) return false
    if (potItems.length >= POT_MAX) return false
    var el = document.createElement('div')
    el.className = 'dshca-pot'
    var item = {
      el: el,
      index: potItems.length,
      jitterX: (Math.random() * 2 - 1) * POT_OFFSET_JITTER,
      tilt: POT_TILT + (Math.random() * 2 - 1) * POT_TILT_JITTER,
      landed: false,
      drag: null,
      timer: 0,
    }
    potItems.push(item)
    layer.appendChild(el)
    bindPot(item)
    // 掉落有 420ms —— 这段时间刚好够把那条 25KB 的音效拉下来解码，
    // 所以"第一次掉盆没声音"这件事基本不会发生（预热在这里发起，见 preloadClip）。
    preloadPotSound()
    var slot = applyPotSlot(item, item.index)
    if (!slot) {
      potItems.pop()
      if (el.parentNode) el.parentNode.removeChild(el)
      return false
    }

    var landedTransform = 'rotate(' + item.tilt.toFixed(2) + 'deg)'
    item.fallFrom = -slot.fall
    item.el.style.transition = 'none'
    el.style.transform = 'translateY(' + (-slot.fall).toFixed(2) + 'px) ' + landedTransform
    void el.offsetWidth // 让"天上"这一格先被算成初始值
    el.style.transition = 'transform ' + POT_FALL_MS + 'ms cubic-bezier(.42,.02,.86,.42)'
    el.style.transform = landedTransform

    item.timer = window.setTimeout(function () {
      item.timer = 0
      onPotLanded(item)
    }, POT_FALL_MS)
    return true
  }

  /** 盆沿碰到头顶：响一声、压一下再弹回，从此算"已经摞在头上"。 */
  function onPotLanded(item) {
    if (potItems.indexOf(item) < 0) return
    item.landed = true
    var el = item.el
    var settled = 'rotate(' + item.tilt.toFixed(2) + 'deg)'
    // 落点先对齐到槽位（掉落期间只有 transform 有过渡，所以 left/top 是瞬时的）。
    applyPotSlot(item, item.index)
    el.style.transition = 'transform .24s ease-out'
    el.style.transform = settled + ' scale(1.07,.9)'
    playPotSound()
    window.setTimeout(function () {
      if (potItems.indexOf(item) < 0) return
      el.style.transition = 'transform .18s ease-out'
      el.style.transform = settled
    }, 120)
  }

  /** 把一个盆拖到一旁摘掉：淡出 + 缩小，然后把上面那些重新摞下来。 */
  function removePot(item) {
    var index = potItems.indexOf(item)
    if (index < 0) return
    potItems.splice(index, 1)
    if (item.timer) {
      if (typeof window.clearTimeout === 'function') window.clearTimeout(item.timer)
      item.timer = 0
    }
    item.drag = null
    var el = item.el
    el.style.transition = 'opacity ' + POT_REMOVE_MS + 'ms ease, transform ' + POT_REMOVE_MS + 'ms ease'
    el.style.opacity = '0'
    el.style.transform = 'rotate(' + item.tilt.toFixed(2) + 'deg) scale(.6)'
    window.setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el)
    }, POT_REMOVE_MS)
    layoutPots()
  }

  /** 清空所有盆（重播 / 关闭 / 拆回整体时）。 */
  function clearPots() {
    for (var i = 0; i < potItems.length; i += 1) {
      var item = potItems[i]
      if (item.timer) {
        if (typeof window.clearTimeout === 'function') window.clearTimeout(item.timer)
        item.timer = 0
      }
      if (item.el.parentNode) item.el.parentNode.removeChild(item.el)
    }
    potItems = []
    if (potLayer && potLayer.parentNode) potLayer.parentNode.removeChild(potLayer)
    potLayer = null
  }

  /** 事件目标是不是落在某个盆上（用它把"拖盆"从"拖/压小女孩"里摘出来）。 */
  function isPotTarget(target) {
    var node = target
    while (node) {
      if (node.className && String(node.className).indexOf('dshca-pot') >= 0) return true
      if (node.id === 'dshca-pots') return true
      node = node.parentNode
    }
    return false
  }

  function potPointerDown(item, event) {
    if (item.drag) return
    if (typeof event.button === 'number' && event.button !== 0) return
    item.drag = {
      id: event.pointerId,
      // 记"按下那一刻它在哪个 left/top"，之后只按**位移增量**跟手 ——
      // 这样不必碰任何 getBoundingClientRect，指针坐标与元素坐标之间的那点
      // 换算误差也就无从累积（和拖动整块那套是同一个写法）。
      startX: event.clientX,
      startY: event.clientY,
      originX: parseFloat(item.el.style.left) || 0,
      originY: parseFloat(item.el.style.top) || 0,
    }
    // 拖动期间不要过渡：手指到哪就是哪。
    item.el.style.transition = 'none'
    item.el.classList.add('dshca-pot-dragging')
    try {
      item.el.setPointerCapture(event.pointerId)
    } catch (err) {
      /* 抓不住也照样能拖，只是划出元素之后可能收不到 move */
    }
    // 关键：这一下绝不能冒泡到小女孩那一块上 —— 否则会顺手把她拖走 / 压扁。
    event.preventDefault()
    event.stopPropagation()
  }

  function potPointerMove(item, event) {
    var drag = item.drag
    if (!drag || event.pointerId !== drag.id) return
    item.el.style.left = (drag.originX + (event.clientX - drag.startX)).toFixed(2) + 'px'
    item.el.style.top = (drag.originY + (event.clientY - drag.startY)).toFixed(2) + 'px'
    event.preventDefault()
    event.stopPropagation()
  }

  /**
   * 松手：离原位够远就摘掉，不够就弹回原位。
   *
   * 阈值按**块宽的比例**算（而不是固定像素），所以改显示尺寸之后手感一致。
   */
  function potPointerUp(item, event) {
    var drag = item.drag
    if (!drag || event.pointerId !== drag.id) return
    item.drag = null
    item.el.classList.remove('dshca-pot-dragging')
    try {
      item.el.releasePointerCapture(drag.id)
    } catch (err) {
      /* already released */
    }

    var slot = potSlot(item.index)
    var x = parseFloat(item.el.style.left)
    var y = parseFloat(item.el.style.top)
    if (!isFinite(x)) x = slot ? slot.x : 0
    if (!isFinite(y)) y = slot ? slot.y : 0
    var host = potHost()
    var size = host ? sizeOf(host) : { w: 0, h: 0 }
    var limit = Math.max(24, size.w * POT_REMOVE_RATIO)
    var dx = slot ? x - slot.x : 0
    var dy = slot ? y - slot.y : 0
    if (Math.sqrt(dx * dx + dy * dy) > limit) {
      removePot(item)
      event.stopPropagation()
      return
    }
    // 弹回原位：这一下要让 left/top 也走过渡。
    item.el.style.transition = 'left .22s ease, top .22s ease, transform .22s ease'
    applyPotSlot(item, item.index)
    event.stopPropagation()
  }

  /** 给一个盆挂上它自己的三个指针监听（与拖动单元那套同形，但独立）。 */
  function bindPot(item) {
    item.el.addEventListener('pointerdown', function (event) {
      potPointerDown(item, event)
    })
    item.el.addEventListener('pointermove', function (event) {
      potPointerMove(item, event)
    })
    item.el.addEventListener('pointerup', function (event) {
      potPointerUp(item, event)
    })
    item.el.addEventListener('pointercancel', function (event) {
      potPointerUp(item, event)
    })
  }

  /**
   * 小女孩那段跑出动画（girl.webm）期间把盆藏起来。
   *
   * 那一段**独占画面**（她本人已经被替换掉了），留在原地的盆会变成"浮在半空的
   * 帽子"。整块被 display:none 藏起来时不需要叫它 —— 子节点跟着一起没了。
   */
  /**
   * 小女孩那段跑出动画（girl.webm）期间把盆藏起来（0.10.0 起还有两个同类时机）。
   *
   * 那几段素材都是**整幅替换**她的（她本人已经被替换掉了），留在原地的盆会变成
   * "浮在半空的帽子"。三类时机共用这一条判据：
   *   · `girlClipOn` —— 点发送之后她跑出去那一段；
   *   · `basinClipShown()` —— 动画2 里钢盆扣头那一段；
   *   · `dragAnimShowing()` —— 拖动动画（那段素材自己画着"被拎起来"的样子）。
   * 整块被 display:none 藏起来时不需要叫它 —— 子节点跟着一起没了。
   */
  function setPotsVisible(on) {
    if (potLayer) potLayer.style.visibility = on ? '' : 'hidden'
  }

  /** 让盆的显隐跟着上面那三类时机走（每次状态变化后调一次）。 */
  function refreshPotsVisible() {
    setPotsVisible(!girlClipOn && !basinClipShown() && !dragAnimShowing())
  }

  /* ==================================================================== */
  /* §14 电饭煲的两种随机动画（与点击 Q 弹互斥：先掷 A，再掷 B，都没中才 Q 弹）*/
  /* ==================================================================== */
  /*                                                                      */
  /* 一次"点击电饭煲"最多触发一件事，三个结果加起来是 1：                    */
  /*   · 动画1（空锅开盖）：概率 randomAChance，默认 20%；                   */
  /*   · 动画2（米饭热气）：概率 randomBChance，默认 10%；                   */
  /*   · 剩下的 70%：什么都没掷中 —— 走 0.8.0 那套"点击 Q 弹 + 按压音效"。   */
  /* 两者天然互斥（先问 A、只有不是 A 才问 B），所以永远不会同时播。          */
  /*                                                                      */
  /* 几何上这两段素材与发送联动的开盖是同一类：画幅 960x960（正方形）、内容   */
  /* 只占中间一条，所以照样**按内容包围盒**摆 —— 内容宽贴齐电饭煲那一块的宽， */
  /* 水平对着它的中线、内容下沿对齐它的下沿，于是看起来就是那口锅自己在开盖。 */
  /* 播放期间原来那口锅的定格 canvas 让位，屏幕上始终只有一口锅。            */
  /* ==================================================================== */

  /**
   * 电饭煲那一块现在能不能被"随机动画"接管。
   *
   * 与 `squishSourceFor` 同一套"不参与"时机（发送联动的两段、已经在演的随机
   * 动画本身），再加上一条：这一块得真的在页面上、且没被藏起来。
   */
  function randomAnimBlocked() {
    if (!RANDOM_ENABLED || destroyed || !partUnits) return true
    if (randomAnim) return true
    if (girlClipOn || dragAnimOn) return true
    if (basinClipShown()) return true
    if (lidClip && lidClip.classList.contains('dshca-lid-on')) return true
    if (sendPhase !== 'idle') return true
    var cooker = partUnits[0]
    if (!cooker || !cooker.el || !cooker.el.parentNode) return true
    if (cooker.el.classList.contains('dshca-cooker-hidden')) return true
    return false
  }

  /**
   * 掷这一次点击的骰子。返回 true = 这一次按压已经被随机动画接管（调用方
   * 必须放弃压扁与按压音）。
   *
   * 顺序是刻意的：先掷 A（20%），只有 A 没中才问 B（10%）—— 两个概率相加
   * 才是"这一下会播随机动画"的总概率，而且**绝不会有两次都中的可能**。
   */
  function maybePlayRandomCooker(unit) {
    if (randomAnimBlocked()) return false
    if (!partUnits || unit !== partUnits[0]) return false
    if (RANDOM_A_CHANCE <= 0 && RANDOM_B_CHANCE <= 0) return false
    if (RANDOM_A_CHANCE > 0 && Math.random() < RANDOM_A_CHANCE) return playRandomLid('lid1')
    // 动画2 走 `openGirlBasinFlow()`：它把"她那段 + 锅飞过去"**一起**起起来。
    // `playRandomLid('lid2')` 只换锅那一侧的画面 —— 早先这里直接调了它，于是
    // 点出来的动画2 只有锅在开盖，她那段与"追过去"整个不见了。
    if (RANDOM_B_CHANCE > 0 && Math.random() < RANDOM_B_CHANCE) {
      openGirlBasinFlow()
      return randomAnim === 'lid2'
    }
    return false
  }

  /** 两道随机动画各自的素材 URL / 内容倍率 / 挂在哪个槽位上。 */
  function randomLidSpec(kind) {
    if (kind === 'lid1') return { url: LID_EMPTY_URL, scale: RANDOM_A_SCALE, slot: 'a' }
    if (kind === 'lid2') return { url: LID_RICE_URL, scale: RANDOM_B_SCALE, slot: 'b' }
    return null
  }

  /* --- 诊断账本：`window.__dshcaRandomDebug` ---------------------------- */
  /* 与 `window.__dshcaSendDebug` 同一个套路：每次判断 / 每次起播都留一笔，   */
  /* 排查"点了没反应 / 锅飞了没回来"时先看它。                              */

  var randomEvents = []
  function randomDebug(kind, detail) {
    var entry = { t: Math.round(now()), kind: kind, detail: detail === undefined ? null : detail }
    randomEvents.push(entry)
    if (randomEvents.length > 80) randomEvents.shift()
    try {
      window.__dshcaRandomDebug = { stage: randomAnim, events: randomEvents, last: entry }
    } catch (err) {
      /* ignore */
    }
  }

  function ensureCookerClip(kind) {
    if (destroyed || !partUnits) return null
    var spec = randomLidSpec(kind)
    if (!spec) return null
    var cooker = partUnits[0]
    var existing = spec.slot === 'a' ? cookerClipA : cookerClipB
    if (existing) {
      // 重播会先把两块（连同这两段视频）从页面上摘掉，而节点是留着重用的 ——
      // 所以这里必须确认它还挂在锅那一块上（与 ensureGirlClip 同一个坑）。
      if (existing.parentNode !== cooker.el) cooker.el.appendChild(existing)
      return existing
    }

    // **带声**（用户明确要的）：起点是用户点锅那一下，手势就在眼前，所以
    // 不会被自动播放策略拦下；真被拦了就退回静音，画面照旧（见 playRandomLid）。
    var el = createClipVideo({
      id: spec.slot === 'a' ? 'dshca-cooker-a' : 'dshca-cooker-b',
      url: spec.url,
      muted: false,
    })
    el.addEventListener('loadedmetadata', layoutCookerLidAnims)
    el.addEventListener('loadeddata', function () {
      measureLidAtAnchor(el, spec.slot)
      layoutCookerLidAnims()
    })
    el.addEventListener('timeupdate', function () {
      onCookerLidTick(kind, el)
    })
    el.addEventListener('ended', function () {
      onCookerLidEnded(kind, el)
    })
    el.addEventListener('error', function () {
      // 素材坏了：直接当作演完，把画面干净地交回去，绝不卡在"锅不见了"。
      randomDebug('lid-error', kind)
      if (randomAnim === kind) onCookerLidEnded(kind, el, true)
    })

    if (spec.slot === 'a') cookerClipA = el
    else cookerClipB = el
    cooker.el.appendChild(el)
    return el
  }

  /**
   * 那口锅（动画里画着的那口完整的锅）在屏幕上该落在哪。
   *
   * 与 `layoutLid()` 同一套公式，差别只在"用哪一个内容包围盒"与倍率，以及
   * 两段素材各自缓存自己量到的框（它们是两份文件，留白不一定一样）。
   *
   * **内容宽贴齐锅那一块的宽**：这一块本来就是照着最后那一帧里那口锅裁出来的，
   * 而素材里那口锅在同一高度上的宽度与它基本一致（604 源像素 ↔ 拆分框 604 源
   * 像素），所以"内容宽 = 块宽"就是"锅还是原来大小"；内容下沿对齐块的下沿，
   * 于是看起来就是那口锅自己在开盖，位置与大小都不跳。
   */
  function layoutCookerLidAnims() {
    if (!partUnits) return
    var cooker = partUnits[0]
    var box = cooker.el.getBoundingClientRect()
    if (!(box.width > 0)) return
    var specs = [
      { el: cookerClipA, content: cookerBoxA, scale: RANDOM_A_SCALE },
      { el: cookerClipB, content: cookerBoxB, scale: RANDOM_B_SCALE },
    ]
    for (var i = 0; i < specs.length; i += 1) {
      var el = specs[i].el
      if (!el) continue
      var vw = el.videoWidth
      var vh = el.videoHeight
      if (!vw || !vh) continue
      var content = specs[i].content || { x: 0, y: 0, w: vw, h: vh }
      markContentBox(el, content)
      // 内容宽贴齐锅那一块的宽 —— 这一块本来就是照着锅裁出来的，所以
      // "内容宽 = 块宽"就是"两口锅一样大"。
      var scale = (box.width / content.w) * specs[i].scale
      if (!isFinite(scale) || scale <= 0) continue
      placeContentBox(el, vw, vh, content, scale, { w: box.width, h: box.height })
    }
  }

  /**
   * 把元素 seek 到某一时刻，**等 `seeked` 真的到了**再回调。
   *
   * 为什么不能"设完 currentTime 直接量"：那一刻新的一帧往往还没解码出来，
   * 画布上仍是上一帧（或干脆是空白），量出来的包围盒会是垃圾 —— 自检里就
   * 量到过一个 565x3 的框，于是"她那段"被放大 36 倍、飞到屏幕外，而接触判据
   * 在 22ms 就宣告"已经碰到"。
   *
   * 回调拿到 `{ box, reached }`：`box` 是**当前这一帧**的内容包围盒，`reached`
   * 表示 seek 真的成功（false = 元素不可 seek，调用方该退回整幅）。
   */
  function measureAt(el, time, cb) {
    var done = false
    var finish = function (reached) {
      if (done) return
      done = true
      var box = null
      try {
        box = measureContent(el)
      } catch (err) {
        box = null
      }
      cb(box, reached)
    }
    var onSeeked = function () {
      el.removeEventListener('seeked', onSeeked)
      if (timer) {
        if (typeof window.clearTimeout === 'function') window.clearTimeout(timer)
        timer = 0
      }
      finish(true)
    }
    el.addEventListener('seeked', onSeeked)
    // 兜底：某些元素 / 某些时刻 seek 不触发 `seeked`，别让整个流程卡在等待上。
    var timer = window.setTimeout(function () {
      timer = 0
      el.removeEventListener('seeked', onSeeked)
      finish(false)
    }, 900)
    try {
      el.currentTime = time
    } catch (err) {
      if (timer) {
        if (typeof window.clearTimeout === 'function') window.clearTimeout(timer)
        timer = 0
      }
      el.removeEventListener('seeked', onSeeked)
      finish(false)
    }
  }

  /**
   * 量出"那口锅"在素材里的位置与大小。
   *
   * **优先取 0.04 秒那一帧**（"盖刚离开锅身一丁点"，正是拆分时定格的那一格），
   * 这样同一段动画在哪台机器上跑都是同一个大小。但**只有在这一段还没起播时**
   * 才去 seek：对正在播放的元素做 seek 会把它的时间轴拽走（自检实测：倒放会从
   * 0.6 秒就开始，整段开盖只演了一瞬）。真正播放期间 `loadeddata` 迟到的话，
   * 就地量当前这一帧顶上去 —— 大小略有出入，但绝不会打断播放。
   */
  function measureLidAtAnchor(el, slot) {
    var anchor = 0.04
    var duration = el.duration
    if (isFinite(duration) && duration > 0 && duration < anchor * 2) anchor = 0
    if (!el.videoWidth) {
      // 元数据还没来 —— 等到了再量一次（量完照样会重排）。
      el.addEventListener(
        'loadeddata',
        function () {
          measureLidAtAnchor(el, slot)
          layoutCookerLidAnims()
        },
        { once: true },
      )
      return
    }
    var store = function (box) {
      if (slot === 'a') cookerBoxA = box
      else cookerBoxB = box
      layoutCookerLidAnims()
    }
    var fallback = { x: 0, y: 0, w: el.videoWidth, h: el.videoHeight }
    // 已经在播了：绝不 seek（会打断播放），就地量一帧。
    var playing = false
    try {
      playing = !el.paused && !el.ended && el.currentTime > 0
    } catch (err) {
      playing = true
    }
    if (playing || anchor <= 0) {
      store(measureContent(el) || fallback)
      return
    }
    measureAt(el, anchor, function (box, reached) {
      if (!reached) {
        // seek 不成功就不乱写：留着上一次量到的框（没有就整幅等比）。
        if (!(slot === 'a' ? cookerBoxA : cookerBoxB)) store(fallback)
        return
      }
      store(box || fallback)
      // 量完把时间轴放回 0：这里只是一次探测，不该影响接下来的播放。
      try {
        el.currentTime = 0
      } catch (err) {
        /* ignore */
      }
    })
  }

  /** 播放期间原来那口锅让位（`on` 为假就把画面交回去）。 */
  function setCookerShown(on) {
    if (!partUnits) return
    var cooker = partUnits[0]
    if (on) cooker.el.classList.add('dshca-random-hidden')
    else cooker.el.classList.remove('dshca-random-hidden')
  }

  /**
   * 起播一道随机动画。返回 true = 这一次点击归它了。
   *
   * 起点刻意留在**用户点锅那一下**（`unitPointerDown` 里直接调到这里），所以带声
   * 播放不会被自动播放策略拦；播放期间排期器停摆（她头上那段的"唯一一段画面"
   * 不变量在电饭煲这一侧同样要成立：屏幕上不能同时有两口锅）。
   */
  function playRandomLid(kind) {
    // 已经有一个在演就不重入。`openGirlBasinFlow()` 是唯一会走这条路的例外：
    // 它为了避开重入判据，会**先**把 randomAnim 置成 'lid2' 再来调这里 ——
    // 判据因此只是"槽位相同"，不再去猜那个元素当前是不是 paused。
    // （早先按"元素是否 paused"认，结果是连掷 400 次骰子之后有一次卡在
    //   paused=true 上，整段动画2 被自己的重入判据拒掉。判据越简单越可靠。）
    if (randomAnim && randomAnim !== kind) {
      randomDebug('reentry-blocked', { want: kind, have: randomAnim })
      return false
    }
    var claimed = randomAnim === kind
    if (!claimed && randomAnimBlocked()) {
      randomDebug('blocked', { want: kind })
      return false
    }
    var el = ensureCookerClip(kind)
    if (!el) {
      randomDebug('no-clip', { want: kind })
      return false
    }
    randomAnim = kind
    randomHijack = true
    if (basinScheduleWasOn === null) {
      basinScheduleWasOn = scheduleOn
      if (scheduleOn) pauseSchedule()
    }
    layoutCookerLidAnims()
    setCookerShown(true)
    // 从头演（重播那一下不能接着上一轮的位置继续）—— 顺带把倒放改过的速率复位。
    try {
      el.currentTime = 0
    } catch (err) {
      /* seek may fail before metadata */
    }
    try {
      el.playbackRate = 1
    } catch (err) {
      /* ignore */
    }
    // 这里**不**动她那一侧的显隐：电饭煲换画面与她无关。她那一侧由
    // `openGirlBasinFlow()` 在"她那段真的出画之后"才让位（见那段里的顺序注释）
    // —— 提前让位会在她与锅交接的空隙里留出一帧"什么都没有"。
    el.classList.add('dshca-cooker-on')
    randomDebug('start', { kind: kind, muted: el.muted })
    // 'playing' = 真的出画了（第一帧已经准备好）。用它而不是"调过 play()"：
    // 后者在素材还没解码好时给不出一帧能看的画面，提前藏掉她那一格就会闪一下。
    el.addEventListener(
      'playing',
      function () {
        if (randomAnim === kind) syncCanvasVisibility()
      },
      { once: true },
    )
    var attempt = el.play()
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(function () {
        // 带声被拦：静音再放一次。画面才是这一段的主体，不能因为声音没了就不演。
        randomDebug('audio-blocked', kind)
        el.muted = true
        var second = el.play()
        if (second && typeof second.catch === 'function') {
          second.catch(function () {
            // 连静音都放不了：把画面干净地交回去，别留着一口不见了的锅。
            randomDebug('blocked', kind)
            if (randomAnim === kind) onCookerLidEnded(kind, el, true)
          })
        }
      })
    }
    // 兜底：'ended' 因为任何原因没来也不能让锅永远消失（原时长 + 3 秒）。
    var duration = el.duration
    var guard = (isFinite(duration) && duration > 0 ? duration * 1000 : 5200) + RANDOM_REVERSE_GUARD_MS
    lidGuardTimer = window.setTimeout(function () {
      lidGuardTimer = 0
      if (randomAnim !== kind) return
      randomDebug('guard', kind)
      onCookerLidEnded(kind, el, true)
    }, guard)
    return true
  }

  /**
   * 倒放的**进度条**：用 timeupdate 而不是去读 currentTime 的每一帧。
   *
   * 为什么不做成"每帧设一次 currentTime"：`playbackRate = -1` 在浏览器里本来就不
   * 被支持，而逐帧 seek 在 VP9 上会疯狂重新解码（画面会一卡一卡的）。这里让元素
   * 用**正速率往前播**，只是把它按真实时间轴拨回去 —— 视觉上就是"原路退回"，
   * 顺滑且只用一次 seek 起步。
   */
  function reverseLidProgress(el, startedAt, fromTime) {
    var elapsed = now() - startedAt
    var ratio = RANDOM_REVERSE_MS > 0 ? elapsed / RANDOM_REVERSE_MS : 1
    if (ratio > 1) ratio = 1
    try {
      el.playbackRate = 1
      el.currentTime = fromTime * (1 - ratio)
    } catch (err) {
      /* ignore */
    }
    return ratio >= 1
  }

  function clearLidReverseTimers() {
    if (lidReverseTimer) {
      if (typeof window.clearTimeout === 'function') window.clearTimeout(lidReverseTimer)
      lidReverseTimer = 0
    }
    if (lidGuardTimer) {
      if (typeof window.clearTimeout === 'function') window.clearTimeout(lidGuardTimer)
      lidGuardTimer = 0
    }
  }

  /** 收干净：定时器、状态、隐藏那一层，然后把画面交回锅原来的定格图。 */
  function clearRandomAnim() {
    clearLidReverseTimers()
    // **飞行那一套东西也要在这里收**（定时器、rAF、transform、class）。
    // 只挂在 `stopRandomAnims()`（重播 / 关闭那条路）是不够的：正常演完走的是
    // 这里，漏了就会留下一个"歪在一边、还带着 dshca-flying"的锅 —— 自检里
    // 就是"接触之后电饭煲没有归位"（实际是左/上没变，只是 transform 还挂着）。
    clearFlightArtifacts()
    randomAnim = null
    randomHijack = false
    var a = cookerClipA
    var b = cookerClipB
    if (a) {
      try {
        a.pause()
      } catch (err) {
        /* ignore */
      }
      a.classList.remove('dshca-cooker-on')
    }
    if (b) {
      try {
        b.pause()
      } catch (err) {
        /* ignore */
      }
      b.classList.remove('dshca-cooker-on')
    }
    setCookerShown(false)
    // 先把 randomAnim 清掉（调用方已经清了，这里兜一道），再收敛一次画面：
    // 她那一侧该回到"上一段动画的末帧 / 定格图"，电饭煲那一侧回到它的定格图。
    syncCanvasVisibility()
    // 动画2 收工后她那一格回来了 —— 摞在她头上的盆也要跟着回来（0.10.1）。
    // 放在 refreshPotsVisible 的判据自然成立的位置：basinClipShown() 已经是假。
    refreshPotsVisible()
    settleVisibility()
    resumeAfterRandom()
  }

  /** 随机动画（两种）共用一套"起播状态"：播放期间锅那一块不再接受 Q 弹。 */
  function onCookerLidTick(kind, el) {
    if (randomAnim !== kind || lidReverseTimer) return
    var duration = el.duration
    if (!isFinite(duration) || duration <= 0) return
    // 留 0.05 秒不进倒放：倒放需要一个明确的正向起点，贴着 0 起步会只剩几毫秒。
    if (el.currentTime >= duration - 0.05) beginLidReverse(kind, el)
  }

  /**
   * 动画1 播完：**倒放**回第 0 帧（这就是"变回原样"的那个过程）。
   *
   * 动画2 在这台机器上由"接触"叫停，走的是 `finishRandomLid2`（不等它自己播完）；
   * 万一它先播完了（接触迟迟没发生），同样倒放收工 —— 两条路都落到同一个收尾。
   */
  function beginLidReverse(kind, el) {
    if (lidReverseTimer || randomAnim !== kind) return
    if (lidGuardTimer) {
      if (typeof window.clearTimeout === 'function') window.clearTimeout(lidGuardTimer)
      lidGuardTimer = 0
    }
    var duration = el.duration
    var fromTime = isFinite(duration) && duration > 0 ? Math.min(el.currentTime, duration) : el.currentTime
    randomDebug('reverse-start', { kind: kind, from: Math.round(fromTime * 1000) / 1000 })
    var startedAt = now()
    // 先停下（下一拍就往前拨）—— 元素用正速率播放，只是时间轴被我们往回拨。
    try {
      el.pause()
    } catch (err) {
      /* ignore */
    }
    // 用 rAF 驱动（不是定时器）：它天然与合成器同拍，倒放看起来才像"顺着原路
    // 退回"而不是一跳一跳。`lidReverseTimer` 仍然当"倒放进行中"的标志用 ——
    // 它是 rAF 句柄，非 0 即真。
    var step = function () {
      lidReverseTimer = 0
      if (randomAnim !== kind || destroyed) return
      var done = shouldStopReverse(kind) || reverseLidProgress(el, startedAt, fromTime)
      if (done) {
        randomDebug('reverse-done', kind)
        finishRandomLid(kind)
        return
      }
      if (typeof window.requestAnimationFrame === 'function') {
        lidReverseTimer = window.requestAnimationFrame(step)
      } else {
        lidReverseTimer = window.setTimeout(step, 33)
      }
    }
    step()
  }

  /**
   * 动画2 的倒放提前收工：接触已经发生，没必要再慢慢倒回去。
   *
   * 这一条在动画1 的路径上永远为假（那条路必须老老实实倒放完），留着它是因为
   * 倒放这套逻辑两种动画共用，而"要不要提前停"是动画2 才有的语义。
   */
  function shouldStopReverse(kind) {
    return kind === 'lid2' && basinContactHappened
  }

  /** 一次随机动画的收尾：**立刻**把画面交回锅原来那格定格图（用户选的）。 */
  function finishRandomLid(kind) {
    if (randomAnim !== kind) return
    // 状态先落地，再交画面：否则 showOnly 会在 randomAnim 还挂着时按老状态重算。
    randomAnim = null
    randomHijack = false
    randomDebug('finish', kind)
    clearRandomAnim()
  }

  function onCookerLidEnded(kind, el, forced) {
    if (randomAnim !== kind) return
    if (forced) {
      finishRandomLid(kind)
      return
    }
    var duration = el.duration
    if (isFinite(duration) && duration > 0 && el.currentTime >= duration - 0.08) {
      beginLidReverse(kind, el)
      return
    }
    // 被外部打断（换素材 / 用户重播）—— 不值得倒放，直接收。
    finishRandomLid(kind)
  }

  /* ==================================================================== */
  /* §14·动画2：小女孩那段 + 电饭煲"在 5 秒内追到她"                        */
  /* ==================================================================== */
  /*                                                                      */
  /* 两件事**同时**开始：小女孩开始演 girl-basin（钢盆扣在头上左右张望），   */
  /* 电饭煲同时沿直线向她移动。移动量不是"一格一格挪"，而是**一次算清**：    */
  /* 在直线上按比例采样 N 个点，按"帧内矩形 + 贴片内容框"算出每个点上两者    */
  /* 的重叠率，取重叠率最大的那个点当终点 —— 于是"移动 = 降采样"这件事在   */
  /* 时间轴上真的成立（采样严格单调），而不是靠一个定时器假装。              */
  /* 逐帧（rAF）把进度推上去，**哪一帧越过了 0.5 的重叠率就算接触**：那一刻  */
  /* 立刻把电饭煲放回原位、把画面交回各自的定格图。                          */
  /* ==================================================================== */

  /** 这一次动画2 开始之前，两条节拍是不是在跑（复位之后要原样还回去）。 */
  var basinScheduleWasOn = null

  /** 小女孩那段现在是不是在出画（它自己那一层，与 girlClip 分开）。 */
  function basinClipShown() {
    return !!(girlBasinClip && girlBasinClip.classList.contains('dshca-showing'))
  }

  /**
   * 保证小女孩那段（girl-basin）存在并挂在右块上。与 `ensureGirlClip` 同形，
   * 但**不复用** girlClip：那是"点发送"那条流程的独占资源，两套状态混在一起
   * 迟早会出现"她演到一半被另一条流程接走"。
   */
  function ensureGirlBasinClip() {
    if (!partUnits) return null
    var girl = partUnits[1]
    if (girlBasinClip) {
      if (girlBasinClip.parentNode !== girl.el) girl.el.appendChild(girlBasinClip)
      return girlBasinClip
    }
    var el = createClipVideo({ id: 'dshca-girlbasin', url: GIRL_BASIN_URL })
    el.addEventListener('loadedmetadata', function () {
      layoutGirlBasinClip()
    })
    el.addEventListener('loadeddata', function () {
      // 每个元素只量一次（见 measureGirlBasinBox 的注释）：来回量不但白费，
      // 还会把"飞行计划"一遍遍重算。
      if (!girlBasinMeasured) {
        girlBasinMeasured = true
        measureGirlBasinBox(el)
      }
      layoutGirlBasinClip()
    })
    el.addEventListener('ended', function () {
      // 她演完了但接触还没发生（锅太远）：游戏继续，只是她换成定格图。
      randomDebug('girl-ended', { contact: basinContactScale })
      el.classList.remove('dshca-showing')
      // 她那一格回来了，摞在她头上的盆也回来（0.10.1 修的漏洞2）。
      refreshPotsVisible()
    })
    el.addEventListener('error', function () {
      randomDebug('girl-error', null)
      el.classList.remove('dshca-showing')
      refreshPotsVisible()
    })
    girlBasinClip = el
    girl.el.appendChild(el)
    return el
  }

  /**
   * 量出小女孩那段里"那张静止的贴片"在**素材坐标**里的矩形。
   *
   * 她那段素材里内容会漂（0.04 秒那一帧 350,245,565,415；第五秒 371,213,509,419），
   * 所以取两个量法的**交集**：
   *   · `measureContent()` 的贴片包围盒（整段里出现过内容的外框）；
   *   · seek 到 0.04 秒之后**当前这一帧**的内容矩形。
   * 交集一定 <= 那个外框，用它去算"接触"宁可保守一点：判定会稍晚，但绝不会
   * 出现"锅还离得老远就算碰到了"。
   *
   * 两次读像素都必须在 `seeked` **之后**（见 measureAt）：读一帧还没解码出来的
   * 画布会量出一个几像素高的垃圾框（自检实测：565x3 → 她那段被放大 36 倍）。
   * seek 不成功就退回整幅，绝不留一个假框在那儿。
   */
  function measureGirlBasinBox(el) {
    var vw = el.videoWidth
    var vh = el.videoHeight
    if (!vw || !vh) return
    var outer = measureContent(el)
    measureAt(el, 0.04, function (inner, reached) {
      try {
        el.currentTime = 0
      } catch (err) {
        /* ignore */
      }
      if (!reached || !inner || !outer) {
        girlBasinBox = outer || inner || { x: 0, y: 0, w: vw, h: vh }
      } else {
        var x0 = Math.max(outer.x, inner.x)
        var y0 = Math.max(outer.y, inner.y)
        var x1 = Math.min(outer.x + outer.w, inner.x + inner.w)
        var y1 = Math.min(outer.y + outer.h, inner.y + inner.h)
        // 交集太小说明两次量法对不上（比如画布还没解码出来）：宁可退回外框，
        // 也不要留一个"几像素高"的假框 —— 那个框会把整段素材放大到屏幕外。
        var ok = x1 - x0 >= inner.w * 0.5 && y1 - y0 >= inner.h * 0.5
        girlBasinBox = ok ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : outer
      }
      layoutGirlBasinClip()
      // 0.10.2：她那段的内容框量到了 —— 贴边间隙按它重新收紧。
      rehugGirl()
      if (randomAnim === 'lid2' && !basinContactHappened) basinFlight = computeFlightPlan()
    })
  }

  /**
   * 小女孩那段的摆放：内容高贴齐她那一块（乘倍率，默认 0.95 —— 接触时要缩
   * 的那一点点）、水平居中、底边对齐。与 girlClip 的公式同源，只多了个倍率。
   * 顺手维护 `basinRect` —— "按帧取交"用的贴片矩形（位置/大小都以块为单位）。
   */
  function layoutGirlBasinClip() {
    var fit = fitClipToGirlPart(girlBasinClip, girlBasinBox, RANDOM_CONTACT_SCALE)
    if (!fit) return
    // 诊断：把这一次排版用到的三个原始数写回 DOM，排查"她怎么这么大"时一眼可见。
    girlBasinClip.setAttribute(
      'data-layout',
      'unit=' + Math.round(fit.box.w) + 'x' + Math.round(fit.box.h) +
        ' video=' + fit.vw + 'x' + fit.vh + ' scale=' + fit.scale.toFixed(4),
    )
    // **单位必须是 CSS 像素**：content 是素材坐标，乘了 scale 之后才是屏幕上
    // 的尺寸。早先这里直接存了 content.w/h，于是"按帧取交"用到的是一个
    // 大了五倍的矩形 —— 锅还没动就已经判定"接触"（实测 14ms 就收工了）。
    // 竖直中心也按**底边对齐**算（与摆放公式同源）：她可能被缩到 95%，那时
    // 贴片的下沿就是"脚站在地上"的那条线，不能让中心偏上去。
    var pieceW = fit.content.w * fit.scale
    var pieceH = fit.content.h * fit.scale
    basinRect = {
      w: pieceW,
      h: pieceH,
      cx: fit.box.w / 2,
      cy: fit.box.h - pieceH / 2,
    }
  }

  /** 她那块的视口矩形（她也可能正在被 transform 挪 —— 目前没有，但按真值算）。 */
  function girlViewportRect() {
    var girl = partUnits ? partUnits[1] : null
    if (!girl) return null
    var origin = viewportOrigin(girl.el)
    var size = sizeOf(girl.el)
    if (!origin || !(size.w > 0)) return null
    return { left: origin.x, top: origin.y, right: origin.x + size.w, bottom: origin.y + size.h }
  }

  /** 电饭煲**内容**在移动 d 之后落在哪（用当前布局里的真值推，不用 getBoundingClientRect）。 */
  function cookerRectAfter(dx, dy) {
    var cooker = partUnits ? partUnits[0] : null
    if (!cooker) return null
    var origin = viewportOrigin(cooker.el)
    var size = sizeOf(cooker.el)
    if (!origin || !(size.w > 0) || !(size.h > 0)) return null
    return {
      left: origin.x + dx,
      top: origin.y + dy,
      right: origin.x + size.w + dx,
      bottom: origin.y + size.h + dy,
    }
  }

  /**
   * 电饭煲与她的"按帧取交"：
   * 拿她**当前这一帧**的内容矩形（`basinRect` 是它在块内的位置/大小）与锅的
   * 矩形求重叠率。她还没出画（还在定格图/她演完了）时退回整块矩形 —— 那时
   * 屏幕上确实是"她那一块"，用它算接触并不过分。
   */
  function basinBasinOverlap(cookerRect) {
    var girlRect = girlViewportRect()
    if (!girlRect || !cookerRect) return 0
    var piece = null
    if (basinRect && girlBasinClip && girlBasinClip.classList.contains('dshca-showing')) {
      var gw = girlRect.right - girlRect.left
      var gh = girlRect.bottom - girlRect.top
      var cx = girlRect.left + gw * (basinRect.cx / (gw || 1))
      var cy = girlRect.top + gh * (basinRect.cy / (gh || 1))
      piece = {
        left: cx - basinRect.w / 2,
        top: cy - basinRect.h / 2,
        right: cx + basinRect.w / 2,
        bottom: cy + basinRect.h / 2,
      }
    }
    return overlapRatio(cookerRect, piece || girlRect)
  }

  /** 把移动量写进那一块（用 transform，绝不动 left/top —— 拖动几何是真值）。 */
  function applyFlight(dx, dy) {
    var cooker = partUnits ? partUnits[0] : null
    if (!cooker) return
    cooker.el.style.setProperty('--dshca-fly-x', Math.round(dx) + 'px')
    cooker.el.style.setProperty('--dshca-fly-y', Math.round(dy) + 'px')
  }

  function clearFlight() {
    var cooker = partUnits ? partUnits[0] : null
    randomDebug('clear-flight', {
      hasCooker: !!cooker,
      x: cooker ? cooker.el.style.getPropertyValue('--dshca-fly-x') : null,
      flying: cooker ? cooker.el.classList.contains('dshca-flying') : null,
    })
    if (!cooker) return
    cooker.el.classList.remove('dshca-flying')
    cooker.el.style.removeProperty('--dshca-fly-x')
    cooker.el.style.removeProperty('--dshca-fly-y')
  }

  /** 三次平滑：起步不猛、落点不撞。 */
  function smoothstep(t) {
    if (t <= 0) return 0
    if (t >= 1) return 1
    return t * t * (3 - 2 * t)
  }

  /**
   * 在"原位置 → 她的位置"这条直线上按比例采样，取重叠率最大的那个点。
   *
   * 目标点是"锅的内容中心落到她那一块的中心"：那个点上两口锅必然叠在一起，
   * 所以只要她还在视口里，就一定能找到"接触"的那一刻。允许目标点越出视口 ——
   * 这只是一次临时移动，用户要的是"追上她"。
   */
  function computeFlightPlan() {
    if (!partUnits) return null
    var cooker = partUnits[0]
    var girl = partUnits[1]
    var cookerSize = sizeOf(cooker.el)
    var girlOrigin = viewportOrigin(girl.el)
    var cookerOrigin = viewportOrigin(cooker.el)
    if (!(cookerSize.w > 0) || !girlOrigin || !cookerOrigin) return null
    var girlSize = sizeOf(girl.el)

    // 目的地：锅那一块的中心对齐到她那一块的中心（也是接触必然发生的点）。
    var tx = girlOrigin.x + (girlSize.w - cookerSize.w) / 2 - cookerOrigin.x
    var ty = girlOrigin.y + (girlSize.h - cookerSize.h) / 2 - cookerOrigin.y
    if (!isFinite(tx) || !isFinite(ty)) return null

    var steps = RANDOM_FLIGHT_SAMPLES
    var best = { t: 1, overlap: 0, contact: 1 }
    var contact = -1
    for (var i = 1; i <= steps; i += 1) {
      var t = smoothstep(i / steps)
      var ratio = basinBasinOverlap(cookerRectAfter(tx * t, ty * t))
      if (ratio > best.overlap) best = { t: t, overlap: ratio, contact: ratio }
      if (contact < 0 && ratio >= 0.5) contact = t
    }
    return {
      dx: tx,
      dy: ty,
      // 接触发生在哪个进度上（-1 = 这条直线上两个盒子压根不相交，那就走完全程）。
      contactAt: contact,
      overlap: best.overlap,
    }
  }

  /** 一次动画2 的起点：起播她那段 + 让锅起飞（两件事同时开始）。 */
  function openGirlBasinFlow() {
    if (destroyed || !partUnits) return
    var cooker = partUnits[0]
    var girl = partUnits[1]
    // 她那一块**只要求还在 `partUnits` 里**，不要求此刻挂在文档上：`display:none`
    // 与"暂时摘下来"都不影响这一段的播放（她那段是绝对定位的覆盖层）。
    // 早先多要了一条 `girl.el.parentNode`，于是"发送联动把整块藏起来"那种状态下
    // 动画2 会被自己的前置条件静默拒掉 —— 而拒绝发生在任何日志之前，排查起来
    // 像见鬼一样（harness 里就是这样）。
    if (!cooker || !girl || !girl.el) return

    // **先把这一段标记成"动画2 正在演"，再让锅那段起播**（顺序是关键）：
    // `playRandomLid()` 自己会问一次 `randomAnimBlocked()`，而那条判据认识
    // "已经有随机动画在演" —— 反过来写的话它会把这一次起播当成"重入"拒掉，
    // 整段动画连画面都不会出（自检里就是"stage 立刻是 null"）。
    randomAnim = 'lid2'
    if (basinScheduleWasOn === null) {
      basinScheduleWasOn = scheduleOn
      if (scheduleOn) pauseSchedule()
    }
    if (!playRandomLid('lid2')) {
      randomDebug('flow-rejected', { cooker: !!cooker, girl: !!girl })
      randomAnim = null
      resumeAfterRandom()
      return
    }
    cooker.el.classList.add('dshca-flying')
    applyFlight(0, 0)
    // 先算一次：她那段可能还没拿到元数据，这时按整块矩形采样（一样成立）。
    basinFlight = computeFlightPlan()

    var el = ensureGirlBasinClip()
    if (el) {
      layoutGirlBasinClip()
      try {
        el.currentTime = 0
      } catch (err) {
        /* ignore */
      }
      el.classList.add('dshca-showing')
      // **监听要在 play() 之前挂**（'playing' 有可能同步就到），回调里做的是
      // "先把画面交给她那段、再让她原来那一格让位" —— 反过来的话，两次赋值
      // 之间会有一帧"她没了、新的也还没出画"，屏幕上什么都不剩（自检里就是
      // count=0 的那一条违规）。
      el.addEventListener(
        'playing',
        function () {
          if (randomAnim === 'lid2') {
            syncCanvasVisibility()
            refreshPotsVisible()
          }
        },
        { once: true },
      )
      // 头上的盆一起让位（0.10.1 修的漏洞2）：她这一段是"整幅替换她"的，
      // 摞在原位的盆会浮在坐姿动画的半空 —— 与 girl.webm / 拖动动画同一待遇。
      // 挂在这一刻而不是等 'playing'：盆是画外的硬家伙，早一帧收掉没有观感代价，
      // 漏一帧就是"盆悬空"。
      refreshPotsVisible()
      var attempt = el.play()
      if (attempt && typeof attempt.catch === 'function') {
        // 被自动播放策略拦下（理论上 muted 不会被拦）：她这一段没画面，锅照样飞。
        attempt.catch(function () {
          randomDebug('girl-blocked', null)
        })
      }
      // 元数据 / 第一帧到位之后 `ensureGirlBasinClip()` 的 loadeddata 会去量内容框
      // 并重排（量完还会顺手把飞行计划重算一遍）—— 这里不需要再挂一次。
    }
    basinContactScale = 0
    basinContactHappened = false
    randomDebug('flight-start', {
      dx: basinFlight ? Math.round(basinFlight.dx) : null,
      dy: basinFlight ? Math.round(basinFlight.dy) : null,
      contactAt: basinFlight ? Math.round(basinFlight.contactAt * 1000) / 1000 : null,
      overlap: basinFlight ? Math.round(basinFlight.overlap * 1000) / 1000 : null,
      window: RANDOM_FLIGHT_MS,
    })

    var startedAt = now()
    var lastRatio = 0
    var step = function () {
      basinFlightFrame = 0
      if (destroyed || randomAnim !== 'lid2') return
      // 用户把锅拖走了 / 换了布局：缓存下来的移动量已经失效，就地重算一次。
      if (!basinFlight) basinFlight = computeFlightPlan()
      var raw = RANDOM_FLIGHT_MS > 0 ? (now() - startedAt) / RANDOM_FLIGHT_MS : 1
      if (raw > 1) raw = 1
      var eased = smoothstep(raw)
      // 终点不越过"接触点"：越过了就只是白穿过去，画面上反而像穿模。
      var t = eased
      if (basinFlight && basinFlight.contactAt >= 0 && t > basinFlight.contactAt) t = basinFlight.contactAt
      if (basinFlight) applyFlight(basinFlight.dx * t, basinFlight.dy * t)

      var ratio = basinBasinOverlap(cookerRectAfter(
        basinFlight ? basinFlight.dx * t : 0,
        basinFlight ? basinFlight.dy * t : 0,
      ))
      if (ratio > lastRatio) lastRatio = ratio
      basinContactScale = lastRatio
      // 接触判据：**这一帧**两块矩形真的相交过半 —— 不是"走完了"。
      if (ratio >= 0.5) {
        randomDebug('contact', {
          at: Math.round((now() - startedAt)),
          overlap: Math.round(ratio * 1000) / 1000,
        })
        finishRandomLid2()
        return
      }
      // 5 秒走完也只算"已经贴到她身上了"：素材与节拍都要收工，不能永远挂着。
      if (raw >= 1 || (basinFlight && basinFlight.contactAt >= 0 && eased >= basinFlight.contactAt)) {
        randomDebug('contact-timeout', { overlap: Math.round(ratio * 1000) / 1000 })
        finishRandomLid2()
        return
      }
      basinFlightFrame = window.requestAnimationFrame(step)
    }
    // 兜底：rAF 在后台标签页会被节流甚至暂停，这条定时器保证"5 秒 + 2 秒"内一定收工。
    basinGuardTimer = window.setTimeout(function () {
      basinGuardTimer = 0
      if (randomAnim !== 'lid2') return
      randomDebug('flight-guard', null)
      finishRandomLid2()
    }, RANDOM_FLIGHT_MS + 2000)
    basinFlightFrame = window.requestAnimationFrame(step)
  }

  var basinContactHappened = false

  /** 接触发生：**立刻**把锅放回原位、把画面交回两边各自的定格图。 */
  function finishRandomLid2() {
    if (randomAnim !== 'lid2') return
    basinContactHappened = true
    randomDebug('finish2', { overlap: Math.round(basinContactScale * 1000) / 1000 })
    closeGirlBasinFlow()
    // 锅那边走"收尾"这条路（与动画1 倒放结束后的落点是同一个函数）。
    finishRandomLid('lid2')
  }

  /** 小女孩那段收工：停播、让位、画面交回她的定格图。 */
  function closeGirlBasinFlow() {
    if (girlBasinClip) {
      try {
        girlBasinClip.pause()
      } catch (err) {
        /* ignore */
      }
      girlBasinClip.classList.remove('dshca-showing')
    }
    // 她那一格回来了 —— 头上的盆也回来（0.10.1 修的漏洞2 的"恢复"那一半）。
    // 接触复位 / 5 秒兜底 / 重播 / 关闭 / 新一轮发送都从这里过，一处收口。
    refreshPotsVisible()
  }

  /** 收掉"飞过去"这件事留下的所有东西（定时器、rAF、transform、class）。 */
  function clearFlightArtifacts() {
    if (basinFlightFrame) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(basinFlightFrame)
      basinFlightFrame = 0
    }
    if (basinGuardTimer) {
      if (typeof window.clearTimeout === 'function') window.clearTimeout(basinGuardTimer)
      basinGuardTimer = 0
    }
    basinFlight = null
    basinContactHappened = false
    basinContactScale = 1
    clearFlight()
  }

  /**
   * 一次随机动画之后，把"进来之前"的排期状态还回去。
   *
   * 刻意做成"还回去"而不是"一定开起来"：用户自己按过暂停（⏸）的话，这里
   * 不能替他把节拍又打开 —— 那会变成"我明明暂停了，点一下锅它又动起来了"。
   */
  function resumeAfterRandom() {
    if (destroyed || !partUnits) {
      basinScheduleWasOn = null
      return
    }
    var wasOn = basinScheduleWasOn
    basinScheduleWasOn = null
    if (wasOn && !scheduleOn) startSchedule()
  }

  /**
   * 把这次随机动画引出来的东西全部收干净（重播 / 关闭 / 新一轮发送时调用）。
   *
   * 与 `clearRandomAnim()` 的分工：那个是"正常演完"的落点（要接着把画面与节拍
   * 还回去），这个是"外部接管"的落点（后面马上会有别的流程重新安排画面）。
   */
  function stopRandomAnims(force) {
    clearLidReverseTimers()
    clearFlightArtifacts()
    if (!randomAnim) {
      if (force) setCookerShown(false)
      basinScheduleWasOn = null
      return
    }
    randomAnim = null
    randomHijack = false
    if (cookerClipA) {
      try {
        cookerClipA.pause()
      } catch (err) {
        /* ignore */
      }
      cookerClipA.classList.remove('dshca-cooker-on')
    }
    if (cookerClipB) {
      try {
        cookerClipB.pause()
      } catch (err) {
        /* ignore */
      }
      cookerClipB.classList.remove('dshca-cooker-on')
    }
    closeGirlBasinFlow()
    setCookerShown(false)
    basinScheduleWasOn = null
  }

  /* ==================================================================== */
  /* §15 拖动动画：拖小女孩时循环"被拎起来"，松手立刻切回                   */
  /* ==================================================================== */

  function ensureDragClip() {
    if (destroyed || !partUnits) return null
    var girl = partUnits[1]
    if (dragClip) {
      if (dragClip.parentNode !== girl.el) girl.el.appendChild(dragClip)
      return dragClip
    }
    // **循环**：拖动可能持续很久，而素材只有 5.5 秒 —— 松手才收工。
    var el = createClipVideo({ id: 'dshca-drag', url: DRAG_URL, loop: true })
    el.addEventListener('loadedmetadata', layoutDragClip)
    el.addEventListener('loadeddata', function () {
      if (!dragBox) dragBox = measureContent(el)
      layoutDragClip()
      // 0.10.2：量到了拖动素材的内容框 —— 贴边间隙按它重新收紧。
      rehugGirl()
    })
    el.addEventListener('error', function () {
      dragAnimOn = false
      el.classList.remove('dshca-drag-on')
      refreshPotsVisible()
      settleVisibility()
    })
    dragClip = el
    girl.el.appendChild(el)
    return el
  }

  /** 拖动动画的摆放：与 idle/act 完全同一套（内容高贴齐右块、居中、底对齐）。 */
  function layoutDragClip() {
    fitClipToGirlPart(dragClip, dragBox, DRAG_ANIM_SCALE)
  }

  /** 这一块现在能不能用拖动动画替换画面。 */
  function dragAnimBlocked(unit) {
    if (!DRAG_ANIM || destroyed || !partUnits) return true
    if (!partUnits[1] || unit !== partUnits[1]) return true
    if (dragAnimOn || randomAnim) return true
    if (girlClipOn || basinClipShown()) return true
    if (sendPhase !== 'idle') return true
    if (unit.el.style.display === 'none') return true
    return false
  }

  /** 真成了"一次拖动"：起播拖动动画（循环到松手）。 */
  function startDragAnim(unit) {
    if (dragAnimBlocked(unit)) return false
    if (randomHijack) return false
    // 正在被按压（快照顶着画面）就先把它收干净 —— 否则松手时 snapshot 会
    // 与拖动动画抢同一块画面（finishSquish 会把 source 的 visibility 写回来）。
    if (squishHolding(partUnits[1])) endSquish(true)
    var el = ensureDragClip()
    if (!el) return false
    dragAnimOn = true
    layoutDragClip()
    try {
      el.currentTime = 0
    } catch (err) {
      /* seek may fail before metadata */
    }
    try {
      el.playbackRate = DRAG_ANIM_RATE
    } catch (err) {
      /* ignore */
    }
    // 这一路**立刻**出画，然后才让她那一格让位。
    //
    // 顺序是这里的关键（自检实测踩到）：等 `playing` 再显示这一段的话，`play()`
    // 到第一帧就绪之间有 100~150ms，而她那格定格图在这段时间里已经让开了 ——
    // 屏幕上会空一下（"一按下拖动她就闪没了"）。素材本身开头是透明的，所以
    // "先让它占位、再把她的图收掉"在观感上只是"她的姿势在这一瞬间换了"，
    // 中间不会出现什么都没有的一帧。
    //
    // 出画用**内联 `display`**（而不是只挂一个 class）：拖动这一路"在不在屏幕上"
    // 必须能从 DOM 上一眼读出来 —— 自检就是靠这个断言"松手之后它收掉了"的
    // （CSS 里的 `display:none` 默认值在脚本里读不到，会误判成"还在出画"）。
    el.style.display = 'block'
    el.classList.add('dshca-drag-on')
    randomDebug('drag-show', { loop: el.loop })
    syncCanvasVisibility()
    // 拖动期间不放盆：那段素材自己画着"被拎起来"的样子，浮在半空的盆会穿帮。
    refreshPotsVisible()
    el.addEventListener(
      'playing',
      function () {
        if (!dragAnimOn) return
        var box = el.getBoundingClientRect()
        randomDebug('drag-on', {
          w: Math.round(box.width),
          h: Math.round(box.height),
          visible: box.width > 0,
        })
        syncCanvasVisibility()
        refreshPotsVisible()
      },
      { once: true },
    )
    var attempt = el.play()
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(function () {
        // 放不出来（理论上 muted 不会被拦）：这次拖动就没有拖动动画，别的照旧。
        dragAnimOn = false
        el.classList.remove('dshca-drag-on')
        refreshPotsVisible()
        settleVisibility()
      })
    }
    // 她那一侧的显隐交给上面那个 'playing' 回调；这里只把"哪一路该出画"收敛好。
    settleVisibility()
    return true
  }

  /**
   * 松手：立刻把画面交回她原来那一格（用户选的"立刻切回"）。
   *
   * **幂等**：不管 `dragAnimOn` 是什么，都要把"层"收干净（隐藏 + 暂停 + 收敛
   * 显隐）。早先开头就 `if (!dragAnimOn) return`，于是"层已经挂上、但标志已经被
   * 别处清掉"时（比如 'playing' 的那次回调把标志改了），松手就会跳过整段收尾 ——
   * 拖动动画留在屏幕上不走、她的定格图永远不回来（harness 里就是这样）。
   */
  function stopDragAnim() {
    dragAnimOn = false
    if (dragClip) {
      dragClip.classList.remove('dshca-drag-on')
      dragClip.style.display = 'none'
      try {
        dragClip.pause()
      } catch (err) {
        /* ignore */
      }
    }
    refreshPotsVisible()
    settleVisibility()
    syncCanvasVisibility()
  }

  /**
   * 拖动动画是否在出画 —— 排期器的挡拍判据与 `isClipShown()` 都认它。
   *
   * 挡拍的语义与"正在播的不打断"一致：拖动期间到点的那一拍**往后挪一拍**，
   * 于是松手之后露出来的是她自己那格画面，而不是一段已经跳过去的动画。
   */
  function dragAnimShowing() {
    return dragAnimOn && !girlClipOn && !basinClipShown()
  }

  /**
   * 排查 / 自检入口：`window.__dshcaRandom.*`。
   *
   * 两道随机动画是按概率触发的，没法靠"多点几下"稳定复现，所以这里必须有一个
   * **不受骰子限制**的手动入口（`play('lid1'|'lid2')`）—— 预览页与自检脚本
   * 全靠它，否则"20% 的那条路"根本没法验。
   */
  function exposeRandomApi() {
    window.__dshcaRandom = {
      version: '0.10.0',
      /** 现在的状态：谁在演、锅被挪了多远、她那段出没出画、两条概率是多少。 */
      probe: function () {
        var cooker = partUnits ? partUnits[0] : null
        var girl = partUnits ? partUnits[1] : null
        var cookerRect = cooker ? viewportRect(cooker.el) : null
        var girlRect = girl ? viewportRect(girl.el) : null
        return {
          enabled: RANDOM_ENABLED && !destroyed,
          chanceA: RANDOM_A_CHANCE,
          chanceB: RANDOM_B_CHANCE,
          chanceTotal: Math.min(1, RANDOM_A_CHANCE + RANDOM_B_CHANCE),
          stage: randomAnim,
          hijack: randomHijack,
          flightMs: RANDOM_FLIGHT_MS,
          reverseMs: RANDOM_REVERSE_MS,
          contactScale: RANDOM_CONTACT_SCALE,
          basinContact: Math.round(basinContactScale * 1000) / 1000,
          scheduledBefore: basinScheduleWasOn,
          scheduleOn: scheduleOn,
          flight: basinFlight
            ? {
                dx: Math.round(basinFlight.dx),
                dy: Math.round(basinFlight.dy),
                contactAt: Math.round(basinFlight.contactAt * 1000) / 1000,
                overlap: Math.round(basinFlight.overlap * 1000) / 1000,
              }
            : null,
          cooker: cookerRect
            ? { left: Math.round(cookerRect.left), top: Math.round(cookerRect.top), w: Math.round(cookerRect.right - cookerRect.left), h: Math.round(cookerRect.bottom - cookerRect.top) }
            : null,
          girl: girlRect
            ? { left: Math.round(girlRect.left), top: Math.round(girlRect.top), w: Math.round(girlRect.right - girlRect.left), h: Math.round(girlRect.bottom - girlRect.top) }
            : null,
          fly: cooker
            ? {
                x: cooker.el.style.getPropertyValue('--dshca-fly-x') || '0px',
                y: cooker.el.style.getPropertyValue('--dshca-fly-y') || '0px',
                flying: cooker.el.classList.contains('dshca-flying'),
              }
            : null,
          cookerClips: {
            a: cookerClipA
              ? {
                  on: cookerClipA.classList.contains('dshca-cooker-on'),
                  t: Math.round(cookerClipA.currentTime * 1000) / 1000,
                  paused: cookerClipA.paused,
                  muted: cookerClipA.muted,
                  error: !!cookerClipA.error,
                  box: cookerClipA.getAttribute('data-content-box'),
                  w: cookerClipA.style.width,
                  h: cookerClipA.style.height,
                  top: cookerClipA.style.top,
                }
              : null,
            b: cookerClipB
              ? {
                  on: cookerClipB.classList.contains('dshca-cooker-on'),
                  t: Math.round(cookerClipB.currentTime * 1000) / 1000,
                  paused: cookerClipB.paused,
                  muted: cookerClipB.muted,
                  error: !!cookerClipB.error,
                  box: cookerClipB.getAttribute('data-content-box'),
                  w: cookerClipB.style.width,
                  h: cookerClipB.style.height,
                  top: cookerClipB.style.top,
                }
              : null,
          },
          girlBasin: girlBasinClip
            ? {
                showing: basinClipShown(),
                t: Math.round(girlBasinClip.currentTime * 1000) / 1000,
                paused: girlBasinClip.paused,
                error: !!girlBasinClip.error,
                box: girlBasinClip.getAttribute('data-content-box'),
                style: {
                  w: girlBasinClip.style.width,
                  h: girlBasinClip.style.height,
                  left: girlBasinClip.style.left,
                  top: girlBasinClip.style.top,
                },
              }
            : null,
          drag: dragClip
            ? {
                on: dragAnimOn,
                visible: dragClip.classList.contains('dshca-drag-on'),
                t: Math.round(dragClip.currentTime * 1000) / 1000,
                paused: dragClip.paused,
                loop: dragClip.loop,
                error: !!dragClip.error,
                box: dragClip.getAttribute('data-content-box'),
                style: {
                  w: dragClip.style.width,
                  h: dragClip.style.height,
                  left: dragClip.style.left,
                  top: dragClip.style.top,
                },
              }
            : null,
          /** 屏幕上此刻有哪几层画面（用来断言"有且仅有一段"）。 */
          visibleLayers: (function () {            var out = []
            if (dragAnimShowing()) out.push('drag')
            if (basinClipShown()) out.push('girl-basin')
            if (girlClipOn) out.push('girl')
            if (cookerClipA && cookerClipA.classList.contains('dshca-cooker-on')) out.push('cooker-a')
            if (cookerClipB && cookerClipB.classList.contains('dshca-cooker-on')) out.push('cooker-b')
            if (lidClip && lidClip.classList.contains('dshca-lid-on')) out.push('send-lid')
            if (girlClip && girlClip.classList.contains('dshca-showing')) out.push('send-girl')
            if (!cookerClipA || !cookerClipA.classList.contains('dshca-cooker-on')) {
              if (!cookerClipB || !cookerClipB.classList.contains('dshca-cooker-on')) out.push('cooker-canvas')
            }
            if (!dragAnimShowing() && !basinClipShown() && !girlClipOn) out.push('girl-canvas-or-clip')
            return out
          })(),
        }
      },
      /** 手动演一道（不受概率限制）：`play('lid1')` / `play('lid2')`；返回有没有接住。 */
      play: function (kind) {
        var want = kind === 'lid2' ? 'lid2' : 'lid1'
        if (destroyed || !partUnits) return false
        if (randomAnim) return false
        if (want === 'lid2') {
          openGirlBasinFlow()
          return randomAnim === 'lid2'
        }
        return playRandomLid('lid1')
      },
      /** 按概率掷一次（与真实点击同一条路径，用来验概率分布）。 */
      roll: function () {
        return maybePlayRandomCooker(partUnits ? partUnits[0] : null)
      },
      /** 立刻收工（等同"接触已发生"）。 */
      stop: function () {
        if (!randomAnim) return false
        if (randomAnim === 'lid2') finishRandomLid2()
        else finishRandomLid(randomAnim)
        return true
      },
      /** 诊断账本（含"她那一格该不该出画"的最近 40 次判定）。 */
      debug: function () {
        return { stage: randomAnim, events: randomEvents.slice(), canvasVis: canvasVisLog.slice() }
      },
      /** 拖动动画：手动起 / 停（同样不受任何骰子限制）。 */
      drag: function (on) {
        if (!partUnits) return false
        if (on === false) {
          stopDragAnim()
          return true
        }
        return startDragAnim(partUnits[1])
      },
    }
  }

  /* ==================================================================== */
  /* §16 「发送消息」联动：点发送 → 她演一段 → 计时器 → 开盖 → 复位          */
  /* ==================================================================== */
  /*                                                                      */
  /* 这一整节只做两件事，全部靠观察 DOM：                                   */
  /*                                                                      */
  /*   事件 1（用户点「发送消息」）                                         */
  /*     a. 在右侧小女孩那块上面播 girl.webm；                              */
  /*     b. 播完 → 把控制条搬到电饭煲上方、把小女孩那块整个藏起来、          */
  /*        在电饭煲下方显示蓝色文案 + 计时器（计时器从这一刻开始跑）。      */
  /*                                                                      */
  /*   事件 2（0.10.2 起：**一轮对话完整结束**，与 whale 挂件弹「本次消费金额」  */
  /*     同一触发点 —— 宿主 turn/end 信号；信号不可用时退回旧的"开始输出"探测） */
  /*     播 lid.webm（**带声**），播完停在最后一帧；计时器一起收掉（0.7.4），    */
  /*     之后点击停在末帧的开盖画面 → 整条联动复位回拆分态（0.10.2）。          */
  /*                                                                      */
  /*   再发一条消息 → 整套重置（回到现在的布局，重新开始）。                */
  /*                                                                      */
  /* 为什么必须靠观察：客户端只是页面里的一个普通脚本，读不到 React 状态，  */
  /* 也没有宿主事件可订阅。所以两处判断都用**与 class 名无关**的判据：      */
  /*   · 点发送：文案/aria 命中「发送」语义的按钮被点（或输入框里回车）；    */
  /*   · 开始输出：屏幕上出现**正在变长**的文本节点（思考阶段的文本不长，    */
  /*     所以二者天然可分）。命中不了也不会静默 —— 见 sendDebug()。         */
  /* ==================================================================== */

  /** 诊断账本：`window.__dshcaSendDebug`，排查"没反应"时先看它。 */
  var sendEvents = []
  function sendDebug(kind, detail) {
    var entry = { t: Math.round(now()) , kind: kind, detail: detail === undefined ? null : detail }
    sendEvents.push(entry)
    if (sendEvents.length > 60) sendEvents.shift()
    try {
      window.__dshcaSendDebug = { phase: sendPhase, events: sendEvents, last: entry }
    } catch (err) {
      /* ignore */
    }
  }

  function now() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now()
    }
    return Date.now()
  }

  /** `mm:ss`（超过一小时就 `h:mm:ss`）。 */
  function formatClock(ms) {
    var total = Math.max(0, Math.floor(ms / 1000))
    var h = Math.floor(total / 3600)
    var m = Math.floor((total % 3600) / 60)
    var s = total % 60
    function pad(n) {
      return (n < 10 ? '0' : '') + n
    }
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s)
  }

  /* --- 状态机 ---------------------------------------------------------- */
  /* idle → girl（小女孩在演）→ laid（按钮已搬走、计时器在跑）→ 等 output   */
  /* → lid（开盖在播/已定格）→ 下一条消息回到 idle                        */
  var sendPhase = 'idle'
  /** 这一轮的起点：事件 1 收尾、计时器开始跑的那一刻。 */
  var sendStartedAt = 0
  var sendTicker = 0
  var sendWatcher = 0
  var sendDeadline = 0
  var sendLastText = 0
  /** 基线是否已固定。保留这个标志是为了自检与诊断（见 armOutputWatch）。 */
  var sendHaveBaseline = false
  /** 输出已经开始了，但小女孩可能还在演 —— 等收尾时补播开盖。 */
  var sendOutputSeen = false
  var sendLidWanted = false
  /**
   * 这一轮有没有因为"还在深度思索"而按住过开盖（0.7.5）。
   *
   * **只用于诊断去重**（把 `output-held-reasoning` / `reasoning-ended` 各记一笔，
   * 而不是每 180ms 刷一次）—— 判据本身只看 `reasoningRunning()`，不依赖这个标志。
   */
  var sendHeldForReasoning = false
  var sendSwitch = null

  /** 事件 1（点发送）是否已经触发过 —— 防止一次发送被识别成两次。 */
  var sendArmed = true

  /* --- 0.10.2：turn/end 信号轮询的状态 --------------------------------- */
  /** 轮询定时器句柄（0 = 没在轮询）。 */
  var turnWatcher = 0
  /** 上一次读到的 seq：null = 还没对齐过（首个读数只对齐、不触发）。 */
  var turnSeqBaseline = null
  /** 本轮武装以来连续失败的次数（达到 TURN_FAIL_LIMIT 就退回旧探测）。 */
  var turnFailures = 0
  /** 这台宿主的 turn.json 是否曾经给过有效读数（跨轮记忆，失败兜底只用一次）。 */
  var turnSignalOk = false

  function sendActive() {
    return sendPhase !== 'idle'
  }

  /* --- 文案 / 计时器 / 开盖视频的 DOM ---------------------------------- */

  function buildSendDOM(host) {
    if (sendBar) return
    sendBar = document.createElement('div')
    sendBar.id = 'dshca-sendbar'

    sendLabelEl = document.createElement('div')
    sendLabelEl.id = 'dshca-sendlabel'
    sendLabelEl.textContent = SEND_LABEL
    sendLabelEl.style.color = SEND_LABEL_COLOR

    timerEl = document.createElement('div')
    timerEl.id = 'dshca-timer'
    timerEl.textContent = '00:00'
    timerEl.setAttribute('role', 'timer')

    lidClip = document.createElement('video')
    lidClip.id = 'dshca-lid'
    lidClip.src = LID_CLIP_URL
    lidClip.muted = !SEND_LID_AUDIO
    lidClip.defaultMuted = !SEND_LID_AUDIO
    lidClip.playsInline = true
    lidClip.loop = false
    lidClip.preload = 'auto'
    lidClip.tabIndex = -1
    lidClip.controls = false
    lidClip.setAttribute('playsinline', '')
    lidClip.setAttribute('draggable', 'false')
    lidClip.setAttribute('disablepictureinpicture', '')
    lidClip.setAttribute('disableremoteplayback', '')
    lidClip.addEventListener('loadedmetadata', function () {
      layoutLid()
      layoutSendBar()
    })
    lidClip.addEventListener('loadeddata', function () {
      if (!lidBox) lidBox = measureContent(lidClip)
      layoutLid()
      layoutSendBar()
    })
    lidClip.addEventListener('error', function () {
      sendDebug('lid-error', null)
    })
    // 开盖演完 = 这一轮的"收工信号"：文案与计时器一起收掉（0.7.4）。
    // 开盖画面本身不动，仍停在最后一帧；0.10.2 起这一格**可以点击** ——
    // 点它就把整个发送联动复位回「电饭煲 / 小女孩」各自可拖的拆分态。
    lidClip.addEventListener('ended', function () {
      onLidClipEnded()
    })
    lidClip.addEventListener('click', function (event) {
      // 别让这次点击落进 DSH 的页面里（我们只是浮在它上面的一层画面）。
      event.preventDefault()
      event.stopPropagation()
      onLidFrameClick()
    })

    sendBar.appendChild(sendLabelEl)
    sendBar.appendChild(timerEl)
    // 挂 <body>：这一列要跟着电饭煲走，而拖动时只有视口坐标是唯一真值。
    ;(document.body || document.documentElement).appendChild(sendBar)

    // 开盖那段**不**放这一列里（0.7.3）：它要原地替换电饭煲，所以单独挂在
    // <body> 上、用视口坐标定位（见 layoutLid）。放进这一列的话，它就只能
    // 出现在文案与计时器的下方 —— 那正是用户报的"开盖播在了计时器下面"。
    ;(document.body || document.documentElement).appendChild(lidClip)

    unmuteButton = document.createElement('button')
    unmuteButton.id = 'dshca-unmute'
    unmuteButton.type = 'button'
    unmuteButton.textContent = '🔇'
    unmuteButton.title = '这一段有声音：点一下放声'
    unmuteButton.setAttribute('aria-label', '开启声音')
    unmuteButton.addEventListener('pointerdown', function (event) {
      event.stopPropagation()
    })
    unmuteButton.addEventListener('click', function (event) {
      event.stopPropagation()
      if (!lidClip) return
      lidClip.muted = false
      lidClip.defaultMuted = false
      var attempt = lidClip.play()
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(function () {
          /* 还是不行就继续静音放，至少画面在 */
          lidClip.muted = true
        })
      }
      unmuteButton.classList.remove('dshca-showing')
    })
    host.appendChild(unmuteButton)
  }

  /**
   * 开盖那段**原地**盖在电饭煲那一块上（0.7.3 起）。
   *
   * 素材 2560x1440 里内容只占 37% 宽、85% 高（大片透明留白），所以还是按**内容框**
   * 摆：内容宽对齐电饭煲那一块的宽度（乘手动旋钮 `sendLidScale`）、水平对着它的
   * 中线；**内容下沿对齐电饭煲的下沿** —— 于是视频里那口锅正好落在原来那口锅的
   * 位置，她探头出来也是从原地冒出来。
   *
   * 它挂在 <body> 上、用视口坐标（与计时器那一列同一套坐标系），所以拖动电饭煲、
   * 改显示尺寸、改窗口大小都会重新走这里（unitApply / setWidth / onResize）。
   *
   * 最后一步的夹取是刻意的：窗口放不下时把它整体挪进来 —— 那时候原来那口锅本来
   * 就被藏起来了（`.dshca-cooker-hidden`），所以"不再逐像素重合"没人看得出来，
   * 而"她探头时被窗口边缘切掉"是看得见的。
   */
  function layoutLid() {
    if (!lidClip || !partUnits) return
    var cooker = partUnits[0]
    var vw = lidClip.videoWidth
    var vh = lidClip.videoHeight
    if (!vw || !vh) return
    var box = cooker.el.getBoundingClientRect()
    if (!(box.width > 0)) return

    var content = lidBox || { x: 0, y: 0, w: vw, h: vh }
    var scale = (box.width / content.w) * SEND_LID_SCALE
    if (!isFinite(scale) || scale <= 0) return

    // 诊断用：把量到的内容框写回 DOM（与小女孩那段同一约定）。
    markContentBox(lidClip, content)
    lidClip.style.width = (vw * scale).toFixed(2) + 'px'
    lidClip.style.height = (vh * scale).toFixed(2) + 'px'

    // 内容框在屏幕上的目标位置：水平贴着电饭煲的中线，下沿贴着它的下沿。
    var contentW = content.w * scale
    var contentH = content.h * scale
    var left = clamp(box.left + (box.width - contentW) / 2, 0, Math.max(0, viewportWidth() - contentW))
    var top = clamp(box.bottom - contentH, 0, Math.max(0, viewportHeight() - contentH))

    // 元素自身的左上角 = 内容框左上角减去素材里那块透明留白。
    lidClip.style.left = (left - content.x * scale).toFixed(2) + 'px'
    lidClip.style.top = (top - content.y * scale).toFixed(2) + 'px'
  }

  /**
   * 计时器/文案整列挂在电饭煲左缘正下方，且保证不超出视口。
   *
   * 这一列**挂在 <body> 上、用视口坐标**（所以 CSS 里是 position:fixed）：它要
   * 跟着电饭煲走，而拖动过程中电饭煲的 left/top 才是真值 —— 挂在块内用相对
   * 坐标会在"拆开时用左上角、拖过之后用 pos"之间来回跳。挂 body 只有一个坐标系。
   *
   * 开盖那段播放期间电饭煲那一块被藏成 `visibility:hidden`（**不是 display:none**），
   * 所以这里量到的 rect 依然有效、布局不会跳。
   */
  function layoutSendBar() {
    if (!sendBar || !partUnits || !sendBar.parentNode) return
    var cookerRect = partUnits[0].el.getBoundingClientRect()
    if (!(cookerRect.width > 0)) return

    var vw = window.innerWidth || document.documentElement.clientWidth || 0
    var vh = window.innerHeight || document.documentElement.clientHeight || 0

    var left = cookerRect.left
    var top = cookerRect.bottom + 6
    sendBar.style.left = Math.round(left) + 'px'
    sendBar.style.top = Math.round(top) + 'px'

    // 下方放不下：整列上移，宁可压住电饭煲也不让它跑出屏幕。
    var rect = sendBar.getBoundingClientRect()
    var overflowBottom = rect.bottom - (vh - 8)
    if (overflowBottom > 0) {
      sendBar.style.top = Math.round(top - overflowBottom) + 'px'
      rect = sendBar.getBoundingClientRect()
    }
    // 右缘越界：往左推回去。
    var overflowRight = rect.right - (vw - 8)
    if (overflowRight > 0) {
      sendBar.style.left = Math.round(left - overflowRight) + 'px'
    }
    if (rect.left < 8) sendBar.style.left = '8px'
  }

  /* --- 事件 1：小女孩那一段 ------------------------------------------- */

  function ensureGirlClip() {
    if (!partUnits) return null
    var girl = partUnits[1]
    if (girlClip) {
      // 重播会先把两块（连同这一段视频）从页面上摘掉，但节点本身是留着重用的 ——
      // 所以这里必须确认它还挂在右块上。否则下一轮她"演"的是一段已经不在页面里的
      // 视频：屏幕上什么都没有，而流程照旧走完（用户看到的就是"跑出动画没播"）。
      if (girlClip.parentNode !== girl.el) girl.el.appendChild(girlClip)
      return girlClip
    }
    girlClip = createClipVideo({ id: 'dshca-girl', url: GIRL_CLIP_URL })
    girlClip.addEventListener('loadedmetadata', function () {
      layoutGirlClip()
    })
    // 关键：她那段素材的内容只占画幅 38%（大片透明留白），所以要把**内容框**
    // 量出来再摆 —— 跟 idle/act 用的是同一套 measureContent()（读 alpha 包围盒）。
    // 量之前先隐着，免得按整幅尺寸闪一下。
    girlClip.addEventListener('loadeddata', function () {
      if (!girlBox) girlBox = measureContent(girlClip)
      layoutGirlClip()
      // 0.10.2：跑出素材的内容框量到了 —— 贴边间隙按它重新收紧。
      rehugGirl()
      if (sendPhase === 'girl') girlClip.classList.add('dshca-showing')
    })
    girlClip.addEventListener('ended', function () {
      if (sendPhase === 'girl') onGirlClipEnded()
    })
    girlClip.addEventListener('error', function () {
      // 素材读不出来不能让流程卡住：直接当作"已经演完"。
      sendDebug('girl-error', null)
      if (sendPhase === 'girl') onGirlClipEnded()
    })
    girl.el.appendChild(girlClip)
    return girlClip
  }

  /**
   * 小女孩那段按"她原来站的位置"贴合右块。
   *
   * 素材是 1920x1080 横构图，而右边那一块是竖的窄条，所以**不能**按整幅宽度铺 ——
   * 那样小女孩会只见头顶。做法与 idle/act 完全一致：量出素材里**内容**的包围盒，
   * 把内容高对齐右块高、水平居中、底边对齐；这样"跟随挂件宽度"这句话在观感上
   * 就是"她跟原来一样大"。
   */
  function layoutGirlClip() {
    fitClipToGirlPart(girlClip, girlBox, SEND_GIRL_SCALE)
  }

  /**
   * 触发事件 1。`onDone` 在"按钮已搬走、计时器已起步"之后调用，供自检与调试。
   *
   * 之所以把它做成显式函数（而不是只在事件回调里内联）：预览页要能直接驱动整条
   * 流程，DevTools 里也能 `window.__dshcaSend.simulate()` 手动跑一遍。
   */
  function runSendFlow(onDone) {
    if (destroyed) return
    if (sendPhase === 'girl') return
    // 新一轮：先把上一轮留下的东西（开盖定格、搬走的按钮、计时器）全部复位。
    resetSendFlow(true)

    // 还没拆成两块（开场动画还在演 / split:false）就没有"右侧小女孩那块"可站：
    // 直接把这一轮标记为已收尾，等下一次发送再说。按钮该搬的还是会搬。
    if (!partUnits || !SPLIT) {
      sendPhase = 'laid'
      onSendLaid()
      if (typeof onDone === 'function') onDone()
      return
    }

    sendPhase = 'girl'
    sendDebug('girl-start', null)
    // 排期先停：小女娃那块现在归 girl.webm 用，别让 idle/act 冒出来抢画面。
    if (scheduleOn) pauseSchedule()

    var clip = ensureGirlClip()
    layoutGirlClip()
    if (clip) {
      try {
        clip.currentTime = 0
      } catch (err) {
        /* seek may fail before metadata */
      }
      clip.classList.add('dshca-showing')
      // 关键（0.7.3）：她这一段要**独占画面** —— 定格 canvas 与 idle/act 那一路
      // 都在这一刻让位，否则她会与"原先那张她"叠在一起（她那段的透明区域会
      // 把底下那张图露出来），看起来就是跑出动画没播。
      setGirlClipShown(true)
      sendBar && sendBar.classList.remove('dshca-send-on')
      var attempt = clip.play()
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(function () {
          // 被自动播放策略拦下（理论上 muted 不会）：直接当演完处理，别卡住。
          sendDebug('girl-blocked', null)
          if (sendPhase === 'girl') onGirlClipEnded()
        })
      }
      // 兜底：万一 'ended' 因为任何原因没来，不能让按钮永远搬不走。
      var guardMs = 0
      var duration = clip.duration
      guardMs = (isFinite(duration) && duration > 0 ? duration * 1000 : 5200) + 2500
      window.setTimeout(function () {
        if (sendPhase === 'girl') {
          sendDebug('girl-timeout', null)
          onGirlClipEnded()
        }
      }, guardMs)
    } else {
      onGirlClipEnded()
    }
    if (typeof onDone === 'function') {
      window.setTimeout(onDone, 0)
    }
  }

  /** 小女孩演完：搬按钮 → 藏她 → 起计时器。 */
  function onGirlClipEnded() {
    if (sendPhase !== 'girl') return
    sendDebug('girl-ended', null)
    sendPhase = 'laid'
    onSendLaid()
  }

  /** 事件 1 的收尾：控制条搬到电饭煲上方、小女孩隐藏、计时器开始跑。 */
  function onSendLaid() {
    // 她那段到此为止：先放开"独占画面"，把两路节拍与定格 canvas 的显隐交回
    // 原来的判据（紧接着整个右块就被藏起来了，所以这一步只是把状态收回原位）。
    setGirlClipShown(false)
    if (destroyed || !partUnits) return
    var cooker = partUnits[0]
    var girl = partUnits[1]

    // ① 控制条（和它带着的设置面板）搬到电饭煲上方。
    if (bar) {
      var rect = cooker.el.getBoundingClientRect()
      bar.classList.add('dshca-detached')
      bar.style.width = Math.round(rect.width) + 'px'
      bar.style.left = Math.round(rect.left) + 'px'
      bar.style.top = Math.round(rect.top - 28) + 'px'
      if (bar.parentNode !== document.body && bar.parentNode !== document.documentElement) {
        ;(document.body || document.documentElement).appendChild(bar)
      }
      panelBox = null
    }
    // 面板现在挂在电饭煲这一块上，位置跟着它。
    setPanelHost(cooker.el)

    // ② 小女孩那块整个藏起来（连她的定格 canvas 与两路动画层），文案/计时器列出现。
    girl.el.style.display = 'none'
    if (girlClip) girlClip.classList.remove('dshca-showing')
    if (lidClip) {
      lidClip.classList.remove('dshca-lid-on')
      lidClip.style.visibility = 'hidden'
    }
    buildSendDOM(cooker.el)
    if (sendBar) sendBar.classList.add('dshca-send-on')
    layoutSendBar()

    // ③ 计时器从这一刻开始跑。
    sendStartedAt = now()
    updateTimer()
    stopSendTicker()
    sendTicker = window.setInterval(updateTimer, 1000)
    layoutPanel()
    // 这一轮已经走到"按钮搬好、计时器在跑"，再来的"发送"信号就是下一条消息了，
    // 所以这里重新武装（另有一个超时兜底，防止小女孩那段播不出来时永久卡住）。
    sendArmed = true
    // ④ 如果输出在小女孩还在演的时候就已经开始了，这里补播开盖（问题 1）。
    flushDeferredOutput()
  }

  /** 停掉计时器那条每秒一次的重排（读数保留，DOM 也不动）。 */
  function stopSendTicker() {
    if (sendTicker) {
      if (typeof window.clearInterval === 'function') window.clearInterval(sendTicker)
      sendTicker = 0
    }
  }

  function updateTimer() {
    if (!timerEl) return
    timerEl.textContent = formatClock(now() - sendStartedAt)
    layoutSendBar()
  }

  /**
   * 开盖那段播完：**蓝色文案与计时器一起收掉**（0.7.4），开盖画面仍停在最后一帧。
   *
   * 为什么连计时器一起停：这一列计量的是"这轮对话跑了多久"，而开盖（模型开始输出）
   * 就是这一轮的句号 —— 用户要的是"饭做好了就把计时收掉"，不是让它继续跑给谁看。
   * 只藏 DOM 是不够的：`sendTicker` 每秒钟还会读一次表、重排一次发送列，所以这里
   * 一并把表停掉；下一轮复位（`resetSendFlow` → `onSendLaid`）会把它重新挂回来。
   *
   * 判据只有 `sendPhase === 'lid'`：已经复位、或者用户又发了下一条消息（相位已经不是
   * `lid`）时，这里什么都不做 —— 迟到的 `ended` 绝不能把新一轮的计时器收掉。
   */
  function onLidClipEnded() {
    if (destroyed || sendPhase !== 'lid') return
    sendDebug('lid-ended', null)
    stopSendTicker()
    if (sendBar) sendBar.classList.remove('dshca-send-on')
    // 0.10.2：停在最后一帧的这格现在标记为"可点"（pointer-events + 手型光标）。
    if (lidClip) lidClip.classList.add('dshca-lid-frozen')
  }

  /**
   * 点击「开盖动画最后一帧」（0.10.2 修的漏洞3 的落点）：
   * 整条发送联动复位 —— 锅回原样、小女孩回来、控制条回到她那一侧、两条节拍
   * 接回去，恢复成「电饭煲」和「小女孩」各自独立可拖的状态。
   *
   * 判据刻意收在 `ended` 上：只有真的停在最后一帧时这一格才可点；
   * 播放中的点击穿过（pointer-events:none），不会把正在演的动画打断。
   */
  function onLidFrameClick() {
    if (destroyed || sendPhase !== 'lid') return
    if (!lidClip || !lidClip.ended) return
    sendDebug('lid-frame-click', null)
    resetSendFlow(false)
  }

  /* --- 事件 2：模型开始输出时播开盖 ----------------------------------- */

  /**
   * 开始等"开始输出"。
   *
   * **在"点发送"那一刻就要调它**，而不是等小女孩演完（0.7.2 修的关键一条）。
   * 原因：小女孩那段素材有 5 秒，如果这轮"思考 + 输出"在 5 秒内就结束了，
   * 等小女孩演完再取基线时**正文已经写完、不再变长** —— 于是增长判据永远不成立，
   * 开盖动画永远不播，计时器却一直在走（用户报的就是这个）。
   *
   * 现在从点发送那一刻就开始量，所以"输出发生在小女孩还在演的时候"也能被抓到；
   * 抓到之后不立刻播，而是记下来，等小女孩演完（`sendPhase === 'laid'`）再播。
   *
   * 0.10.2：主触发改为「一轮完整结束」（turn.json 的 seq 变大，与 whale 挂件弹
   * 「本次消费金额」同一条件）—— 这里保留旧的正文基线，但**不再**立刻启动旧
   * 探测；只有 turn 信号被判定不可用（连续失败）时，才退回旧的正文增长探测。
   */
  function armOutputWatch() {
    if (!SEND_HOOK || destroyed) return
    sendDeadline = now() + SEND_OUTPUT_TIMEOUT
    // 基线在**这一刻**（点发送）就固定住，之后只比"长了多少"，见 checkForOutput()。
    var sample = answerTextLength()
    sendLastText = sample.total
    sendHaveBaseline = true
    sendLidWanted = true
    sendOutputSeen = false
    // 新一轮：把"上一轮按住过"的诊断标志归零（判据本身每拍现算，不依赖它）。
    sendHeldForReasoning = false
    // 静默判定的初值：以"点发送那一刻"为起点。
    sendSettleLen = -1
    sendSettleAt = now()
    sendPeakText = sendLastText
    sendDebug('watch-output', { baseline: sendLastText, inAnswerContainer: sample.found })
    if (sendWatcher) {
      if (typeof window.clearInterval === 'function') window.clearInterval(sendWatcher)
      sendWatcher = 0
    }
    armTurnWatch()
  }

  /* --- §17：turn/end 信号轮询 ------------------------------------------ */

  /** 取一次 turn.json 的 seq；任何失败都回调 null（由调用方决定怎么兜底）。 */
  function fetchTurnSeq(cb) {
    var fetcher = window.fetch
    if (typeof fetcher !== 'function') {
      cb(null)
      return
    }
    var pending
    try {
      pending = fetcher(TURN_URL, { cache: 'no-store' })
    } catch (err) {
      cb(null)
      return
    }
    if (!pending || typeof pending.then !== 'function') {
      cb(null)
      return
    }
    pending
      .then(function (res) {
        if (!res || res.ok === false || typeof res.json !== 'function') {
          throw new Error('turn.json unavailable')
        }
        return res.json()
      })
      .then(function (data) {
        if (!data || data.ok !== true || !isFinite(data.seq)) throw new Error('turn.json bad payload')
        cb(Math.max(0, Math.round(data.seq)))
      })
      .catch(function () {
        cb(null)
      })
  }

  /** 处理一次轮询读数：对齐基线 / 触发开盖 / 连续失败时退回旧探测。 */
  function handleTurnSample(seq) {
    if (destroyed) return
    if (seq === null) {
      turnFailures += 1
      if (!turnSignalOk && turnFailures >= TURN_FAIL_LIMIT) startLegacyOutputWatch()
      return
    }
    turnFailures = 0
    turnSignalOk = true
    if (turnSeqBaseline === null) {
      // 首个读数只对齐：武装之前就已结算的轮次不该把开盖带出来。
      turnSeqBaseline = seq
      sendDebug('turn-baseline', { seq: seq })
      return
    }
    if (seq > turnSeqBaseline) {
      turnSeqBaseline = seq
      onTurnSettled()
    }
  }

  /** 武装 turn 信号轮询（点发送时调）：先取基线，再每秒问一次。 */
  function armTurnWatch() {
    if (destroyed || !SEND_HOOK) return
    turnFailures = 0
    turnSeqBaseline = null
    fetchTurnSeq(handleTurnSample)
    if (turnWatcher) {
      if (typeof window.clearInterval === 'function') window.clearInterval(turnWatcher)
      turnWatcher = 0
    }
    if (typeof window.setInterval === 'function') {
      turnWatcher = window.setInterval(function () {
        fetchTurnSeq(handleTurnSample)
      }, TURN_POLL_MS)
    }
  }

  /**
   * 一轮真的结束了（turn/end，与 whale 弹「本次消费金额」同一时刻）。
   *
   * 与旧的 onOutputDetected 同一套接法：能播就播，小女孩还在演就先记下来，
   * 等她演完（onSendLaid → flushDeferredOutput）补播。
   */
  function onTurnSettled() {
    if (destroyed || !sendLidWanted) return
    sendDebug('turn-settled', { phase: sendPhase })
    disarmOutputWatch()
    try {
      if (sendPhase === 'laid') {
        playLid()
        return
      }
      // 小女孩还在演：先记下，等 onSendLaid() 收尾时补播。
      if (sendPhase === 'girl') sendOutputSeen = true
      sendDebug('turn-settled-deferred', { phase: sendPhase })
    } catch (err) {
      sendDebug('lid-play-error', String((err && err.message) || err))
    }
  }

  /** turn 信号判定不可用：退回旧的"正文增长"探测（0.7.x 的行为）。 */
  function startLegacyOutputWatch() {
    if (destroyed || sendWatcher) return
    sendDebug('turn-signal-unusable', null)
    if (typeof window.setInterval !== 'function') return
    sendWatcher = window.setInterval(checkForOutput, SEND_WATCH_INTERVAL)
    window.setTimeout(checkForOutput, SEND_WATCH_INTERVAL)
  }

  function disarmOutputWatch() {
    sendLidWanted = false
    if (sendWatcher) {
      if (typeof window.clearInterval === 'function') window.clearInterval(sendWatcher)
      sendWatcher = 0
    }
    // 0.10.2：turn 轮询与旧探测同生共死 —— 一轮收工（开盖播了 / 复位了）就都停。
    if (turnWatcher) {
      if (typeof window.clearInterval === 'function') window.clearInterval(turnWatcher)
      turnWatcher = 0
    }
  }

  /** 输出已经开始了 —— 但小女孩可能还在演，那就等她演完再播开盖。 */
  function onOutputDetected(from, to, inAnswerContainer) {
    sendOutputSeen = true
    disarmOutputWatch()
    // 播放本身绝不能把异常抛回去：这里跑在定时器回调里，抛出去会**静默**地
    // 让开盖不播、而计时器照旧在走（自检时踩到过，排查了很久）。
    try {
      if (sendPhase === 'laid') {
        playLid()
        return
      }
      // 小女孩还在演（或者这一轮还没走到收尾）：先记下，等 onSendLaid() 收尾时补播。
      sendDebug('output-deferred', {
        from: from,
        to: to,
        inAnswerContainer: inAnswerContainer,
        phase: sendPhase,
      })
    } catch (err) {
      sendDebug('lid-play-error', String((err && err.message) || err))
    }
  }

  /** 事件 1 收尾时调用：如果输出早就开始了，这里补播开盖。 */
  function flushDeferredOutput() {
    if (!sendOutputSeen || sendPhase !== 'laid') return
    sendOutputSeen = false
    sendDebug('output-deferred-flush', null)
    try {
      playLid()
    } catch (err) {
      sendDebug('lid-play-error', String((err && err.message) || err))
    }
  }

  /**
   * 页面上**正文**（回答）的文本总长度 —— 事件 2 的判据。
   *
   * 为什么要挑"正文"而不是全页文本（**这是 0.7.1 修的关键一条**）：实测发现
   * **思考过程本身就是流式文本** —— DSH 每轮都会挂一行 `div._row_…`，标题是
   * "思考"，后面跟着正在生成的推理内容。所以"全页文本在变长"这条判据会在
   * **思考刚开始**就命中，开盖动画提前播出去，而不是等"开始输出结果"。
   *
   * 现在按这个顺序找正文容器：
   *   ① `ANSWER_SELECTOR`：从实机 DOM 抓到的 markdown 容器（DSH 用 `_markdown_…`
   *      渲染回答正文），并**排除**推理行（`REASONING_SELECTOR`）与我们自己；
   *   ② 找不到正文容器时退回全页文本总长（老判据）。这时至少还能用，
   *      只是可能偏早 —— 这也是为什么把 ① 做得尽量宽。
   *
   * 0.7.5 补充：兜底路径**排不掉过程行**（「正在分析请求」等 `message.stepProcess.*`
   * 文案不在推理行里），所以"文本在长"并不等于"开始输出结果"；真正的把关交给
   * `reasoningRunning()` —— 深度思索没结束就不开盖（见 `checkForOutput()` 判据 ③）。
   */
  function answerTextLength() {
    var total = 0
    var found = false
    try {
      if (!document.body) return { total: 0, found: false }
      var nodes = []
      try {
        nodes = document.querySelectorAll(ANSWER_SELECTOR)
      } catch (err) {
        nodes = []
      }
      for (var i = 0; i < nodes.length; i += 1) {
        var el = nodes[i]
        if (inOurWidget(el)) continue
        if (el.closest && el.closest(REASONING_SELECTOR)) continue
        found = true
        total += (el.textContent || '').length
      }
    } catch (err) {
      /* ignore */
    }
    if (!found) return { total: pageTextLength(), found: false }
    return { total: total, found: true }
  }

  /**
   * 页面上全部文本的总长度，**排除"思考"那一行与我们自己**。兜底判据。
   *
   * 为什么是"总和"而不是"最长的那一段"：真实页面里一条回答会被拆成很多文本节点
   * （Markdown 的段落/列表/代码块各一个），流式输出往往只让**其中一个**节点变长；
   * 只看最长节点会漏掉这种增长（实测踩到过：总长从 36 涨到 78，最长节点只从
   * 36 涨到 42，没过阈值）。
   *
   * **必须排除推理行**：DSH 每轮都会挂一行「思考」，里面的推理内容也是流式生成的；
   * 不排除的话，模型还在思考时判据就命中了，开盖动画会提前播出去（问题 3 的成因）。
   * 之所以在兜底路径上也要排，是因为实机的正文容器不一定命中 `ANSWER_SELECTOR` ——
   * 那时就走这里，而这一条必须依然可靠。
   */
  function pageTextLength() {
    var total = 0
    var reasoning = 0
    try {
      if (!document.body || typeof document.createTreeWalker !== 'function') return 0
      var walker = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */, null)
      var node = walker.nextNode()
      while (node) {
        var parent = node.parentNode
        if (parent && !inOurWidget(parent)) {
          var tag = parent.tagName
          if (tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'NOSCRIPT') {
            var len = node.nodeValue ? node.nodeValue.length : 0
            total += len
            if (isInsideReasoning(parent)) reasoning += len
          }
        }
        node = walker.nextNode()
      }
    } catch (err) {
      /* ignore */
    }
    return Math.max(0, total - reasoning)
  }

  /** 这个元素是不是在"思考"那一行里（里面的文本是推理，不是正文）。 */
  function isInsideReasoning(el) {
    try {
      // 实机的推理行带一个构建哈希类名（`_3GBCTG_row`）：**哈希会随构建变**，
      // 所以既按类名前缀认，也按"标题是不是『思考』"认，双保险。
      if (el.closest && el.closest(REASONING_SELECTOR)) return true
      if (el.closest && el.closest('[role=button]')) {
        var row = el.closest('[role=button]')
        var head = (row.textContent || '').slice(0, 12)
        if (REASONING_TEXT_PATTERN.test(head)) return true
      }
    } catch (err) {
      /* ignore */
    }
    return false
  }

  /**
   * 「深度思索」那一行：**还在思索**时带 `data-state="running"`。
   *
   * 判据直接抄 DSH 自己的推理行（`@deepseek-ai/dsh-client-ui-chat` 的 `ReasoningRow`）：
   *   `<div data-variant="think" data-state={running ? 'running' : 'ok'} …>`
   * 其中 `running` = "这一块还是这条消息的流式尾巴"；一旦它后面出现正文块（或流结束），
   * 就翻成 `ok`。于是"还在思索"和"思索已结束"共用同一个属性，而且是 **data 属性、
   * 与构建哈希无关** —— 比按类名认更稳。
   */
  var REASONING_RUNNING_SELECTOR = '[data-variant="think"][data-state="running"]'

  /**
   * 现在是不是**还在「深度思索」里**（0.7.5 的开盖前置条件）。
   *
   * 为什么必须有这一条：思索期间页面上照样有文本在变 —— 「思考」那一行的流式预览
   * （已按 `REASONING_SELECTOR` 排除），以及**过程行**「正在分析请求 / 正在读取文件 /
   * 正在调用工具」（`message.stepProcess.*`，它不在推理行里，排除不掉）。
   * 于是"页面文本在变长"这条兜底判据会在模型还在想的时候就成立，开盖提前播出去。
   *
   * 三层，从准到宽（DSH 换了写法也不至于永远不开盖）：
   *   ① `[data-variant="think"][data-state="running"]`；
   *   ② 推理行类名前缀 + `data-state="running"`；
   *   ③ 推理行类名前缀 + 里面还有 `[data-streaming]` 的摘要（0.7.1 起就在用的锚点）。
   * 只认**看得见**的行：藏在别的面板 / 折叠区里的推理行不该把这一轮卡住。
   * 三条都命中不到 = 没在思索（没有推理阶段的模型、关掉思考时同样如此）。
   */
  function reasoningRunning() {
    var selectors = [
      REASONING_RUNNING_SELECTOR,
      REASONING_SELECTOR + '[data-state="running"]',
      REASONING_SELECTOR + ' [data-streaming]',
    ]
    for (var i = 0; i < selectors.length; i += 1) {
      var nodes = []
      try {
        nodes = document.querySelectorAll(selectors[i])
      } catch (err) {
        continue
      }
      for (var j = 0; j < nodes.length; j += 1) {
        var el = nodes[j]
        if (inOurWidget(el)) continue
        if (visible(el)) return true
      }
    }
    return false
  }

  /**
   * 拍一次，判断"模型是不是已经在输出结果了"。
   *
   * 三条判据，命中任意一条就算（问题 1 就是只留第一条导致短回答永远不播）：
   *   ① **正文比"点发送那一刻"长了一点点**（`SEND_TEXT_GROWTH` 个字符）。
   *      基线刻意取"点发送那一刻"（`armOutputWatch()` 里量一次就固定住），而不是
   *      "第一次轮询时量到的值"：很短的一轮里，正文可能在第一次轮询（180ms 后）
   *      之前就写完了，若拿那次当基线，暴涨会被当成基线、之后再也不长。
   *   ② **正文静下来了**：有变化、然后连续 `SEND_SETTLE_MS` 没再变。
   *      这条是为了"回答很短"的情况 —— 比如只回一句"好的"，永远到不了 ① 的阈值。
   *      （所以 ① 的阈值必须很小，只有 2 个字符；它只是个"确实有输出"的门槛，
   *      真正决定时机的是 ② 的静默窗口。）
   *   ③ **前置条件（0.7.5）**：上面任意一条成立时，**「深度思索」必须已经结束**
   *      （`reasoningRunning()` 为假）。思索期间过程行一直在变，①②都会提前成立 ——
   *      按住不动，等它想完。按住时**一个字的状态都不改**（基线、峰值、静默时刻全不动），
   *      所以思索一结束，同一条判据立刻再次成立、开盖紧接着就播，不会晚。
   */
  function checkForOutput() {
    if (destroyed || !sendLidWanted) return
    var sample = answerTextLength()
    var len = sample.total
    lastTextSeen = len
    var t = now()

    var thinking = reasoningRunning()
    if (thinking && !sendHeldForReasoning) {
      // 只在"开始按住"这一刻记一笔，免得每 180ms 刷爆诊断账本。
      sendHeldForReasoning = true
      sendDebug('output-held-reasoning', { len: len, inAnswerContainer: sample.found })
    } else if (!thinking && sendHeldForReasoning) {
      sendHeldForReasoning = false
      sendDebug('reasoning-ended', { len: len, inAnswerContainer: sample.found })
    }

    if (t > sendDeadline) {
      // 还在深度思索就继续等：这一轮的开盖本来就该等它想完，不能因为"想得久"
      // 就整轮放弃（默认 10 分钟）。截止时刻往后推，并留一笔诊断。
      if (thinking) {
        sendDeadline = t + SEND_OUTPUT_TIMEOUT
        sendDebug('watch-extended', { len: len, deadlineIn: Math.round(sendDeadline - t) })
      } else {
        sendDebug('output-timeout', { len: len, inAnswerContainer: sample.found })
        disarmOutputWatch()
        return
      }
    }

    // 正文一有变化就记下时刻与峰值，供"静下来"那条判据用。
    if (len !== sendSettleLen) {
      sendSettleLen = len
      sendSettleAt = t
    }
    if (len > sendLastText) sendPeakText = len

    var grew = len - sendLastText >= SEND_TEXT_GROWTH
    // 静默判据**必须建立在"确实已经长过一点"之上**：否则"模型还在思考、正文还是空的"
    // 也会被算成"静下来了"，于是思考刚开始就把开盖播出去（问题 3 的另一种形态）。
    // 所以这里要求 sendPeakText 严格大于基线。
    var hasOutput = sendPeakText - sendLastText > 0
    var settled = !grew && hasOutput && t - sendSettleAt >= SEND_SETTLE_MS

    if (grew || settled) {
      // ③ 还在深度思索：这一拍按住。注意这里**只是不播**，别的什么都不做 ——
      // 开盖没播，电饭煲就一直停在它自己的定格图上（"思索时保持原样"）。
      if (thinking) return
      sendDebug(grew ? 'output-detected' : 'output-settled', {
        from: sendLastText,
        to: len,
        inAnswerContainer: sample.found,
        settleMs: Math.round(t - sendSettleAt),
      })
      onOutputDetected(sendLastText, len, sample.found)
    }
  }

  /** 最近一次量到的"正文长度"、静默判定用的状态，都只服务于上面那条判据。 */
  var lastTextSeen = 0
  var sendSettleLen = -1
  var sendSettleAt = 0
  var sendPeakText = 0

  /**
   * 播开盖视频（带声优先；被拦就静音放画面 + 小喇叭兜底）。
   *
   * **开盖那段是来"替换"电饭煲的，不是叠在它下面**（问题 3）：素材里本来就画着
   * 一口完整的锅（从合盖到开盖、冒出小女孩），所以电饭煲那一块必须先藏起来 ——
   * 否则屏幕上会同时出现两口锅（一口是拆分时裁出来的定格图，一口是视频里的）。
   * 0.7.3 起 `layoutLid()` 把它**原地**摆到电饭煲那一块的位置上（内容下沿对齐锅的
   * 下沿、水平对着锅的中线），所以替换是无缝的 —— 它不再跑到计时器下面去播。
   */
  function playLid() {
    if (destroyed || !partUnits) return
    var cooker = partUnits[0]
    // 开盖这一段要**替换**电饭煲那一块：如果这一块此刻正被按着（快照顶着
    // 锅的画面），先把那一次按压干净地收掉，否则快照会盖在开盖视频上面。
    endSquish(true)
    buildSendDOM(cooker.el)
    if (!lidClip) return
    // 先让开盖那段**就位到电饭煲那一块上**（此刻它还是 display:none，位置只由
    // 电饭煲那一块的 rect 决定），再藏电饭煲、再显示它 —— 中间不会出现"两口锅
    // 都不在"或者"两口锅同时在"的一帧。
    layoutLid()
    layoutSendBar()
    sendPhase = 'lid'
    sendDebug('lid-play', { muted: lidClip.muted })

    try {
      lidClip.currentTime = 0
    } catch (err) {
      /* ignore */
    }
    var attempt = lidClip.play()
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(function () {
        // 带声自动播放被拦：静音放画面，并给出可点的小喇叭。
        sendDebug('lid-audio-blocked', null)
        lidClip.muted = true
        if (unmuteButton) unmuteButton.classList.add('dshca-showing')
        var second = lidClip.play()
        if (second && typeof second.catch === 'function') {
          second.catch(function () {
            sendDebug('lid-blocked', null)
          })
        }
      })
    }
    lidClip.classList.add('dshca-lid-on')
    lidClip.classList.remove('dshca-lid-frozen')
    lidClip.style.visibility = ''
    // 只有当开盖那段真的能显示时才藏电饭煲；素材坏了（error）就不藏，
    // 免得画面上什么都没有。
    if (!lidClip.error) cooker.el.classList.add('dshca-cooker-hidden')
    layoutLid()
    layoutSendBar()
  }

  /* --- 复位 ------------------------------------------------------------ */

  /**
   * 回到"什么都没发生"的布局。`keepRunning` 为真时用于"新的一轮开始"，
   * 那时不该把排期再打开 —— 小女孩马上要演下一段。
   */
  function resetSendFlow(keepRunning) {
    // 新一轮：先把可能还在进行的那次点击拉伸收掉（它可能正按着小女孩或锅），
    // 否则快照会与"按钮搬走 / 小女孩藏起来"这套复位叠在一起。
    endSquish(true)
    // 0.10.0：随机动画 / 拖动动画也先收干净 —— 新一轮开始时两个部分马上要重新
    // 排布（按钮搬走、小女孩藏起来），带着一口飞在路上的锅进来只会互相打架。
    stopRandomAnims(true)
    dragAnimOn = false
    if (dragClip) dragClip.classList.remove('dshca-drag-on')
    disarmOutputWatch()
    stopSendTicker()
    sendPhase = 'idle'
    sendStartedAt = 0
    // 0.10.2：复位即"回到什么都没发生"。发送联动期间排期被暂停过（paused=true），
    // 不清掉这个标志的话，"点击末帧还原"之后两条节拍永远不会接回来 ——
    // 小女孩会永远停在上一格，不待机也不做动作。
    paused = false
    if (timerEl) timerEl.textContent = '00:00'

    if (girlClip) {
      girlClip.classList.remove('dshca-showing')
      try {
        girlClip.pause()
      } catch (err) {
        /* ignore */
      }
    }
    // 复位 = 她那段（如果还在演）就此收工：独占画面的开关一并放掉，
    // 画面交回节拍那一层，下一轮她才会重新独占。
    setGirlClipShown(false)
    if (lidClip) {
      try {
        lidClip.pause()
      } catch (err) {
        /* ignore */
      }
      lidClip.style.visibility = 'hidden'
      lidClip.classList.remove('dshca-lid-on')
      lidClip.classList.remove('dshca-lid-frozen')
    }
    if (unmuteButton) unmuteButton.classList.remove('dshca-showing')
    if (sendBar) sendBar.classList.remove('dshca-send-on')

    if (partUnits) {
      var cooker = partUnits[0]
      var girl = partUnits[1]
      cooker.el.classList.remove('dshca-send-on', 'dshca-lid-on', 'dshca-cooker-hidden')
      girl.el.style.display = ''
      // 控制条回到小女孩那一侧（这是 0.6.0 的默认布局）。
      if (bar) {
        bar.classList.remove('dshca-detached')
        bar.style.width = ''
        bar.style.left = ''
        bar.style.top = ''
        girl.el.appendChild(bar)
      }
      setPanelHost(girl.el)
      panelBox = null
      layoutOverlay()
      layoutPanel()
    }
    if (!keepRunning && partUnits && !scheduleOn && !paused && (IDLE || ACT) && girlTarget()) {
      // 没有新一轮要来：把两条节拍接回去。
      startSchedule()
    }
  }

  /* --- §18：点「发送消息」的侦测 ---------------------------------------- */

  var SEND_TEXT_PATTERN = /发送|发消息|send|submit/i
  var ABORT_TEXT_PATTERN = /停止|中止|中断|取消|stop|abort|cancel/i
  var SEND_EXCLUDE_SELECTOR = '#dshca-bar,#dshca-panel,#dshca-root,.dshca-part,#dshca-unmute'

  /**
   * 实机 DOM 抓到的东西（DSH web GUI，`http://127.0.0.1:<port>/`）：
   *
   *   发送按钮   <button class="RlGAzG_primary" aria-label="发送消息">
   *   输入框     <div class="RlGAzG_input" role="textbox"
   *                     aria-label="发消息或创建任务, / 调用指令, @ 文件或对话">
   *   推理过程   <div class="_row_… _3GBCTG_row" role="button"> 里含 <span>思考</span>
   *              —— 注意这是**流式文本**，不能用它判断"开始输出"
   *   回答正文   由 `_markdown_…` 容器渲染（classHints 里抓到的）
   *
   * 这些类名里带着构建哈希（`_row_jhda5_16` 这种），**不能写死**；所以这里只用
   * 稳定的部分：aria 文案、role、以及"前缀"匹配（`[class*="_markdown"]`）。
   */
  var SEND_ARIA_PATTERN = /^(发送消息|发送|Send message|Send)$/i
  var EDITOR_ARIA_PATTERN = /^(发消息|输入|Type a message|Message|Ask anything)/i
  /** 回答正文的容器（宽匹配：不同版本哈希不同，取语义前缀）。 */
  var ANSWER_SELECTOR = '[class*="_markdown_"],.markdown-body,[data-markdown]'
  /** 「思考」那一行 —— 它的文本是推理，不算正文。 */
  var REASONING_SELECTOR = '[class*="_3GBCTG_"]'
  /** 推理行的标题文案（类名哈希会变，所以再按文案认一次）。 */
  var REASONING_TEXT_PATTERN = /^(思考|正在思考|深度思考|Thinking)/i

  function inOurWidget(el) {
    if (!el) return false
    try {
      return !!(el.closest && el.closest(SEND_EXCLUDE_SELECTOR))
    } catch (err) {
      return false
    }
  }

  function buttonText(el) {
    var parts = []
    if (el.getAttribute) {
      parts.push(el.getAttribute('aria-label') || '')
      parts.push(el.getAttribute('title') || '')
      parts.push(el.getAttribute('data-testid') || '')
    }
    parts.push(el.textContent || '')
    return parts.join(' ')
  }

  function visible(el) {
    var rect = el.getBoundingClientRect()
    if (rect.width <= 1 || rect.height <= 1) return false
    var view = el.ownerDocument && el.ownerDocument.defaultView
    if (!view || typeof view.getComputedStyle !== 'function') return true
    var cs = view.getComputedStyle(el)
    return cs.display !== 'none' && cs.visibility !== 'hidden'
  }

  /**
   * 找到"发送消息"那颗按钮。
   *
   * 三级，从准到宽：
   *   ① 用户显式配的 `sendSelector`；
   *   ② **aria-label 精确等于"发送消息"**（实机就是这个，最可靠）；
   *   ③ 文案里带"发送 / send / submit"且不含"停止 / 取消 / stop"。
   *
   * 每一级都要"看得见"（有尺寸、没被 display:none 掉）。注意实机上那颗按钮
   * 在生成期间可能被禁用，所以**不禁用也能被找到** —— 是否禁用交给调用方判断，
   * 这样"重播期间按钮 disabled"不会让整个侦测失明。
   */
  function findSendButton() {
    if (SEND_SELECTOR) {
      try {
        var explicit = document.querySelector(SEND_SELECTOR)
        if (explicit) return explicit
      } catch (err) {
        sendDebug('selector-invalid', SEND_SELECTOR)
      }
    }
    var buttons = document.querySelectorAll('button,[role=button]')
    var i
    var b
    // ② aria 精确匹配
    for (i = 0; i < buttons.length; i += 1) {
      b = buttons[i]
      if (inOurWidget(b)) continue
      var aria = b.getAttribute ? b.getAttribute('aria-label') || '' : ''
      if (!SEND_ARIA_PATTERN.test(aria.trim())) continue
      if (!visible(b)) continue
      return b
    }
    // ③ 宽匹配
    for (i = 0; i < buttons.length; i += 1) {
      b = buttons[i]
      if (inOurWidget(b)) continue
      var hay = buttonText(b)
      if (ABORT_TEXT_PATTERN.test(hay)) continue
      if (!SEND_TEXT_PATTERN.test(hay)) continue
      if (!visible(b)) continue
      return b
    }
    return null
  }

  /** 这个元素是不是"输入区"（回车要在这里才算发送）。 */
  function isEditor(el) {
    if (!el || !el.tagName) return false
    var tag = el.tagName
    if (tag === 'TEXTAREA') return true
    if (tag === 'INPUT' && String(el.type || 'text').toLowerCase() === 'text') return true
    if (el.isContentEditable === true) return true
    if (el.getAttribute && el.getAttribute('role') === 'textbox') return true
    // 实机的输入区是 contenteditable 的 div，但 aria 上写着"发消息或创建任务…"，
    // 所以再按 aria 认一次，跨版本更稳。
    var aria = el.getAttribute ? el.getAttribute('aria-label') || '' : ''
    return EDITOR_ARIA_PATTERN.test(aria.trim())
  }

  /** 事件 1 的入口：任何一条侦测路径都要经过这里，保证一轮只触发一次。 */
  function onSendSignal(source) {
    if (!SEND_HOOK || destroyed) return
    if (sendPhase === 'girl') return
    if (!sendArmed) return
    sendArmed = false
    sendDebug('send-signal', source)
    // 顺序很重要：`runSendFlow()` 的第一件事是**复位**（复位里会 disarm 观察器），
    // 所以必须"先复位、再开始观察"。反过来的话，刚架好的观察器会被这次复位拆掉，
    // 之后什么都不再发生 —— 开盖永远不播，而计时器照旧在走（这就是问题 1 的成因）。
    // 复位是同步完成的，所以"开始观察"依然发生在"点发送"这一刻，基线仍然正确。
    runSendFlow(null)
    armOutputWatch()
    // 只在"确实有重复信号"的窗口里屏蔽：短时间内连点、或者同一次发送又冒出一个
    // 信号（回车 + 点击、React 重挂等）都算一次。
    //
    // **不能**只在 1.5 秒后就完事：一轮回答可能跑几分钟，1.5 秒后"重新武装"会让
    // 下一条消息点发送时 `sendArmed` 早就是 true 了，其实没问题 —— 但反过来，
    // 若把重新武装做成"等太久才 true"，那下一轮的开始就会被吞掉。
    // 所以这里两条都做：短窗口去抖 + 一轮真正收尾后立刻重新武装。
    if (sendArmedTimer) {
      if (typeof window.clearTimeout === 'function') window.clearTimeout(sendArmedTimer)
    }
    sendArmedTimer = window.setTimeout(function () {
      sendArmedTimer = 0
      sendArmed = true
    }, SEND_DEBOUNCE_MS)
  }

  /** 去抖窗口：这么短时间内的重复"发送"信号只算一次。 */
  var SEND_DEBOUNCE_MS = 1500
  var sendArmedTimer = 0

  function onDocumentClick(event) {
    if (!SEND_HOOK || destroyed) return
    var target = event.target
    if (!target || inOurWidget(target)) return
    var button = findSendButton()
    if (!button) return
    if (button !== target && !(button.contains && button.contains(target))) return
    if (button.disabled) return
    onSendSignal('click')
  }

  function onDocumentKeydown(event) {
    if (!SEND_HOOK || destroyed) return
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    var target = event.target
    if (!target || inOurWidget(target)) return
    if (!isEditor(target)) return
    // 只有"确实存在一颗可用的发送按钮"时才认这次回车 —— 否则聊天里普通换行
    // （Shift+Enter 之外的多行输入、命令面板等）会被误判成发送。
    var button = findSendButton()
    if (!button || button.disabled) return
    onSendSignal('enter')
  }

  function installSendHook() {
    if (!SEND_HOOK) return
    document.addEventListener('click', onDocumentClick, true)
    document.addEventListener('keydown', onDocumentKeydown, true)
    sendDebug('hook-installed', { selector: SEND_SELECTOR || '(aria + semantic)' })
    exposeSendApi()
  }

  function uninstallSendHook() {
    document.removeEventListener('click', onDocumentClick, true)
    document.removeEventListener('keydown', onDocumentKeydown, true)
    try {
      delete window.__dshcaSend
    } catch (err) {
      window.__dshcaSend = null
    }
  }

  /* --- §19：发送联动的调试入口（window.__dshcaSend） -------------------- */

  /**
   * 排查用的公开小 API（只读 + 一个显式"手动跑一遍"的入口）。
   *
   * `simulate()` 是给"没反应"这种情况准备的：不用真的发一条消息，就能把事件 1
   * 与事件 2 各走一遍，看是侦测没命中、还是播放/搬运出了问题。
   */
  function exposeSendApi() {
    window.__dshcaSend = {
      version: '0.7.2',
      phase: function () {
        return sendPhase
      },
      /** 当前找到的"发送"按钮（找不到就是 null）。 */
      findButton: function () {
        var b = findSendButton()
        return b ? { text: buttonText(b).slice(0, 40), disabled: !!b.disabled } : null
      },
      /** 手动触发事件 1（可选：紧接着触发事件 2）。 */
      simulate: function (opts) {
        var alsoOutput = !opts || opts.output !== false
        runSendFlow(function () {
          if (alsoOutput) {
            window.setTimeout(function () {
              playLid()
            }, 60)
          }
        })
      },
      /** 只触发事件 2（开盖那一段）。 */
      output: function () {
        playLid()
      },
      reset: function () {
        resetSendFlow(false)
      },
      /** 诊断账本：每一次判断的依据与时间。 */
      debug: function () {
        return { phase: sendPhase, label: SEND_LABEL, events: sendEvents.slice() }
      },
      /** 观察器内部状态 —— 排查"事件 2 不触发"时看这里。 */
      probe: function () {
        var sample = answerTextLength()
        return {
          phase: sendPhase,
          armed: sendLidWanted,
          watcher: sendWatcher,
          lastText: sendLastText,
          answerText: sample.total,
          peakText: sendPeakText,
          settleFor: Math.round(now() - sendSettleAt),
          settleWindow: SEND_SETTLE_MS,
          usingAnswerContainer: sample.found,
          pageText: pageTextLength(),
          answerContainers: (function () {
            try {
              return document.querySelectorAll(ANSWER_SELECTOR).length
            } catch (err) {
              return -1
            }
          })(),
          deadlineIn: Math.round(sendDeadline - now()),
          threshold: SEND_TEXT_GROWTH,
          // 0.7.5：开盖的前置条件 —— 现在还在不在「深度思索」里。
          reasoningRunning: reasoningRunning(),
          heldForReasoning: sendHeldForReasoning,
        }
      },
      /** 现在认定哪颗是发送按钮、输入框认不认 —— 排查"点了没反应"时先看它。 */
      detect: function () {
        var b = findSendButton()
        var editors = []
        try {
          var all = document.querySelectorAll('[role=textbox],textarea,input,div[contenteditable]')
          for (var i = 0; i < all.length && i < 8; i += 1) {
            if (isEditor(all[i])) {
              editors.push({
                tag: all[i].tagName.toLowerCase(),
                cls: String(all[i].className || '').slice(0, 40),
                aria: all[i].getAttribute ? all[i].getAttribute('aria-label') : null,
              })
            }
          }
        } catch (err) {
          /* ignore */
        }
        return {
          button: b
            ? {
                tag: b.tagName.toLowerCase(),
                cls: String(b.className || '').slice(0, 40),
                aria: b.getAttribute ? b.getAttribute('aria-label') : null,
                disabled: !!b.disabled,
              }
            : null,
          editors: editors,
          reasoningRows: (function () {
            try {
              return document.querySelectorAll(REASONING_SELECTOR).length
            } catch (err) {
              return -1
            }
          })(),
        }
      },
    }
  }

  /* ------------------------------------------------------------------ */
  /* §20 控制条（重播 / 排期 / 间隔 / 折叠 / 关闭）                       */
  /* ------------------------------------------------------------------ */

  function makeButton(glyph, title, onClick) {
    var button = document.createElement('button')
    button.type = 'button'
    button.textContent = glyph
    button.title = title
    button.setAttribute('aria-label', title)
    button.addEventListener('pointerdown', function (event) {
      event.stopPropagation()
    })
    button.addEventListener('click', function (event) {
      event.stopPropagation()
      onClick()
    })
    return button
  }

  function buildControls() {
    bar = document.createElement('div')
    bar.id = 'dshca-bar'

    bar.appendChild(
      makeButton('↻', '重播动画', function () {
        hidePlayHint()
        merge() // 先合回整体（顺带撤掉待机层），再从头播一遍；播完会重新拆分并重新待机。
        try {
          video.currentTime = 0
        } catch (err) {
          /* ignore */
        }
        start()
      }),
    )

    // Debug 按钮：手动暂停 / 继续小女孩那块的动画排期。放在重播右边，
    // 位置固定，方便"不重启也要立刻看下一段动画"这种反复调试。
    if (IDLE || ACT) {
      animButton = makeButton('▶', '暂停动画排期（Debug）', toggleSchedule)
      animButton.id = 'dshca-anim-toggle'
      animButton.setAttribute('aria-pressed', 'false')
      bar.appendChild(animButton)

      // 动画间隔档位：点一下切下一档（⇄0.5× / 1× / 2× / 4×，到顶回卷）。
      // 标签上直接写当前倍率，不用展开面板也知道现在的节拍。
      speedButton = makeButton('⇄' + speedLabelOf(SPEED), '', cycleSpeed)
      speedButton.id = 'dshca-speed-toggle'
      speedButton.className = 'dshca-speed'
      bar.appendChild(speedButton)
    }

    // 折叠按钮就在重播按钮右侧。
    collapseButton = makeButton('▾', '展开设置', function () {
      syncPanel(!panelOpen, true)
    })
    bar.appendChild(collapseButton)

    bar.appendChild(
      makeButton('✕', '关闭（本次运行）', function () {
        destroy()
      }),
    )

    root.appendChild(bar)
  }

  /* ------------------------------------------------------------------ */
  /* §21 生命周期：挂载 / 自适应 / 启动 / 销毁                            */
  /* ------------------------------------------------------------------ */

  function destroy() {
    if (destroyed) return
    // 还在按着的那一次拉伸先收回：它的快照与"暂停着的那一段"都挂在马上要被
    // 摘掉的节点上，不先收掉就会留下一个永远不播的视频元素。
    endSquish(true)
    // 头上的盆连同它们的定时器一起清掉（✕ 是"本次运行不要了"）。
    clearPots()
    // 0.10.0：拖动动画与两道随机动画的状态、定时器、rAF 一个都不能留下。
    stopRandomAnims(true)
    dragAnimOn = false
    if (dragClip) {
      try {
        dragClip.pause()
      } catch (err) {
        /* ignore */
      }
      dragClip.classList.remove('dshca-drag-on')
    }
    clearLidReverseTimers()
    clearFlightArtifacts()
    destroyed = true
    // 播放层与节拍器都要跟着一起走。
    scheduleOn = false
    paused = false
    detachOverlay()
    stopAllTimers()
    // 0.7.0：发送联动的侦听器、计时器、观察器一个都不能留下。
    uninstallSendHook()
    disarmOutputWatch()
    stopSendTicker()
    try {
      video.pause()
    } catch (err) {
      /* ignore */
    }
    if (girlClip) {
      try {
        girlClip.pause()
      } catch (err) {
        /* ignore */
      }
    }
    if (lidClip) {
      try {
        lidClip.pause()
      } catch (err) {
        /* ignore */
      }
    }
    // 按压音效的 AudioContext 也一并放掉（✕ 是"本次运行不要了"，没有下一声了）。
    if (audioCtx) {
      try {
        if (typeof audioCtx.close === 'function') audioCtx.close()
      } catch (err) {
        /* ignore */
      }
      audioCtx = null
    }
    // 控制条搬走过的话，它现在挂在 body 上，得单独收拾。
    if (bar && bar.parentNode && bar.parentNode !== root && partUnits) {
      bar.parentNode.removeChild(bar)
    }
    if (partUnits) {
      for (var i = 0; i < partUnits.length; i += 1) {
        if (partUnits[i].el.parentNode) partUnits[i].el.parentNode.removeChild(partUnits[i].el)
      }
      partUnits = null
    }
    if (sendBar && sendBar.parentNode) sendBar.parentNode.removeChild(sendBar)
    if (unmuteButton && unmuteButton.parentNode) unmuteButton.parentNode.removeChild(unmuteButton)
    if (root && root.parentNode) root.parentNode.removeChild(root)
    window.removeEventListener('resize', onResize)
    window.removeEventListener('pointerup', unlockPanel, true)
    window.removeEventListener('pointercancel', unlockPanel, true)
  }

  function onResize() {
    for (var i = 0; i < units.length; i += 1) {
      if (!units[i].drag) unitClamp(units[i])
    }
    // 窗口变窄/变宽之后，贴边的那一块跟着新的边框重新贴一次。
    rehugGirl()
    layoutOverlay()
    layoutPanel()
    // 0.7.0：拆分态下这几样都跟着小女孩/电饭煲的位置与尺寸走。
    layoutGirlClip()
    layoutLid()
    layoutSendBar()
    layoutDetachedBar()
    // 0.10.0：三份新素材的层同样要跟着重排；正在"飞过去"的那一次把移动量作废
    // （几何变了，缓存下来的终点已经不对了，下一帧会就地重算）。
    layoutDragClip()
    layoutCookerLidAnims()
    layoutGirlBasinClip()
    basinFlight = null
  }

  /** 搬到电饭煲上方的那条控制条：跟着电饭煲的位置走。 */
  function layoutDetachedBar() {
    if (!bar || !bar.classList.contains('dshca-detached') || !partUnits) return
    var rect = partUnits[0].el.getBoundingClientRect()
    bar.style.width = Math.round(rect.width) + 'px'
    bar.style.left = Math.round(rect.left) + 'px'
    bar.style.top = Math.round(rect.top - 28) + 'px'
  }

  function reveal() {
    if (revealed || !root) return
    if (!rootUnit.pos) placeRoot()
    revealed = true
    root.classList.add('dshca-ready')
    syncPanel(PANEL_OPEN, false)
  }

  /**
   * 第一段视频播完：定格 -> 拆分 -> 启动小女孩那块的动画排期。
   *
   * 刚拆完那一瞬画面上是"原样的定格图"，与拆分前完全重合，没有任何跳变；
   * 随后由排期器按节拍把两段动画轮流接上去。用户按过暂停（或已经重播）时，
   * 排期不会自己启动，绝不覆盖用户的意图。
   */
  function onEnded() {
    holdLastFrame()
    if (!SPLIT) return
    // 等这一帧真正落到合成器上再去裁，否则可能裁到倒数第二帧。
    if (video.seeking) {
      video.addEventListener('seeked', function onSeeked() {
        video.removeEventListener('seeked', onSeeked)
        nextFrame(onSplitAndStart)
      })
      return
    }
    nextFrame(onSplitAndStart)
  }

  /** 拆分，然后启动动画排期。 */
  function onSplitAndStart() {
    split()
    if (!partUnits || destroyed) return
    if (!IDLE && !ACT) return
    startSchedule()
  }

  function mount() {
    insertStyles()

    root = document.createElement('div')
    root.id = 'dshca-root'
    root.className = 'dshca-host'
    root.style.width = WIDTH + 'px'
    root.style.opacity = String(OPACITY)
    if (DRAGGABLE) root.classList.add('dshca-draggable')

    video = document.createElement('video')
    video.id = 'dshca-video'
    video.src = MEDIA_URL
    video.autoplay = true
    video.muted = true
    video.defaultMuted = true
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.setAttribute('muted', '')
    video.setAttribute('preload', 'auto')
    video.setAttribute('draggable', 'false')
    video.setAttribute('disablepictureinpicture', '')
    video.setAttribute('disableremoteplayback', '')
    // 关键：不设 loop —— 播完停在最后一帧。
    video.loop = false

    root.appendChild(video)
    if (SHOW_CONTROLS) {
      buildControls()
      buildPanel()
    }

    rootUnit = createUnit('merged', root)
    panelHost = root

    video.addEventListener('loadedmetadata', function () {
      // 尺寸已知，可以正确定位（尤其 bottom-* 角落需要高度）。
      placeRoot()
      reveal()
    })
    video.addEventListener('loadeddata', reveal)
    video.addEventListener('playing', function () {
      hidePlayHint()
      reveal()
    })
    video.addEventListener('ended', onEnded)
    video.addEventListener('error', destroy)

    ;(document.body || document.documentElement).appendChild(root)

    // 元数据迟迟不来（网络慢 / 解码慢）也要让用户看到东西。
    window.setTimeout(reveal, REVEAL_TIMEOUT)

    window.addEventListener('resize', onResize)
    // 面板锁定的解锁（0.10.2）：松手/取消在**任何地方**发生都要算数 ——
    // 也挂捕获阶段，免得被块上的 stopPropagation（unitPointerUp 等）吞掉。
    window.addEventListener('pointerup', unlockPanel, true)
    window.addEventListener('pointercancel', unlockPanel, true)

    // 0.7.0：「发送消息」联动。侦听器挂 document（捕获阶段），所以 React 每次
    // 重挂发送按钮都不影响 —— 我们是在点击到达时**现找**那颗按钮。
    installSendHook()

    // 0.8.0：按压音效的试听 / 自检入口（`window.__dshcaPress`）。
    // 只挂 API；AudioContext 与"钢管"素材都等到第一次按压才动。
    exposePressApi()

    // 0.9.0：盆的图片在挂载时就预热（~400KB）。第一次按压最早也在开场动画播完
    // 之后，所以真正掷中时它已经在缓存里 —— 掉下来的盆不会先空一下再出现。
    preloadPotImage()
    exposePotApi()

    // 0.10.0：两道随机动画 + 拖动动画的排查 / 自检入口（`window.__dshcaRandom`）。
    // 只挂 API；那三段素材都等到真正需要时才去拉。
    exposeRandomApi()

    start()
  }

  function boot() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', mount, { once: true })
      return
    }
    mount()
  }

  boot()
})()
