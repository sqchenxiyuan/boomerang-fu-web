# Boomerang Fu：本地逆向与 Web 复刻初查

核验日期：2026-10-27。目标：`F:\SteamLibrary\steamapps\common\Boomerang Fu`。

这轮任务是了解游戏并确定复刻依据，尚未实现 Web 游戏，也没有启动原版进行手感测量。证据包括本地安装文件、REA 静态元数据、ILSpy 重建的 C#、Unity 序列化资源与官方玩法资料。反编译结果是派生重建，不是原始工程。

## 结论

这是一个很适合先做核心战斗复刻的目标：本地是 Unity Mono 构建，主要游戏逻辑以可读 CIL 保存在 `Assembly-CSharp.dll`，核心类名和字段名保留。角色与回旋镖的主要运动、碰撞发生在二维平面，画面由三维相机和模型呈现。Web 版可采用 TypeScript 规则模拟与 Three.js 显示。

困难集中在回旋镖状态机、碰撞优先级、移动手感、强化组合与动画反馈。Windows 成品不能直接转存成 Unity WebGL；要么重新实现逻辑与显示，要么另行重建 Unity 工程并解决资源、脚本和插件兼容问题。本阶段建议采用前者。

## 游戏轮廓

- 最多六人本地同屏；也能和机器人玩。食物角色在短回合竞技场里互相淘汰。
- 三个主要战斗按钮分别承担冲刺、近战挥砍、回旋镖投掷；方向输入还参与瞄准与弧线控制。
- 持有回旋镖时可以投掷或近战；镖飞出后需要考虑返回、接取或主动召回。空手攻击另有缴械/击退路径，不能等同于持械挥砍。
- 通常敌方镖或近战有效命中后直接死亡，但护盾、冲刺、无敌状态、正面格挡/反弹、友伤设置会改变判定。
- 正式玩法包括自由混战、组队、黄金回旋镖、躲猫猫。`SettingsManager.MatchType` 中的 `KingOfTheHill` 只是代码存在性证据，本轮没有确认它是可进入的正式菜单模式；组队由 `teamMatch` 标志表示。
- 回合变化来自强化组合和地图机关：掩体、可破坏物、移动平台、传送门、地板坍塌、缩圈等。

官方来源和各版本边界见 [official-gameplay.md](official-gameplay.md)。Steam Remote Play Together 是官方宣传的远程同玩方式；本轮没有证明原版具备独立客户端的网络状态同步协议。

## 安装与技术身份

| 项目 | 已观察事实 | 依据 |
| --- | --- | --- |
| Steam app / build | `965680` / `20430461` | 安装清单，仅读取名称、版本等字段 |
| 开发者 | Cranky Watermelon | `Boomerang Fu_Data/app.info` |
| 引擎 | Unity `2022.3.62f2 (7670c08855a9)` | `UnityPlayer.dll` 产品版本 |
| 构建时间文本 | `Build from NOX at 17/10/2025 5:08:34 PM` | `StreamingAssets/build_info.txt`；没有推断其时区 |
| 安装大小 | 393 个文件，697,287,050 字节，约 665 MiB | 文件系统清点 |
| 逻辑程序集 | `Assembly-CSharp.dll`，1,072,128 字节 | 文件与 REA 元数据 |
| 托管实现 | Unity Mono，CIL，AnyCPU 程序集 | REA CLI header 与 UnityEngine 引用；不代表原生播放器为 32 位 |
| 元数据规模 | 889 个 TypeDef、5,341 个 MethodDef、5,463 个字段 | 含嵌套状态机与第三方类，不能全算成独立玩法系统 |
| 资源容器 | `globalgamemanagers`、`resources.assets`、`sharedassets*.assets`、`level0`–`level60` | 61 个 level 文件不等于 61 张可玩地图 |
| 输入/音频/辅助库 | Rewired、FMOD、A* Pathfinding Project、DOTween、Steamworks 原生库 | 程序集引用与插件文件；核心调用另有 C# 佐证 |

