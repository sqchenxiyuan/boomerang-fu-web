# 原版地图资源清单与几何提取

当前安装中有 **57 张正式地图和 1 张教程**。完整导出覆盖 58 个独立 `LevelAsset`、59 个关卡构建条目；`LevelToaster` 在构建索引 8、33 重复，465 个 Collider 的形状及世界坐标相同。索引 0、1 是 `LoadingScene`、`GameScene`，不计地图。

这份记录来自只读解析安装资源与托管程序集元数据，没有启动原版。它证明资源中的配置、层级和空间数值；运行时玩法还需要对应 Web 状态机和浏览器测试。

## 安装身份

| 项目 | 值 |
| --- | --- |
| Steam app / build | `965680` / `20430461` |
| Depot / manifest | `965681` / `8723037355367748083` |
| Unity | `2022.3.62f2` |
| 安装目录 | `F:\SteamLibrary\steamapps\common\Boomerang Fu` |
| Assembly-CSharp.dll SHA-256 | `7e5a31b96c64150455340067314538af3399b723cd11d9891a065bde2dce2a6f` |
| globalgamemanagers SHA-256 | `92776e6a29019fa67439b8b00abb27be47a326c80998125713cd836f1267dde2` |
| sharedassets1.assets SHA-256 | `7421b9f85a2afe32e478e457360eb26fa27e5fbcd9cb7555261d94f061ed7f3f` |

## 覆盖范围

- 扫描全部 **63 个顶层 `.assets` 文件**，发现 58 个 `LevelAsset`，均被 `LevelManager.levelAssets` 引用；无未入目录的额外 LevelAsset。
- 基础内容 37 个资产，其中 36 张正式地图、1 张教程；`JustDessertsPack` 21 张正式地图。`DownloadableContentID`: 0=None、1=FreshFlavorsPack、2=JustDessertsPack，当前地图目录未使用 1。
- 复杂度为 Tutorial 1、Simple 21、Advanced 36；5 张地图最大玩家数为 4，其余 53 张为 6。出生点总是保留全部 6 个，最大玩家限制来自 LevelAsset。
- 59 个关卡文件合计 55,395 个 GameObject、同数 Transform、15,940 个 Collider2D；其中 10,365 个在序列化层级中 active 且 enabled。该计数包含重复 Toaster。
- 生产目录包含 3,338 个障碍、860 个地面、11 个水/滑面区域、44 个传送门。
- 全部 57 张正式地图的原版预览 Sprite 已提取到本地 `analysis/derived/v5-maps/previews/`；教程 `mapSprite` 为 null，contact sheet 明确标记没有源预览。预览是资源中的地图缩略图，不是这次运行截图。

## 数据位置与重现

| 文件 | 内容 |
| --- | --- |
| `scripts/research/export-original-maps.py` | UnityPy 全场景提取器，包含资源 hash、GO/Transform、Collider、本地/世界坐标、MonoBehaviour 原始字节和字段、Mesh 可视包围盒 |
| `scripts/research/inventory-original-level-assets.py` | 扫描全部 .assets，核对目录遗漏 |
| `scripts/research/convert-original-maps.py` | 转换为 Web 的标量空间数据与规则实例，未复制模型、贴图、音频和代码 |
| `scripts/research/validate-original-maps.py` | 验证目录、原始 header、引用范围、父子关系、世界坐标往返与生产链接 |
| `scripts/research/export-original-map-previews.py` | 仅供本地对照的原版 Sprite 和 contact sheet |
| `analysis/derived/v5-maps/catalog.json` | LevelManager 引用顺序、LevelAsset 来源/pathID、模式、DLC、人数和复杂度 |
| `analysis/derived/v5-maps/level2.json` … `level60.json` | 每个构建关卡完整静态证据，包含未启用节点与非玩法碰撞体 |
| `analysis/derived/v5-maps/all-level-assets.json` | 63 个资产文件 hash 与全部 LevelAsset 核对 |
| `analysis/derived/v5-maps/serialized-schemas.json` | 托管程序集 hash、生成的序列化字段树、已处理的 header 对齐差异 |
| `analysis/derived/v5-maps/validation-report.json` | 本次静态校验结果 |
| `analysis/derived/v5-maps/conversion-report.json` | 每图转换数量、视觉圆轮廓离散说明、拾取候选点来源 |
| `src/core/original-map-data.json` | 可分发的空间数值、实例规则和来源摘要，58 项 minified 数组 |

