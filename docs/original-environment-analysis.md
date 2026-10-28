# 原版场景机关：静态证据与 Web 实现

本记录依据本机 Steam 安装的 `Assembly-CSharp.dll` 和 Unity 场景资源。分析期间没有启动原版游戏、修改原版存档或把原版程序集装进 Web。C# 是 ILSpy 11.2.0.10050 的反编译结果，不是开发商源码；Web 行为验证针对独立 TypeScript 模拟，不代表原版运行时实测。

程序集 SHA-256：`7e5a31b96c64150455340067314538af3399b723cd11d9891a065bde2dce2a6f`。身份记录：`analysis/evidence/assembly-identity.rea.json`，REA evidence ID：`ev_c05f0fee6a054766734a886ffd4ce0e68e5c05f141e2ce72b9b595f9a0f07746`。

场景字段来自 `analysis/derived/v5-maps/level2.json` 至 `level60.json`，通过 UnityPy 和 Managed 元数据生成的类型树读取，MonoBehaviour 字段要求 `parseStatus=complete-size-checked`。59 个构建场景中 `LevelToaster` 重复，按 `scenePath` 去重得到 58 张独立场景。地图数据与导出方法另见 `docs/original-maps-progress.md`。

## 实例覆盖

以下计数同时要求 GameObject 在完整父链上激活，且组件 `m_Enabled` 为真。活动计数不是程序集中类的出现次数，也不是原版运行时动态实例数量。

| 原版类                                          | 58 场景中活动实例 | 场景数 | Web 处理                                                         |
| ----------------------------------------------- | ----------------: | -----: | ---------------------------------------------------------------- |
| MovingObstacle                                  |                35 |     13 | 平移、弹簧返回、旋转、开关变速与反向                             |
| MovingObstacleButter / MovingObstacleRollingPin |             1 / 3 |  1 / 2 | 共享墙体运动；附属挤压和滚轴动画为简化表现                       |
| MovingFloor                                     |                16 |      7 | 五种路径插值、连续旋转、携带角色和地面物体                       |
| MovingFloorReactive                             |                14 |      6 | 开关触发、反向、弹簧返回                                         |
| MovingFloorRollingPin                           |                 2 |      1 | 配对平台的滚轴表现，不新增碰撞类别                               |
| MovingDoor                                      |                24 |      1 | 高度插值与碰撞启闭                                               |
| Switch                                          |                60 |     21 | 引用原版目标数组，触发方向、遮挡、冷却与一次性开关               |
| FallingFloor                                    |               129 |      2 | 关卡自动塌陷                                                     |
| TrapFloor                                       |               397 |      9 | 踩踏预警、塌陷、复位                                             |
| DestructableObstacle                            |               358 |     36 | 共享碰撞体耐久与破坏                                             |
| DestructableObstacleDestroyer                   |                 6 |      2 | 清除道具、可破坏物和替身的区域                                   |
| Plant                                           |              3760 |     12 | 触碰摆动、冰切除、燃烧与爆炸切除                                 |
| AnimatedObstacle / WobblyObstacle               |           3 / 838 | 3 / 56 | Animated 简化受击反馈；Wobbly 保留碰撞几何，未复刻每个模型的弹簧 |
| Teleportal                                      |                44 |     13 | 原始矩形入口、出口偏移与安全标记                                 |
| AutoRotate                                      |                11 |      3 | 其中 Z 轴旋转影响二维层级；X/Y 轴为滚轴等三维表现                |

`AutoRotate` 在 `level60` 的同一个 GameObject 463 有两个同参数组件；它们各自从相同初始角更新并设置同一个角度，不能累加为双倍速度。Z 轴组件合并后覆盖四齿轮和旋转传送门场景。`level55` 的七个组件只转 X/Y 轴。

`RotatingObstacleController` 仅有一份场景组件，且禁用。`GoldenTotem` 的七份实例在静态层级中均未激活；即使激活，`GoldenTotem.cs:30` 也会在非 GoldenDisc 模式销毁它。不能把它当普通淘汰赛机关。

`Trap`、`TempHazard`、`Pushwave`、`LevelProcedural`、`LevelRandomChunk`、`RandomEnabler` 在这些场景中没有实例。程序集中存在这些类不证明当前场景使用它们。Web 保留了可序列化的旧式 Trap 状态支持，但地图不凭空生成这些节点。

## 运动与开关

`MovingObstacle.cs:216–313` 给出固定更新、旋转、预备延迟、弹簧暂停和回程。正向用 `sin(πt/2)`，反向用 `1-cos(πt/2)`。再次触发时交换端点、令进度变为 `1-progress`，再经过预备延迟。弹簧模式要求恰好两个端点；达到端点 1 后暂停并按单独回程时长返回。

场景参数覆盖类默认值。例如 `level3` 的 MovingObstacle pathID 2316：端点局部坐标 `(-14.5,0)` 与 `(-14.5,-21.7000008)`，`moveDur=0.6000000`、`preMoveDur=0.25`、`springPauseDur=1.2000000`、`springWindBackDur=1.39999998`。Web 使用 0.4 空间比例，位移对应 8.68；时间不缩放。全场景平移时长范围为 0.2–2 秒；滚筒旋转周期含 2.5 和 3.5 秒。不能统一套默认 0.5 秒。