## 资源读取结果

使用 UnityPy 1.23.0 清点了 125 个序列化容器，共 217,720 个序列化对象。关键类型计数如下，包含 UI、碎片、重复变体和各场景内容，不能当作独立美术作品数量。

| 类型 | 对象数 |
| --- | ---: |
| Mesh | 1,356 |
| Texture2D | 704 |
| Material | 448 |
| AnimationClip | 580 |
| AnimatorController | 44 |
| SkinnedMeshRenderer | 239 |

`TimeManager` 中固定步长为 `0.016666000708937645 s`，约 60 Hz；`Physics2DSettings` 中重力为 `(0, 0)`。这与代码中的平面运动和固定步长积分相符。场景也包含三维刚体与碰撞体，因此这里的“二维碰撞”特指核心角色/飞镖模拟，并非断言全部效果和物体都只用二维物理。

完整 `PlayerSettings` 和 `BuildSettings` 的类型树解析各报一个越界错误，已原样记入清单；没有把失败字段补零或当作不存在。对 `BuildSettings` 改为只解码已核对布局的首个字符串数组，取得 61 条场景路径，剩余 136 字节保留未解释。列表含 LoadingScene、GameScene、Tutorial，且 LevelToaster 路径出现两次，所以不能说有 61 张不同可玩地图。

另外，成功解码了六张原包内的 480×270 地图预览贴图，拼成 [地图预览](../analysis/derived/map-preview-sheet.png)。这是随游戏打包的贴图，不是本轮实机截图，也不代表地图三维场景已被重建。它们显示出低多边形卡通场景、倾斜俯视构图和较强的障碍轮廓，适合用 Three.js 还原显示风格。

资源明细：`analysis/derived/unity-inventory.json`、`unity-settings.json`、`build-scenes-prefix.json`、`map-preview-manifest.json`。网格和动画目前只完成库存读取；尚未验证骨骼绑定、动画曲线、Unity 材质与浏览器渲染的转换。

## 核心代码入口

所有重建代码位于本机 `analysis/derived/csharp/`，已排除出 Git 默认跟踪。

| 文件/方法 | 已确认职责 | 对 Web 复刻的意义 |
| --- | --- | --- |
| `Actor.FixedUpdate`、`CheckForCollisions`、`ApplyForces` | 二维速度、阻力、冲刺/突进力、Physics2D 查询、位置积分 | 把模拟与三维显示分开，保持固定步长 |
| `Actor.Dash`、`CooldownDash`、`Attack` | 冲刺方向锁定、冷却恢复、近战突进、持械与空手分支 | 要保留动作之间的抢占和输入窗口 |
| `Actor.OnDamageColliderTriggered`、`Player.OnDamageColliderTriggered` | 敌我识别、冲刺/无敌/护盾过滤、死亡、格挡与缴械 | 不能只做距离小于半径就掉血 |
| `RewiredController.Update`、`PlayerInput.Update` | 移动轴，冲刺/近战按下，投掷释放，按住投掷 | 浏览器输入层需要保留 down/held/up 语义及输入缓存 |
| `Player.ThrowDisc`、`Aim` | 有镖蓄力、无镖召回、方向历史转成弧线角度 | 同一个按钮依角色状态产生不同动作 |
| `Projectile`、`Disc` | 镖的状态、速度、曲线、回归、反弹、追踪、强化 | 是首版最需要忠实重建的系统 |
| `Player.StartPowerup` | 位标志组合、持久强化队列、替换和互斥 | 不能把所有强化当成独立永久叠加 |
| `GameManager`、`SettingsManager`、`MatchSettings` | 对局状态、击杀/生存计分、队伍、复活、可调规则 | 首版只选一条明确的模式路径 |
| `PlayerAI` | 难度相关反应时间、追逐/躲避/召回等行为 | 可先实现少量行为，再逐步对照原版 |
| `LevelAsset`、`LevelManager`、`Level` | 关卡元数据、模式支持、玩家范围、DLC 条件与场景加载 | 资源存在不等于玩家拥有或当前模式可选 |
| `Camera3D` | 多目标构图、平滑变焦、震动；使用 FOV 计算取景 | 推荐窄视角透视相机；正交相机只是可选的首版简化 |

