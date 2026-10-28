# Boomerang Fu：过场、相机与动画反馈分析

调查日期：2026-10-28。目标为本机 `F:\SteamLibrary\steamapps\common\Boomerang Fu`。本轮没有启动原版、执行原版程序集或修改存档；以下“观察”均指安装产物的静态观察，不能当作录屏逐帧测量。

## 证据与问题清单

程序集 SHA-256：`7e5a31b96c64150455340067314538af3399b723cd11d9891a065bde2dce2a6f`。复用 REA `inspect_managed_artifact` 证据 `ev_c05f0fee6a054766734a886ffd4ce0e68e5c05f141e2ce72b9b595f9a0f07746`（`analysis/evidence/assembly-identity.rea.json`）。调用关系和代码依据为 ILSpy 11.2.0.10050 的静态重建，保存在 `analysis/derived/csharp`；不是原始源码。

新资源证据 `analysis/derived/transitions-resources.json` 记录各文件 SHA-256、UnityPy 1.23.0 解析结果、对象 path ID 和偏移。可用 `analysis/derived/inspect-transitions.py` 重跑；仅读取安装文件。UICircleWipe 的自定义字段因 Unity 类型树被剥离，使用已反编译字段顺序完整解析，且验证消耗字节数正好等于对象长度。动画和 AnimatorController 使用 UnityPy 原生类型解析。

| 问题 | 状态 | 证据边界 |
| --- | --- | --- |
| 普通回合开场、角色入场和解锁顺序 | 已回答 | 代码时序；包含条件分支，不能概括为所有局固定总秒数 |
| 圆形过场实际配置 | 已回答 | 场景对象完整字段解析，区别于类默认值 |
| 击杀停帧、慢动作、相机变化 | 已回答 | 代码触发条件与计时规则；实际视觉强度待实机校准 |
| 结算与下一地图加载 | 已回答 | 代码调用链，正常结算需要玩家继续，不是固定延时自动跳过 |
| 入场、冲刺资源动画长度 | 部分回答 | 原始 clip 长度和入场控制器退出条件已取证；没有重建骨骼姿态或角色 override 对应表 |
| 地图机关分类 | 已回答（六张样本） | 场景组件与对应行为代码；不把名字或预览图当机关运行证据 |

下文代码定位均相对于 `analysis/derived/csharp/`，资源定位相对于游戏 `Boomerang Fu_Data/`。

## 1. 开场并非三秒数字倒计时

`GameManager.cs:1748–1868` 的主链是 `TransitionIn → StartRoundSequence → Playing → Player.Go()`。

1. 开场立刻并行启动 `transitionCircleWipe.TransitionOut()`，设置音乐为 Match，然后等待 **0.1 秒 real time**（`GameManager.cs:1754–1761`）。所以画面展开与角色展示重叠。
2. 非团队局先展示领先者，再按玩家顺序展示其他人；平分/无领先者时走正常顺序（`:1781–1798`）。出生位置的随机化是另一件事，不能用展示顺序决定出生位置。
3. `SpawnPlayer` 调用 `GetReady()`，每人基础间隔 **0.4 秒 game time**，总人数 >4 时为 **0.35 秒**。玩家提示、落后补偿盾、强化图标还会增加时长，每个图标再等 **0.1 秒**（`:1900–1945`）。因此 `0.1 + 人数×0.4` 只是无附加展示时的基准。
4. 首局可能弹操作说明，等待真实 UI 关闭；不能把这段写成固定等待（`:1800–1813`）。
5. 普通局显示 **Ready 1.0 秒**，切 Go 的那个回调就将 `titlesShowing=false`。GameManager 等到此标志释放后进入 Playing，Go 文字继续显示 **0.7 秒**（`UIMenuRoundTitles.cs:93–139`）。热身额外为 1.2+0.3 秒，决胜额外为 1.5+1.5+0.3 秒。
6. 标题从 0.5 倍弹到 1 倍，用 **0.15 秒 OutBack**；Go 切换时结束 Ready 声音，播放专用声音和粒子（`UIMenuRoundTitles.cs:287–330`）。

