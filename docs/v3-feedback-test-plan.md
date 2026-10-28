# V3 缩圈与死亡反馈审计、资源证据及浏览器验收计划

日期：2026-10-28。本文审计基线为 SDK 0.2.0 初版（tarball SHA-256 `ab234970b3f0b5170ad349db511adc211f41253eacbd9d75c185796c9c36dae9`）。后续实现正在并行推进，下面的“当前缺口”描述该基线，不代表 V3 修复后的最终状态。本文场景尚未执行；验收结果应另存带时间与构建哈希的报告。

原版依据是既有 REA managed 静态证据 `ev_c05f0fee6a054766734a886ffd4ce0e68e5c05f141e2ce72b9b595f9a0f07746`、ILSpy 重建代码及本轮 UnityPy 1.23.0 对选定资源的只读解析。没有启动原版、运行原版程序集或改动原版文件；颜色/时间来自序列化数据，不能当作实机截图像素或输入手感测量。完整规则与死亡分型由对应研究报告展开，这里集中在显示、事件与验收。

## 1. 基线直接缺口

| 优先级 | 静态发现与证据 | V3 应达成的可观察结果 |
| --- | --- | --- |
| P1 | `src/simulation/game.ts:73` 从 35 秒起把 `safeRadius` 从 100 跳至 15，然后每秒减 .55；`actors.ts:191` 圆外立即死亡。 | 与选定原版规则一致的边界形状、中心、收缩阶段与圈外宽限；越界、回归、倒计时耗尽分开。 |
| P1 | `renderer.ts:130,279` 只有固定红色 `LineLoop`，只改缩放；没有缩圈目标标记、贴图滚动或发光侧墙。 | 边界表示真实判定区域，开始收缩可感知，圈外角色可辨认回归方向。 |
| P1 | `view.ts:213` 只有全局 danger-note，`sdk/browser.ts` 基础 HUD 只有比分/阶段；无角色级越界状态。 | 主站与安装包都能辨识危险；无 HUD 模式仍保留世界内边界/角色提示。原版是闪烁/方向/音高警告，数字倒计时若加入应标作 Web 便利设计。 |
| P1 | `combat.ts:18,44` 的 cause 仅 weapon/explosion/fall/boundary；镖与近战都归 weapon，状态没有持久死因。`characters.ts:309` 全部倒转、下沉、缩小，`effects.ts:43` 全部同色碎球，`audio.ts:95` 同一死亡音。 | 状态持久化死亡类型/方向/开始时间；镖/近战、爆炸、水、悬崖、越界至少有符合其机制的视觉分型。一次伤害只产生一次死亡。 |
| P1 | `characters.ts:313` 无条件用 invulnerable 闪烁覆盖 body.visible；环境死绕过无敌，死者不再递减 invulnerable（`actors.ts:20`）。 | 无敌期间环境死亡后，死者不会在隐藏期限后重新闪现；无敌闪烁只用于活体。 |
| P1 | `game.ts:97` 发现 ≤1 活体立即进入 roundEnd，之后不再推进飞镖/爆炸/下落。 | 终局观察窗口允许已在途威胁和同步出局完成，再一次性提交赢家/分数；不能先加分再靠 UI 修正。 |
| P2 | `types.ts:127` 没有缩圈/越界/回归/roundEnd 事件，只有下局 `round` 与终局 `win`。 | SDK 状态足以恢复当前提示；若新增事件，明确事件边沿、tick 与顺序，既有死亡/分数不重复。不要让渲染器自己推演权威死亡。 |
| P2 | `view.ts:246` 胜者统一显示 NICE THROW；无赢家统一“同时出局”；即使本局达到总分目标也说“下一回合马上开始”。 | 环境淘汰不误称投掷击杀；超时平局与全员出局分开；冠军局不预告不存在的下一局。 |

基线的正面保证：同 tick 攻击先收集后结算，Game 在处理整批事件后才安排 hit-stop；Session 每个控制器读取同一份推进前状态，推进后发 game/step 事件；pause 清输入，start 撤销旧控制凭据，快照脱离权威状态。新反馈应保留这些性质。