解析器使用项目内 `tools/python/UnityPy` 1.23.0 与本地分析依赖 `analysis/derived/v5-tools/TypeTreeGeneratorAPI` 0.0.10。生成器只读取 Managed DLL 元数据，不执行目标程序集。使用项目已配置的 bundled Python，按 export → inventory → convert → validate 顺序运行。

生产 JSON：4,014,868 bytes；SHA-256 `2f74e5c3393ef5555a3f91e461dd581fab65bad2154870d91503698649600e44`。

## 坐标、层与形状

权威提取数据保持 Unity XY 物理坐标、完整 XYZ local TRS 和父子层级。`worldMatrix` 为 row-major 4×4，使用列向量乘法，按父世界矩阵 × 本地 TRS 累乘。Web 投影固定 `x=Unity.x×0.4`、`y=-Unity.y×0.4`，高度使用 `-Unity.z×0.4`。Collider `m_Offset` 必须先经完整世界变换，不能直接加到 Web position。

生产 `c-123`、`f-123`、`s-123` 对应该图原始 Collider pathID=123；`m-123`、`p-123` 对应机制/传送门 MonoBehaviour pathID=123。`provenance.sceneFile` 与每图 source hash 可定位本地完整对象记录，包含 byteStart/byteSize。

| 语义 | 原层/规则 |
| --- | --- |
| 玩家障碍 | Actor.obstacleLayer 256，仅 layer 8 `Obstacle` |
| 玩家支撑地面 | Actor.floorLayers 1610678272：16 `Floor`、29（未命名）、30 `MovingFloor` |
| LevelManager 地面检查 | floorLayers 1073807360：16 + 30，与 Actor mask 不同 |
| 水区域 | layer 4 `Water`；云图坠落种类仍要查询区域 |
| 滑面 | layer 26 `WetFloor`；是独立 surface，不自动当支撑地面 |
| 植物触发 | layer 21 `Plant`，不加入实体障碍 |
| 开关 / 传送门 | layer 24 / 25，实际触发形状及引用链单独保留 |
| Particle3D | layer 20，碎片的碰撞体保存在证据，未冒充关卡实体障碍 |

地面是所有有效支撑形状的 union，不能拿关卡 boundary 替代。例如 Enclosed 的 `FloorCollider` 是 100×100，而对局 boundary 是 43×43。真实地面可超出边界，物理数据不裁切；相机和视觉远景可以另作处理。

### 圆碰撞缩放规则的官方证据