旋转速度为 `±360/rotatingDur` 度/秒。多个 `rotatingDurations` 通过开关循环；变慢时用 0.5 秒 SmoothDamp，变快立即切换（`MovingObstacle.cs:219–232, 356–373`）。Web 保存不折返到 ±π 的连续角度，避免每转一圈产生角速度尖峰。

`MovingFloor.cs:165–249` 的路径类型依次为 linear、circular、eased、supercircular、easedsoft。各轴插值在父 Transform 的局部坐标中计算，不能将旋转后的世界坐标直接分别缓动。因此地图除世界端点外还保存 `motionOrigin` 和 `motionAngle`。每段目标时长取 `moveDurMin/Max` 随机值，当前时长每个固定步向目标平滑；实际资源常见 3–10 秒。平台启动由 LevelManager 调用 StartMoving；Reactive 的 StartMoving 是空实现，必须等开关。

`Switch.cs:122–184` 说明一个开关可以同时连接多个墙、门与 Reactive 平台。正常触发受冷却、活动状态和 Obstacle 射线遮挡限制。飞镖要求速度与 `switch.up` 的点积小于 0.1，或处于刚抛出且离主人不足三倍飞镖半径的特例。Unity 的 +Y 转为 Web 的 -Y；测试使用转换后的方向。普通走路触碰不是已证实的开关输入，Web 接近战与飞镖命中，不通过站在开关附近自动激活。

Web 使用攻击序号防止一个近战有效窗口重复拨动开关。飞镖钩子由抛射物模拟传入真实经过的每段路径，墙后或传送前后跨空间的虚构线段不会触发开关。一次性开关不再接受后续触发。

## 移动实体与碰撞

`Actor.cs:1002–1067` 是先求重叠与推挤，再递归解除穿透；递归仍卡住才直接以 squished 死亡。这不是移动墙接触即死。Web 对快速墙进行空间子步，避免薄墙在一帧内越过角色；可脱离时推动，被两堵墙夹住时才用 `crush`。护盾、普通冲刺无敌和受击无敌不阻止压死；WallDash 冲刺忽略障碍层。

旋转墙的推动速度包含圆周切向速度。被压住的飞镖恢复给主人。墙清除碰到的火/冰区域并可破坏箱体。碰撞查询先检查边界，避免每个移动机关对所有远处多边形逐边计算。

移动平台的成员关系保存在 `Actor.movingFloorId`，重叠平台同一步只携带角色一次。离开支持面后解除关系。平台也移动地面飞镖、拾取物、火/冰区域、替身及子级开关、碰撞形状和传送门。导出时每个碰撞体只归属最近的机制节点，父子运动逐层传递，避免变换两次。

`MovingDoor.cs:65–96` 只按 Z 高度移动，以 `transform.position.z - renderer.bounds.extents.z` 的正负启闭碰撞；`KillEverythingTouching()` 是空函数。Web 保存转换后的 `closedHeight/openHeight/solidHeight`，到阈值才改变碰撞与导航。门的资源 `moveDur` 全部为 0.4 秒，不是类默认 0.25 秒。几何高度与机关升降偏移分开保存，渲染不得重复加一次基础高度。

`DestructableObstacleDestroyer.cs:22–64` 会销毁可破坏物、拾取物、替身，以及挤扁已经死亡的角色/碎片；没有直接杀死活玩家的分支。Web 的 destroyer 区域不额外给活角色施加伤害。

## 两类下沉地板

| 行为         | FallingFloor           | TrapFloor                                  |
| ------------ | ---------------------- | ------------------------------------------ |
| 起因         | Level 的定时塌陷队列   | 非冲刺角色踩在此处，且没有其他实体地面支撑 |
| 预警         | 2 秒                   | 2.5 秒                                     |
| 失去物理支撑 | 进入 Falling 的瞬间    | 进入 Falling 的瞬间                        |
| 下沉表现     | 0.75 秒，原版 Z 增加 6 | 1 秒，原版 Z 增加 5                        |
| 等待后复位   | 永久消失               | 等待 4 秒，再上升 0.5 秒                   |
| 恢复支撑     | 不恢复                 | 上升开始后 0.2 秒                          |

证据：`FallingFloor.cs:18–24, 63–143`；`TrapFloor.cs:26–44, 88–220`。两者在 StartFalling 时就将导航区域标记为 OOB，物理支撑则保留到预警结束，不能把二者时间混用。

`Level.cs:124–129, 230–246` 在边界盒内部随机选择最终区域中心，按距离排序，从最远块开始，每次间隔乘 `Random.Range(0.9,1.111)`。队列剩六块时停止继续启动，仅一名对手存活时停止关卡塌陷。此逻辑不用于 GoldenDisc 或 KingOfTheHill。Web 当前淘汰赛按相同的空间排序和时间范围执行；压力地板独立于永久塌陷队列。

