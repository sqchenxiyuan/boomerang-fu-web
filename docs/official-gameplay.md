# Boomerang Fu 官方玩法笔记

核验日期：2026-10-27（Asia/Shanghai）。这里只使用开发者官网、Steam 商店及 Steam 官方开发者公告；没有运行游戏，也没有把营销文案当作精确模拟参数。公告内容经文末 Steam News API 批量接口实际读取，单篇链接采用 API 原样返回的 URL，标题与 gid 一并列出。部分单篇网页直连超时，正文证据来自已成功读取的官方 API。

## 核心定位与操作

| 项目 | 官方直接支持的结论 | 证据 |
| --- | --- | --- |
| 开发者 | Cranky Watermelon；Steam App ID 为 965680 | S2 |
| 基本形态 | 食物角色参与快节奏、分回合的物理战斗；最多 6 名本地玩家。Steam 标记单人、同屏 PvP、同屏合作与 Remote Play Together | S1、S2 |
| 输入规模 | 一个方向摇杆与三个主要按钮；商店推荐手柄，并提供完整手柄支持 | S1、S2 |
| 回旋镖 | 投掷、弯曲投掷轨迹绕过墙角、召回掉落回旋镖、反弹敌方攻击都是明确宣传的操作能力 | S1、S2 |
| 冲刺与近战 | 发售公告明确写 dash；1.0.7 公告直接提及 Slash / slash attack。穿墙强化生效时不能在墙内进行 Slash，也不能在穿越长墙时中途改变方向 | S3、S4 |
| 键盘 | 1.0.6 增加可改键菜单，公告以 WASD + JKL 描述原有默认按键组；不能据此确定目前本地配置或 J/K/L 各自绑定 | S5 |
| 联机边界 | 官方明确宣传 Steam Remote Play Together；它依靠主机画面串流与远端输入。这里没有找到原生独立客户端联网协议的证明，不能据此规划原版网络同步复刻 | S2、S3 |

**适合复刻研究的核心问题：** 玩家何时有回旋镖、何时空手，投掷/飞行/落地/召回/接取如何衔接，以及近战反弹、冲刺躲避与场景遮挡如何互相制约。官方文案证明这些能力存在，但没有给出完整状态机和时序。

## 模式与回合规则

| 模式 | 官方可确认内容 | 仍需本地代码或实机核验 |
| --- | --- | --- |
| Free For All | 独立的标准混战模式；1.3.5 增加地图选择且会保存选择 | 计分到底按存活、击杀还是可选规则；目标分、平局、回合时限 |
| Team Up | 玩家可以合作对抗 AI；可让全部机器人加入 Team Chill，官方举例 1 名玩家打 5 个高难度机器人；存在队友复活。1.1.3 后机器人也会复活队友，复活空手队友会自动补一把回旋镖 | 复活距离、按键、持续时间、队伍上限、复活打断条件 |
| Golden Boomerang | 争夺黄金回旋镖；持有足够时长获胜，1.0.8 对 2–3 人局增加所需持有时长；1.1 中出界时持有计时只有正常速度的 1/3；模式有复活 | 黄金镖和普通投掷的交互、死亡是否重置累计时间、准确目标时长 |
| Hide & Seek | 1.3.1 免费更新加入。每人轮流当 seeker，闭眼期间其他人寻找藏身处；当时规则为 10 秒后藏家变成邻近道具，seeker 辨别真假。时间限制、搜查次数可调；1.3.5 又增加可调躲藏准备时间 | 搜查操作、错误惩罚、比分算法、是否允许机器人及其具体行为 |

来源：FFA 与选图见 S6、S10；队伍见 S2、S5、S7；黄金回旋镖见 S2、S8、S9，S10 的 bug fix 明确涉及该模式复活；捉迷藏见 S11、S10。

公告还明确存在 **Sudden Death**；1.1 将它的最终位置从地图正中改为随机地图位置（S9）。其缩圈几何、启动条件和伤害不能从这条公告还原。

## 强化与组合

官网列出的强化名称包括：Move Faster、Dash Through Walls、Teleport、Explosive Boomerang、Multi Boomerang、Fire Boomerang、Ice Boomerang、Disguise、Shield、Battle Royale、Telekinesis、Decoy（S1）。这些是官网展示项，**不是本地版本的完整枚举证明**。

