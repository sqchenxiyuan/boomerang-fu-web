# Boomerang Garden SDK API

本文对应本地 ESM 包 **`@boomerang-garden/sdk` 0.2.0**。SDK 把固定步长模拟、人物控制来源和浏览器呈现分开；运行不需要 Boomerang Fu 的安装目录或原版素材。

公开类型以 `src/sdk/types.ts`、`src/sdk/browser.ts` 及打包后的 `.d.ts` 为准。示例采用公开包入口，不依赖开发调试接口。

## 安装与入口

在本仓库构建本地安装包：

```sh
npm run build:sdk
```

在使用 SDK 的项目里安装生成的 tarball，路径按实际位置调整：

```sh
npm install /path/to/dist-sdk/boomerang-garden-sdk-0.2.0.tgz
```

这不是 npm 在线发布。包提供以下入口：

| 入口                            | 用途                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| `@boomerang-garden/sdk`         | `createSession`、`GameSession`，以及 Session、动作、比赛状态相关类型 |
| `@boomerang-garden/sdk/browser` | `createBrowserGame`、`BrowserGame`，以及浏览器配置和帧类型           |
| `@boomerang-garden/sdk/types`   | `Action`、`ScriptController`、`SessionAPI` 等类型入口                |

核心入口不加载 DOM、Three.js 或渲染器，可在 Node.js 20+ 直接运行。构建本仓库仍应遵循项目的 Node 版本要求。浏览器入口需要现代浏览器、WebGL 2，并由 Vite 等打包器或 import map 解析包名和 `three` 依赖。包为 ESM；TypeScript 消费端可使用 Bundler 或 NodeNext 模块解析。

## Node：手动推进完整比赛

`createSession(options)` 等价于 `new GameSession(options)`。创建后立即处于 `status='running'`、`phase='countdown'`，但核心没有后台计时器，只有调用 `step()` 才推进。默认 0 号角色为人工，1 号为机器人；下面把两者都交给机器人。

```js
import { createSession } from '@boomerang-garden/sdk';

const session = createSession({ seed: 295, mapId: 'portals', mapRotation: 'cycle' });
session.useBot(0);
session.useBot(1);

const stop = session.onEvent((entry) => {
  if (entry.type === 'game' && entry.event.type === 'win') {
    console.log('Winner:', entry.event.actorId, 'at tick', entry.tick);
  }
});

try {
  for (let i = 0; i < 700; i++) {
    session.step(60);
    if (session.getState().phase === 'matchEnd') break;
  }
  const state = session.getState();
  if (state.phase !== 'matchEnd') throw new Error('Match did not finish within the limit');
  console.log(state.actors.map(({ id, score, kills }) => ({ id, score, kills })));
} finally {
  stop();
  session.destroy();
}
```

包内另有完整示例，可在安装 SDK 的项目目录执行：

```sh
node node_modules/@boomerang-garden/sdk/examples/node-bots.mjs
```

### 比赛选项

构造函数将传入的部分选项与默认值合并；`start(options)` 则与当前比赛选项合并。显式 `undefined` 不覆盖当前值。

| 字段          | 默认值        | 有效值                                                            |
| ------------- | ------------- | ----------------------------------------------------------------- |
| `mode`        | `'solo'`      | `'solo'` 初始 1 个人工角色；`'local'` 初始 2 个人工角色           |
| `bots`        | `1`           | 整数；solo 为 1–3，local 为 0–2；总人数最多 4                     |
| `difficulty`  | `'normal'`    | `'easy'`、`'normal'`、`'hard'`                                    |
| `seed`        | `1261`        | 0–4,294,967,295 的整数                                            |
| `scoreGoal`   | `5`           | 1–100 的整数                                                      |
| `mapId`       | `'courtyard'` | `'courtyard'`、`'canal'`、`'market'`、`'switchback'`、`'portals'` |
| `mapRotation` | `'fixed'`     | `'fixed'` 固定地图；`'cycle'` 从所选地图开始按上述顺序轮换        |