永久下沉完成后禁用子级。压力地板下沉完成时对附属 DestructableObstacle 调用 TakeSinkDamage；地板恢复不会把已破坏的箱子复活。生产数据中 FallingFloor 下有植物，BigRaft/Trap 的 TrapFloor 下有箱体，父级下沉偏移需同时影响这些物体的表现。

## 植物、可破坏物与边界

`DestructableObstacle.cs:35–89` 每次交互减一，恰好到零时禁用。导出场景的 `hitsLeft` 全为 1，Web 数据结构支持更高耐久；共享多个碰撞体的物体只在同一个近战序号扣一次。`AnimatedObstacle` 接入简化受击反馈；`WobblyObstacle` 没有单独接入原版弹簧状态，只保留有关碰撞体，不能据此宣称全部摆件动画已复刻。

`Plant.cs:106–148` 及接触分支区分摆动、切除、燃烧。普通近战和飞镖会扰动植物；冰区域和普通爆炸切除；燃烧会耗尽 0.4 的 burnHealth，生成短时火焰后切除。原版按若干渲染帧抽样 CellManager，Web 以固定步和现有火/冰区域系统执行，视觉和逐帧传播不会完全一致。原 Actor 的 wadeFactor 默认 1，未发现这些场景主动修改它；不凭植物名称添加未经证实的移动减速。

传送门依据 `Teleportal.cs` 和 `Actor.cs:1174–1207` 保留原矩形触发器、出口厚度、方向及 AI 安全信息。角色与飞镖出门保持原速度和朝向，原版并不按两扇门的夹角自动旋转角色。

## 验证与未覆盖范围

`tests/environment.test.ts` 覆盖 35 项规则：开关多目标/冷却/一次性/方向/遮挡、真实滑墙弹簧参数、反向连续性、连续旋转、平台携带与重叠平台归属、局部轴缓动、快速薄墙推挤、夹击压死及 WallDash、两类塌陷时序、门碰撞阈值、箱体共享耐久、附属箱体下沉、清理区域、植物、Game 主循环接入、重开时清除湿滑与平台归属，以及 JSON 状态加 RNG 种子的恢复。真实导出地图还检查 TurnTeleportals 两组门各以 12 度/秒转动（包括重复组件组），以及 RollerSweep 四个清理区域跟随所属滚筒旋转。

第二轮检查得到以下实际数据回归与修复：

- 60 个导出开关均可从一个合法的附近站位进行近战激活，并使链接机关在随后 0.5 秒内实际改变位置、角度或高度。修复前只有 47 个开关找到可用站位，13 个贴墙开关被自己的背板误挡。
- 真实原因是射线规则：`Switch.cs:169` 从开关 pivot 向触发物体发射射线，且只查 Obstacle 层 8。原安装 `Boomerang Fu_Data/globalgamemanagers` 的 Physics2DSettings pathID 15 指定 `m_QueriesStartInColliders=false`，原文件 SHA-256 为 `92776e6a29019fa67439b8b00abb27be47a326c80998125713cd836f1267dde2`。Web 按源层过滤并忽略包含射线起点的碰撞体；不会移除背板或放行前方其他墙壁。
- 397 个压力地板均能从一个合法站位触发，无需先破坏箱体；之后 2.5 秒全部撤去支撑。另对两张永久塌陷地图验证定时队列确实启动并移除支持面。最终区域采样使用源 Level.box 的半尺寸乘 0.8，不使用旋转后扩大了的场景轴对齐包围盒。
- `LevelManager.IsPointOnSolidGround` 是中心加八个脚边样本，其中朝上样本放大 1.25 倍。压力地板现在遵循此判断，脚边仍搭在普通地面时不提前预警；触发器判定使用身体重叠，允许中心刚越过地板边缘。移动平台也遵循 `Actor.cs:1151` 的边缘附着条件。
- 拾取物、地面飞镖、火/冰格和替身与角色一样只属于一个移动平台，避免重叠平台同一步将物体移动两次。父子机制逐层变换仍可叠加父运动与自身运动。
- CircleMaze 的 Reactive 平台原字段 `positions[].z=[0,120,240]` 是角度。生产导出已修正其漏失角度的问题；Reactive 平台连续转过多圈时也保持角度连续，避免 360 度跳变导致插值和角速度异常。

上述安全站位和触发验证没有执行逐帧移动到站位，也不证明每个出生点在所有机关阶段都存在普通步行路线。平台等待、跨隙冲刺及机器人策略仍由完整对局和浏览器验证覆盖。

完整关卡的物理、AI 和浏览器集成结果由主任务汇总。单元测试通过不证明 58 张图已逐张进行原版对照。当前仍使用独立程序化美术，原版网格、材质、Animator、粒子、音频、细小碎片与夜景随机表现不在此机制还原结论内。二维圆碰撞器已按 Unity 官方编辑器源码确认的最大 XY 缩放规则转换，证据见地图文档；整体接触求解和原版引擎逐帧结果仍未通过原版运行时对照。
