# 缩圈、出界与末位淘汰：静态证据及 Web 实现

这份记录依据本机安装版本的托管程序集与 Unity 序列化资源，未启动原游戏，也没有把 Web 测试当作原版运行测量。缩圈是向随机位置移动的有限矩形，普通 DeathMatch 默认在 **180 秒**后开始，终点为 **10×10 原版单位**；出界需要连续超时，不能按圆形边缘立即淘汰。

## 证据身份与读取边界

- `Assembly-CSharp.dll` SHA-256：`7e5a31b96c64150455340067314538af3399b723cd11d9891a065bde2dce2a6f`。
- REA 托管身份记录：`analysis/evidence/assembly-identity.rea.json`；证据 ID `ev_c05f0fee6a054766734a886ffd4ce0e68e5c05f141e2ce72b9b595f9a0f07746`。
- 以下行号对应 ILSpy 11.2.0.10050 输出的 `analysis/derived/csharp/*.cs`，不是开发者原始源码行号。
- 新增只读资源解析：`analysis/derived/inspect-sudden-death.py` → `analysis/derived/sudden-death-resources.json`。只读取已定位对象；MonoBehaviour 头及脚本引用由 UnityPy 解码，缺失的自定义 type tree 按反编译字段顺序解析有限前缀，记录对象 ID、文件偏移和字段偏移。没有执行程序集、修改存档或重新扫描全部资源。
- `level1` SHA-256：`f51d58e0a085629b0b27a9c460bcfaf929892c3556505cc77a61cdba9ba6de39`。其余被读取场景哈希保存在资源 JSON；原版派生文件保持本地，不作为 Web 分发素材。

## 自动触发与矩形运动

`GameManager.cs:707–718` 的条件同时要求：正在 Playing、`roundTimer > suddenDeathTime`、尚未自动触发、DeathMatch、非教程地图、当前没有收缩、剩余对手数大于 1。比较是严格大于。`OpponentsLeftStandingNow`（2814–2849）按非 Dead 角色计数，Falling 仍计入；队伍模式按剩余队伍计数。

默认时间有两份相互吻合的证据：

- `MatchSettings.cs:45` 初始化为 `180f`。
- `level0` SettingsManager MonoBehaviour **88**，文件偏移 **10872**，对象大小 **680**；嵌入 MatchSettings 起点为对象相对 **+232**，`suddenDeathTime` 位于 **+308**，浮点值为 **180.0**。这证明随包配置默认值，不证明用户存档没有覆盖。

`LevelManager.cs:514–536` 在载入地图时把 `level.box` 的尺寸、位置、旋转和 offset 复制到边界，保存初始尺寸，目标尺寸设为 `(10,10)`，清空 owner；有些地图允许初始出界并隐藏边界线。`StartShrinkingLevelBoundary`（645–670）会：

1. 从当前矩形取起始角点和尺寸，重置计时。
2. 令持续时间为 **当前宽度 / 7**，不是常量 6 秒。
3. 把目标中心约束在原始地图 box 内，边缘留出目标半宽 5；目标尺寸固定为 10×10，保持矩形旋转。
4. 如原地图允许出界，将该标志关闭，显示边界、闪光、目标 marker，并播放 battle_royale 音效。
5. 记录可选 owner。自动超时使用空 owner，ShrinkingBounds 道具以玩家位置为目标并传入玩家（`Player.cs:2822–2823`）。

自动目标来自 `GetRandomPointInLevelBounds`（1231–1234），不是地图中心。Clamp（625–633）只约束矩形范围，不寻找地板，不避开水面或障碍。原代码随机区间参数的书写顺序反向；这里没有验证 Unity 对该次调用的运行分布，因此 Web 使用自己的确定性均匀 RNG，不宣称与 Unity 随机序列一致。

Playing 中的 Update（145–168）使用 `shrinkCurve.Evaluate(elapsed/duration)` 插值尺寸及对角点中点。到期后停止；它不会继续缩到零。`StopShrinkingLevelBoundary`（672–676）仅停止收缩及 marker 发射，**不会恢复尺寸、清 owner 或隐藏 glow**。剩余对手少于 2 时会提前停止，留下当时的矩形。

### 随包收缩曲线

`level1` LevelManager MonoBehaviour **8970**，文件偏移 **1505416**，对象大小 **1128**。其 `levelBoundary=(0,2890)`、`levelBoundaryLine=(0,9891)`、`shrinkingBoundsMarker=(0,2999)`；曲线位于对象相对 **+840**，已解析前缀到 **+940**。