**重要区别：Go 解锁行走，不等于立刻拿到镖。** `Player.cs:981–1007` 开启 canWalk/canRotate，再调用 `RespawnDisc(combatDelayAtStart)`；`:189` 是静态常量 **1.2 秒**，`:2953–2977` 实际等待后才补镖。`GameManager.cs:1727` 每回合都调用 `Init(0,roundNumber==0)`，`Player.cs:759` 设置 HasDiscs=startDiscs，然后每回合的 Go 执行上述发镖；不是只有首局等待。预告模式将该延迟改为 0，捉迷藏有独立角色分支。

跨回合护盾也不是无条件恢复：`Init` 只在 resetPowerups（首局）清空持有强化，但总会暂时设置 IsShielded=false（`Player.cs:791–802`）；入场时 activePowerup 仍含 Shield 才恢复外观，否则仅满足自动平衡条件才重新 StartShield（`:894–900,964–978`）。已被打破的盾由 StopShield 从 activePowerup 和 powerupHistory 移除（`:2912–2920`），不会下一局免费再生。

### 入场动作和动画资产

`Player.GetReady()` 触发 Animator 的 `Appear`（`Player.cs:870–876`）。`SpawnIn` 同步开始无敌、显示角色、隐藏投影、播 SpawnBurst 和 whoosh；0.2 秒后显示投影；到 `groundSlamDelayOnSpawn` 时落地粒子、手柄震动和镜头 Shake(1.2,0.2)，之后又等 0.5 秒才可能解除 isSpawningIn，再等 0.5 秒撤销这次常规入场无敌（`:881–941`）。`Character.cs:134` 的落地延迟代码默认值是 **0.4333 秒**，各角色序列化 override 本轮未完整解码，所以不能宣称所有角色都精确在这刻触地。

| 静态资源 | 观察 | 不可直接推出 |
| --- | --- | --- |
| `sharedassets1.assets` path IDs 1188–1196、1217、1497、1502–1508、1510–1513 的 22 个 Appear clip | 21 个约 **1.716667 秒**，1511 为 **1.216666 秒**，不循环；采样 60 Hz | 每个角色都需要等完整 clip 才能操作 |
| 同文件 AnimatorController 1717 `CharacterController` 的 Appear 状态 | speed=1；按 normalized exit time≈0.9 转 idle，另可由 StopAppear 触发 **0.25 秒固定过渡** | clip 尾部一定在实机完整播放 |
| 同文件 AnimationClip 1355 `Dash` | **0.233333 秒**、不循环 | dash 无敌/位移窗口也是 0.233333 秒；二者由不同代码管 |
| 同文件 clip 1266 `ShieldAppear` / 1265 `PowerupSpawn` / 1231 `DiscGrounded` | 分别约 **0.333333 / 0.35 / 0.4 秒** | 原版贴图、模型或动画可以原样作为 Web 运行依赖 |

以上资源都已解析为数值摘要，没有加入 Web 的素材依赖。资源摘要见 `transitions-resources.json:227` 起，Animator 摘要见 `:935` 起。

## 2. 圆形过场：序列化值覆盖了类默认值

`UICircleWipe.cs:147–202` 每帧用 **unscaledDeltaTime** 推进，收拢可追踪角色屏幕坐标；展开默认重新居中。材质半径参数是 `safeArea.width × (1 - progressCurve(progress))`（`:121–132`），不是线性 opacity 淡入淡出。

| 场景对象 | 精确资源定位 | 收拢 / 展开 | 特征 |
| --- | --- | --- | --- |
| TransitionCircleWipe | `level1` path ID **10126**，object offset **1657968**，180 bytes，times 位于对象内 +104 | **0.5 / 1.0 秒** | progress curve 两个端点，斜率约 0.568 和 1.488；不换色；focus offset=(0,0,-2) |
| VictoryCircleWipe | `level1` path ID **10101**，object offset **1653720**，348 bytes，times 位于对象内 +160 | **2.0 / 0.5 秒** | 半径曲线在 normalized≈0.25 达到约 0.888，保持到≈0.95，再闭合；颜色有独立曲线；focus offset=(0,0,-2) |