## 2. 缩圈可视资源：具体文件、对象与参数

这次直接读取 `F:\SteamLibrary\steamapps\common\Boomerang Fu\Boomerang Fu_Data` 中两个文件，复用本仓库 `tools/python` 的 UnityPy；没有导出模型、贴图或音频到 Web。

| 文件 | SHA-256 |
| --- | --- |
| `level1` | `f51d58e0a085629b0b27a9c460bcfaf929892c3556505cc77a61cdba9ba6de39` |
| `sharedassets1.assets` | `7421b9f85a2afe32e478e457360eb26fa27e5fbcd9cb7555261d94f061ed7f3f` |

### 边界线：四角、虚线滚动、状态透明度

`level1` GO 86 `LevelBoundary` 包含 BoxCollider2D 2890；子 GO 570 `LevelBoundaryLine` 包含 MonoBehaviour **9891** 与 LineRenderer **2991**。

MonoBehaviour 9891 起始文件偏移 **1625928**、长度 **140**。由 UnityPy 解析 MonoBehaviour 基础与脚本引用，再按 `LevelBoundaryLine.cs` 序列化字段顺序解析剩余字段；完整消费恰好 140 字节，line 引用 `(0,2991)`、glow 引用 `(0,2812)` 均可解析。

| 字段 | 对象内偏移 | 实际值 RGBA |
| --- | --- | --- |
| colorNormal | +56 | `(0,0,0,0.1019608)` |
| colorNear | +72 | `(0,0,0,0.2980392)` |
| colorOutside | +88 | `(0,0,0,0.8)` |
| colorFlash | +104 | `(1,1,1,0)` |
| zOffset | +120 | `(0,0,-0.2)`；覆盖类默认 -0.25 |
| scrollOffset | +132 | `(0,0)` |

LineRenderer 2991（文件偏移 544832、435 字节）是 **4 点闭合线**，worldSpace=true，widthMultiplier≈**0.2**，widthCurve 恒 1，textureMode=1（Tile），numCornerVertices=4，材质为 sharedassets1:116。材质 116 使用 shader 1115 `UU/Unlit/Alpha/Blend`，`_SrcBlend=5`、`_DstBlend=10`、`_ZTest=4`、`_ZWrite=0`。`_MainTex` 为 Texture2D **480** `LevelBoundary`，512×512；解码 alpha：左半透明，右半不透明，非透明区域 x=256…511，RGB≈242。纹理 x scale≈.66；配合滚动形成重复虚线/条纹，而非连续红线。

`LevelBoundaryLine.cs:66–102` 每帧滚动纹理，通常速率 -.5，缩圈时反向至 +.25；缩圈统一朝 colorOutside 插值，否则活体越界优先，其次接近边缘，普通为低透明度。颜色 Lerp 系数 `deltaTime*5`。`Flash():105` 使用 .5 秒 tween 并激活 glow。材质初始 `_Color` 是紫色 `(0.2848,.2,.5,.4118)`，但运行脚本会改 `_Color`；不能只看材质初值就说边界一直紫色。

### 发光层：世界内红色渐变侧墙，不是全屏遮罩

`level1` GO39 `LevelBoundaryGlow` / Transform2812 的子 GO125 `BoundingCube`，包含 MeshFilter2888、MeshRenderer2886、Animator2892。引用 sharedassets1 Mesh **840** `pCube1`、Material **171** `BoundaryGlow`、AnimatorController1722。

Mesh840（偏移 2487672、776 字节）有 **16 顶点、24 索引、8 三角形**。解码位置和索引确认是四面侧墙，x/z 为 ±.5，y 为 0…1，没有顶底面。父 transform 绕 x=-90°；脚本 `SetGlowSize` 使用 `(size.x-.33,10,size.y-.33)`。这与碰撞边界并非精确贴边，需保留装饰 padding 与权威边界的区别。