### 回旋镖并不是预设椭圆轨迹

`Projectile.Movement` 有 `Throwing`、`Returning`、`Free`、`Dropped`、`Squished`、`Controlled` 六种状态。`Disc.StartThrow` 会将蓄力强度映射到推力、限速、飞行阶段时长和辅助追踪范围；`Player.ThrowDisc` 从近期输入方向差计算 `spinAngle`，夹在 ±90° 内。

`Disc.ApplySpin` 给运动施加侧向力；`CalculateReturn` 会随主人位置更新回归方向；`ApplyHoming` 对前方、未冲刺、无遮挡的敌人进行辅助追踪。普通半径代码值是 7，键盘玩家路径改为 11，蓄力还会继续放大。这个差异会影响键盘版手感。

`Player.Aim` 同时承担蓄力与主动召回入口，按键释放再尝试 `ThrowDisc`。无镖时能否召回还取决于是否冲刺/突进、在外镖数量、设置和强化。

### 已取得的参数与读取边界

以下为当前程序集字段初值或方法内赋值；公开/序列化字段仍可能被资源覆盖，实际动作间隔还受状态机影响。

| 参数 | 代码值 | 解释 |
| --- | --- | --- |
| `Actor.dashDuration` | 0.2 s | 冲刺力衰减窗口 |
| `Actor.dashCooldown` | 0.55 s | 冷却计时初值；`CooldownDash` 在余量小于 `dashDuration` 时即可恢复冲刺，所以不能直接声称两次输入必须间隔 0.55 s |
| `Actor.attackDuration` | 0.2 s | 近战计时初值，不等同于已经实测的全部有效判定帧 |
| `Actor.attackCooldownDuration` | 0.66 s | 攻击冷却参数 |
| `Actor.aimStartTime` / `aimDuration` | 0.1 / 0.9 s | 进入瞄准与蓄力时序参数 |
| `Disc.StartThrow` | 0.45 s | 普通投掷阶段；蓄力按 `aimPower * 0.15` 缩短，小镖另有分支 |
| `Actor.reviveDuration` | 1.68 s | 队友复活计时目标；实际进度还受触发持续性影响 |
| `Player.maxActivePowerups` | 3 | `powerupHistory` 队列上限；临时效果/场景效果不能简单计入 |

移动的 `walkSpeed=200`、`dashSpeed=660` 等字段进入施力、阻力和限速计算，不是可以直接换成 Web 像素/秒的最终速度。

### 强化系统细节

`PowerupType` 有 15 个非零标志，但 `Powerup.AllPowerups()` 只组合 14 项，排除了 `TimeImmune`。因此不能把枚举项数量当作菜单可选数量，更不能把官网展示图标数当成本地总数。

`Player.StartPowerup` 中：

- 持久强化超出 `powerupHistory` 上限时移除最早一项。
- `FireDisc` 和内部名 `SlimeDisc` 在该分支中互相替换；内部名字与面向玩家的名称需再对照本地化资源。
- `ReverseInputs` 是 6 秒临时效果；`ShrinkingBounds` 触发场景边界变化，不走相同的持久队列。
- `TimeImmune` 虽有代码路径，但不在 `AllPowerups()` 中；不能宣称普通随机池会生成它。
- `ExtraDisc` 有补充镖与激活强化两部分逻辑。

## 建议的 Web 实现

技术选择是本项目设计建议，不是原版实现事实。

