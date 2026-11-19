# 无头 Agent 模式（与 MUNDI Godot 接口对齐）

MUNDI 平台接 Godot 版 Boomerang Fu 时，用的是 `arkena.game.v1` 协议。本地 CLI 也走同一套接口，以无头方式运行 Godot，让 `decide(observation, memory)` 策略对打。Web 版现在实现了同一套接口：观察字段、动作字段、单位、决策节奏、按住和松开的语义、策略沙箱限制都一致。同一个策略文件可以不改一行，在两边运行。

两边是不同的引擎。Web 版的物理参数参照 Godot 参考值，但浮点结果不逐位相同，所以成绩和录像不能跨引擎混用。引擎标识是 `boomerang-garden-web-0.10.2-agent.1`，按这个标识隔离。

## 快速开始

```sh
npm ci
npm run agent -- init my-agent                    # strategy.js、baseline.js、seeds.json、AGENTS.md
npm run agent -- check my-agent/strategy.js       # 沙箱编译，并跑一小局冒烟
npm run agent -- test my-agent/strategy.js --opponent bot:hard
npm run agent -- batch my-agent/strategy.js --games 20 --opponent house --jobs 2
npm run agent -- compare my-agent/baseline.js my-agent/strategy.js --seeds 9000,9001,9002,9003,9004
npm run agent -- replay runs/test-…/s1-seat0.replay.json
npm run agent -- contract                         # 输出 JSON 契约，可直接交给代码助手
```

`npm run agent` 先用 esbuild 把 CLI 打包到 `dist-agent/boomerang-agent.mjs`，再运行它。也可以单独执行 `npm run build:agent`，然后直接用 `node dist-agent/boomerang-agent.mjs …`。

**对手**：可以是策略文件，也可以是内置的：

- `starter`：入门策略，不闪避，总是长蓄力。
- `house`：中等策略，会侧移闪避，近距离点投，远距离蓄力。
- `bot:easy|normal|hard|impossible`：Web 自带的机器人，按同样的每 6 帧节奏决策，转成同样的动作格式。注意它读取完整模拟状态，不只是 observation。

**输出**：每局都写这些文件：

- `*.result.json`
- `*.replay.json`：动作日志加每次决策后的帧哈希，`replay` 命令会逐帧重算并核对。
- `*.web-replay.json`：`test` 默认生成，`batch`/`compare` 加 `--web-replay` 才生成。在游戏里打开「音乐 · 历史回放 · 倍速」→「导入录像」选中它，就能在回放工作台里观看。
- `*.trace.jsonl`：加 `--trace` 时生成，记录每次决策时双方收到的完整观察和返回的动作。

`batch`/`compare` 的每个种子都会让双方各坐一次 0 号和 1 号席位。`compare` 以种子为单位做配对比较；少于 5 个完整种子时会注明证据不足，也不会自动采用候选。`Ctrl-C` 取消时，已完成的对局会保留。`--jobs` 默认 1、最多 4，同时不超过 CPU 核数的一半；如果可用内存不够，或者负载超过 80%，就会降级或拒绝并行。

## 接口对齐表

