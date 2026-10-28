# 第二阶段验收记录

核验日期：2026-10-28（Asia/Shanghai）。本阶段按“原版机制/手感/过场研究 → 玩法与地图验证 → SDK 分离 → 源码和安装包消费验证”实施。运行层和人物控制现已分离，试玩站点本身也使用公开 SDK。

## 研究与实现依据

原版目标为 `F:\SteamLibrary\steamapps\common\Boomerang Fu`。本轮没有启动原版。安装程序集 SHA-256 为 `7e5a31b96c64150455340067314538af3399b723cd11d9891a065bde2dce2a6f`。来源包括 CIL 静态重建、Unity prefab/场景序列化字段、过场曲线和动画资源；不把字段名称、默认值或未运行的分支当作原版实机结果。

- [机制与手感](mechanics-and-feel.md)：施力/阻力、转向、冲刺恢复、攻击与输入缓冲、1 秒蓄力曲线、护盾/命中停顿、发镖时序，以及与 Web 的差异。
- [过场动画](transitions-analysis.md)：逐人入场、Ready/Go、圆形幕布资源曲线、计分流程、地图机关的静态证据。
- [地图设计](maps-expansion.md)：五张原创地图、碰撞/寻路/传送规则、完整对局数据。
- [SDK API](sdk-api.md)：正式接口与明确的时间、状态、控制权、接管及错误边界。

主要已修正：普通冲刺完整恢复 .55 秒（加速 .33）、近战命中窗与位移/恢复分开、攻击/冲刺缓冲、持续施力和惯性、瞄准停止推进但保留朝向、总蓄力 1 秒、每回合 Go 后 1.2 秒发镖、按事件区分命中停顿。回合末 3.1 秒自动演出、地图几何、AI 和部分飞镖物理为 Web 适配，不宣称逐帧一致。

## 自动化逻辑与完整对局

`npm run check` 与 `npm run build` 的严格 TypeScript 检查通过。全套 `npm test`：**8 个文件，92 项通过**。

| 类别 | 测试数 | 主要证据 |
| --- | ---: | --- |
| 连续碰撞 | 3 | 高速扫掠与墙体碰撞 |
| 战斗 | 13 | 武器、反弹、护盾、爆炸、召回等规则 |
| 手感 | 13 | 惯性、转向、冲刺与缓存、瞄准和蓄力边界 |
| 权威流程 | 2 | 入场锁定、装备、模拟/表现阶段一致 |
| 地图 | 32 | 五图出生/可达性/破箱/传送/轮换及完整比赛 |
| 对局 | 7 | 多种种子完整比赛、四人强化及库存有界 |
| 表现 | 5 | 确定性时间轴、暂停/重新采样、圆形幕布 |
| SDK | 17 | 外控、TTL、接管、脚本、状态隔离、生命周期、确定性 |

地图集：`courtyard`、`canal`、`market`、`switchback`、`portals`。每图两场不同种子的双机器人比赛与一场四机器人比赛，共 **15 场固定图完整比赛**，另有完整五图轮换局。没有直接改生命、比分或指定胜者来结束比赛。

SDK 分离后的原始统计保存在 `test-results/map-matches-sdk.json`。15 场合计 194 次武器死亡、89 次爆炸死亡、3 次落水死亡、0 次缩圈死亡；门图四人局含 38 次人物和 13 次飞镖传送。这里只证明这组测试的可玩性，不证明所有随机种子平衡。SDK 改造前的 `map-matches.json` 是历史结果；独立机器人 RNG 会改变同一旧 seed 的轨迹。

SDK 的 17 项测试仅使用公开 Session API，含机器人完整五分比赛、JS 脚本对机器人的完整比赛，以及同种子/同动作序列的状态和事件一致性。

## 源码浏览器验收

主站重验使用当前 5173 源码，非冻结的 SDK 前副本。`scripts/v2-browser-verify.mjs` **17 项通过**；结果在 `test-results/v2-sdk-main-browser/verification.json`。

- 五张地图的 UI 选择与真实键盘移动、攻击、投掷。
- 入场阶段不能移动；Go 时未持镖，.95 秒仍未发镖，1.2 秒完成发镖。
- 暂停时权威时间不变，入场 Canvas 截图哈希完全一致。
- 真实移动穿门到配对出口；真实冲刺落水后计分并从庭院轮换到水道。
- 换图清掉旧飞镖与场景；960×640 菜单无水平溢出。
- 每图及最终 `frameErrors=0`，没有页面/资源错误。