角色 ID 从 0 开始，当前存在的 ID 通过 `getState().actors` 查询。`mode` 决定初始人数和来源；之后 `useBot`、`useScript`、`acquire` 等可以控制任意存在的角色，不受其初始人工/机器人身份限制。

### 三种 tick 含义

每个核心 tick 的固定步长为 **1/60 秒**，`step(n)` 同步执行最多 n 次。`n` 必须为 1–1,000,000 的整数；暂停、`menu` 或 `matchEnd` 状态下不推进。批量推进期间发生暂停、重开或销毁也会停止剩余批次。

- `snapshot().tick`：Session 已推进的总 tick，包含倒计时、回合结算和命中停帧；重开归零。
- `state.time`、`roundTime` 等：模拟自己的时钟。命中停帧会使游戏时钟和动作暂停，不能用 `tick/60` 替代所有游戏计时。
- 外部动作 TTL：仅在 **playing、没有命中停帧、角色存活**且能够消费控制输入的 tick 扣减。暂停和停帧不消耗 TTL，阶段变化直接清除样本。

脚本收到的 `context.tick` 是本次推进前的计数；该 tick 结束后的 `game` / `step` 事件使用推进后的计数。相同选项、种子、控制切换和逐 tick 动作序列可复现结果；自定义脚本若读取 `Date.now()`、`Math.random()` 或外部可变状态，应自行保证其可复现性。机器人使用与物理随机数分离的确定性随机流。

## 浏览器：嵌入画面和输入

容器必须有可见宽高。SDK 自带基础比分、Ready/Go、暂停和结算显示；完整游戏菜单由宿主页面提供。

```html
<div id="arena" style="width:100%;height:540px"></div>
<button id="start">开始 / 重开</button>
<button id="pause">暂停</button>
<button id="resume">继续</button>
<script type="module" src="/main.js"></script>
```

```js
// main.js；由 Vite 等工具解析包入口。
import { createBrowserGame } from '@boomerang-garden/sdk/browser';

const game = createBrowserGame(document.querySelector('#arena'), {
  match: { mapId: 'canal', seed: 41 },
  autoStart: false,
  keyboard: true,
  hud: true,
  pauseOnBlur: true,
  onFrame({ state, status }) {
    document.querySelector('#pause').disabled = status !== 'running';
    document.querySelector('#resume').disabled = status !== 'paused';
    // state 是本帧副本，可用于宿主 HUD；不要用它修改比赛。
  },
});

document.querySelector('#start').onclick = () => game.start();
document.querySelector('#pause').onclick = () => game.pause();
document.querySelector('#resume').onclick = () => game.resume();

// SPA 组件卸载时调用 game.destroy()。
```

`BrowserGame` 自己维护一个 RAF 和固定步长循环。使用它时通过 `game.session` 管理人物控制，**不要再用另一个循环调用 `game.session.step()`**。点击 Canvas 可获得输入焦点并解锁音频；默认键位为 1P WASD/J/K/L，2P 方向键/逗号/句号/斜杠，Esc 暂停/继续，M 切换静音，支持标准 Gamepad API。

| `BrowserGameOptions` | 行为                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `match`              | 传给核心的部分比赛选项                                            |
| `autoStart`          | 默认运行；`false` 创建后暂停。`resume()` 继续此局，`start()` 重开 |
| `keyboard`           | 默认启用内置人工动作采样；`false` 可供纯脚本/外控演示使用         |
| `inputTarget`        | 输入焦点范围，默认容器；自定义元素应包含需要接收操作的焦点元素    |
| `hud`                | 默认显示基础 HUD；`false` 隐藏它，便于宿主绘制自己的 UI           |
| `pauseOnBlur`        | 默认窗口失焦或页面隐藏时暂停；`false` 关闭此行为                  |
| `onFrame`            | 每个显示帧的观察回调，区别于固定模拟 tick                         |

浏览器实例公开 `session`、`canvas`、可替换的 `onFrame`，以及下列方法：

