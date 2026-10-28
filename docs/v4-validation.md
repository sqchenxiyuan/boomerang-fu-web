# V4 验收：道具、开场武器与流畅特效

本轮保留用户选择的原版时序：进入 Playing 后 1.2 秒自动发镖。界面显示剩余时间，授予时播放提示音、出现就绪提示和装备效果。普通对局不需要先在地上找武器。

只更新本地站点与 SDK；GitHub Pages 仍关闭，没有自动部署工作流。以后用户明确要求部署时再发布。

## 功能范围

- 14 种正式效果均进入真实模拟：shield、haste、explosive、wallDash、reverse、multi、teleport、fire、extra、ice、disguise、controlled、shrink、decoy。
- 3 个持久槽按获得顺序替换；反向输入持续 6 秒，缩圈立即触发，二者不占持久槽。火冰互斥，失去强化时清理对应状态。
- 双镖按武器库存计数，分裂镖按武器组回收，不能靠拾取重复道具或多个碎片无限增殖。分裂通常 5 片，火/爆组合为 4 片。
- 火焰地面、燃烧、冰面、减速、冻结、按键破冰、伪装、穿墙冲刺、传送碰撞、遥控范围、诱饵都有实际规则。
- 配方书从完整普通池抽取。主菜单的“14 种道具 · 组合试验”可选择最多三种开场效果，全员走同一授予流程；后续配方书限定在所选池内。普通“进入花园”恢复完整随机池。
- SDK 0.4.0 增加 `powerupPool`、`startingPowers`、轻量 `status`/`tick`，保留快照隔离、输入 TTL、所有权与暂停语义。

## 性能改动

- 瞬态颗粒/环/贴花改用固定容量实例批次，清空与 GPU 释放分开；静态场景按材质合并，保留可破坏物和动画对象。
- 飞镖对象复用；连续拖尾、蓄力环和挥砍弧线按模拟时钟采样，传送/新回合/时间倒退时清历史。
- 地面区域、角色状态及诱饵可见；有效伤害区域必须有可见的地面标记，装饰颗粒数量可以受预算限制。
- 内部只读生命周期属性不再复制整个世界；普通机器人 tick 不创建额外观察副本；用户脚本仍各自收到独立副本。
- HUD 文本与 HTML 在内容变化时更新；过场缩放/透明度单独更新。暂停仍保留渲染循环以支持尺寸变化，不能宣称暂停零 CPU。

## 验证入口与证据范围

单元测试覆盖每种正式效果以及双镖/分裂/火冰/盾/传送等组合；多地图、多种子完整机器人对局检查存活计分和库存上限。

`scripts/v4-browser-verify.mjs` 用真正的 BrowserGame、键盘和公开 Session 控制接口验证菜单配方、1.2 秒装备、火焰分裂、遥控、传送、伪装、诱饵、反转到期、真实移动拾书与暂停。它不注入模拟状态，不额外推进浏览器实例的时钟。报告保存全部源文件前后哈希。

`scripts/render-visual-verify.mjs` 的图片是隔离的合成表现样本，用于检查效果可见性，不能作为正常玩法路径证据。

性能基线见 `v4-performance-baseline.md`；武器基线另使用冻结源码保留在忽略目录 `test-results/weapon-perf/baseline-source`。Chrome 的 CPU 绘制指标包含 JS 和 WebGL 提交，不能称为纯 GPU 时间；自然机器人对战的事件分布会随规则变化，重复效果夹具更适合比较绘制开销。

## 最终验收结果

2026-10-28 本机验收完成。最后一轮浏览器检查和渲染复测使用冻结的最终 `src`；SDK 构建清单中的源码哈希也逐一匹配。仅 V3 检查脚本改为读取实例批次的实际可见粒子数量，生产源码未为测试修改。