| time | value | inSlope = outSlope | weightedMode |
| --- | --- | --- | --- |
| 0 | 0 | -0.09615211188793182 | 0 |
| 0.8998180031776428 | 0.9163225889205933 | 2.18933367729187 | 0 |
| 1 | 1 | 0 | 0 |

`preInfinity=2`、`postInfinity=2`。各键无加权切线，Web 用分段 cubic Hermite，再把值 clamp 到 `[0,1]`，对应 Unity `Vector2.Lerp`。开头负切线会产生一小段被 clamp 为 0 的停顿，不能用线性或随意的 ease-in 替换。

### 六张已定位地图的实际 box

以下 collider 均 offset=(0,0)、Transform 位置=(0,0,0)、scale=(1,1,1)，并位于场景根节点；表中旋转是局部及世界 Z 角。持续时间由尺寸推导，并非运行计时。

| 地图 / 文件 | Level MB / BoxCollider2D | 尺寸 | 旋转 | 初始允许出界 | 宽度/7 秒 |
| --- | --- | --- | --- | --- | --- |
| LevelEnclosed / level2 | 1770 / 1701 | 43×43 | 0° | 否 | 6.1429 |
| LevelTeleportals / level30 | 1383 / 1234 | 57×45 | 45° | 否 | 8.1429 |
| LevelFalling / level14 | 1128 / 1067 | 60×54 | 45° | 是 | 8.5714 |
| LevelRaftPair / level51 | 1694 / 1562 | 64×60 | 0° | 是 | 9.1429 |
| LevelFourCogs / level45 | 2618 / 2556 | 64×56 | 0° | 否 | 9.1429 |
| LevelSlideTraps / level3 | 2329 / 2171 | 70×48 | 0° | 否 | 10 |

## 出界判定、宽限和死亡

`LevelManager.IsInBounds`（588–605）先把**角色原点**转到 box 本地坐标并减 offset，再作严格矩形比较：`-w/2 < x < w/2 && -h/2 < y < h/2`。恰好位于边线上算外侧，不以角色半径、脚部或碰撞体重叠判定。允许出界的地图会直接返回 true，直到收缩入口关闭该标志。

`Player.CheckIfPlayerIsInBounds`（1441–1501）：

- 首次离开，若**此刻**正在缩圈，给予 **3.75 秒**；否则 **3 秒**。收缩随后停止不会改写已开始的剩余秒数。
- 连续在外且 Alive 时，每次减 `Time.deltaTime`。Falling 的正计时不递减；已到 0 的计时仍可进入死亡分支。
- 回来即解除出界，下一次离开重新获得完整宽限，不累计暴露时间。
- 剩余时间跨过 0 的当次走减时分支，下一次检查才执行死亡；若这次检查已经回到矩形内，可以活下来。
- 消耗前 20% 宽限后才显示警告：普通约 .6 秒、收缩约 .75 秒。脉冲基于 ease-in 的已消耗比例和正弦；上升穿过 .8 时发 warning 音。箭头指向最近边缘，不是中心。
- `outOfBoundsDuration` 在 `Player.cs:191` 是 **static**：另一角色的新离开能改变所有角色警告的归一化分母，但不会改写旧角色剩余时间。Web 为每角色保存 duration，保留死亡时限，警告分母采用该角色进入时值；这是一项明确的视觉差异。

调用处 `Player.cs:1107–1114` 没有 shield、dash、invulnerable 拦截。超时直接 `Die(outofbounds)`，`Player.Die`（3186–3200）和 `Actor.Die`（2586–2607）也没有普通武器免疫门。因此护盾、冲刺和普通受击无敌不挡出界死亡。冻结角色仍为 Alive，会继续该计时。TimeImmune 不会改变这里的 `Time.deltaTime`；全局 TimeKeeper 的慢动作及 freeze 则影响轮次、缩圈与出界时钟。

`Actor.cs:2633–2643` 的默认死亡支路会播放 OutOfBoundsBurst、隐藏角色并关闭 physics collider；护盾在 Player 后续死亡处理移除，不是挡掉伤害。出界不走斩切复活分支。击杀归属可能保留此前推人的 killer；在特定自杀归属条件下改给 boundaryOwner（`Player.cs:3226–3245`），不能把所有出界都简单算为自杀。

边界线、glow、四路目标标记及箭头的完整资源证据见 [V3 反馈测试计划](v3-feedback-test-plan.md)。已确认线颜色是黑色 alpha .102/.298/.8、红色侧墙 additive glow；不是原型中的红色圆环。

