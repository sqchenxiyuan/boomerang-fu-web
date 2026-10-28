# V4 最终性能与 SDK 安装包验收

最终采样：2026-10-28 15:43:08–15:45:28 UTC（北京时间 23:43–23:45）。

结论：最终硬件 Chrome 的六场景 baseline + profile 共 **12/12** 通过，全部约 **59.95 RAF Hz**，间隔 p95 **16.8 ms**，没有 >25 ms / >50 ms 间隔。同步绘制提交开销相较早期记录约减半，四人 idle 的完整世界复制从每帧 3 份减到 1 份；无变化 HUD 的文本/HTML 重写已消除。原先硬件样本本就大多接近 60 Hz，改进体现在每帧工作量和余量，不能描述成帧率翻倍。

## 证据和可比范围

- 最终原始报告：`test-results/v4-performance-final/report.json`。
- 优化前：`test-results/v4-performance/report.json`，解释见 `docs/v4-performance-baseline.md`；保留原记录，没有覆盖。
- 使用同一已安装 Chrome 154、RTX 2060 SUPER / ANGLE D3D11、1100×760、DPR 1、每场景预热 1.5 秒和采样 6 秒。控制器、地图、seed、scoreGoal 和测量口径相同。
- 最终整轮 **没有任何 src 哈希变化**；最终报告的源码哈希与 SDK build manifest 中全部打包源码匹配。所有 profile 都断言 hook 确实命中运行中的 renderer/HUD；Vite 的时间戳模块 URL 已按本页实际加载地址解析，避免钩到未使用的第二份类。
- 前后之间同时加入新道具、AI、视觉及批处理等修改，早期整轮还曾在样本间改变 effects.ts。下面是整批交付的实测对照，不是某一个优化的单变量因果实验。
- baseline 只做轻量 native RAF / 公开 onFrame 记录；profile 额外拦截 clone、DOM setter 和源码方法。函数耗时是同步包含子调用的墙钟时间，不能相加当独占 CPU 时间；WebGL 返回不代表 GPU 已完成。RAF Hz 也不代表显示器的最终呈现帧率。

复现最终一轮：

```powershell
$env:GARDEN_PERF_OUTPUT='test-results/v4-performance-final'
$env:GARDEN_PERF_PROFILE='1'
$env:GARDEN_PERF_SOFTWARE='0'
$env:GARDEN_PERF_CPU_PROFILE='0'
node scripts/v4-performance-verify.mjs
```

## 绘制和状态复制

下表均使用各自 profile 轮。draw calls 是每 30 帧抽样统计；战斗中会随实体变化。

| 场景                 | 旧 draw 均值 / p95 | 最终 draw 均值 / p95 |         旧 calls → 最终 calls | 每帧世界复制：旧 → 最终 |
| -------------------- | -----------------: | -------------------: | ----------------------------: | ----------------------: |
| 菜单预览             |     5.09 / 5.90 ms |       2.16 / 2.60 ms |                     390 → 118 |                   1 → 1 |
| 主站四人 idle        |     6.33 / 7.30 ms |       3.04 / 3.50 ms |                 442 → 168–175 |                   3 → 1 |
| 主站四 bot           |     7.20 / 8.60 ms |       3.24 / 3.90 ms | 首样本 506 → 最终范围 149–194 |                2.81 → 1 |
| 主站暂停             |     6.33 / 7.40 ms |       2.98 / 3.50 ms |                     434 → 160 |                   1 → 1 |
| SDK HUD 四人 idle    |     7.30 / 8.90 ms |       3.30 / 4.00 ms |                 442 → 168–175 |                   3 → 1 |
| SDK 四个 idle script |     6.29 / 7.40 ms |       2.97 / 3.70 ms |                 442 → 168–175 |                   7 → 6 |

主站四人 idle 的整次 RAF callback 同步均值由 7.22 ms 降为 3.58 ms；四 bot 由 8.71 ms 降为 4.03 ms。四 bot 最终样本真实记录 5 次投掷、9 次反弹、3 次死亡、1 次拾取，涵盖 playing 与 roundEnd，不是静态 renderer fixture。

SDK 四脚本仍保留共同 pre-routing baseline 和每个脚本独立观察副本，因此是每帧 6 份而非 1 份。最终 2160 次 world clone / 360 帧，累计 362 ms，即约 1.01 ms/帧；旧值约 1.09 ms/帧。由于新状态字段和玩法增加，四脚本 sessionStep 均值为 0.979 ms，高于旧 0.859 ms；不能宣称每个局部方法都更快。公开快照、脚本与 onFrame 的隔离继续验证通过。