| 方法                    | 行为                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| `start(options?)`       | 重开比赛并恢复输入、时钟                                                          |
| `pause()` / `resume()`  | 暂停 / 继续当前比赛                                                               |
| `showPreview(options?)` | 新建并暂停比赛，显示菜单用动态景观；后台不推进比赛                                |
| `toggleSound()`         | 切换静音，返回新的静音状态                                                        |
| `stats()`               | 返回帧数、显示累计时间、`frameErrors` 和渲染统计                                  |
| `destroy()`             | 停止 RAF，移除输入/窗口监听、Canvas/HUD，释放渲染和音频并销毁 Session；可重复调用 |

`BrowserFrame` 包含 `state`、`status`、插值系数 `alpha`、显示时钟 `elapsed` / `dt`、本显示帧收集的 `events` 和 `muted`。显示帧 `dt` 不是固定模拟步长；一帧可能收集零个或多个模拟 tick 的事件。`onFrame` 抛错会被隔离，并累计到 `stats().frameErrors`。

## 外部注入：完整按钮状态和有限有效期

```ts
interface Action {
  move?: { x: number; y: number };
  attack?: boolean;
  dash?: boolean;
  throw?: boolean;
}
```

`Action` 是一次**完整采样**。省略的移动归零，省略的按钮视为未按；`move` 必须有限，长度超过 1 会归一化，较小长度保留。`x` 正方向向右，`y` 正方向向下。

SDK 从相邻有效样本推导边沿：`attack` / `dash` 从 false 变 true 才产生按下动作；`throw` 为 true 时蓄力或召回，从 true 变 false 才有意投掷。持续提交 `attack:true` 不会每 tick 连打。按钮松开和再按下之间需要有实际消费样本的 tick；同一 tick 前连续提交多次，以最后一份完整样本为准。

下面是独立的 Node 外控例子：

```js
import { createSession } from '@boomerang-garden/sdk';

const session = createSession({ mode: 'local', bots: 0 });
try {
  // 倒计时输入不积压。Go 后还需等待发镖，再注入战斗动作。
  for (let i = 0; i < 600; i++) {
    const state = session.getState();
    if (state.phase === 'playing' && state.weaponsGranted) break;
    session.step();
  }
  session.step(2);

  const input = session.acquire(0, 'planner');
  input.submit({ move: { x: 1, y: 0 }, throw: true }, 40);
  session.step(24);
  input.submit({}); // 完整中性样本：产生有意松开投掷边沿。
  session.step();

  console.log(session.getState().discs);
  input.release(); // 角色切为 idle；不是返回初始人工控制。
} finally {
  session.destroy();
}
```

`acquire(actorId, label?)` 替换该角色当前来源，返回 `ExternalController`：

- `actorId`：控制的角色；`active`：凭据是否仍为当前有效凭据。
- `submit(action, ttlTicks=6)`：复制动作，允许接下来 1–600 个有效战斗 tick 消费。续交新样本会重设 TTL。
- `release()`：当前凭据释放后角色进入 `idle`；重复释放、释放旧凭据均无效果。

样本消耗完后若没有更新，SDK 在后续可消费输入的 tick 取消移动输入、蓄力和待处理按钮，**不把超时解释为松键投掷**。TTL 到期不会撤销控制凭据，同一个有效 handle 可以提交新动作。取消输入不抹掉已存在的物理惯性或中止所有已启动动作。

暂停或非 playing 阶段的 `submit` 仍会校验参数，但不存储动作。停帧期间的新样本可以更新，恢复消费后才扣 TTL。阶段/回合变化、切换来源、暂停/继续和重开都会清旧输入，避免跨状态误投。

这里的“外部”指通过公开 JS API 提交动作。SDK **不提供 HTTP、WebSocket、进程 IPC 或模型 API 传输层**。接远程 Agent 时，由宿主完成通信和权限处理，在本地持有 handle 并调用 `submit`。`generation` 是当前实例内的控制版本信息，不是网络认证令牌，也不能凭其数值重建 handle。

## JavaScript 脚本控制器

