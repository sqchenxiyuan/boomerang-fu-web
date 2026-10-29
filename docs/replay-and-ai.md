# 音乐、录像与 AI 对战（SDK 0.6.0）

## 浏览器使用

菜单选择 **AI 观战**，可观看 2 或 4 个内置机器人互战。右上角 **音乐 · 历史回放 · 倍速** 面板提供独立音乐/音效音量、0.25/0.5/1/2/4/8×、自动录制、手动录制和历史对局。每次打开页面默认启用自动录制；可关闭后手动录制。

历史列表按录制时间倒序排列，显示地图、时长、模式、人数，以及完整对局或片段。选中任意一局即可回放、下载或删除；回放支持暂停、拖动进度、结束后重播。导入的录像也会加入历史，相同录像不会重复保存，删除后可以重新导入。

录像结束、手动停止、重新开局或返回菜单时，会压缩保存到当前浏览器的 IndexedDB，标记为 **已存本地** 后刷新仍可查看。列表只读取元数据，选中回放时才加载完整录像。同一站点多个标签页的历史列表会同步。游戏进行中直接刷新或关闭页面尚不保证保存当前片段；需要保留时先点击 **停止并保存**。

每个站点最多保存 100 局、合计 200 MiB 压缩数据，浏览器自身配额也可能更小。达到上限或存储不可用时，会显示警告并将新录像暂存在本页，不会自动删除旧录像；可先下载再删除不需要的历史。录像不会上传，清除站点数据会删除本地历史；不同浏览器、端口或域名之间不共享，可通过下载/导入迁移。更新前未下载、已经被覆盖的录像无法恢复。

声音由 Tone.js 15.1.22 合成，首次点击页面后解锁。菜单、对战、决胜和胜利使用不同节奏与配器，挥砍、投掷、反弹、传送、拾取及不同死亡有分层音效。音乐按真实音频时间播放，加速不会变调；密集音效有去重和限流。音乐和音效是新编排，未复用原版录音。

## 录像与状态恢复

```js
import { createSession, ReplayPlayer } from '@boomerang-garden/sdk';
const session = createSession({ mode: 'bots', bots: 4, seed: 8751 });
session.startRecording({ label: '机器人对战', checkpointInterval: 600 });
session.step(1800);
const data = session.stopRecording(); // 比赛结束会自动完成，亦可 getRecording()
const player = new ReplayPlayer(data);
player.step(60);
player.pause();
player.seek(900); // 暂停状态保持；跳转不重发历史声音
player.resume();
console.log(player.getState());
session.destroy();
```

- `startRecording({label?, checkpointInterval?, maxTicks?})`：可从中途开始；标签最长 120 字符，检查点间隔 60–3600 tick，默认 600；最长 108000 tick（30 分钟模拟时间）。重复启动会报错。
- `recording` 返回 `ticks/seconds/checkpoints/operations/estimatedBytes`；未录制为 `null`。
- `stopRecording()` / `getRecording()` 返回独立的 `ReplayData` 副本，无录像时为 `null`。完成原因 `manual/match-end/restart/destroy/limit/size-limit`。
- 录像保存实际消费的 Command、输入取消操作、初始完整世界及 RNG 和定期检查点。相同命令连续帧压缩，不保存模型、网络凭据或控制器脚本。回放不调用原来的控制器。
- 保守估计达到 32 MiB 时自动结束当前片段；下载文件为 gzip JSON（`.bgr.gz`），导入允许 gzip 或 JSON，解压后上限 64 MiB。容量上限可能先于时长上限；比赛继续，可以录制下一片段。
- `parseReplay(dataOrJSON)` 校验模拟/地图版本、60 Hz、结构、操作计数及检查点哈希。`ReplayPlayer` 在到达末尾时校验最终状态和 RNG。哈希将非整数规范到小数点后 9 位，容忍不同 JS 引擎约 10⁻¹⁹ 量级的数学尾差；不改变实际模拟数据。哈希用于发现数据漂移，不用于文件认证。
- `player.tick/durationTicks/status/label` 为只读；`status` 为 `playing/paused/ended`。`step(n)` 在暂停/结束时不推进；`seek(tick)` 从最近检查点重演。空录像直接结束。回放保存的是游戏状态与动作，不是视频或声音录音。
- 支持相同 SDK/地图版本的回放，已验证当前 Chrome 与 Node；其他 JS 引擎/架构及未来版本不保证浮点逐位一致。版本不符直接拒绝，末尾漂移会提示错误。

