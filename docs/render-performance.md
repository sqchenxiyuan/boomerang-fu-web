# V4 渲染优化与表现验证

2026-10-28，本机 Chrome 硬件 WebGL 的同一合成事件夹具中，绘制提交耗时 p50 从 9.3 ms 降为 3.4 ms，p95 从 11.0 ms 降为 4.2 ms；draw calls 从中位数 691 降为 162。这个结果支持“合批和复用减少渲染提交成本”，不等于 GPU 时间下降同样比例，也不证明所有设备稳定 60 FPS。

本报告前半保留渲染分支集成时的样本；文末追加最终规则补丁后的复测及完整源码哈希绑定，不把不同版本的测量混为一次运行。

## 采样条件与证据

- 硬件后端：`ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 SUPER, Direct3D11)`；真实安装的 Chrome headless。
- 视口 1280×800，DPR 1；相同设备、场景 seed 41、courtyard。测试时与其他浏览器性能任务错开，单独使用 GPU。
- 基线运行冻结代码：`test-results/weapon-perf/baseline-source/`，端口 5176；报告 `test-results/weapon-perf/baseline/report.json`，采样时间 UTC 15:00:06。
- 基线当时关键文件哈希：`test-results/weapon-perf/baseline-hashes.json`；从保留冻结目录生成的完整清单：`test-results/weapon-perf/baseline-source-manifest.json`。完整清单是事后对冻结副本求哈希，不伪装成原采样时生成。
- 优化样本：`test-results/weapon-perf/optimized/report.json`，端口 5173，UTC 15:30:48；报告含全部 `src` 的 before/after SHA-256，`sourceStable=true`，页面及控制台错误为零，SDK `frameErrors=0`。
- 脚本：`scripts/render-perf-verify.mjs`。最初基线脚本只捕获 pageerror；优化复测另外捕获 console error，包含 WebGL shader 报错。不能把新增检查反推为基线已执行。

`drawCpuMs` 是 `GameRenderer.draw()` 调用从开始到返回的同步墙钟耗时，包含 JavaScript、Three.js 和 WebGL 提交，未使用 GPU timer query。帧间隔来自 JavaScript callback 到达时刻，含采样 hook 的影响，不是显示器实际呈现计数。`geometries` 是 Three.js 已登记的 GPU geometry 数量，不是字节数或 JS heap。

## 同输入的合成事件压力夹具

四个站立角色，每 6 帧在角色位置依次发出 explosion、deflect、pickup、dash，连续 240 帧；前 60 帧预热，后 180 帧统计。两次使用同一事件时序和状态构造，隔离了 bot 行为差异。效果实现本身已改变，因此它是同输入渲染对比，不是逐像素相同帧的 A/B。

| 指标                    |         冻结基线 |           优化后 |
| ----------------------- | ---------------: | ---------------: |
| draw 同步耗时 p50       |          9.30 ms |          3.40 ms |
| draw 同步耗时 p95       |         11.00 ms |          4.20 ms |
| draw 同步耗时均值       |          9.28 ms |          3.46 ms |
| draw calls p50 / p95    |        691 / 716 |        162 / 162 |
| geometry 数 p50 / p95   |        678 / 703 |        154 / 154 |
| callback 间隔 p50 / p95 | 16.70 / 16.80 ms | 16.70 / 16.80 ms |

优化后的整个 180 帧统计窗固定为 162 calls、154 geometries，粒子持续生成和消失期间没有 geometry 数波动。两次 callback 间隔都约 16.7 ms；本次改善是为 CPU 绘制提交留下更多余量，不能称为帧率从低帧升到 60。

## 自然 bot 对战的描述样本

通过公开 BrowserGame 创建四人对局，再通过公开 Session 控制 API 把四名角色切换为 bot。预热 3 秒，测量 12 秒，未手动推进模拟。基线与优化版之间，14 道具和战斗规则也在整合，交战序列并非相同，以下不用于计算严格的渲染因果收益。

| 指标                       |          冻结基线 |           优化后 |
| -------------------------- | ----------------: | ---------------: |
| 测量帧 / 事件              |          713 / 31 |         716 / 28 |
| draw 同步耗时 p50 / p95    |    6.10 / 7.90 ms |   3.00 / 3.90 ms |
| draw calls p50 / p95       |         434 / 516 |        146 / 183 |
| geometry 数最大值          |               655 |              256 |
| callback 间隔 p95 / 最大值 | 18.70 / 137.60 ms | 17.40 / 72.40 ms |
| draw 同步耗时最大值        |         127.40 ms |         58.50 ms |

两次都有离群慢帧，短样本不足以把其原因定为 GC、shader 编译或某个规则。基线 snapshot hook 测到 1432 次调用，p50 0.2 ms；优化版 SDK 内部已改变读取路径，该 hook 调用次数为零，不能据此宣称状态复制成本为零。公开状态隔离及 SDK 整体优化由独立 SDK 测试负责。

## 实现与生命周期

