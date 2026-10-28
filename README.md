# 回旋花园 · Boomerang Garden

基于 Boomerang Fu 本地静态研究的 Web 玩法复刻。使用 TypeScript、Three.js 和 Vite，自建模型与合成音效；运行不需要原版文件、Unity 或账户。当前包含五张地图、完整存活计分对局，以及可独立安装的 SDK。

## 启动与试玩

需要 Node.js 22.12+ 和支持 WebGL 2 的现代桌面浏览器。本机使用 Node 24.21.0 与 Chrome 验证。

```powershell
npm ci
npm run dev
```

- 游戏：[http://127.0.0.1:5173/](http://127.0.0.1:5173/)
- SDK 控制演示：[http://127.0.0.1:5173/sdk-demo.html](http://127.0.0.1:5173/sdk-demo.html)

线上试玩：[GitHub Pages](https://sqchenxiyuan.github.io/boomerang-fu-web/)；[线上 SDK 演示](https://sqchenxiyuan.github.io/boomerang-fu-web/sdk-demo.html)。

演示页可启动 JS 对战脚本、按住按钮注入外部动作、切换到真实键盘人工接管，再恢复原脚本。开发服务器只绑定本机。

## 已实现

- 山间庭院、双桥水道、货箱集市、折返回廊、跃迁花园；支持固定地图或逐回合轮换。
- 单人对机器人、本地双人、最多四人混合对战、三档机器人难度。
- 移动与惯性、转向、冲刺、近战/空手击退、正面反弹、蓄力投掷、弧线与追踪、回返/接取/召回。
- 墙体、可破坏箱子、水坑、矩形决胜缩圈；人物和飞镖均可穿过传送门。
- 默认 180 秒缩圈（菜单可选 30/60 秒），出界后有 3～3.75 秒返回宽限，配有箭头和倒计时。
- 切片、爆炸压扁、落水、坠崖、界外爆散分别呈现；下落有短暂冲刺救回窗口，淘汰后延迟 1.45 秒核对胜负。
- 14 种正式道具：护盾、加速、穿墙、反向输入、爆炸、分裂、传送、火焰、双镖、冰冻、伪装、遥控、缩圈、诱饵。三槽 FIFO、火冰互斥、跨回合保留；菜单支持配方组合试验。
- 角色依次入场、Ready/Go、开始后 1.2 秒自动发镖及就绪提示、命中停顿、比分揭示、圆形幕布与换图。
- 连续飞镖拖尾、蓄力环；普通攻击包含转身横挥、踏步和收招，刀光跟随镖尖轨迹。粒子实例化、静态场景合并和飞镖对象复用。
- 最后存活者得一分，同时出局不得分，先得五分获胜；暂停/恢复、重开、合成音效。
- 独立 SDK 的状态/事件、外部动作注入、JS 控制器、人工接管、控制权恢复与销毁。

## 操作

| 动作 | 1P | 2P | 标准手柄 |
| --- | --- | --- | --- |
| 移动/朝向 | WASD | 方向键 | 左摇杆/十字键 |
| 近战/反弹 | J | 逗号 / 小键盘 1 | X |
| 蓄力/投掷/召回 | K | 句号 / 小键盘 2 | B / RB |
| 冲刺 | L / 空格 | 斜杠 / 小键盘 3 | A |
| 暂停/继续 | Esc | Esc | Start |
| 静音 | M | M | 界面按钮 |

点击画面获得输入焦点。按住投掷蓄力，松开投出；空手按住同一键召回。完整蓄力约一秒。冲刺可越过水坑；下落前 0.33 秒可在冷却允许时冲刺自救一次。两支手柄按连接顺序分配；Gamepad API 已使用虚拟输入验证，未用实体手柄复验。

## SDK

```powershell
npm run build:sdk
npm run verify:sdk
# 在另一个项目安装；也可以使用绝对路径
npm install ./dist-sdk/boomerang-garden-sdk-0.4.1.tgz
```

交付的是本地 ESM 包 `@boomerang-garden/sdk@0.4.1`，未发布 npm。

```js
import { createBrowserGame } from '@boomerang-garden/sdk/browser';

const game = createBrowserGame(document.querySelector('#arena'), {
  match: { mapId: 'portals', seed: 295 },
}); // #arena 必须有非零宽高，浏览器适配层自动推进

const source = game.session.acquire(0, 'my-agent');
source.submit({ move: { x: 1, y: 0 } }, 6);
// 外部调用方持续提交完整按钮状态；样本到期自动回到中立输入。

game.session.useScript(0, ({ state, actorId }) => {
  const me = state.actors.find(actor => actor.id === actorId);
  return { move: { x: me.position.x < 0 ? 1 : -1, y: 0 } };
});
const human = game.session.takeover(0, 0);
human.release(); // 恢复原脚本
game.destroy();
```

核心入口 `createSession` 不加载 DOM/Three.js，仅在调用 `step()` 时推进；浏览器入口拥有 RAF、画面与输入。每个角色只有一个当前控制源。旧外控租约在人工接管时失效，退出接管后需重新 acquire；脚本/机器人可直接恢复。暂停、到期和切换控制不会生成误投。

动作 TTL 以实际消费输入的战斗 tick 计数，默认 6 tick；过场、暂停及命中停顿不消耗它，阶段变化会清空样本。脚本为受信任的同步 JS；外部异步模型/网络应由宿主接收结果后调用 submit，SDK 未包含网络协议或沙箱。

完整签名、时钟、输入、错误和清理契约见 [SDK API](docs/sdk-api.md)。[Node 整场示例](examples/node-bots.mjs)和[普通 JS 对战策略](examples/duel-controller.js)随包交付。

## 构建与验证

```powershell
npm run check
npm test
npm run format:check
npm run build
npm run preview
# 以下浏览器测试需对应服务器运行，使用本机 Chrome
npm run test:browser        # 5173：五图、输入、装备、暂停、换图
npm run test:sdk-browser    # 5173：注入、接管、多实例、销毁
npm run test:v3-browser     # 5173：缩圈/死亡实际流程与独立呈现样本
node scripts/v4-browser-verify.mjs # 5173：发镖、配方、键盘道具操作、真实拾取
node scripts/production-smoke.mjs # 4173：正式游戏 + SDK 演示
npm run build:sdk
npm run verify:sdk          # 独立目录安装 tarball，Node + 浏览器消费
```

`dist/` 可部署到普通静态站点。GitHub Pages 通过 Actions 中的 **Deploy game to GitHub Pages → Run workflow** 手动发布，提交不会自动部署。流程先运行测试，再按仓库子路径构建并部署游戏与 SDK 演示。线上冒烟测试可设置 `GARDEN_TEST_URL`、`GARDEN_TEST_DIST` 和 `GARDEN_TEST_OUTPUT` 后运行 `scripts/production-smoke.mjs`。第四阶段见 [道具研究](docs/v4-powerups-analysis.md)、[性能基线](docs/v4-performance-baseline.md)和[验收记录](docs/v4-validation.md)。[第三阶段验收](docs/v3-validation.md)及更早报告保留为历史记录。

SDK 0.4.1 同步更新普通攻击表现，改动和验证见 [普通攻击动画](docs/melee-animation.md)。

## 分层

```text
src/core/        类型、地图、参数、数学、碰撞、表现时间线
src/simulation/  固定步长人物/战斗/飞镖/回合；不读取控制设备
src/sdk/         Session、控制权、动作采样、脚本/机器人驱动、浏览器适配
src/rendering/   只读状态的 Three.js 画面
src/platform/    键盘/手柄、RAF、音效
src/ui/          试玩站点的菜单与 HUD
src/main.ts      使用 SDK 的游戏站点
src/sdk-demo.ts  使用相同公开 API 的接管演示
```

模拟只接受 `actorId → Command`，不自行决策。每个机器人有独立种子随机流；渲染不修改状态。碰撞与显示共用地图实体数据，公开快照与事件均隔离复制。

## 原版研究与差异

- [本地逆向初查](docs/boomerang-fu-investigation.md)
- [机制与操作手感](docs/mechanics-and-feel.md)
- [过场与动画](docs/transitions-analysis.md)
- [地图扩展与验证](docs/maps-expansion.md)
- [矩形边界与缩圈](docs/sudden-death-analysis.md)
- [死亡反馈](docs/death-feedback-analysis.md)
- [官方玩法和版本资料](docs/official-gameplay.md)

研究对象：`F:\SteamLibrary\steamapps\common\Boomerang Fu`。本轮未启动原版；结论来自安装文件、反编译 CIL 和 Unity 序列化资源。报告区分代码默认值、资源值和 Web 设计选择，不能据此声称逐帧还原或实机手感一致。

Web 保留简化的飞镖动力学、回收、下落惯性与 AI；边界仅支持轴对齐矩形，地图为原创布局，并非导入原版全部地图。14 种正式道具已进入模拟规则，但爆炸伤害窗口、武器补发等待、诱饵决策等仍有 Web 适配差异，详见第四阶段报告。隐藏的 TimeImmune、全部角色美术、组队/黄金回旋镖/躲猫猫或联网尚未实现。原版资源及分析工具不进入站点或 SDK。

`tools/`、`analysis/evidence/`、`analysis/derived/`、`test-results/` 和构建产物默认忽略 Git。原版离线分析使用 ILSpy / UnityPy，它们不是 Web 游戏运行或构建依赖。
