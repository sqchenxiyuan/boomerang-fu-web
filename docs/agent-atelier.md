# Agent 工坊：自定义出战形象

菜单里的“✎ 捏 Agent”会打开工坊。画好的 Agent 可以分配给 1P（AI 观战模式下是第一个机器人），同屏双人时也可以分配给 2P。对局里，这个角色的名字、颜色和三维模型都换成你画的样子，规则和物理完全不变。

## 来源：MUNDI 的 Agent 形象工坊

做法移植自 `Arkevo-Lab/mundi-web` 的 `dev` 分支：

| MUNDI 文件 | 内容 | 本仓库 |
| --- | --- | --- |
| `src/client/features/appearance.js` | 1000² 画板：画笔、填色、橡皮、左右对称、撤销/重做、色板与底色；21 个按种子画的预制生物；`traitsFrom` 从描述里取关键词（颜色、龙、机器人、三只眼…）；`dominantHex` 取主色 | `src/agents/look.ts`、`src/ui/atelier.ts` |
| `src/client/features/agent-world.js` | `voxelizeTex`：把画像按 30×30 体素化，只保留不透明轮廓，每行颜色相近的格子合并成一块；方块头接在按主色着色的方块身体上 | `src/rendering/agent-model.ts` |

几处调整：

- 画板为 512²，这样浏览器里能多存几个 Agent。体素网格仍是 30×30。
- 预览不是 MUNDI 的 Canvas 投影，而是用对局里的 Three.js 角色本身，所以转台上看到的就是对局里的模型，包括手臂、脚、手里的回旋镖和主色光环。
- 体素数据和 PNG 一起保存，对局开始时直接建模，不需要再解码图片。
- 身体只用一个顶点着色网格（头和躯干合并），被切开时按头部下三分之一分成两半，带切面。

## 数据与存储

`localStorage` 键 `boomerang-garden.agents.v1`，最多保存 12 个 Agent：

```ts
interface AgentLook {
  v: 1; id: string; name: string;   // 名字最多 12 个字符，去掉尖括号与控制字符
  img: string;                      // 画板 PNG data URL，透明处不生成方块
  bg: string; hue: string;          // 画板底色、主色（身体、手脚、HUD 颜色）
  grid: number; runs: [x, y, w, '#rrggbb'][];
  updated: number;
}
// slots: [1P 使用的 id | null, 2P 使用的 id | null]
```

读取时会逐项校验，被篡改或格式不对的记录直接丢弃。名字插入 HTML 前会转义。存储不可用或空间已满时，本次会话内仍可使用，工坊会给出提示。

## 边界

- **只影响画面。** 模拟、SDK 状态和录像都不含外观信息，所以对局仍是确定性的，录像格式也不变。看回放时显示默认水果形象。
- 机器人不会自动使用自定义形象，只有被分配到的位置才会用。
- 本轮没有在真实浏览器中验证工坊界面和三维转台，因为开发机缺少 Chromium 运行库。已验证的部分：体素化、主色、存储校验、描述关键词、身份登记、模型尺寸与切片（`tests/agents.test.ts`），以及类型检查和生产构建。