```js
const script = session.useScript(
  0,
  ({ actorId, tick, dt, state }) => {
    const self = state.actors.find((actor) => actor.id === actorId);
    const enemy = state.actors.find((actor) => actor.id !== actorId && actor.alive);
    if (!self?.alive || !enemy) return {};
    const dx = enemy.position.x - self.position.x;
    const dy = enemy.position.y - self.position.y;
    return {
      move: { x: dx, y: dy }, // SDK 会归一化。
      attack: Math.hypot(dx, dy) < 2 && tick % 50 === 0,
      throw: self.armed ? tick % 90 < 30 : true,
    };
  },
  'simple duelist',
);

// 需要停止此脚本时：script.release()。
```

`useScript(actorId, controller, label?)` 返回 `ControlHandle`。脚本只在 playing、没有命中停帧且角色存活时调用，必须**同步返回 Action**。`dt` 恒为 1/60；所有控制器基于同一次推进前的状态决策，每个脚本得到单独副本。

脚本抛异常、返回非法动作或 Promise 时，仅该角色转为 `idle`，清旧输入，发出 `error` 事件；其他角色继续。Promise 的拒绝会被接收以避免未处理拒绝，但 SDK 不等待异步结果。异步模型/网络计算应在宿主执行，再通过外部 handle 提交结果。

脚本是宿主提供的**可信同步 JavaScript**，不是沙箱。SDK 不隔离其无限循环、全局副作用或运行时长。脚本回调只能观察并返回动作，不能在回调中调用控制切换、生命周期或重入 `step()`；这类调用会作为该脚本的错误处理。包内 `examples/duel-controller.js` 提供更完整的控制器函数示例。

## 人工接管与恢复

每个角色同一时刻只有一个来源；`humanIndex` 只允许 0 或 1，同一个人工输入槽不能同时分配给两个角色。

```js
// 在 BrowserGame 中注册脚本；0 号原来的人工槽因此空出。
const script = game.session.useScript(
  0,
  ({ tick }) => ({
    move: { x: Math.cos(tick / 120), y: Math.sin(tick / 120) },
  }),
  'patrol',
);

// UI 的“接管”按钮执行：
const takeover = game.session.takeover(0, 0);
game.canvas.focus();
// 此时 1P 键盘/手柄控制 0 号角色，脚本暂停调用。

// UI 的“交还”按钮稍后执行：
takeover.release();
// 原来的 patrol 函数恢复执行，旧蓄力和按钮不会重放。
```

上例的接管与交还应放在不同的用户动作中。切换后 `script.active` 为 false：恢复的是保存的函数和来源，旧 handle 不会重新生效。

| 操作                                                    | 结果                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `useHuman(actorId, humanIndex=0)`                       | 直接换成人工；不保存被替换的来源                              |
| `takeover(actorId, humanIndex=0)`                       | 保存当前来源，换成人工，返回可释放的接管 handle               |
| 接管前是脚本或机器人                                    | 接管 handle 释放时恢复保存的脚本/机器人                       |
| 接管前是 external                                       | 旧外部凭据立即永久失效；交还后为 idle，外部需重新 `acquire()` |
| 接管前是人工或 idle                                     | 交还时恢复该来源；恢复人工槽时仍检查占用冲突                  |
| 对同一未结束接管再次 `takeover()`                       | 明确抛错，避免隐式嵌套                                        |
| 接管中另用 `useBot/useScript/acquire/useHuman` 替换来源 | 旧接管 handle 失效，之后 release 不覆盖新来源                 |

`submitHuman(humanIndex, command)` 供浏览器或自定义输入适配器使用，`Command` 已包含按下/松开边沿：

```ts
{
  move: { x: 0, y: 0 },
  attack: false,       // 本次按下脉冲，不是持续状态。
  dash: false,
  throwHeld: false,
  throwReleased: false
}
```

它只路由到当前绑定该人工槽的角色；没有绑定时忽略，不会夺回脚本/外控角色。样本在下一次有效输入 tick 消费一次，适配器应逐 tick 提交，并在清空输入后避免重放旧松键边沿。外部 Agent 通常应使用 `acquire().submit(Action)`，由 SDK 生成边沿。

## 状态、事件与来源信息

`getState()` 返回独立的 `GameState` 副本；`snapshot()` 返回：