- TypeScript + Vite + Three.js；三维模型与 UI 读取模拟状态。
- 二维平面约 60 Hz 固定步长模拟；优先还原原版的施力、阻尼、圆/多边形检测和扫掠碰撞。是否采用 Planck.js 等 2D 物理库，待一个测试地图验证后决定，避免默认刚体行为改变手感。
- 输入抽象统一键盘与 Gamepad API，并保留按下、按住、释放和输入缓存。
- 美术初期用可替换的简模；资源导出成功之后，再单独验证网格、贴图、骨骼、动画和材质到 Web 的转换。
- 首阶段做本地对战与机器人；独立联网同步属于新增工程范围，需要另行设计。

第一版建议限定为：一张小竞技场、一名玩家与一个机器人（随后支持本地双人），实现移动、冲刺、近战/反弹、投掷/回归/召回、死亡与回合计分，再加入护盾、加速和爆炸三种强化。验收依据是完整打完数个回合，并用原版片段对照关键时序、碰撞和视觉反馈。

## 证据与复现

本次 REA MCP 工具没有出现在当前会话中。已安装的 `rea 6.7.0` CLI 可用，`doctor --client codex --json` 报告 Codex 注册已对齐。使用现成 CLI 完成托管静态检查，没有修改 Codex 注册或安装原生反汇编引擎。

| 证据 | ID / 身份 | 文件 |
| --- | --- | --- |
| REA 托管身份 | `ev_c05f0fee6a054766734a886ffd4ce0e68e5c05f141e2ce72b9b595f9a0f07746` | `analysis/evidence/assembly-identity.rea.json` |
| REA 成员/调用信息 | `ev_1d95eea23e769c4fd53fe93d1f0568949e1ebfb3ffb60649bd28400ac83c286e` | `analysis/evidence/assembly-members.rea.json` |
| 程序集 SHA-256 | `7e5a31b96c64150455340067314538af3399b723cd11d9891a065bde2dce2a6f` | `Assembly-CSharp.dll` |
| MVID | `a3bddac1-d8a4-4072-bae6-d3434330c793` | 上述程序集 |
| C# 重建工具 | ICSharpCode.Decompiler `11.2.0.10050`，官方 NuGet 包 | `tools/ilspy/`；每次输出有哈希清单 |

`scripts/decompile-selected.ps1` 通过 ILSpy 库读取目标程序集，默认重建重点类型；没有将游戏程序集加载进 CLR 执行。反编译关闭了依赖解析失败时抛错，当前重点代码可读，但这不等于整个 Unity 工程已成功还原或编译。

`scripts/inspect-unity.py` 使用本地隔离安装的 UnityPy，读取序列化容器、资源类型和选定设置，记录来源哈希。下载的工具与原版派生内容保存在忽略目录；报告与分析脚本留在 Git 可审查范围内。

`scripts/inspect-unity-samples.py` 对完整类型树不适配的 BuildSettings 进行有边界的场景数组读取，并导出六张地图预览贴图。工具安装时 UnityPy 1.25.3 的 `tpk_ar` 依赖不可获得，最终固定使用 1.23.0；PyPI 文件下载缓慢时使用清华 PyPI 镜像获取依赖。没有将这些环境问题视为目标加密或资源损坏。

## 本轮问题状态

| 问题 | 状态 | 后续所需证据 |
| --- | --- | --- |
| 游戏是什么、核心操作和正式模式是什么 | 已回答 | 官方资料与代码相互补充 |
| 引擎和脚本是否可读、从哪里切入 | 已回答 | 本地身份与 26 个重点类型重建 |
| 能否选择合理 Web 架构 | 已回答 | 二维模拟/三维显示的代码依据 |
| 完整参数、碰撞和所有强化交互 | 部分回答 | 继续核对资源覆盖值、动画事件与各状态分支 |
| 全部地图与资源能否导成浏览器可用格式 | 部分回答 | 需单独做模型/骨骼/动画/材质与场景转换验证 |
| 原版手感是否已被复现 | 未进行 | 启动原版采样，再与 Web 原型逐项对照 |

分析只读了原安装目录；未修改游戏、存档或设置。