## 回合结束与重置

`GameManager.CheckPlayersLeftStanding`（2679–2741）先等 **.15 秒**，普通模式再等 **1.3 秒**，随后重新数剩余对手。超过 1 则取消结束；Survival 模式此时才加最后存活者分。死亡／自杀处理（2395–2418）停止旧检查协程并重新启动，所以新死亡会重新开始迟判。等待中仍是 Playing，飞镖、延迟爆炸及落水继续生效。该方法没有调用 `AreDangersPresentForPlayer`，因此没有依据另加“等所有危险消失”的无限等待。

源代码的 Remaining 计数包含 Falling；Web 另外显式防止唯一角色仍有 `fall` 时发分，以完成当前落水的结果。迟判可能把本来的一胜变成双亡平局。原版普通 DeathMatch 的已检查 roundTimer 路径里没有 65 秒强制平局。

`EndRound`（2478–2496）进入 Menu、暂停时间并开始成绩／转场，不是还原边界。下一次载入地图重建 box；`PrepareRound`（1613–1616）清 `suddenDeathStarted` 和 roundTimer。缩圈道具本身不设置该自动触发标志，因此在较早道具收缩结束后，时间阈值仍可能再触发一次同尺寸、移动中心的收缩。

## Web 状态契约与实现范围

`src/simulation/boundary.ts` 是纯模拟模块。当前 Web 地图轴对齐，空间比例沿用 `worldScale=.4`，因此终点为 **4×4**、halfSize=(2,2)，宽度除 **2.8** 保持对应的持续时间；Web 地图尺寸与上述原版六场景并非逐场景复刻。

```ts
state.boundary = {
  phase: 'idle' | 'shrinking' | 'settled',
  center, halfSize,
  startCenter, startHalfSize,
  targetCenter, targetHalfSize,
  elapsed, duration, startedAt,
  progress, // elapsed / duration；center/halfSize 已应用资源曲线
  ownerId: number | null,
};
actor.outOfBounds?: { remaining: number; duration: number };
state.suddenDeathStarted: boolean;
state.roundFinishTimer: number | null;
```

`settled` 包含“仅剩一个对手时提前停止”，不代表必定到了最终 4×4。`safeRadius` 仅为 deprecated 派生展示值，不能再用于碰撞、出界或 AI 导航。每次开始收缩只发一次 `boundary` 事件，位置为目标中心，owner 为空时 actorId=-1。

`MatchOptions.suddenDeathTime` 可为合法验收／短局显式设置非负有限秒数，默认 **180**，SDK 统一校验。不存在隐藏的 35 秒默认或 65 秒强制终局。AI 使用当前矩形约束目标及闪避落点；水面／障碍只影响 AI 选路，不改变已经选定的收缩终点。

`Actor.death` 固定记录 cause、variant、time、position、normalized direction、确定性 seed，避免渲染依赖之后改变的位置。fall 保存进入时的 water/cliff 分类；接入 `hazards.ts` 的 .66/.74 秒落水／坠落、.33 秒内一次 dash 救回，未落地前不恢复救回次数。进入 fall 后不能继续走路、攻击或投掷，保留速度漂移；救回成功使用普通 dash 冲量与冷却。`Game` 在 1.45 秒确认期间继续模拟，并等待末位 fall 结束。

保留差异：未加入原版旋转 box、每地图 allowPlayersOutOfBounds、ShrinkingBounds 道具掉落池、队伍／GoldenDisc 模式、完整推人击杀归属或 Unity RNG；这里不宣称原版所有模式都已复现。原代码道具选择 fallback（`LevelManager.cs:1118–1126`）还存在与命名直觉相反的 allowed 分支，不能仅据正常入口断言重复道具收缩绝不发生。Web 固定 60 Hz 与原版 Update／FixedUpdate 排序并不逐帧等价。

## 验证

`tests/boundary.test.ts` 覆盖严格矩形角落／边线、默认及 SDK 参数、阈值、种子目标、资源曲线节点、有限终点、提前停止、无 65 秒硬截止、hit stop 暂停、3/3.75 秒及下一次检查死亡、护盾／冲刺绕过、回圈重置、fall 暂停、死亡几何、1.45 秒迟判、爆炸导致平局及最后一人落水不提前发分。`tests/hazards.test.ts` 覆盖完整落水时限及救回规则。它们验证 Web 模拟，不证明原游戏实测帧时一致。