```ts
{
  tick: number,
  status: 'running' | 'paused' | 'disposed',
  state: GameState,
  controls: Array<{
    actorId: number,
    kind: 'human' | 'bot' | 'external' | 'script' | 'idle',
    label: string,
    humanIndex?: number,
    generation: number
  }>,
  listenerErrors: number
}
```

**当前控制权看 `snapshot().controls`。** `state.actors[].controller` 和 `humanIndex` 保留比赛初始分配元数据，不能用于判断脚本/外部/接管后的实际来源。修改返回对象不会修改模拟，也不会改变其他调用者的副本。

快照用于观察，不是可写状态入口或完整存档。SDK 不提供从快照恢复任意 tick 的 API；要复现比赛，应保存初始选项和逐 tick 控制序列。

```js
const unsubscribe = session.onEvent((entry) => {
  if (entry.type === 'game') console.log(entry.tick, entry.event.type);
  if (entry.type === 'control') console.log('Owner:', entry.control);
  if (entry.type === 'error') console.error(entry.actorId, entry.message);
});
// 不再需要时调用 unsubscribe()。
```

| 事件        | 内容                                                       |
| ----------- | ---------------------------------------------------------- |
| `game`      | 模拟事件及对应 tick，如 throw、death、teleport、round、win |
| `step`      | 一次 Session 推进完成后的 tick                             |
| `control`   | 新的 `ControlInfo`                                         |
| `lifecycle` | 显式 start、pause、resume、destroy                         |
| `error`     | `code:'script'`、消息及出错 actorId                        |

订阅不会立即推送快照，也不重放过去事件；初始状态请主动读取。每个监听器收到自己的事件副本，异常计入 `listenerErrors`，不会阻止其他监听器。游戏事件由 Session 统一取出再分发，消费者不应依赖 `state.events` 留存日志。

监听器可以在 tick 完成后请求暂停或切换来源，但不能重入正在执行的 `step()`。构造函数不会发出 `lifecycle:start`，显式 `start()` 才会。监听器自身的错误只累计计数，不再递归产生 `error` 事件。

## 生命周期与错误边界

| 方法 / 情况                          | 行为                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `start(options?)`                    | 合并当前选项，重建比赛，tick/比分归零，重建默认人工/机器人来源，撤销全部旧 handle，进入 running/countdown             |
| `pause()`                            | 暂停时清输入和蓄力，之后 step 不推进；控制来源和当前外部凭据保留                                                      |
| `resume()`                           | 从暂停恢复前再清输入；需提供新样本。已 running 时不重开比赛                                                           |
| 回合/阶段变化                        | 保留控制来源，清样本、蓄力和输入缓存；机器人清决策状态                                                                |
| `destroy()`                          | 清输入、标记 disposed、撤销有效性并移除订阅；重复调用安全                                                             |
| disposed 后                          | 仅 `snapshot()` 继续返回最终观察值；普通方法调用抛错。旧 handle 的 active 为 false，release 和 unsubscribe 可重复调用 |
| 非法 start 参数                      | 在替换比赛前拒绝；原状态和凭据不被改动                                                                                |
| 非法动作 / TTL / actorId / tick 数量 | 同步抛 TypeError 或 RangeError，不作为合法输入执行                                                                    |
| 已失效外部 handle.submit             | 同步抛错，不能抢回控制；release 不影响当前控制者                                                                      |
| 人工槽占用冲突                       | 同步抛错，原控制分配保留                                                                                              |
| 标签                                 | 若提供，须为去除空白后非空、原长度不超过 128 的字符串                                                                 |

浏览器宿主卸载时调用 `game.destroy()`，纯核心宿主结束时调用 `session.destroy()`。不要用更改状态副本、重新使用旧 handle 或创建第二个时钟来绕过生命周期。

当前验证由 `tests/sdk.test.ts`、地图/整场测试和 `scripts/sdk-package-verify.mjs` 覆盖；安装包检验使用隔离目录和公开入口，另有浏览器实际操作验收。机制相似度与未实现的原版特性见项目仓库的 `docs/mechanics-and-feel.md`，该研究报告不随 SDK 包分发，与 SDK 接口保证分开理解。