对应资源摘要 `transitions-resources.json:38–224`。两个对象均绑定 `globalgamemanagers.assets` MonoScript path ID **666**（UICircleWipe）。`UICircleWipe.cs:15–17` 的两个默认 1 秒不能替代这些场景值。

**推断：** VictoryCircleWipe 是快速围住角色、停留展示、最后收口的 spotlight 节奏，而不是匀速两秒黑屏。该推断来自曲线数值和 shader 半径入参；本轮没有逐像素比对 shader 输出。

## 3. 命中反馈需要区分三个时钟

`TimeKeeper.cs:50–113` 同时积累 scaled / unscaled time。慢动作包络和停帧使用 unscaled 时间，世界移动用 scaled 时间；Pause 是独立状态。照搬成“render 暂停”会让伤害/碰撞仍在后台继续，语义不对。

| 触发条件 | 代码观察 | 依据 |
| --- | --- | --- |
| 飞镖/近战/爆炸/队友击杀死亡 | **0.1 秒 FreezeFrame**，受 freezeFramesEnabled 开关约束 | `Player.cs:3490–3494`；`TimeKeeper.cs:199–206` |
| 常规死亡，满足非热身/已完成热身及模式条件 | `SlowMoEffect(0.5,0.5)`；默认 slowScale=0.2 | `Player.cs:3325–3327` |
| 近战格挡飞行中的镖 | **0.25 秒 FreezeFrame**；满蓄力镖额外 `SlowMoEffect(0.3)`，并有击退 | `Actor.cs:1664–1707` |
| 近战与近战对砍 | 存活对手数 <3 时 **0.2 秒 FreezeFrame**，并用玩家 ID 限制重复特效 | `Player.cs:2163–2171` |
| 护盾受伤 | **没有无条件 FreezeFrame**；ShieldPop、减少盾次数、**0.85 秒临时无敌**；满蓄力镖击盾另有条件性 SlowMoEffect(0.25) | `Player.cs:2250–2343` |
| 三杀/更多连杀 | **0.2 秒 FreezeFrame** | `Player.cs:2036–2053` |
| GoldenDisc 回合结束 | 0.5 秒入、0.2 timeScale，锁定慢动作 | `TimeKeeper.cs:173–177` |
| Match 结束 | 0.5 秒入、**0.015 timeScale**，锁定慢动作 | `TimeKeeper.cs:179–183` |

`SlowMoEffect(hold,in,scale)` 的实际结构是 **in → hold → out**，且 out 被设为 hold（`TimeKeeper.cs:129–158`）。新效果叠加已有慢动作时延长/重置 hold，不是每次强制清空重新播放。普通死亡调用基准包络是 0.5+0.5+0.5=1.5 秒 real time，但同期 freeze、重复击杀、开关和锁定结束效果会改变表现，不能给所有死亡一个固定“总耗时”。

镜头晃动还存在一个容易漏掉的换算：`Shake(intensity,duration)` 内部存 `duration×3`，并按 ExpoOut 衰减（`Camera3D.cs:335–356`）。例如入场参数 0.2 代表内部 shakeDuration **0.6 秒**；静态调用参数不能直接写成录屏晃动长度。

**Web 建议：** 将死亡/飞镖格挡分别配置成 0.10/0.25 秒停帧，对砍为有条件的 0.20 秒，盾本身为 0。保留 60 Hz 外部 tick，由权威模拟在完整处理同 tick 的命中后安排后续停帧，不能在第一个 death 事件立即退出而吞掉同时击杀。SDK 手动 step 应明确停帧是否消耗外部 tick，replay 记录事件和计时状态。纯 presentation 模块只做画面求值，**不自行改变原版 timeScale 或停止物理**；物理停帧由 Game 统一管理。

## 4. 相机是动态取景，不是固定俯视

`Camera3D.cs:184–205` 用 unscaled 时间追焦（Lerp 系数 5），但菜单、暂停、加载、freezeFrame 时不执行相机更新。目标位置虽叫 WeightedTargetCentroid，实际是各目标按 influence 内插后的包围盒中心，并限制在地图边界内（`:223–262`）。

