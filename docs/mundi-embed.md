# MUNDI 嵌入页

MUNDI 平台把游戏放进同源 iframe，通过 `arkena.game.v1` 协议驱动。Godot 版在 mundi-web 的 `src/game/host.js` 里实现游戏侧；这个仓库的 `mundi.html` 是 Web 引擎的对应实现：没有菜单，所有操作都来自平台。

## 构建

```sh
npm run build:mundi
```

输出 `dist-mundi/<引擎标识>/`，例如 `dist-mundi/boomerang-garden-web-0.10.2-agent.1/`：

| 文件 | 内容 |
| --- | --- |
| `index.html` | 嵌入页入口，所有资源用相对路径，放在任意目录下都能运行 |
| `assets/*` | 带内容哈希的 JS/CSS，其中 Three.js 单独分包 |
| `SOURCE.json` | 引擎标识、协议、源码仓库与提交、工作区是否有未提交改动、每个文件的 SHA-256，以及本地运行时（`runtime.file` / `sha256`） |

同一次构建还输出 `dist-mundi/<引擎标识>.local-runtime.mjs`：MUNDI 本地 CLI 与中心批量执行器启动的 Node 运行时。它只实现 `mundi.local.v1`：回连、令牌握手，`reset` / `advance` / `snapshot` 返回 `{frame, observations}`，以及 `quit`；不含策略沙箱，也不读写文件。它的 SHA-256 记录在 `SOURCE.json.runtime`，平台导入时把它固定到 `game-source/<引擎标识>/local-runtime.mjs`。浏览器游戏和运行时因此来自同一个提交；模拟跨 JS 引擎逐位一致（`src/core/dmath.ts`），两边的帧完全相同。

平台把整个目录原样复制到 `/games/<引擎标识>/`。目录发布后不可修改：模拟有任何变化，都必须换新的引擎标识（`src/sdk/recording.ts` 的 `SIMULATION_VERSION` 或 `src/agent/contract.ts` 的适配器后缀），否则旧录像无法重算。正式发布用的构建应在干净工作区完成（`SOURCE.json` 里 `dirty: false`）。

## 协议

由 `src/mundi/host.ts` 的 `MundiHost` 实现，不依赖 DOM。校验规则和报错文字与平台的 Godot 宿主一致。

| 项目 | 行为 |
| --- | --- |
| 加载 | 页面就绪后向父页面发 `arkena:ready`；出错时发 `arkena:error`。父页面发 `arkena:connect`（同源、协议和引擎标识一致、带一个 MessagePort）后，回 `{id:0, result: manifest}` |
| manifest | `protocol, engineId, tickHz:60, directRunner, preparedReset, pacedStep, observations, stepObservations, presentEnding`，以及 Web 扩展 `appearance` |
| `reset` | `seed` 为整数（平台用 uint32），`mode` 为 `round` 或任一 `match*`（统一按 `match` 运行，局数和目标分由平台判定），`characters` 可选，两名不同的原版角色 |
| `observe` / `observations` | 单个或两个玩家的观察，字段同无头模式 |
| `step` | 1–6 帧，立即执行 |
| `pacedStep` | 1–6 帧，速度为 1、1.25、1.5、2、4 或 8 倍，按真实时间推进；`observations:true` 时把下一次决策的观察一并返回 |
| `replay` | 1–30 个动作对，每个推进 6 帧，返回每次决策后的帧 |
| `snapshot` | 当前帧 |
| `presentEnding` | 出结果后，不再接受输入，按真实时间播放最多 240 帧收尾演出（回合结束 → 胜利），然后停留 750 ms，供平台录完整视频；结果不变 |
| `audio` | 开关声音，返回 `{phase, enabled}`，并通过 `arkena:audio` 通知父页面 |
| `appearance` | Web 扩展，仅影响显示：`{players: [look\|null, look\|null]}`。look 为 `{name, hue?, img}`（玩家画的 Agent，PNG/WebP data URL，体素化成头部），或 `{name, hue?, seed}`（MUNDI 默认形象：与平台 `agent-world.js` 相同的种子 5×5 对称脸加熊耳，见 `src/mundi/identity.ts`）。收到后重建角色模型，并在头顶名牌和比分条显示玩家名；不进录像，也不影响结果 |
| `match-seven` | 与平台的 SevenScore 一致：所有回复里的帧和观察的比分下限为 0（回合结束时扣分本来就会清零）；模拟和录像动作不变 |
| 暂停 | `{control:'pause', paused}` |
| 直连运行器 | `connectRunner` 传入第二个端口，策略 Worker 直接发 `observations` / `pacedStep`；其他命令在该端口上被拒绝。`detachRunner` 断开并暂停 |
| 并发 | 同一时间只执行一个命令，重叠的命令返回 `Game command already in flight` |
| `dispose` | 回复后释放渲染、声音和模拟 |

平台的录像器还会直接读取嵌入页的两个对象：`#canvas`（画面）和 `window.BFAudio.capture()`（返回含音轨的 `MediaStream`，取自限幅器之后的总输出）。嵌入页都提供了。平台在自己的帧里用 `drawImage` 复制 `#canvas`，所以嵌入页的 WebGL 画布开启了 `preserveDrawingBuffer`；不开时读到的是已清空的缓冲，录出来的复盘视频是全黑的。

## 模拟与显示

- 模拟用 `AgentRuntime`，与无头 CLI（`npm run agent`）是同一份代码，所以浏览器里实时对局的每一帧与 CLI 重算结果逐字段相同（`tests/mundi-host.test.ts` 验证）。
- 实时节奏由 `src/mundi/pacer.ts` 控制：按墙钟时间累计帧额度（每秒 60 帧 × 速度，最多累计 2 秒），暂停或标签页隐藏时清零；4 倍速以下每批至少 ⌈速度⌉ 帧，4 倍速及以上整批推进。
- 画面复用游戏渲染器，默认像素风；地址加 `?style=standard` 切换到普通画风。抬头显示只有比分、回合、倒计时与回合结束提示、缩圈提示和转场遮罩。
- 默认外观：1P 红豆、2P 紫影。平台传入的原版角色名（Avocado 等）照常校验、写回帧和观察，但不改变外观；玩家自己的 Agent 由平台通过 `appearance` 传入（画像或 MUNDI 种子形象）。
- 声音默认关闭，由平台的声音按钮打开（浏览器自动播放规则要求用户操作）。

## 验证

- `tests/mundi-host.test.ts`：manifest；reset/step/速度/回放批次的校验；实时推进与 CLI 逐帧一致（含 `observations:true`）；直连运行器端口只允许观察和推进；重叠命令被拒绝；暂停后不推进；`presentEnding` 不改变结果；`appearance` 与声音开关。
- 本机 headless Chromium（软件渲染）：用平台对游戏文档的同一套响应头（CSP、COOP/COEP、`X-Frame-Options: SAMEORIGIN`）提供构建目录，父页面按平台流程握手：
  - 3.6 s 就绪；
  - `match-seven` reset 后连续 60 次 1 倍速 `pacedStep`，实测 58.6 tick/s；
  - `#canvas` 与 `BFAudio.capture()` 的音轨可用；
  - 控制台无错误。
