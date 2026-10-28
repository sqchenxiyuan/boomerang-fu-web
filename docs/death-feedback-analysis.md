# 死亡表现：静态证据与 Web 实现

本轮只读取 `F:/SteamLibrary/steamapps/common/Boomerang Fu` 的安装文件，没有运行原版。以下调用关系来自 ILSpy 重建，资源参数来自 UnityPy 1.23.0；这些证据能证明分支与配置，不能证明画面已经与原版一致。Web 使用自行构造的几何体、材质和音效，不分发原版资产。

## 证据与复查方式

- 程序集：`Boomerang Fu_Data/Managed/Assembly-CSharp.dll`，SHA-256 `7e5a31b96c64150455340067314538af3399b723cd11d9891a065bde2dce2a6f`。REA 身份记录在 `analysis/evidence/assembly-identity.rea.json`，ID `ev_c05f0fee6a054766734a886ffd4ce0e68e5c05f141e2ce72b9b595f9a0f07746`。
- 代码引用均相对于 `analysis/derived/csharp/`；`scripts/decompile-selected.ps1` 可重新生成所列类型，manifest 记录重建文件和程序集哈希。
- 资源结果：`analysis/derived/death-feedback-resources.json`；提取脚本：`analysis/derived/inspect-death-feedback.py`。文件哈希、资源文件名、path ID、对象偏移、解析范围均保存在结果中。
- `DeathSlice` 的 81 个组件均以 144 字节完整布局解析。`ParticleManager` 完整解析到 2104 字节；AnimationClip、ParticleSystem 和 Rigidbody2D 使用内置类型树。`Explosion` 只解析前三个浮点字段，不能把未解析字段视为已核实。

## 原版各死因的调用链

| 触发 | 身体、残片与粒子 | 声音和方向依据 |
| --- | --- | --- |
| 飞盘命中 | 未冻结时先 `character.Slice`，再 `Die(disc)`。切换完整/切开预制模型；脱离一块独立 `DeathSlice`；剩余身体进入切片死亡动画。通用分支生成角色颜色的 Splatter。 | `Actor.cs:1493–1497`：方向为受击者位置减飞盘位置的单位向量。`Character.cs:220–232`：首次 IsSliced 播 `event:/death/sliced`。 |
| 武器近战 | 同一切片链；攻击者收到成功近战通知。 | `Actor.cs:1526–1534`：方向为受击者减攻击者，`DeathSlice` 最后归一化。 |
| 爆炸 | `GetExploded()` 生成 Splatter、设置 IsSquished、朝下转向、尝试留下 3 处汁液贴花；之后 IsBurnt。一般不是抛出武器切片。若身处危险地形，继续死亡后的坠落。 | `Actor.cs:1579–1602,2545–2569,2618–2620`；直接播放 `event:/death/exploded`，帽子沿爆心到角色方向抛出。 |
| 挤压 / telefrag | 与 GetExploded 共用压扁和汁液，但挤压另禁用物理碰撞。 | `Actor.cs:2539–2550,2614–2616`。不要把这些分支都标成普通武器切片。 |
| 落水 | 先 Falling 状态，最终 FallInHazard 隐藏身体、关碰撞、熄火；播放 Splash 与 WaterBubbles。 | `Actor.cs:2522–2536`；水花音效由 ParticleManager 资源绑定，不在 Actor 的这一行直接写出。 |
| 坠崖 | 与落水共用 Falling 判定，最终走 OffCliff 分支，在向下偏移处播放 CloudPuff，无水花。 | `Actor.cs:1435–1452,2529–2533`；资源绑定 `event:/environment/cloud_puff`。 |
| 越界倒计时到期 | 通用 Splatter 再加 OOBBurst，立即隐藏角色，关物理碰撞，沿负 stored velocity 丢帽子。 | `Player.cs:1466–1495`、`Actor.cs:2635–2643`，`event:/death/outofbounds`。警告阶段还会红色发光、闪箭头和逐渐加快的 warning 音效。 |
| 火焰 | 在 hipJoint 或角色位置生成 FireBurst；Player 设 dead 表情并熄火。烧焦材质与 DeathBurnt 动画独立于切片。 | `Actor.cs:2622–2631`、`Player.cs:3341–3354`、`Character.cs:246–278`。Web 当前没有完整火焰玩法，此分支保留为研究结果。 |
| 冻结中死亡 | 普通武器命中会跳过 Slice；死亡时隐藏角色，播 shatter、Splatter、丢帽子，再由 Player 后续 Unfreeze 处理冻块粒子。 | `Actor.cs:1493,1528,2651–2657`、`Player.cs:3453–3457`。Web 当前未实现冰冻，不把它伪装为已支持。 |