浏览器 SDK 额外提供 `loadReplay(dataOrJSON)`、`seekReplay(tick)`、`playback`、`setSpeed(value)`、`speed`、`unlockAudio()`、`configureAudio({music,sfx,muted})`、`audioSettings()`。音量范围 0–1。加载前先校验，失败保留当前游戏；成功后暂停 live session，回放独立运行。`pause/resume` 路由到当前回放，结束后 resume 从头播放；`start/showPreview` 退出回放。`BrowserFrame` 包含 `recording/replay/replayError/audio/speed`，`stats()` 包含音频状态和时钟计数。

## 内置及外部 AI：无渲染批量运行

```powershell
npm run build:sdk
node dist-sdk/examples/ai-match.mjs --matches 3 --seed 8751 --bots 4 --map courtyard --out test-results/replays
# 另一个终端启动示例 HTTP 策略
node examples/http-agent.mjs
# 使用 HTTP 策略控制角色 0，其余角色仍用内置机器人
node dist-sdk/examples/ai-match.mjs --agent-0 http://127.0.0.1:8787/action --score 1 --out test-results/agent-replays
```

安装 SDK 后，示例在 `node_modules/@boomerang-garden/sdk/examples/`。CLI 支持 `--matches/--seed/--bots/--map/--score/--ticks/--action-ticks/--timeout/--agent-0..3/--out`；逐局打印 seed、胜者、比分、tick、模拟秒、墙钟秒、实际倍率和错误次数。Ctrl+C 取消；只有指定 `--out` 才录制并写文件。每局 seed 递增。32 MiB/30 分钟上限仍适用，长场次输出可能只有前半段录像。

```js
import { runAIMatch, createHttpAgent } from '@boomerang-garden/sdk';
const result = await runAIMatch({
  match: { mode: 'bots', bots: 2, mapId: 'courtyard', seed: 41, scoreGoal: 5 },
  agents: { 0: createHttpAgent('http://127.0.0.1:8787/action') },
  actionTicks: 6, timeoutMs: 2000, maxTicks: 108000, record: true,
});
console.log(result.reason, result.simulationRate, result.agentErrors);
```

`agents` 按角色 ID（0–3，且需在本局存在）绑定 `AgentPolicy(observation, signal) => Action | Promise<Action>`。默认 6 tick 采样一次，允许 1–60。所有策略收到同一模拟时刻的独立世界副本；等待期间游戏不推进。`AbortSignal` 的公共类型使用 DOM-free `AgentSignal` 子集，可传原生信号。外部策略是宿主信任的代码，同步死循环无法用 Promise 超时打断；不可信策略应放在独立进程。

HTTP POST 请求：

```json
{"protocol":"boomerang-garden.agent.v1","actorId":0,"tick":300,"dt":0.016666666666666666,"actionTicks":6,"state":{"...":"完整 GameState"}}
```

响应（JSON，最大 64 KiB）：

```json
{"protocol":"boomerang-garden.agent.v1","actorId":0,"tick":300,"action":{"move":{"x":1,"y":0},"attack":false,"dash":false,"throw":true}}
```

每次响应须匹配协议、角色和 tick。动作是完整按钮状态：省略值为中立，移动向量会限幅；`throw:true` 持续蓄力/召回，之后 `false` 松开投掷。`attack/dash` 为按键边沿，持续 true 不会每帧触发。超时、HTTP 错误、错 tick 或非法动作会取消蓄力和租约，再取得控制权，避免失败造成意外投掷；其他角色继续。最多保存 1000 条错误详情。

凭据放在 Node 宿主，通过 `createHttpAgent(url, headers)` 传入；CLI 可读宿主环境变量 `GARDEN_AGENT_TOKEN`，不记录到录像。示例服务器仅绑定本机。这是**完整状态接口**，不是仅看屏幕的 AI 测试，也未接入真实大模型。浏览器跨域接口需由服务端配置 CORS；推荐 Node 宿主接入网络 AI。

## 加速边界

模拟始终 60 Hz。浏览器只改变每帧步数，最多 48 步/帧、约 12 ms 模拟预算；慢设备会低于所选倍率，不跳过物理 tick，超量墙钟积压会丢弃并计入 `stats().clock.discardedSeconds`。切回后台后不补跑整段离线时间。Node `runAIMatch` 省去渲染，不等待实时钟，按 CPU 能力推进并定期让出事件循环；外部 AI 推理或网络延迟计入实际倍率。倍率依赖地图、机器和 AI，不承诺固定值。