Material171（偏移407952、588字节）引用 Shader1099 **Legacy Shaders/Particles/Additive**，`_TintColor=(1,0,0,.1960784)`，Texture384 `LobbyGlow` 为 512×1024 的纯白 RGB + alpha 渐变。实际 shader pass 为 srcAlpha/one、ZWrite off、ZTest LEqual、Cull off；材质里遗留的 `_ZWrite=1` 并非此 shader 的有效绘制状态。GlowOn clip1242长 **.5秒**且不循环，GlowLoop clip1241长 **1.5秒**且循环。其动画曲线为压缩存储，本轮只确认 clip 时长/loop，没有解包逐样本亮度。

由组件链、顶点与 shader 可确认它是有深度测试的世界内渐变边墙。没有证据表明该组件绘制了“圈外整屏红遮罩”；若 Web 使用外区面片或屏幕警示，应明确是可读性适配。没有实机曝光/遮挡对照，不保证静态颜色值等同最终屏幕像素。

### 目标标记与回归箭头

`level1` GO562 `ShrinkingBoundsMarker` / ParticleSystem2999 有四个子 ArrowParticle（GO155/768/344/374；ParticleSystem3003/3005/3001/3006），局部位于左右/上下各4单位，旋转分别面向中间。四者为循环粒子，playOnAwake=false，useUnscaledTime=false；每个粒子寿命 **.75秒**、速率1/秒、startSpeed=7、size=1.5、颜色约 `(.2571,.2,.4,.7412)`。使用 Material201 `ShrinkingArrow`、Texture662 `ArrowCute`（512×412）。主粒子2999的 EmissionModule **disabled**；虽然它有 Skull 材质、.7秒寿命和size11，不能因此宣称骷髅中心一定实际发射。`LevelManager.cs:662–675` 在showMarker时Play，停止缩圈时StopEmitting(withChildren:true)，已存活粒子可自然退场。

角色回归箭头是另一套 `OutOfBoundsArrow.cs`：越界时朝最近 BoxCollider 边缘旋转，sprite alpha 取 Player 警告波形；Disable延迟 .25秒 real time 后隐藏。`Player.cs:1466–1484` 到剩余80%时开始闪烁，并按波形越过 .8 的时刻播放警告音；越危险闪烁/音高越强。没有看到这一链直接显示阿拉伯数字倒计时。不可把收缩中心箭头与角色回归箭头混成同一提示。

## 3. SDK 状态、事件及资源清理契约

建议在权威快照中保存边界阶段/几何、每角色越界剩余时间、死亡种类/方向/起始时间；具体字段名由实现方确定。渲染器初次挂载、暂停恢复、事件订阅较晚时仍能从快照重建持续状态。瞬时声音/爆发粒子依赖事件，不能每帧见到 dead 就重复播放。

死亡 tick 的 SDK 观察值应满足：death.actorId 对应已死亡角色，死因与持久记录相同；攻击者在同一 tick 死亡仍保留正确归因；一次真实死亡只发一次death；计分只由模拟提交。缩圈/越界事件如果新增，应按边沿发出，不按每帧重复，回合重置后可以再次触发。`round` 是新回合事件、`win` 是整场事件，不能因视觉层重复挂载再次发出。

基线清理已覆盖：`resetRound` 重建arena并清discs/pickups/hitStop；renderer 的 arenaKey 含round，切局重建地图并清Effects；start重新创建人物；destroy停RAF、移除监听/Canvas/HUD、断开ResizeObserver、释放几何/独占材质和音频context。共享palette材质有显式缓存，不能把有限的稳定材质缓存直接判为泄漏。

需要追加验收：危险提示/尸体/碎片/回归箭头使用的独占对象都进入clear/reset/dispose；同图跨回合也清，不只mapId变化才清；暂停时世界动画/警告倒计时冻结；重开后旧音效、警告节拍或延迟回调不会污染新局。当前AudioEngine只在destroy关闭context，pause/start不取消已调度短音（最长当前胜利旋律约 .74秒）；它们的尾音策略应有明确定义，新增长循环警告不能沿用无管理调度。当前safeRing在roundEnd/matchEnd仍可见（只判断半径和menu），V3应明确保留到哪一过场阶段。

