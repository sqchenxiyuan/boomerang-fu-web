import data from './original-map-data.json';
import type { Arena, MapId } from './types';

export interface MapInfo {
  id: MapId;
  name: string;
  subtitle: string;
  description: string;
  theme: 'garden' | 'canal' | 'sandstone' | 'ruins';
  source: 'original' | 'custom';
  tutorial?: boolean;
  minPlayers?: number;
  maxPlayers?: number;
  complexity?: number | string;
  requiredDLC?: number;
  supportedMatchTypes?: string[];
  buildIndices?: number[];
}

export interface OriginalMapRecord {
  info: MapInfo;
  arena: Arena;
  provenance: { sceneFile: string; sceneSha256: string; levelAssetPathId: number };
}

const MAP_NAMES: Record<string, string> = {
  drift: '漂移浮岛',
  enclosed: '封闭庭院',
  'mini-island': '迷你孤岛',
  falling2: '连环坍塌',
  island: '孤岛',
  maze: '石墙迷宫',
  moving: '移动墙阵',
  plants: '密植花园',
  square: '方块广场',
  rooms: '连通房间',
  spin: '旋转平台',
  teleportals: '传送门阵',
  tracks: '轨道机关',
  tutorial: '教程场地',
  split: '分割岛屿',
  falling: '坍塌群岛',
  wheel: '旋转轮盘',
  clouds: '云端浮岛',
  'slide-traps': '滑墙陷阱',
  pools: '水池庭院',
  marketplace: '集市街巷',
  temple: '神庙',
  'temple-garden': '神庙花园',
  turnstile: '旋转闸门',
  toaster: '烤面包机',
  washer: '洗衣机',
  forest: '森林',
  pier: '栈桥',
  onsen: '温泉',
  'cloud-sweep': '云端扫杆',
  whisk: '打蛋器',
  'bamboo-grove': '竹林',
  bridges: '交错桥梁',
  henge: '巨石阵',
  mist: '雾中庭院',
  ring: '环形回廊',
  pinball: '弹珠台',
  'turn-teleportals': '旋转传送门',
  trap: '陷阱广场',
  pincer: '夹击机关',
  shrine: '祭坛',
  rivercrossing: '渡河',
  maze2: '曲折迷宫',
  'raft-crusher': '浮筏压墙',
  'raft-switches': '开关浮筏',
  'raft-pair': '双浮筏',
  'big-raft': '大型浮筏',
  'island-pair': '双岛',
  crate: '货箱阵',
  'trap-maze2': '陷阱迷宫',
  courtyard: '庭院',
  'four-cogs': '四齿轮',
  donut: '环岛',
  'trap-islands': '陷阱群岛',
  'raft-switches2': '双向开关浮筏',
  'circle-maze': '环形迷宫',
  'roller-sweep': '滚筒扫杆',
  'jungle-ruins': '丛林遗迹',
};