- 官方直接确认强化可叠加形成组合；火焰、冰冻、爆炸、多镖、传送、念力都有明确文字说明或名称（S1–S3）。
- Decoy 在 1.1.3 加入：冲刺时制造幻影分身；1.2.0 进一步让分身复制玩家的回旋镖数量和 Caffeinated 强化后的速度（S7、S12）。因此“更快移动 + 分身”存在明确的交互证据。
- Bamboozled 在多篇更新中出现，而官网强化图列没有显示它；1.3.1 规定一场 match 的首个拾取强化不会是 Bamboozled（S5、S11）。不要按官网图标数量硬编码总数。
- 发光配方书是强化拾取物的官方描述；强化生成速率可调，官方举例可以开到 2 倍（S8）。
- 1.0.6 曾规定每获得一个强化后生成频率降低 20%；可选强化种类少时也降低生成频率。这是历史平衡说明，是否仍使用同一公式必须核验本地版本（S5）。
- 常规模式的强化容量不能只凭“3rd power-up”或“错误收集 4 个”推定；黄金回旋镖模式有自己的容量规则，1.1 将其上限增加 33%，且随回合继续增加（S4、S8、S9）。
- 可定制启用哪些强化、关闭护盾、开启友伤（S1、S2）。自动平衡护盾也被历史修复记录明确提及（S8），需区分它与拾取 Shield 的规则。

## 地图与环境

- 官网和基础游戏商店文案写 **30 多张竞技场**；这只是营销页的范围描述，不能作为当前安装中的精确关卡数（S1、S2）。
- 官方明确列出移动平台、可穿行的植被、触发滑动墙挤压敌人、巨大擀面杖等工具/陷阱（S2）。
- 1.1 免费更新新增 6 张地图；Just Desserts DLC 宣传 21 张新地图，以及会崩塌的古桥、旋转平台和巨大黄油块机关（S9、S13）。是否安装、可用还需查本地内容。
- 公告确认还存在传送门、浮动平台、坠落地板陷阱；部分地图被从 Golden Boomerang 或 Hide & Seek 移除，不能假设每种模式共用同一地图池（S10、S11、S14、S15）。
- 1.3.1 加入 Fall Protection：Off 为旧行为；Gentle 默认轻推角色远离边缘；Extreme 完全阻止玩家走下边缘。这会直接影响移动/碰撞复刻，不能仅实现“走到边缘就落水”（S11）。

## 已确认与未确认的边界

官方文字足以确认“最多六人同屏、短回合、投掷/召回/弯曲回旋镖、冲刺、Slash、可叠强化、互动地图、四种已发布模式、AI 与队友复活”的系统轮廓。

下面都需要本地逆向或实机测量，不能从本笔记当作事实抄进 Web 实现：一击必杀的例外、碰撞半径、移动加速度、冲刺距离/冷却/无敌帧、Slash 判定角度/窗口、反弹归属、回旋镖速度/曲率/飞行时长、落地与召回触发条件、强化替换顺序与跨回合保留、准确 AI 策略、物理步长、全部地图清单。官方说“physics combat”也不能证明具体使用哪种物理引擎。

## 精确来源

- **S1** 开发者官网：<https://www.boomerangfu.com/>
- **S2** Steam 商店：<https://store.steampowered.com/app/965680/Boomerang_Fu/>；本次读取的结构化商店接口：<https://store.steampowered.com/api/appdetails?appids=965680&l=english>
- **S3** `Boomerang Fu - Release Date Announcement`，gid `3444640809422813101`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/3444640809422813101>
- **S4** `Performance Improvements and Bug Fixes in Update 1.0.7`，gid `5422856308610568385`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/5422856308610568385>
- **S5** `New Options and Languages in Update 1.0.6!`，gid `3670950880883541529`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/3670950880883541529>
- **S6** `FREE DEMO during Steam Festival`，gid `3309530667994621957`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/3309530667994621957>
- **S7** `New Decoy Power-Up and Better Bots in Update 1.1.3`，gid `4038025325475609863`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/4038025325475609863>
- **S8** `Adjust the Power-up Spawn Rate in the Latest Update`，gid `3856733878307194952`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/3856733878307194952>
- **S9** `The Grilling Spree Update is OUT NOW`，gid `4767601588110550909`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/4767601588110550909>
- **S10** `Update 1.3.5 Patch Notes`，gid `1795283637874698`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1795283637874698>
- **S11** `New Hide & Seek Mode` / 1.3.1，gid `5746109972566769019`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/5746109972566769019>
- **S12** `New Languages and Bug Fixes in Update 1.2.0`，gid `4971406207536249763`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/4971406207536249763>
- **S13** `Just Desserts DLC is out now!`，gid `6890025005350405175`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/6890025005350405175>
- **S14** `Update 1.3.2 Patch Notes`，gid `5747236506605686586`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/5747236506605686586>
- **S15** `Update 1.3.3 Patch Notes`，gid `5759622039982425475`：<https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/5759622039982425475>

抓取入口为 <https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=965680&count=100&maxlength=0&feeds=steam_community_announcements>，仅使用 `steam_community_announcements` 开发者公告源。Steam News Hub 的 `/view/<gid>` 不一定对应公告 gid，本笔记未将未验证的此类链接当作来源。
