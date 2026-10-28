# V4 性能基线与诊断边界

采样日期：2026-10-28（UTC 15:02–15:09；北京时间 23:02–23:09）。

结论：这台 RTX 2060 SUPER 机器的硬件 WebGL 短样本没有持续低帧率，主要场景约 59.95 次 RAF/秒。绘制提交是测到的主要同步开销；暂停仍全速绘制，状态复制及无变化 HUD 写入是确定存在的额外工作。强制软件 WebGL 则只有约 5–7 次 RAF/秒，不能把软件后端的结果直接归因于模拟逻辑。

这份文档记录优化前样本，不宣称后续 SDK/renderer 修改已验证，也不代表原版 Boomerang Fu 的性能。

## 可复现入口

只使用已经运行的开发服务器，不启动服务、不构建、不发布、不修改 `src`：

```powershell
node scripts/v4-performance-verify.mjs
```

默认依次执行 baseline 和 profile 两轮，每个场景预热 1.5 秒、采样 6 秒。6 个场景：主站菜单预览、四人 idle、四 bot 自然对战、暂停、直接 SDK + HUD 四人 idle、SDK 四个 idle script 控制器。输入走公开 Session API，模拟只由自身 RAF 推进。

配置通过进程环境变量提供：

| 变量                      | 默认值 / 用途                                                      |
| ------------------------- | ------------------------------------------------------------------ |
| `GARDEN_TEST_URL`         | `http://127.0.0.1:5173`                                            |
| `GARDEN_PERF_OUTPUT`      | `test-results/v4-performance`；复测请用不同目录保留旧证据          |
| `GARDEN_PERF_SAMPLE_MS`   | `6000`                                                             |
| `GARDEN_PERF_WARMUP_MS`   | `1500`                                                             |
| `GARDEN_PERF_PROFILE`     | `0` 只跑轻量 baseline，否则追加计时 profile                        |
| `GARDEN_PERF_SCENARIOS`   | 逗号分隔的上述场景名，见脚本默认列表                               |
| `GARDEN_PERF_SOFTWARE`    | `1` 强制 ANGLE SwiftShader；实际后端仍以报告为准                   |
| `GARDEN_PERF_CPU_PROFILE` | `1` 增加 CDP 1 ms 采样，输出 `.cpuprofile`，明确标为 `cpu-sampled` |
| `GARDEN_PERF_HEADLESS`    | 默认真实 Chrome headless；`0` 使用可见 Chrome                      |

生产 preview 4173 可选择 `main-*` 场景；直接 SDK 和源码 prototype 计时需要开发服务器。生产 bundle 没有源码方法计时，不伪装成与开发模块完全相同的 profile。

软件对照示例：

```powershell
$env:GARDEN_PERF_SOFTWARE='1'
$env:GARDEN_PERF_PROFILE='0'
$env:GARDEN_PERF_SCENARIOS='main-idle-four,main-paused'
$env:GARDEN_PERF_SAMPLE_MS='4000'
$env:GARDEN_PERF_OUTPUT='test-results/v4-performance-software'
node scripts/v4-performance-verify.mjs
```

需要切回硬件时请清除 `GARDEN_PERF_SOFTWARE`；其他环境变量同理。

## 样本与版本

- 主报告：`test-results/v4-performance/report.json`，12/12 场景完成、无 page/console 错误；每个单独样本都通过源码稳定性检查。
- 参考 HEAD：`bf8349604fc0e690d19bd3b4ea273962fe05bc78`，工作区当时正并行开发，不能把 HEAD 当作整份样本的精确源码。报告为每个样本保存全部 `src` SHA-256。
- 主报告整轮期间 `src/rendering/effects.ts` 在样本之间改变。SDK/session/loop/UI 的关键审查文件在这些样本中一致；不可跨行宣称严格固定版本的 renderer A/B 性能提升。
- CPU 补充：`test-results/v4-performance-cpu/report.json` 和 `cpu-sampled-main-bots-four.cpuprofile`。采样中 `src/simulation/inventory.ts` 改变，标记 `sourceStable=false`；只用于诊断，排除出固定版本基线。
- 软件补充：`test-results/v4-performance-software/report.json`，2/2 场景通过；整轮源码哈希稳定。
- 1100×760 CSS 像素，DPR 1；直接 SDK 使用同尺寸容器。四人场景 `courtyard`、seed 53、local + 2 bots，然后用公开 API 设置实际控制来源。scoreGoal 50 避免短采样提前结束，比分 DOM 比产品默认 5 分多，不能把其 HUD 数据直接当作默认模式的精确成本。
- 所有报告都记录真实 WebGL renderer。浏览器是已安装 Chrome，并非 Playwright 自带的无 GPU 假场景。

## 硬件 WebGL 的轻量基线

实际后端：`ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 SUPER, Direct3D11)`。