const MAP_DESCRIPTIONS: Record<string, string> = {
  enclosed: '围墙内的开阔草地，利用零散石块反弹回旋镖。',
  'slide-traps': '斜墙分隔通道，留意来回滑动的夹击机关。',
  turnstile: '中央转闸不断改变通路，绕开岩石抢占出口。',
  pools: '弯曲水池切开庭院，沿岸追击时小心落水。',
  marketplace: '围绕中央喷泉，在摊位与货箱之间穿行。',
  washer: '三臂转盘扫过场地，跟随空隙改变走位。',
  toaster: '木桥连接四周平台，在狭窄出入口争夺空间。',
  plants: '密集植被遮挡视线，留意叶丛后的对手和回旋镖。',
  rooms: '矮墙和水池划出相连房间，借拐角伏击。',
  'cloud-sweep': '云端石台间有扫杆经过，注意脚下缺口。',
  whisk: '两根旋转长杆交替扫过圆场，避开夹角。',
  'temple-garden': '曲折水渠与石块间的追逐，岸边留好退路。',
  falling: '悬空地板逐片坍塌，及时转移到安全落脚点。',
  island: '水中孤岛与中央木桥，边缘很容易被击落。',
  'mini-island': '狭长小岛上的近距离对决，利用石块短暂掩护。',
  clouds: '高空平台通过窄桥相连，切断对手的退路。',
  falling2: '大块地板连续塌陷，场地会随时间改变。',
  square: '方形墙阵内外相通，寻找能连续反弹的角度。',
  wheel: '交叉长墙绕中心旋转，通道随转盘开合。',
  maze: '密集石墙构成迷宫，短通道适合近身交锋。',
  ring: '绕中央水池周旋，在环形路线两端截击。',
  forest: '树干之间穿梭，利用树丛隐藏接近路线。',
  split: '中央四块平台与外围岛屿相隔，留意水面间隙。',
  moving: '移动墙体改变掩护位置，保持对通路的观察。',
  drift: '两条浮筏在水面移动，抓住靠近岸边的时机。',
  tracks: '沿轨道往返的平台穿过水池，搭乘平台跨越缺口。',
  tutorial: '教程使用的练习场地，可自由练习移动与攻击。',
  spin: '中央木制平台旋转，站位和落脚方向随之改变。',
  teleportals: '迷宫中的成对传送门，让追击路线突然转向。',
  temple: '圆形石座分散在神庙中，借掩体绕行与反弹。',
  pier: '曲折栈桥围绕水面展开，狭路相逢时谨慎冲刺。',
  onsen: '温泉池分隔庭院，在池边与中央石座间走位。',
  henge: '巨石之间留有宽阔空地，旋转扫杆不断经过。',
  bridges: '木桥把两座岛连接起来，控制桥口争取优势。',
  mist: '不规则浮岛被岩石分割，小心狭窄的连接处。',
  'bamboo-grove': '竹丛密布的开阔场地，从植被间的空隙观察对手。',
  pinball: '圆形石台形成反弹点，让回旋镖穿过掩体间隙。',
  'big-raft': '大型木筏与岸边交错，留意平台移动后的缺口。',
  'circle-maze': '弧形墙围出环状通道，沿圆弧追击或绕后。',
  courtyard: '中央通道连接两侧庭院，小石座提供短暂掩护。',
  crate: '大量可破坏货箱构成掩体，打出新的通路。',
  donut: '内外两圈通道相连，绕环移动躲避来袭回旋镖。',
  'four-cogs': '四个相邻转盘改变脚下方向，跨越连接处时看准时机。',
  'island-pair': '两座主岛与小平台相连，在桥口争夺主动。',
  'jungle-ruins': '弯曲遗迹墙与树丛交错，从断墙间穿行。',
  maze2: '转角密集的墙阵，利用短直道快速接近对手。',
  pincer: '两侧机关挤压中央路线，及时离开夹击区域。',
  'raft-crusher': '浮筏经过压墙区域，注意移动中的安全空间。',
  'raft-pair': '成对木筏往返于岸边，跟随平台跨越水域。',
  'raft-switches': '攻击开关改变浮筏状态，抢先控制过河路线。',
  'raft-switches2': '多个开关与浮筏相互配合，留意对手的操作。',
  rivercrossing: '环绕中央岛屿的河道，搭乘平台寻找进攻方向。',
  'roller-sweep': '长滚筒扫过圆场，绕开货箱并保持移动。',
  shrine: '围绕中央祭坛交锋，在零散掩体间寻找空当。',
  trap: '方格地板暗藏陷阱，看清预警后及时离开。',
  'trap-islands': '小岛之间的连接地板会变化，提前规划退路。',
  'trap-maze2': '迷宫与陷阱地板交织，转弯前留意脚下变化。',
  'turn-teleportals': '成组传送门持续旋转，出口方向也会改变。',
};

/** Numeric scene geometry and rules, independently rendered with procedural Web meshes. */
export const ORIGINAL_MAP_RECORDS: readonly OriginalMapRecord[] = (
  data as unknown as OriginalMapRecord[]
).map((entry) => ({
  ...entry,
  info: {
    ...entry.info,
    name: MAP_NAMES[entry.info.id.replace('original-', '')] ?? entry.info.name,
    description: MAP_DESCRIPTIONS[entry.info.id.replace('original-', '')] ?? entry.info.description,
  },
}));
export const ORIGINAL_MAPS: readonly MapInfo[] = ORIGINAL_MAP_RECORDS.map((entry) => entry.info);
const originalById = new Map(ORIGINAL_MAP_RECORDS.map((entry) => [entry.info.id, entry]));

export function createOriginalArena(id: MapId): Arena {
  const entry = originalById.get(id);
  if (!entry) throw new RangeError(`Unknown original map: ${id}`);
  // Every match owns its floors, moving walls and mechanism clocks, including SDK instances.
  return structuredClone(entry.arena);
}