| 项目 | Godot 适配器（MUNDI） | Web 无头模式 |
| --- | --- | --- |
| 协议 | `arkena.game.v1`：reset / observe / step / snapshot / dispose | 相同；`serve` 以 JSON 行提供，外加本地运行器的 `advance` |
| 本地驱动 | `mundi.local.v1`：子进程回连 `MUNDI_LOCAL_PORT`，发 `{hello, token, engine}`，处理 reset / advance / snapshot / quit | `serve --connect` 行为相同，返回 `{frame, observations}`；未知方法返回 `Unknown local runtime method` |
| 时间 | 60 Hz 固定帧；每次 step 精确推进 1–6 帧，不会自己往前走 | 相同 |
| 决策节奏 | 每 6 帧一次，动作在这 6 帧内保持不变；每次推进都会决策，包括回合间隙 | 相同 |
| 动作 | `{moveX, moveY, aimX, aimY, throw, dash, melee}`；数值截断到 [-1, 1]，布尔值缺省为 false，未知字段忽略 | 相同（`normalizeAction` 与平台的 `action()` 规则一致） |
| throw | 为 true 时按住蓄力；从 true 变 false 时只在该块第一帧松手一次；一直为 true 不会投出 | 相同 |
| dash / melee | 为 true 的每一帧都发一次请求，由冷却和 0.25/0.35 s 输入缓冲决定是否生效 | 相同 |
| aim | 每帧开始前把朝向直接设为 aim（要求存活、不在坠落、未眩晕）；之后转身逻辑仍会每帧把朝向向最后移动方向拉回约 20%；**飞镖沿最后移动方向飞出**，不是 aim 方向 | 相同（`Command.aim` + `applyAim`） |
| 坐标 | Unity 世界单位，Y 向上 | 相同：Web 内部坐标除以 0.4，并把 Y 取反 |
| self/opponent | id, x, y, vx, vy, alive, state(0/1/2), discs, aimX, aimY, canDash, aimPower, stunned, frozen, visible, inPlants, inBounds, burnt, powers(位掩码), character, pose, clip, clipTime | 同名同义。不提供 Godot 的渲染字段 pose / clip / clipTime |
| projectiles | owner, x, y, vx, vy, grounded, pose, spin, overlay | owner, x, y, vx, vy, grounded；没有主人的公共飞镖 owner 为 -1 |
| arena.rays | 16 个方向，用角色半径做圆形扫描，最远 5；clearance 是到碰撞点的距离；safe 检查 2 个单位外的点是否在坑洞上方、是否越界 | 相同 |
| arena.path | 原生寻路图上的最多 16 个路径点，每 30 tick 刷新，走到 1.5 以内跳过该点 | 相同规则，路径来自 Web 寻路图 |
| arena.boundary | center, size（全尺寸）, angle（度）, roundSeconds, suddenDeathSeconds=60, shrinking, suddenDeath | 相同；平台模式的缩圈时间设为 60 s |
| 地图 | 原版 `OriginalMatchPlaylist`：两人 DeathMatch、无 DLC、不含教程；Mono System.Random 洗牌，前三张优先简单图 | 相同算法。对种子 1、7、42、123456、2147483647、2147483648、3000000000、4294967295 逐张比对，结果一致 |
| 模式 | round：一局，目标分 1，停表即结束；match：14 分净击杀，回合间换图 | 相同。结束原因为 `score` 或 `round`；整盘在本回合停表、有人达到目标分时就结束 |
| 角色 | Avocado, Watermelon, Bread, Banana, Milk, Coffee，两人不同 | 校验规则相同，原样写回帧和观察；只影响外观，Web 渲染仍用自己的角色形象 |
| 上限 | 每局 108000 tick；到上限不判胜负 | 相同（状态记为 `tick-limit`，winner 为 null） |
| 策略沙箱 | QuickJS（quickjs-emscripten 0.32.0）：8 MB 内存、每次决策 30 ms、代码不超过 24 KB、返回的 JSON 不超过 8 KB、没有 Date、Math.random 用种子初始化（seed + 席位）、memory 必须是对象 | 相同实现方式和版本 |

### 保留差异

- 物理按 JS 双精度计算，Godot 按 float32 计算。轨迹和成绩不能跨引擎比较；录像只能在同一引擎标识下重算。
- Web 模拟本身在不同 JS 引擎间逐位一致：三角函数用 `src/core/dmath.ts`，不依赖各引擎末位不同的 `Math.sin/cos/atan2/acos`。Node CLI 生成的录像可以在浏览器里逐帧重放。
- 回合开场与回合结束的时长沿用 Web 的演出时间，Godot 的过场帧数不同，所以 tick 计数不同。
- `pose`/`clip`/`clipTime`/`camera` 这些 Godot 渲染字段不提供。需要画面时导入 `*.web-replay.json`。
- Web 机器人（`bot:*`）不是 MUNDI 的 QuickJS 陪练脚本，而是 Web 自己的 AI。它读取完整状态，难度档位也不对应 MUNDI 的 house / house_hard / house_impossible。
- MUNDI 的 CLI 只接受 Godot 引擎标识，并用 Godot 专用规则校验录像。要让 MUNDI 运行器调用这个引擎，需要在平台侧登记新的引擎标识和录像格式。协议本身不用改。