目标不仅有人：移动障碍 0.25、移动地板 0.5、传送门和开关 0.75 的权重，均以 2 秒过渡加入（`:139–159`）；所有玩家通常权重 1。目标 bounds 决定距离，拉远系数 6、拉近系数 2（`:264–301`）；常规 FOV 在代码里重置为 **16°**（`:551–559`），min/max Zoom 并非 Web 世界单位可直接照抄。

普通仍有多人存活时，死者以默认 **1.5 秒**被相机目标集合平滑移除（`Player.cs:3495–3504`，`Camera3D.cs:383–420,526–537`）。最后击杀尝试 `ZoomInOnKill`，要求非预告模式、无正在爆炸物、无运动机关；镜头距离 > minimumZoom×1.1 才启动等待 **0.3 秒 game time**，之后 0.3 秒剔除非玩家目标（`:450–482`）。因此“每次击杀都 zoom”与原版不一致，也不要把该 target 当成单独锁定胜者：传入的是死亡对象，代码依靠保留玩家目标和剔除场景目标改变构图。

Web 可先在 roundEnd 做很小的围绕胜者的取景收紧，同时确保所有活体/飞镖都可见；`cameraScale` 只是可复用演出参数，不能声称复刻了这套动态 targets 算法。

## 5. 回合结束、结算、下一地图

普通结束判定协程先等 **0.15 秒 game time**，若对手≤1清理诱饵，再通常等 **1.3 秒 game time**，最后重新确认存活数才结束（`GameManager.cs:2679–2741`）。这给同时死亡、爆炸、坠落等留下结算窗口；两段等待处于慢动作中，不能换算成固定 1.45 秒 real time。

`EndRound` 设置时间比例 0、关闭 gameplay canvas、清理协程，再 `DisplayRoundScores`。若剩一人，0.5 秒 TransitionCircleWipe 收拢中心选最后幸存者；然后切 Menu、恢复菜单时间、显示 RoundEnd、清理回合（`GameManager.cs:2478–2527`）。

结算页先 0.4 秒淡入（`UIMenuRoundEnd.cs:69–95`），0.2 秒后逐行 tally；每加 1 分前等待 **0.4 秒**并作 0.35 秒旋转弹动（`UIScoreRow.cs:40,142–175`）。后续等待 0.4 秒再显示 replay，又等 0.2 秒；皇冠转移再多等 0.6 秒，最后才显示继续按钮（`UIMenuRoundEnd.cs:243–319`）。它没有一个通用于所有得分数、模式、玩家数的固定结算总时长。

继续按钮的协程先加载下一地图，再 StartRound（`UIMenuRoundEnd.cs:397–415`）。`LevelManager.cs:416–462` 明确先异步卸载旧 scene，再按 playlist 取 scene 并 Additive 加载，找到 Level 后标记 ready。playlist 会按人数、模式、DLC 和自定义过滤，并区分 Simple/Advanced（`:197–287`，`LevelAsset.cs:9–44`）。Web 应从 map ID 建新 arena，整批刷新障碍/机关/导航/飞镖缓存后再入场，不能只替换画面。

最终 Match 胜利演出有另一条分支（`GameManager.cs:3082–3153`）：锁定 0.015 慢动作后，明确胜者分支等 0.5 秒，启动以胜者为焦点的 2 秒 VictoryCircleWipe，再等待 1.5+0.5 秒；这与普通每回合 0.5 秒黑色 wipe 不同。当前 Web 生存计分模式不能直接声称走的是原版 kills 模式的所有冠军逻辑。

## 6. 更多地图：按实际机关扩展

六个场景的 MonoBehaviour 基础字段和脚本引用全部解析成功，组件数量是产物静态数量，包含可能未激活对象，不能等同同一局全部生效。证据：`transitions-resources.json:1488` 起。