## 4. 实际浏览器验收矩阵

每项记录 seed/map/options、起止session tick、关键game事件、前后快照及截图时间。Chrome真实WebGL；主站和独立安装tarball各跑一次核心场景。使用公开useScript/acquire/takeover推进，或真实键盘；不要改getState副本伪造结果，不在BrowserGame自身RAF之外再调用step。长等待通过无攻击脚本保持双方存活，等待真实规则到达；缩圈几何快进可另作纯核心测试，但不替代浏览器自然演出。

| ID | 操作与采样 | 通过条件 |
| --- | --- | --- |
| B01 正常→预警→缩圈 | 两名idle脚本自然等到规则阈值，在阈值前1tick、边沿、收缩后截屏；重复固定seed。 | 未到时不误报；边沿仅一次；目标位置、线框、发光层随权威几何；能看清角色和飞镖。 |
| B02 越界→返回→再越界 | 让一个角色在边缘短越界后按箭头回到地面，再二次越界。 | 首次不立即死亡；提示随危急程度变化；回内清警告；二次获得规则规定的新宽限，不继承残留计时。 |
| B03 倒计时耗尽 | 一人主动留在圈外，另一人停在安全处。 | 到期仅一death；事件与状态死因=boundary；分数延迟到统一终局结算；提示不会留在下一局。 |
| B04 暂停中危险 | 越界警告中Esc/点击暂停，保存Canvas，等500ms再截相同区域，随后恢复。 | 权威计时和世界提示不变；恢复不补算后台时间；警告音按确定策略暂停/重启，不加速连发。 |
| B05 画面可读性 | 五地图分别走近/离开边界；1280×800与800×600，并使用HUD false嵌入。 | 墙/水/木箱背景仍分辨线与危险侧；箭头不会全被头顶标签遮住；基础玩法反馈不依赖主站DOM。 |
| D01 武器分型 | 通过脚本接近并分别造成近战与飞镖击杀；记录撞击点/方向和0/.1/.4/1秒图。 | 分型字段真实、姿态/碎片方向稳定；事件、音效各一次；hit-stop期间尸体不会先跑完动画。 |
| D02 爆炸多杀 | 可复现种子拾爆炸镖，安排两人在爆炸半径内；另测本人被波及。 | 多个death都保留，攻击者自伤不误加kill；镜头/闪光不会每个death叠加成不可读白屏；平局判定正确。 |
| D03 水/崖下落及救回 | 从窄道或边沿掉落；分别在 .33秒内、窗口后按冲刺；单次救回后仍未落地再尝试。 | 先fall后death；水/崖时长按规则；早期可救、晚期拒绝；未落地不无限二段救回；真正落地后重置。 |
| D04 无敌环境死亡 | 吃盾后打破盾，在临时无敌中进入水/崖或圈外耗尽。 | 不错误消耗盾挡环境死；死亡模型按结束状态消失，不受旧invulnerable闪烁重新显示。 |
| E01 临界终局 | 最后一名对手死亡时，幸存者已在下落或脚边有未爆飞镖；另测同tick互杀。 | 有威胁观察窗口时允许后续死亡；只有最终存活者加分；全死无胜者，无“先冠军后死亡”。 |
| E02 冠军局/超时 | scoreGoal=1完成一局；另跑多人存活的超时路径。 | win仅一次；最终局无“下一回合”；超时不误写“同时出局”；UI比分与snapshot一致。 |
| L01 警告/死亡期间重开 | 在圈外、死亡碎片、wipe三个时点分别start另一地图，随后回原图。 | 新局time/tick/危险/尸体/碎片均正确重置，旧handle失效；没有上一局箭头/声音延迟触发。 |
| L02 资源长跑 | 同seed同图重复start 20次，再cycle五图10轮；每次等粒子消失后采样stats。 | 每种地图稳态geometries/textures回到其基线附近，不随次数单调增长；Canvas/HUD始终一份；frameErrors/listenerErrors=0。不同地图天然复杂度不能直接比较。 |
| L03 销毁与重建 | 警告播放时destroy两次，按键/resize/blur，再建新实例。 | 旧实例frames停止、Canvas/HUD清零、音频停止；新实例键盘正常且不受旧监听影响。 |
| S01 核心/浏览器一致 | 相同seed与预先记录逐tick动作序列分别在无DOMSession与浏览器重放。 | 边界、fall、death、score及其tick相同；渲染帧率改变不改结果；读取快照和订阅不能改变RNG。 |