下表是 baseline 轮；没有 clone/DOM/prototype 计时 hook，仍有轻量 native RAF 与公开 `onFrame` 记录器，因此也不是零开销硬件 benchmark。

| 场景                 | RAF 平均 Hz | 间隔 p95 | 最大间隔 | >50 ms |    采样到的 draw calls |
| -------------------- | ----------: | -------: | -------: | -----: | ---------------------: |
| 菜单预览             |       59.95 |  16.8 ms |  16.9 ms |      0 |                    390 |
| 主站四人 idle        |       59.95 |  16.8 ms |  16.9 ms |      0 |                    442 |
| 主站四 bot           |       58.62 |  16.8 ms | 133.3 ms |      1 | 首样本 506，随交战变化 |
| 主站暂停             |       59.95 |  16.8 ms |  17.0 ms |      0 |                    434 |
| SDK HUD 四人 idle    |       59.95 |  16.8 ms |  16.9 ms |      0 |                    442 |
| SDK 四个 idle script |       59.95 |  16.8 ms |  16.9 ms |      0 |                    442 |

四 bot 的 133.3 ms 间隔伴随一条 136 ms long task。诊断轮未复现同样停顿，不能仅凭一次样本断言是 GC、着色器编译或 AI 导航。该场景真实产生 5 次投掷、9 次反弹、3 次死亡，涵盖 playing 和 roundEnd，没有用静态截图代替对战。

## 同步调用与复制成本

以下来自单独的 profile 轮，hook 本身有成本；各列存在调用包含关系，不应相加成 CPU 总时间。`rendererDraw` 是 JavaScript + WebGL 提交返回之前的同步墙钟耗时，不是 GPU 完成时间。

| 场景                 | 每帧 rendererDraw 均值 / p95 | 每 tick sessionStep 均值 | 完整世界复制 / 采样帧 | 世界复制累计 / 帧 | 主站 HUD update 均值 |
| -------------------- | ---------------------------: | -----------------------: | --------------------: | ----------------: | -------------------: |
| 菜单预览             |               5.09 / 5.90 ms |                  无 step |             360 / 360 |          0.171 ms |             0.018 ms |
| 主站四人 idle        |               6.33 / 7.30 ms |                 0.238 ms |            1083 / 361 |          0.485 ms |             0.194 ms |
| 主站四 bot           |               7.20 / 8.60 ms |                 0.683 ms |            1013 / 360 |          0.548 ms |             0.251 ms |
| 主站暂停             |               6.33 / 7.40 ms |                  无 step |             361 / 361 |          0.188 ms |             0.230 ms |
| SDK HUD idle         |               7.30 / 8.90 ms |                 0.260 ms |            1080 / 360 |          0.522 ms |          无主站 View |
| SDK 四个 idle script |               6.29 / 7.40 ms |                 0.859 ms |            2520 / 360 |          1.086 ms |          无主站 View |

四 bot profile 的 sessionStep 最大 22.4 ms、rendererDraw 最大 29.9 ms；此记录能定位发生慢调用的层，不能继续细分为某一具体算法。CPU 补充样本的前列非 idle 项集中在 Three/WebGL 的 `renderBufferDirect`、矩阵、uniform 和 binding 操作，snapshot、HUD update 也可见。该 CPU 样本发生源码漂移，且采样是统计估计，不用于给首次 136 ms long task 定案。

### 优化前逐帧路径

1. `src/sdk/browser.ts:174` 的 `onStep` 调 `session.snapshot()` 只检查 status，先复制一次整个世界。
2. `src/sdk/session.ts:121` 每个 playing tick 复制 observations，即使全部是内建 bots/idle/human。
3. `src/sdk/session.ts:294` 每个脚本额外得到一份 detached observations；这是公开隔离保证，需要保留。
4. `src/sdk/browser.ts:186` 每个 RAF 再 snapshot 一次供 renderer 和外部 `onFrame` 使用。
5. `src/sdk/session.ts:448`、`:456` 另有事件队列和每监听器事件拷贝；报告将它们与 world clones 分开，不把小 step event 当成完整世界复制。

因此稳定 60 Hz 的四人 idle 是约 180 份完整世界/秒；四脚本是约 420 份/秒。公有 `snapshot()/getState()` 和不同脚本之间的隔离不能为了省复制直接取消。

## HUD 与暂停

静态审查和真实 DOM setter 计数相互印证：