`scripts/sdk-browser-verify.mjs` **10 项通过**；结果在 `test-results/sdk-browser/verification.json`。

- 演示页按钮通过外控样本移动角色，实际松键投出飞镖。
- 普通 JS 示例产生位移；真实键盘接管后实际移动；交还恢复脚本。
- 暂停/继续冻结并恢复模拟；TTL 超时取消蓄力，不误投。
- 接管撤销旧外部 handle，旧 handle 不能再次提交；交还进入 idle。
- 键盘蓄力时暂停、松开、恢复，不发生幽灵投掷。
- 两个实例分别接收焦点范围内的移动和 Esc，输入互不干扰。
- 经 Session 销毁一个实例会移除其 Canvas 并停止 RAF，另一个继续。
- `keyboard:false` 禁用动作与键盘系统操作；step 监听器中销毁安全。
- `frameErrors=0`、`listenerErrors=0`，没有脚本/资源错误。

已人工查看五图/过场截图总览、接管演示和双实例截图，文件分别位于上述结果目录。截图证明 Web 画面与布局，不代表原版视觉对照。

## 正式站点

`npm run build` 输出 `dist/index.html` 与 `dist/sdk-demo.html`。正式预览 4173 上执行 `scripts/production-smoke.mjs` 通过，结果在 `test-results/production-verification.json`。

检查了游戏开始、实际键盘、HUD、暂停/恢复、销毁，及 SDK 演示页的门图、脚本、人工接管和恢复。正式产物不含开发 `__garden` 入口，无原版安装路径、外部资源请求、页面或资源错误；公开的 `window.boomerangGarden` / `window.sdkDemo` 是宿主显式暴露的实例。SDK 包本身不会创建 window 全局变量。

本次构建的 Three.js 分块约 523 kB（gzip 133 kB），触发 Vite 的 500 kB 大小提示；构建成功。这是体积提示，未把浏览器功能验收扩展成移动设备性能或所有 GPU 的保证。

## SDK 产物和独立消费

正式本地包：`dist-sdk/boomerang-garden-sdk-0.2.0.tgz`，53,350 字节、37 个文件，SHA-256 为 `ab234970b3f0b5170ad349db511adc211f41253eacbd9d75c185796c9c36dae9`。包包含 ESM、类型声明、完整 API 文档、Node 和 JS 示例；不含原版资源、分析工具、源安装路径或开发调试入口。未发布 npm 或部署外网。

打包过程审计核心的所有传递导入：核心不导入 Three.js、DOM 或浏览器适配器；浏览器子入口单独提供显示、输入、音频与唯一 RAF。最终源码 SHA、包 SHA-256、文件列表见 `dist-sdk/build-manifest.json`，最终独立消费报告见 `test-results/sdk-package/verification.json`。

独立消费验证从 tarball 安装到单独 consumer 目录，不使用 src 路径。验证内容包括：

- NodeNext 核心声明在没有 DOM lib 的 TypeScript 工程编译通过；browser/types 子入口声明也通过。
- Node 中通过公开 API 运行双机器人至五分胜局：3,751 tick、8 回合、比分 0:5；移动、蓄力/释放、TTL、脚本和接管契约均通过。
- 浏览器通过 import map 加载 consumer/node_modules 中的真实安装包和 Three.js，显示门图；实际外控移动、脚本移动、真实 d/s 键盘接管、交还恢复脚本、暂停/恢复和销毁均通过。frameErrors、listenerErrors、控制台与请求错误均为 0，截图已人工查看。
- 源码与构建清单哈希一致；安装包的 API 文档与项目文档逐字一致，Node 和普通 JS 示例均在包内。

## 范围与复现

运行命令及页面入口见 [README](../README.md)。`npm run format:check` 通过。历史第一版和 SDK 前浏览器报告保留，不能用它们替代本报告对应的 SDK 迁移后验证。

尚未完成的原版相似度工作包括：原版实机走停/冲刺/投掷录像对比，完整飞镖和回收施力、下落救回窗口、全部强化和模式、原版美术与地图。当前没有网络同步/远程传输服务，外部调用方自行接收异步结果再提交 Action；JS 控制器是可信同步函数，不是可隔离恶意代码的沙箱。未验证实体手柄和移动端性能。