补充纯核心断言应集中在真实边界：倒计时到期±1tick、同tick两人死亡、.33救回窗口±1tick、自然下一回合清空危险字段、restart撤销旧凭据。既有整场bot测试出现0次boundary死亡，不能据此宣称缩圈路径已测试。

## 5. 交付证据与边界

建议结果目录 `test-results/v3-feedback/`：`report.json` 保存场景、构建/资源哈希、events摘要、错误和性能样本；截图以 `B03-before-expiry` / `B03-death` 等场景编号命名。自动断言通过后仍检查关键画面，尤其红光的遮挡、尸体朝向、窄屏字重和回合切换残影。

本计划不把基础UI数字、Web世界比例、合成音效或近似碎片运动说成原版已验证效果。原版动画骨骼、音频参数、相机曝光、真实输入延迟和shader逐像素表现仍需独立实机对照。

## 6. 本轮追加实现：独立下落模块

审计后按整合任务新增 `src/simulation/hazards.ts` 与 `tests/hazards.test.ts`；本模块不改动其它模拟/渲染代码，整合调用由主任务完成。2026-10-28 独立 `npx vitest run tests/hazards.test.ts` **11/11通过**，同时 `npm run check` 通过。这是模块验证，不替代上面的15个浏览器场景。

- `hazardKind(arena,position)`：返回 water / cliff / null。本 Web 地图把内部pit定义为水、arena外缘定义为崖；这是地图适配，不能从地图主题自动推断原版地面类型。
- `tickFall(state,actor,dt)`：移动后每个有效模拟tick调用一次。新下落elapsed=0、duration水=.66/崖=.74；之后在累计达到duration的首tick调用damageActor(fall)，直到该tick都不修改alive/分数。60Hz为进入后40/45tick，分别约.6667/.75秒；区别于原版可变Update采样。
- `canRescueFall(actor)` / `rescueFall(actor)`：仅存活、尚未救过且elapsed≤.33的下落可由有效dash救回；rescue返回boolean，并清fall、设fallsSaved=1。普通dash可用性、输入缓冲和冲量由调用者决定。自动滑回地面的恢复边界按原版为严格<.33。
- 已在冲刺中跨越水面不会新建fall；冲刺结束仍无地面才开始下落。成功救回后，dash结束且踩到真正地面才清救回次数；同次空中连续救回被拒绝。
- 下落开始取消蓄力/召回/近战/lunge，保留武器直到真死亡，防止残留释放动作。模块不积分XY位移；调用者关闭落下期间主动走路，并继续处理惯性。
- 惯性近似 `Actor.StartFall`：后方1个原版单位有地、前方2单位危险时采用向前speedLimit×.6，否则将速度限于speedLimit×.33；探测距离按Web worldScale换算。当前velocity近似原版velocityStored，尚无moving-floor继承速度。death.variant最终由combat确定，不由此模块重复发事件。

精确原版依据为 `Actor.cs:1787–1814` 下落更新、`:1910–1929` dash救回、`:1978–1980` 着地清计数、`:2683–2735` StartFall/FallSaved。暂停、命中停帧和终局观察窗口由Game层决定，不在此模块另设时钟。