## HUD、暂停与资源

- 主站四人 idle 的 6 秒 profile 只有 6 次 timer textContent 更新，无 center/round-label/danger 的重复文字/HTML写入；旧 center 和 round-label 各约 360 次重复写入。
- 主站暂停、SDK HUD idle、SDK 四脚本的采样窗口中，拦截到的 innerHTML/textContent setter 均为 **0 次**。这只覆盖这两类 setter，不等于所有 CSS/属性均无写入。
- 主站四 bot 的 center innerHTML 从旧 360 次降为 1 次；abilities 仍随冷却/蓄力等变化重建（最终 46 次），scoreboard 4 次，control-strip 4 次中仍有 3 次相同。这是未继续扩大修改范围的剩余工作，不影响此次通过。
- 主站 idle baseline 的 CDP LayoutCount 从旧 +363 降为 +7，LayoutDuration 从 66.2 ms/6 秒降为 1.89 ms/6 秒；SDK idle 从 +363 降为 0。主站仍有 CSS RecalcStyle，不把它和 layout 或 text/HTML 写入混为一谈。
- 暂停完整状态和 tick 不变，renderer dt=0，恢复后自然推进；暂停仍保留约 60 Hz RAF、一次世界副本及绘制，最终同步 draw 约 2.98 ms/帧。此次没有声称暂停已降为按需重绘。
- 每个场景均验证两次 destroy 不出错、canvas/HUD 移除、该游戏 RAF 帧数停止；无 page/console 错误。短样本 heap/geometry 变化不作为泄漏结论。

最终一轮没有重新运行 SwiftShader。早期软件后端的 5–7 RAF Hz 只是先前兼容性下限观察；不能用硬件最终样本宣布软件渲染也达到 60 Hz。移动端、高 DPR、显示器呈现、长时间跨地图、完整道具组合和长压力场景由其他验收覆盖，不包含在这 12 个短样本的结论里。

## SDK 0.4.0 最终安装包

- Tarball：`dist-sdk/boomerang-garden-sdk-0.4.0.tgz`。
- 大小：**80,347 bytes**；**48** 个包内文件。
- SHA-256：`eb72f4768029c4de7a7334794f524831e326e5fe88e6495d1b7d361ba06cb3c8`。
- 构建清单：`dist-sdk/build-manifest.json`。
- 实际安装验证：`test-results/sdk-package/verification.json`，`ok=true`，时间 2026-10-28 15:42:57 UTC。

从 tarball 安装到独立 consumer 目录，确认不是源目录符号链接，执行：核心禁止 DOM globals 的导入与对局、三个公开入口、NodeNext 类型检查、外部动作/TTL、脚本、人工接管和过期句柄、矩形边界与持久死亡、status/tick、14 道具枚举与含 fire/telefrag 的 DeathCause、列表校验和复制、开场真实 grant 与受限拾取池。整场机器人比赛自然 step 完成于 6737 ticks / 10 回合，比分 4:5。

安装包浏览器通过了 WebGL 挂载、extra + shield 开场发镖、外部和脚本移动、真实 D/S 键盘接管、交还脚本、onFrame 状态/数组独立性、暂停恢复与销毁；0 frameErrors、0 listenerErrors、0 page/console errors、0 failedRequests。截图 `test-results/sdk-package/browser.png` 已目视核对。

首次安装包浏览器检查曾如实失败：raw import map 只映射 `three`，新增合批模块无法解析 `three/addons/utils/BufferGeometryUtils.js`，`packageGame` 未创建。随后为 consumer 增加 `three/addons/` → `/node_modules/three/examples/jsm/`，同步更新包内 API 示例及生成 README，重新 build、重新安装和验证。上述 hash 属于修复说明后的最终包，不是首次失败包。验证脚本现在先清除旧成功状态，浏览器失败时写明实际 errors，避免读到旧验收结果。

本次没有发布 npm 或部署 GitHub Pages。主代理已重建 `dist-sdk.zip`，177,017 bytes，SHA-256 `f7f26d1476291d924b9e42c4c647f3d2f7aaae0abf4185e561d3b238c21d07e0`；已从 ZIP 读取其中的 0.4.0 tarball，确认与上述独立安装验收的 hash 一致。