| 场景 / 文件 | 静态观察到的机关 | 可以独立复刻的地图玩法 |
| --- | --- | --- |
| LevelEnclosed / `level2` | 9 DestructableObstacle、2 InteractiveObstacle | 封闭掩体/可破坏箱子，改变回旋镖反弹线 |
| LevelTeleportals / `level30` | **8 Teleportal** | 成对入口出口、转向保持和短时间禁止重复进入；AI 路图需要传送边 |
| LevelFalling / `level14` | **31 FallingFloor** | 分块地面预警后下沉，逐步压缩可走区域 |
| LevelRaftPair / `level51` | **2 MovingFloorReactive、17 TrapFloor、2 Switch** | 两个平台+开关改变路径，人物必须接受平台位移 |
| LevelFourCogs / `level45` | **4 MovingFloor** | 四个移动/旋转支撑面；不是“四个会伤人的齿轮”这个仅从名称得出的说法 |
| LevelSlideTraps / `level3` | **2 MovingObstacle、4 Switch** | 开关驱动滑动障碍，预警、推挤/夹击与动态避障 |

行为证据：`Level.cs:42–78,120–130` 收集机关并建立坠落序列；`FallingFloor.cs:19–25,58–133` 为 **2 秒 Warning → 0.75 秒 Falling → Fallen**，开始 Falling 即改碰撞 layer、重建导航和处理地上道具；不是等视觉沉完才删除地面。`MovingFloor.cs:128–220` 在 FixedUpdate 推动平台位置/旋转；`MovingObstacle.cs:242–286` 有 PreMoving→Moving 等状态；`Switch.cs:9–15,70–150` 连接障碍/门/反应地板，`:167` 起处理触发；`Teleportal.cs` 本身主要是成对引用与 0.5 秒闪光，角色/投射物的实际 teleport 在 Actor/Projectile，不能只实现 Flash 就称传送完成。

建议本轮至少覆盖“掩体地图”“传送门地图”“有缺口/窄通道地图”，并加一张能验证动态碰撞的地面预警地图。地图换色不算独立机制。移动平台/旋转碰撞若尚未实现，界面和文档不应先宣称可用。

## 7. Web 演出模块和可验时间轴

`src/core/presentation.ts` 是纯函数演出采样器，输入权威 phase/phaseTime，不读取 DOM、Date、RAF 或随机数。它没有推进物理，也不决定控制解锁；`Game.step` 必须在同一 `introDuration(actorCount)` 边界切 Playing。角色渲染从 `introPose(time,index,count)` 读取可见性、高度、挤压缩放和落地环。

采用经过说明的基准时间轴：0.1 秒首人登场；人数≤4 时每人间隔 0.4 秒；全部开始展示后 Ready 1 秒；到 Playing 的起点显示 Go 0.7 秒。原版可变提示/强化展示、首局说明等待、角色专有骨骼动作均不在此模块内。Go 后 1.2 秒发镖由模拟侧执行，模块仅导出统一的 equipDelay 配置。1 秒展开半径使用安装版 TransitionCircleWipe 的非加权 Hermite 曲线。

roundEnd 的 Web 时间轴则明确是适配：固定 1.45 秒胜负展示、0.5 秒收拢、0.4 秒分数淡入、0.75 秒得分停留，共 3.1 秒后由 simulation 进入下一局/最终结果。原版使用缩放后的等待、独立计分页和人工继续；Web 为保留当前自动连局而使用此可配置固定节奏，不能说成逐帧等同。计分文案只是已提交分数的显示，不重复修改 score。

可验收项：

- countdown 任意时刻玩家位置/生命/分数不因输入变化；切 playing 必须发生在 helper 定义的同一 tick。
- 两人入场基准 t=0.1、0.5 秒；Ready t=0.9，Go/Playing t=1.9；四人相应 Ready t=1.7、Go t=2.7。浮点边界使用 tick 容差。
- 同一状态暂停前后采样值完全相同；从 t=2 回跳到 t=0.2 与直接采样 t=0.2 相同。
- 回合结束先能看清赢家、再圆形闭合；全遮挡时才换 arena；新地图从展开状态显露，旧机关/飞镖不泄漏。
- SDK 可在无 renderer 时完整运行；渲染帧数不同不能改变命中、计分、出生或地图顺序。

剩余实机差异：没有原版视频标注，没有校准落地 squash 的实际幅度/方向、曲线到屏幕半径的 shader 像素效果、镜头 FOV 与 Web 地图世界单位比例、hit-stop 的主观力度。本报告支持机制和时序实现，不支持“完整操作手感已与原版一致”的结论。