[Unity 2022.3 CircleCollider2DTool.cs](https://github.com/Unity-Technologies/UnityCsReference/blob/a322ce5f78a82cf7ea211857a45338136ed7a22f/Modules/Physics2DEditor/Managed/Colliders/CircleCollider2DTool.cs) 的 `GetRadiusScaleFactor` 明确返回 `Max(Abs(transform.lossyScale.x), Abs(transform.lossyScale.y))`。因此世界半径是源 radius × 该缩放；倾斜或非均匀缩放不会把圆投影成椭圆/直线。中心仍由完整矩阵变换 offset 后投影到 XY。

[PrimitiveCollider2DTool.cs](https://github.com/Unity-Technologies/UnityCsReference/blob/a322ce5f78a82cf7ea211857a45338136ed7a22f/Modules/Physics2DEditor/Managed/Colliders/PrimitiveCollider2DTool.cs) 明确约束 2D 旋转；[BoxCollider2DTool.cs](https://github.com/Unity-Technologies/UnityCsReference/blob/a322ce5f78a82cf7ea211857a45338136ed7a22f/Modules/Physics2DEditor/Managed/Colliders/BoxCollider2DTool.cs) 则使用 localToWorldMatrix 的 XY 投影矩阵表示 Box。来源与本地文件 hash 见 `analysis/derived/v5-unity-physics-evidence.json`。

所有生产圆障碍使用 `radius` 做真实圆检测，82 个圆地面与 3 个圆滑面也输出 `radius`；32 点 `paths` 仅供视觉轮廓使用。Pooled/BirchTrunk 圆不会因 90° 倾斜退化。完整原始 3D basis 仍保留在证据中，不再误当物理椭圆。

### 可视高度与静态合批

Unity 的可视 Mesh 可以向地面下方延伸。生产障碍/传送门分别保存 `baseHeight=-worldMaxZ×0.4` 和 `height=(worldMaxZ-worldMinZ)×0.4`，顶部是两者之和；不能把整个地下跨度从零向上挤出。运行时升降只增加相对位移。障碍的 `sourceLayer` 同时保留源碰撞层供交互射线筛选。

静态合批 Mesh 可能包含多个不相关物体。导出按 MeshRenderer 的 `m_StaticBatchInfo.firstSubMesh/subMeshCount` 选择子网格包围盒，并仅应用 `m_StaticBatchRoot` 世界矩阵；根为空时顶点已经处于世界空间，不能再次施加 MeshFilter 所在物体的 Transform。完整 Mesh AABB、各 submesh AABB、所选范围和实际坐标空间都留在本地证据。普通非合批 Mesh 使用自身 local AABB 与世界矩阵。

例：FourCogs (`level45`) 的 `c-2386`/`PoleForBunting_A (1)`，MeshFilter 2168 与 MeshRenderer 1881 引用 Mesh 2 的 submesh 5；同一 Mesh 的 submesh 4 是巨大地板。只选该柱子后 Web 底部约 -0.1081、顶部约 4.1425，不能使用整批 Mesh 后重复变换产生的近 95 单位高度。Enclosed `c-1694` 的真实底部约 -2.1400、顶部约 1.1602。

## 机关实例

| 机制 | 58 独立地图的活动实例 |
| --- | --- |
| 敲击动画 `animated` | 3 |
| 可破坏物 `destructible` | 358 |
| 运动障碍/旋转父节点 `movingObstacle` | 42 |
| 开关 `switch` | 60 |
| 植物 `plant` | 3760 |
| 连锁坠落地板 `fallingFloor` | 129 |
| 自动移动地面 `movingFloor` | 16 |
| 升降门 `door` | 24 |
| 开关移动地面 `reactiveFloor` | 14 |
| 碾碎触发区域 `destroyer` | 6 |
| 踩踏地板 `trapFloor` | 397 |

`movingObstacle` 的 42 个实例由 MovingObstacle 35、MovingObstacleButter 1、MovingObstacleRollingPin 3、有效 Z 轴 AutoRotate 3 组成。TurnTeleportals 同 GO 的两个相同 AutoRotate 会重复设置同一个角度，合并为 1 个驱动，不能把速度相加。原始 AutoRotate 的 X/Y 装饰转动保留在证据中，未变成平面机关。

每个运动节点拥有 `floorIds`、`obstacleIds`、`portalIds`；内部可破坏物等节点以 `parentId` 关联。路径坐标经过父矩阵后变为 Web 世界坐标，同时输出 `motionOrigin/motionAngle`，以便 circular/supercircular 等按父坐标轴求插值。MovingFloor 的 `positionRotations.z` 和 MovingFloorReactive 的 `positions.z` 在 `useRotations` 启用时都是角度而非高度。MovingFloorReactive 的 `StartMoving` 为空，必须等开关触发，不能按自动地面启动。

RotatingObstacleController 在真实关卡里仅发现 1 个，序列化 `m_Enabled=0`，生产运行时不启用。GoldenTotem 只在 GoldenDisc 保留，当前淘汰赛转换未把它当常驻地面机关。Trap、TempHazard、Pushwave、LevelProcedural、LevelRandomChunk、RandomEnabler 在这些关卡中没有活动实例；类定义存在不等于每图需要造一个。

教程的 `playerSpawnPoints` 初始为空，LevelTutorial.Init 从 6 个 `playerSpawnPods` 的 `PlayerSpawn` 子节点填入。转换恢复全部 6 个源点。原版 <=2 人时交错选择 pods，>2 人时取前 N 个，并关闭其余 pod；教程目标引导与人数相关 pod 激活应作为教程流程处理。

## 验证与保留边界

- 14,049 个 MonoBehaviour 的 raw bytes 长度、GO/header、script pointer 检查通过；用户字段解析没有未读尾部。TypeTreeGenerator 0.0.10 的 MonoBehaviour header 把 alignment 放在 script PPtr 之后，导致单独 script 指针错位；导出器从已验证的 byte 16 独立恢复指针，并核对 GO/name/enable。原始字节保留，避免继承中同名隐藏字段被字典覆盖后失去证据。
- 4,209 个生产 Collider 轮廓重新旋转/平移后与源世界形状一致，最大 Web 坐标差 7.87607324e-06；所有机制目标、父节点、所属地面/障碍与 portal exit 引用闭合。
- 274 个静态合批 Renderer 的子网格范围和坐标空间检查通过；3,338 个障碍保留 sourceLayer 与可视底部/高度，7 个启用旋转的地面机关角度与源字段一致。FourCogs 柱子的 172 个原始顶点与所选 submesh AABB 最大差 2.980232238769531e-7，数值证据见本地 `height-evidence.json`。
- 57 张正式地图、1 张教程、21 张 DLC 地图计数与目录一致；58 个 map ID 唯一，每图保留 6 个出生点。
- 某些源出生点与障碍存在初始半径接触，坐标保留不移位；Web 用正常角色去穿透过程处理，不能把移动源出生点伪装成原版数据。
- Mesh 只把按 Renderer/静态合批范围校正的包围盒转换为可视底部和高度，没有发布原模型。通用墙、树、竹、门的程序化外观不等于原画。材质优先使用原 InteractiveObstacle 枚举；无枚举时根据明确源名称推断，在 `sourceName` 留下依据。
- `pickupSpawns` 使用原 disc spawn（如果有），否则用原玩家出生点作为候选；原版 powerup 点由运行时空间采样生成，不能把这些候选声称为原始固定掉落表。
- 日夜、隐藏/搜寻摆件、教程 pods、坠落随机顺序等是运行时变体，不另算独立地图。Mode/DLC/玩家人数元数据保留并不证明相应整套比赛模式已在 Web 实现。
- 这份静态验证没有测量 Unity 原版运行时碰撞/相机/动画，也没有覆盖 Web 帧率；这些由独立行为测试和浏览器检查记录。

## 完整地图目录

表中 Collider 数为该源场景全部碰撞体，包含未启用/碎片/装饰；生产障碍与地面分别按上面的真实 layer 和活动状态筛选。内部场景名来自源资源，不将自定义的旧 5 张地图混入此表。

| Web ID / 原场景 | build index | 来源 | 复杂度 | 最大人数 | 源 Collider | 生产障碍 / 地面 |
| --- | --- | --- | --- | --- | --- | --- |
| `original-enclosed` / LevelEnclosed | 2 | 基础 | Simple | 4 | 144 | 72 / 2 |
| `original-slide-traps` / LevelSlideTraps | 3 | 基础 | Advanced | 6 | 194 | 71 / 1 |
| `original-turnstile` / LevelTurnstile | 4 | 基础 | Advanced | 6 | 110 | 34 / 8 |
| `original-pools` / LevelPools | 5 | 基础 | Advanced | 6 | 72 | 35 / 1 |
| `original-marketplace` / LevelMarketplace | 6 | 基础 | Simple | 6 | 439 | 65 / 1 |
| `original-washer` / LevelWasher | 7 | 基础 | Advanced | 6 | 225 | 55 / 1 |
| `original-toaster` / LevelToaster | 8,33 | 基础 | Simple | 6 | 465 | 58 / 14 |
| `original-plants` / LevelPlants | 9 | 基础 | Advanced | 4 | 1169 | 33 / 14 |
| `original-rooms` / LevelRooms | 10 | 基础 | Simple | 6 | 82 | 62 / 2 |
| `original-cloud-sweep` / LevelCloudSweep | 11 | 基础 | Advanced | 6 | 407 | 59 / 12 |
| `original-whisk` / LevelWhisk | 12 | 基础 | Advanced | 6 | 108 | 44 / 1 |
| `original-temple-garden` / LevelTempleGarden | 13 | 基础 | Advanced | 4 | 1699 | 29 / 3 |
| `original-falling` / LevelFalling | 14 | 基础 | Advanced | 6 | 105 | 14 / 38 |
| `original-island` / LevelIsland | 15 | 基础 | Simple | 6 | 224 | 62 / 9 |
| `original-mini-island` / LevelMiniIsland | 16 | 基础 | Simple | 4 | 75 | 24 / 12 |
| `original-clouds` / LevelClouds | 17 | 基础 | Advanced | 6 | 377 | 63 / 18 |
| `original-falling2` / LevelFalling2 | 18 | 基础 | Advanced | 6 | 162 | 28 / 98 |
| `original-square` / LevelSquare | 19 | 基础 | Advanced | 6 | 141 | 38 / 4 |
| `original-wheel` / LevelWheel | 20 | 基础 | Advanced | 4 | 88 | 33 / 3 |
| `original-maze` / LevelMaze | 21 | 基础 | Simple | 6 | 80 | 71 / 1 |
| `original-ring` / LevelRing | 22 | 基础 | Advanced | 6 | 230 | 67 / 10 |
| `original-forest` / LevelForest | 23 | 基础 | Simple | 6 | 429 | 51 / 1 |
| `original-split` / LevelSplit | 24 | 基础 | Advanced | 6 | 210 | 36 / 15 |
| `original-moving` / LevelMoving | 25 | 基础 | Simple | 6 | 81 | 69 / 1 |
| `original-drift` / LevelDrift | 26 | 基础 | Advanced | 6 | 105 | 19 / 9 |
| `original-tracks` / LevelTracks | 27 | 基础 | Advanced | 6 | 291 | 38 / 3 |
| `original-tutorial` / LevelTutorial | 28 | 基础 | Tutorial | 6 | 290 | 54 / 2 |
| `original-spin` / LevelSpin | 29 | 基础 | Advanced | 6 | 136 | 49 / 8 |
| `original-teleportals` / LevelTeleportals | 30 | 基础 | Advanced | 6 | 115 | 79 / 1 |
| `original-temple` / LevelTemple | 31 | 基础 | Simple | 6 | 350 | 131 / 1 |
| `original-pier` / LevelPier | 32 | 基础 | Advanced | 6 | 410 | 82 / 17 |
| `original-onsen` / LevelOnsen | 34 | 基础 | Advanced | 6 | 182 | 69 / 1 |
| `original-henge` / LevelHenge | 35 | 基础 | Simple | 6 | 83 | 59 / 1 |
| `original-bridges` / LevelBridges | 36 | 基础 | Advanced | 6 | 353 | 48 / 19 |
| `original-mist` / LevelMist | 37 | 基础 | Advanced | 6 | 207 | 63 / 17 |
| `original-bamboo-grove` / LevelBambooGrove | 38 | 基础 | Simple | 6 | 815 | 52 / 1 |
| `original-pinball` / LevelPinball | 39 | 基础 | Simple | 6 | 391 | 108 / 1 |
| `original-big-raft` / LevelBigRaft | 40 | Just Desserts | Advanced | 6 | 223 | 44 / 59 |
| `original-circle-maze` / LevelCircleMaze | 41 | Just Desserts | Simple | 6 | 234 | 57 / 2 |
| `original-courtyard` / LevelCourtyard | 42 | Just Desserts | Advanced | 6 | 276 | 103 / 5 |
| `original-crate` / LevelCrate | 43 | Just Desserts | Simple | 6 | 382 | 107 / 2 |
| `original-donut` / LevelDonut | 44 | Just Desserts | Advanced | 6 | 240 | 30 / 8 |
| `original-four-cogs` / LevelFourCogs | 45 | Just Desserts | Simple | 6 | 224 | 60 / 9 |
| `original-island-pair` / LevelIslandPair | 46 | Just Desserts | Advanced | 6 | 189 | 41 / 18 |
| `original-jungle-ruins` / LevelJungleRuins | 47 | Just Desserts | Simple | 6 | 113 | 62 / 1 |
| `original-maze2` / LevelMaze2 | 48 | Just Desserts | Simple | 6 | 75 | 51 / 1 |
| `original-pincer` / LevelPincer | 49 | Just Desserts | Advanced | 6 | 205 | 47 / 77 |
| `original-raft-crusher` / LevelRaftCrusher | 50 | Just Desserts | Advanced | 6 | 181 | 46 / 4 |
| `original-raft-pair` / LevelRaftPair | 51 | Just Desserts | Advanced | 6 | 119 | 47 / 24 |
| `original-raft-switches` / LevelRaftSwitches | 52 | Just Desserts | Advanced | 6 | 213 | 88 / 12 |
| `original-raft-switches2` / LevelRaftSwitches2 | 53 | Just Desserts | Advanced | 6 | 269 | 122 / 8 |
| `original-rivercrossing` / LevelRivercrossing | 54 | Just Desserts | Simple | 6 | 283 | 59 / 27 |
| `original-roller-sweep` / LevelRollerSweep | 55 | Just Desserts | Advanced | 6 | 156 | 44 / 8 |
| `original-shrine` / LevelShrine | 56 | Just Desserts | Simple | 6 | 231 | 75 / 4 |
| `original-trap` / LevelTrap | 57 | Just Desserts | Advanced | 6 | 169 | 28 / 81 |
| `original-trap-islands` / LevelTrapIslands | 58 | Just Desserts | Simple | 6 | 195 | 33 / 38 |
| `original-trap-maze2` / LevelTrapMaze2 | 59 | Just Desserts | Advanced | 6 | 305 | 125 / 120 |
| `original-turn-teleportals` / LevelTurnTeleportals | 60 | Just Desserts | Advanced | 6 | 149 | 45 / 1 |

本地总览：`analysis/derived/v5-maps/previews/contact-sheet.jpg`。该目录及所有源图仅供本地分析，未加入 Web 发布包。