`Actor.Die` 先中断攻击/冲刺、清速度、切 Dead、关闭伤害碰撞，再选视觉分支（`Actor.cs:2586–2646`）。`Player.Die` 还处理得分、复活规则、武器归属和相机。视觉状态不应反向决定角色是否死亡。

## 切片不是任意网格切割

`CharacterSliced.cs` 是空 MonoBehaviour 标记。真正实现位于：

1. `CharacterPlayer.cs:124–142`：启停 `bodyNormal[]` 与 `bodySliced[]`；这是预制形状替换。
2. `CharacterPlayer.cs:318–332`：调用 DeathSlice；Avocado 是沿自身 up 的特殊例外。
3. `DeathSlice.cs:28–42`：脱离父对象、保留/调整朝向、归一化方向，交给 Debris3D。
4. `Debris3D.cs:90–101,118–173`：独立 Rigidbody2D 平面速度，加手动竖直速度、重力、自转、反弹；着地后仍可被玩家/近战推动，也能被移动地板带走（`:194–247`）。
5. `CharacterPlayer.cs:364–377`：延迟 `slicedFaceplantDelay` 后播放扑地尘雾和 `event:/combat/faceplant`。代码默认延迟 0.75 秒（`Character.cs:136`）；本轮没有完整解析各角色的该继承字段，不能保证所有 override 都是 0.75。

`CharacterCarrot.cs:76–91` 还会将 extraSlices 分别偏转发射；不能从主 DeathSlice 推导所有角色都只有两块。Milk 则在切开后开 pour/splat 粒子，0.45 秒后印白色液体贴花、再过 0.1 秒隐藏液面（`CharacterMilk.cs:60–102`）；特定 DeathMatch 设置下该贴花 lifetime=0，持续到回合清理。

主资源 `sharedassets1.assets:9682`（MilkChar）、`:9781`（EggplantChar）、`:9836`（WatermelonChar）的切片配置相同：

| 参数 | 序列化实际值 |
| --- | ---: |
| speed / speedZ | 20 / 10 |
| gravityMod / bounciness | 7 / 0.7 |
| floorThreshold / speedLimit | -0.4 / 40 |
| spinSpeedStart / spinSpeedBounce | -100 / 60 |
| lifetimeDuration / vanishDuration | 0 / 0.75 |
| Rigidbody2D linearDrag | 2.5 |

对应 Rigidbody2D IDs 为 `8324/8330/8320`。`lifetimeDuration=0` 表示不会因着地时长自行消失（`Debris3D.cs:164`），并非零秒立即销毁。其他碎片确实存在 2、3、7 秒配置，因此不能统一所有碎片的生命周期。

## 汁液、水花和爆炸资源

`level1:9287` 是 ParticleManager（对象文件偏移 1548760，2104 字节）。表中引用的粒子都在 `sharedassets1.assets`；系统 duration 是管理器回收时刻，单粒子寿命另列，不能混为一谈。

| PFX | ParticleSystem ID | system duration | 根粒子寿命 | 资源绑定音效 |
| --- | ---: | ---: | --- | --- |
| Splash | 8989 | 2s | 0.55–0.65s | event:/death/splash_medium |
| Splatter | 8919 | 2s | 1–1.66s | 无直接绑定 |
| OOBBurst | 9025 | 1s | 0.2s | 无直接绑定；Actor 播 outofbounds |
| WaterBubbles | 8931 | 2s | 0.5–0.9s | 无直接绑定 |
| CloudPuff | 9031 | 2s | 0.5–1s | event:/environment/cloud_puff |

Splatter 根发射速度 6–14，粒子大小 2–3；这些是 Unity 资源单位，并非 Web 像素。粒子层级和材质会影响最终观感，本轮没有导出其完整原始外观。

`ParticleManager.cs:68–105,117–158` 会按角色色、关卡水色或地面尘色改色，也可递归改子粒子；`:218–225` 按根 system duration 回收。`SplatDecalSpawner.cs:10–23` 在粒子碰撞速度大于 5 时最多生成 4 个贴花。`DecalManager.cs:31–47` 会检查该点有地板，避免在水面/空中留下地面汁液。

`sharedassets1.assets:9867` SplatDecal 实际 min/maxSize=0.75/1.5，scaleIn=1s、lifetime=4s、scaleOut=0.5s（派生数据相对偏移 44/48/196/200/204）。这覆盖了 `Decal.cs` 中 lifetime=20 的代码默认值。移动地板贴花重挂父对象见 `SplatDecal.cs:25–45`。

爆炸本身由动态网格半径曲线表现，沿障碍角点和圆周发射射线形成被墙遮挡的范围，并在有效时段执行杀伤（`Explosion.cs:126–183,238–262,284–315`）。主爆炸 prefab `sharedassets1.assets:9651` 的实际半径 12、总时长 0.8 秒、末尾无伤害 fade 0.1 秒；不能使用类默认 5.5/0.75/2。Mini 半径减半，摄像机震动强度减半（`:85–109`）。当前 Web 爆炸范围仍属于自己的玩法配置，这里未改动它。