| 检查 | 结果 | 本地证据 |
| --- | --- | --- |
| `npm test -- --reporter=dot` | 16 文件、174 项通过 | 单元、跨地图完整对局、SDK 与渲染生命周期 |
| `npm run format:check` | 通过 | 另检查了最后更新的 V3 脚本 |
| `npm run build` | TypeScript + Vite 通过 | `dist/`；Three.js 大 chunk 提示仍存在 |
| `npm run test:browser` | 17 项通过、0 错误 | `test-results/v2-browser/verification.json` |
| `npm run test:sdk-browser` | 10 项通过、0 错误 | `test-results/sdk-browser/verification.json` |
| `npm run test:v3-browser` | 9 项通过、0 错误 | `test-results/v3-feedback/report.json` |
| `node scripts/v4-browser-verify.mjs` | 8 项通过、0 错误、源码未变 | `test-results/v4-gameplay/report.json` |
| `node scripts/production-smoke.mjs` | 正式游戏和 SDK 演示通过、无外部请求 | `test-results/production-verification.json` |
| 独立 SDK 安装消费 | Node、类型、真实浏览器控制全部通过 | `test-results/sdk-package/verification.json` |
| 最终 SDK/UI 性能 | 6 场景 × baseline/profile 共 12 项通过 | `test-results/v4-performance-final/report.json` |
| 最终自然对战 + 合成渲染压力 | 0 错误、源码未变 | `test-results/weapon-perf/final/report.json` |

V3 首次回归在旧粒子对象树读取处失败；更新为检查具名 InstancedMesh 及其 alpha 后完整重跑，五种死亡变体仍有可见粒子、不同画面，时间回退的像素一致性与重复 reset 资源稳定检查继续通过。没有跳过原断言。

本机 RTX 2060 SUPER / Chrome 的四人 idle 绘制同步均值从 **6.33 ms 降为 3.04 ms**，世界复制从 **3 次/帧降为 1 次/帧**。最终同输入合成效果压力夹具的 draw p50 **9.30 → 3.10 ms**、p95 **11.00 → 3.60 ms**，draw calls **691 → 162**。此前已接近 60 Hz，收益体现为提交开销下降；独立自然对战样本仍有一次约 71.3 ms 间隔，不能宣称所有场景完全无慢帧。完整口径与局限见 `v4-performance-after.md`、`render-performance.md`。

本地正式预览：<http://127.0.0.1:4173/>。新版菜单的配方组合入口和实际对局截图已目视核对。正式产物没有开发调试钩子，游戏与 SDK 演示均无 frame/listener/browser 错误。

## SDK 产物与源码绑定

- SDK：`@boomerang-garden/sdk@0.4.0`，tarball **80,347 bytes**，SHA-256 `eb72f4768029c4de7a7334794f524831e326e5fe88e6495d1b7d361ba06cb3c8`。
- 已更新仓库交付文件 `dist-sdk.zip`：**177,017 bytes**，SHA-256 `f7f26d1476291d924b9e42c4c647f3d2f7aaae0abf4185e561d3b238c21d07e0`；ZIP 内的 0.4.0 tarball 与独立安装验收的包哈希一致。
- 最终渲染报告中 `sourceAfter` 对象经 `JSON.stringify` 后的 SHA-256：`9f5cb05b234da632a955f0af367a2b55dea766276c409172a0ec75081eb8f41f`。其中所有源码均与当前文件逐一核对。
- 汇总审计：`test-results/v4-final-audit.json`；完整逐文件清单见 `dist-sdk/build-manifest.json` 和最终渲染报告。报告与截图留在本机忽略目录，SDK ZIP 随源码提交。

## 原版一致性边界

原版未运行；原版参数和调用关系来自本地 CIL 与 Unity 资源静态证据，详见 `v4-powerups-analysis.md`。Web 是可玩复刻，未宣称逐帧等价。

- 使用原创模型、地图与音效，人物外观和地形并非原版资源导入。
- 飞镖动力学、碰撞和遥控转向为 Web 模拟；保留空间缩放 0.4、固定步长与可重放输入。
- 爆炸当前在爆点即时采样伤害；没有精确重现原版不同 prefab 的持续伤害窗口。火/冰爆留下的地面效果另按区域计时。
- 爆炸销毁及传送收回的库存立即恢复；未精确复刻原版各路径的补发协程等待。
- 地面火/冰按圆形区域近似原版 CellManager；诱饵的路径决策是确定性的 Web AI。
- 正常书籍在生成时显示具体强化，原版在拾取时选择；Web 仍保留反向输入的概率覆盖和正式道具分类。
- 隐藏 TimeImmune 不在正常 14 项列表，本轮没有添加；其他对局模式、联网和全部原版角色不在本轮范围。