- `src/ui/view.ts:203` 的比分、`:230` 的 abilities 已有 key 缓存，不能说整个 HUD 每帧全部 innerHTML 重建。
- 四人 idle：`innerHTML:center` 361 次，其中 360 次与上一次赋值完全一致；`round-label` 同样 361/360；timer 361 次、354 次重复；danger 361/360。重复文字赋值仍产生了 layout/recalc style 工作。
- 四 bot：abilities innerHTML 44 次，scoreboard 4 次；center 360 次，其中 349 次重复。数值变化时整块 abilities 重建，而非仅更新进度条。
- 暂停：center 361 次、360 次重复。暂停发生在开场后很早，presentation 仍是冻结的 GO 元素，所以不是每次都写空串；整个相同子树持续替换。完整状态 JSON 和 tick 保持不变，renderer 每次实际收到 dt=0，但仍绘制 361 帧。
- SDK HUD：score/notice/center 每项各 360 次 textContent，359 次相同。`src/sdk/browser.ts:211` 还每帧写 mask；这些 style 写入没有纳入 setter hook 的 text/HTML 次数。
- 主站四人 idle baseline 的 CDP LayoutCount +363，约每帧一次。其 LayoutDuration 66.2 ms/6 秒，RecalcStyleDuration 33.8 ms/6 秒；相较绘制同步耗时并非第一大项，仍是可去除的工作。

暂停状态正确冻结，resume 后 tick 恢复增长；每个场景 destroy 两次均移除 canvas/HUD 并停止该游戏 RAF。这里的性能问题是暂停继续花费绘制资源，不是模拟没有暂停。

## RAF 时间与软件 WebGL

`src/platform/loop.ts:26` 将 dt 上限设为 100 ms，每个 RAF 最多补 6 个固定 tick（`:32`）。暂停清 accumulator，但 `elapsed` 仍增长，RAF/onFrame 继续运行。渲染中的游戏时间取 `state.time`，死亡/粒子通过 `state.time` 差值推进，所以暂停能冻结画面状态；菜单预览使用 elapsed，符合动态景观用途。HUD toast 使用 elapsed，暂停时其墙钟到期逻辑仍可执行。

软件补充的实际后端为 `ANGLE / Vulkan / SwiftShader Device (Subzero)`，不是 NVIDIA：

| 场景          | RAF 时间戳均值 Hz | p95 间隔 | >50 ms | 4 秒窗口模拟 tick 增量 |
| ------------- | ----------------: | -------: | -----: | ---------------------: |
| 主站四人 idle |              6.93 | 150.2 ms |     28 |                    174 |
| 主站暂停      |              4.86 | 216.9 ms |     21 |                      0 |

软件后端的场景仍约 434–442 calls；进程内 ScriptDuration 只占 0.18–0.27 秒/4 秒，但 RAF 很慢。这说明只用 JavaScript CPU 计时会漏掉软件图形/合成路径和等待，不能宣称“逻辑只占很少，所以应当 60 FPS”。暂停模态还带有额外 CSS 合成效果；两个场景短样本不构成某个具体 GPU/合成阶段的因果拆分。

报告 RAF 使用浏览器传入的 RAF 时间戳；慢软件后端下时间戳可能早于 callback 实际执行。报告同时保存实际 `onFrame` 到达时刻及其间隔。RAF Hz 不是显示器上已呈现帧率、不是 GPU timer query，也不能和采样窗口帧数直接混算。100 ms cap 在软件后端高频触发，因此自然模拟会慢于墙钟；这是丢弃长停顿的策略边界，不是状态漂移或手动快进。

## 建议与验收顺序

1. 优先减少重复 draw submission：静态几何合批/实例化，效果对象复用；然后保持相同后端、尺寸、场景、源码下看 rendererDraw p95 和 calls。暂停可以在仍保留输入/生命周期响应的前提下只做必要刷新；单纯停止整个 RAF 会影响系统按键轮询和恢复，不能直接删循环。
2. 加便宜的 Session status/tick 读取，去掉仅查 status 的 snapshot。内建 bot 从会话私有权威状态读取；脚本仍拿各自 detached pre-physics state，公有 snapshot/getState/event payload 继续隔离。主站 onFrame 也不能暴露私有 state。
3. HUD 用变化检测更新 text，保留 center/abilities 元素后改文字和 style；避免不变 round-label/timer/mask 每帧写入。隐藏的 wipe 不需要持续计算渐变和读取布局尺寸。
4. 真正定位离群帧需要固定版本下复现，记录慢调用的 phase/事件或 trace；目前没有证据把单次 136 ms long task 定成某一项。提升粒子平滑度还需验证 presentation time 与 simulation time 的插值，单纯平均 FPS 不够。
5. 集成后复测同一硬件后端，再跑软件模式作为兼容性下限；任何软件优化结论必须说明 CPU 图形后端，不和硬件结果直接作为同一种 FPS 对比。

脚本不设置“必须 60 FPS”的断言。它只断言自然帧/模拟进展、暂停状态、恢复和资源销毁正确；低性能值本身写入报告供比较。当前不覆盖移动端/高 DPR/实际显示器呈现、完整 14 道具交战、最终安装 SDK 包、长时间跨地图 soak、原游戏运行或逐像素比较。内存 heap/Nodes 增减受 GC 和采样缓存影响，短窗口增长不能单独证明泄漏。