- 静态场景按材质、阴影标志与属性布局合并。水、旗帜、传送门、障碍对象引用保留；每个障碍内部单独合并，破坏显示仍能切换。带子节点的 Mesh 不被整体移除，避免误删动画后代。
- 事件与死亡特效使用三个固定 InstancedMesh。事件只新增有上限的 JS 记录，不为每个粒子创建 geometry/material。`clear()` 清空实例计数，`dispose()` 最终释放缓冲和材质。
- 武器使用三个固定批次：连续短尾迹、蓄力环、双层近战弧光。每条尾迹最多 32 个采样点、保留约 0.2 秒；暂停不继续采样，飞镖传送、跨回合、消失或丢落会清理历史。
- 元素与状态使用四个批次。地面有效区域与装饰粒子分开预算：surface 上限 4096，rim 额外预留 16 个状态环；火焰装饰 768、冰晶装饰 256。大冰爆可以牺牲装饰密度，不能因为装饰限额隐藏地面危害。根任务把相同区域上限作为规则常量，并在超出时淘汰最老危害。
- 飞镖模型最多保留 32 个空闲对象供复用；分身仅克隆场景节点，借用角色 geometry/material/texture。分身移除只解除节点引用，角色销毁前先移除借用者。
- 角色增加双持、木箱伪装和冰冻包裹表现。`shrink` 仍是战场边界收缩，不改变角色体型。

相关测试：`npx vitest run tests/render-batches.test.ts tests/death-visuals.test.ts`，本次 17/17 通过；TypeScript 检查通过。覆盖实例容量与缓冲复用、独立 renderer 的隔离、600 次爆发有界、静态合并变换与动画引用、共享 geometry 生命周期、暂停采样一致性、传送尾迹清理、状态读取不变更世界、450 个冰区全部具备 surface/rim，以及既有死亡轨迹和淡出。

## 视觉证据与复跑

`scripts/render-visual-verify.mjs` 生成三个明确标注“合成渲染夹具”的近景；原始截图和报告保存在 `test-results/v4-rendering/`：

- `weapons.png`：蓄力、近战弧光、双持、元素色尾迹与分裂小镖；26 个尾迹段、4 个提示环、2 个斩击弧。
- `elements.png`：燃烧、冻结、火面和冰面。
- `statuses.png`：伪装、反向操作、遥控和一个同型分身。

三张已人工查看，page/console errors 为空；重复冻结帧不会修改输入状态。截图直接构造表现状态、使用近景相机，不能证明道具经正常拾取生效或操作手感。真实公开 SDK、键盘、初始道具与拾取路径由 `scripts/v4-browser-verify.mjs` 单独验证。

```powershell
$env:GARDEN_TEST_URL='http://127.0.0.1:5173'
$env:GARDEN_TEST_OUTPUT='test-results/weapon-perf/final'
node scripts/render-perf-verify.mjs
$env:GARDEN_TEST_OUTPUT='test-results/v4-rendering-final'
node scripts/render-visual-verify.mjs
```

性能脚本读取当前工作区 `src` 求哈希；如测冻结目录，应同时设置 `GARDEN_SOURCE_ROOT` 指向对应目录，不能把当前源码清单套到其他服务。脚本不启动服务器、不发布、不修改生产源码；开发测试使用 5173，用户正式预览使用 4173。

## 最终源码复测

2026-10-28 15:53:44 UTC 完成最终串行复测，报告 `test-results/weapon-perf/final/report.json`；`sourceStable=true`，page/console errors 为空，真实 BrowserGame `frameErrors=0`。最终 SDK 构建清单与此次全部打包源码逐一匹配。`sourceAfter` 对象 JSON 的 SHA-256 为 `9f5cb05b234da632a955f0af367a2b55dea766276c409172a0ec75081eb8f41f`。

| 指标 | 冻结基线 | 最终合成压力样本 |
| --- | ---: | ---: |
| draw 同步 p50 / p95 | 9.30 / 11.00 ms | 3.10 / 3.60 ms |
| draw 同步均值 / 最大 | 9.28 / — ms | 3.09 / 4.00 ms |
| draw calls p50 / p95 | 691 / 716 | 162 / 162 |
| geometry p50 / p95 | 678 / 703 | 154 / 154 |
| callback 间隔 p50 / p95 | 16.70 / 16.80 ms | 16.70 / 16.90 ms |

最终自然 bot 样本 717 帧、28 次事件，draw p50/p95 2.90/3.90 ms，calls p50/p95 146/183；callback 间隔最大 71.3 ms，draw 最大 57.4 ms。仍保留慢帧事实，未把短期流畅描述为绝无卡顿。其余可比性、合成夹具与真实玩法的区分同上。另有六场景 SDK/UI 性能与状态复制数据，见 `v4-performance-after.md`。

边界：未覆盖移动 GPU、高 DPR、长期跨图 soak、实际显示器呈现、原作动态对比。透明实例使用固定顺序，没有逐粒子深度排序；轻量着色采用近似方向光。没有运行原版游戏或使用其纹理/模型，当前表现是基于静态机制资料的自有程序化改编。