## 嵌入其他语言或训练环境

`serve` 在标准输入输出上提供 JSON 行接口。第一行是 hello，之后每行一个请求：

```json
{"hello":"mundi.local.v1","protocol":"arkena.game.v1","engine":"boomerang-garden-web-0.10.2-agent.1","tickHz":60,"decisionTicks":6}
{"id":1,"method":"reset","params":{"seed":42,"mode":"round","characters":["Banana","Coffee"]}}
{"id":2,"method":"advance","params":{"actions":[{"moveX":1},{"throw":true}]}}
{"id":3,"method":"step","params":{"actions":[{},{}],"frames":3}}
{"id":4,"method":"observe","params":{"player":1}}
{"id":5,"method":"snapshot"}
{"id":6,"method":"dispose"}
```

`reset` 和 `advance` 返回 `{frame, observations}`；`step`、`snapshot` 返回帧，`observe` 返回观察；出错时返回 `{id, error}`。用 Python 等语言做强化学习或批量评测时，可以直接把它当作一个子进程环境。

TypeScript 代码也可以直接用 `src/agent/runtime.ts` 里的 `AgentRuntime`。它不依赖 DOM，录像通过 `record: true` 打开。

## 实现位置

| 文件 | 内容 |
| --- | --- |
| `src/agent/contract.ts` | 协议常量、动作规范化、观察与帧的类型、给策略作者的说明 |
| `src/agent/playlist.ts` | Mono System.Random 与原版地图队列 |
| `src/agent/runtime.ts` | reset / observe / step / snapshot、坐标换算、射线、路径、结束判定、可选的 Web 录像 |
| `src/agent/sandbox.ts` | QuickJS 策略沙箱 |
| `src/agent/strategies.ts` | 内置 starter / house 策略，以及 Web 机器人的动作适配 |
| `src/agent/match.ts` | 单局运行、动作日志、帧哈希与重算校验 |
| `src/agent/cli.ts` | 命令行、并行、`serve` 两种传输方式 |
| `src/simulation/actors.ts` `applyAim`，`src/core/types.ts` `Command.aim`、`MatchOptions.mapPlaylist` | 模拟层只加了两项可选输入；普通对局和旧录像的行为不变 |

## 验证

- `tests/agent-runtime.test.ts` 覆盖：
  - 动作规范化规则；
  - 地图队列与参考队列一致；
  - 沙箱：没有 Date、随机数用种子初始化、超时、返回值过大、缺少 decide；
  - 坐标单位和观察字段；
  - 蓄力与松手边沿；
  - aim 只改朝向，飞镖沿最后移动方向飞出；
  - 按住 dash 时，冷却结束会自动再次冲刺；
  - round 模式结束；
  - 整盘按队列换图，到 tick 上限不判胜负；
  - 确定性、篡改检测、Web 录像能在回放播放器里播放到同一终点。
- 本机实测（4 核）：
  - 单回合约 0.1–0.5 s。
  - house 对 `bot:normal` 的一整盘（24 回合，模拟时长 235 s）用时约 5.7 s，约为实时的 41 倍；重算校验约 0.8 s。
- 用模拟的 MUNDI 运行器测了 `serve --connect`：握手和令牌校验、整局 reset/advance、未知方法、quit 全部通过。
- 用 headless Chromium 导入 CLI 生成的 `*.web-replay.json`：游戏直接进入回放工作台播放，回合事件和地图切换正常，控制台没有错误。