相关动画资源：DeathSliced 21 条约 1.4667 秒、另 1 条 1.3 秒；DeathSlice 1 条约 1.5833 秒；DeathBurnt 22 条 1.25 秒；Fall 22 条约 0.7667 秒、另 1 条 0.9 秒。这些是 clip 范围，不能直接替代状态机退出时间或死亡判定时间。

## 落水、坠崖与反馈节奏

- `Actor.cs:2683–2720`：水 .66 秒、崖 .74 秒；`fallAffordance=.33` 在 `:251`。前 .33 秒重新回到地面可被救回，不能一离开地板就把 alive 置 false（`:1787–1811`）。
- `FallOffCliff` 等待 .3 秒，再用 .45 秒将 anim 的本地 z 从 0 移到 5（`:1435–1452`）；Unity 此项目用 XY 平面和 z 高度，Web 转为 XZ 平面和 y 高度。
- 切片、近战、爆炸、teamkill FreezeFrame(.1)（`Player.cs:3489–3494`）。落水/越界不会无条件获得这次 .1 秒 hit stop。
- 常规死亡 SlowMoEffect(.5,.5)（`Player.cs:3325–3328`）经过 .5 秒进入、.5 秒保持、.5 秒退出，目标比例默认 .2；重复触发有延长/重置规则，见 `TimeKeeper.cs:129–158`。用户可关闭 slow-mo，GoldenDisc 和教程也有条件。
- Player 死亡 Shake(.4,.4)（`Actor.cs:2647–2650`），Camera 内部把 duration 乘 3，因此内部是 1.2 秒指数衰减（`Camera3D.cs:335–356`）。爆炸另有 Shake(2,.75)，mini 为(1,.75)。冻结帧时不推进相机震动。
- `CameraFX.cs:58–71` 证实的是 vignette 从 .4 增到 .46；`TimeKeeper.cs:97` 驱动它。本轮死亡调用链没有全屏白闪的调用证据，因此不以“原版死亡白闪”名义加入白色遮罩。
- 最后一击可能触发 ZoomInOnKill；它要考虑活动爆炸/移动机关并经过延迟，不能简单地把相机永久锁到赢家（`Player.cs:3495–3505`、`Camera3D.cs:450` 起；详见 transitions-analysis.md）。

## 本轮 Web 呈现契约与已实现范围

`Actor.death` 保存 `{cause,variant,time,position,direction,seed}`，variant 为 `slice/squash/water/cliff/burst`。位置固定为死亡地点，方向为伤害方向，facing 使用死亡后稳定的 actor.facing。`Actor.fall` 保存 kind/elapsed/duration，只有模拟层能判断救回或死亡。

- `src/rendering/death-visuals.ts`：纯采样，输入记录与模拟时间，输出切片/扑地姿态、粒子、水纹和贴花；固定 seed 决定随机外观，无隐藏计时器。
- `src/rendering/death-models.ts`：自己搭建的西瓜截块、茄子/橙子半体、牛奶盒开口和顶块；固定预制切形语义，非动态任意网格切割。爆炸使用压扁焦黑残体。
- `src/rendering/characters.ts`：不再所有死因统一侧倒缩小；slice/squash 保留残体，water/cliff/burst 隐藏身体；fall 的可救回阶段只改姿态。无敌闪烁仅对 alive 生效，避免旧 invulnerable 让已隐藏尸体重现。
- `src/rendering/effects.ts`：`syncDeaths(state)` 重建每个死亡快照的汁液/水花/水泡/崖云；一次性 death 事件不再重复生成通用特效。回合清理、复活和重新开始删除对应显示及私有 GPU 资源；多个渲染器独立持有这些资源。

Web 的 0.4 空间缩放沿用项目约定，因此主切片初速 8、向上初速 4、重力 9.82×7×0.4、水平阻尼 2.5、反弹系数 .7。轨迹为可任意采样的解析近似，旋转、落地点、底部扑地姿态及粒子形状是 Web 适配；没有复刻 Unity 碰撞求解、切片再次被推击/压碎/掉入水、角色完整骨骼动画、所有装扮或液体专属资产。普通贴花采用资源时长 1+4+.5 秒，牛奶采用白色，但暂未完整复制 Milk 的持续倒液流程。

`tests/death-visuals.test.ts` 验证 8 项：所有死因可重复/倒退采样，方向与残片保留，表现分支，随机值/坐标范围，晚挂载与重复事件，独立资源释放，可救回落水恢复，以及已死亡角色不被旧无敌标记重新显示。截图 fixture 只验证本实现画面；它不是原版运行对比，也不是端到端玩法通过的证据。
