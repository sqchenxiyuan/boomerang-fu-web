/**
 * Sound inventory for dev/sfx.html: every FMOD event the Godot port (and the
 * recovered original sources it was ported from) references, with the Web
 * synthesized counterpart where one exists.
 *
 * Only event *names* live here. The audio itself is the original game's FMOD
 * bank, read at dev time from the local arkevo-games checkout (vite.config.ts)
 * and never copied into this repository.
 *
 * Status:
 * - godot:    the Godot port plays it (code call site or level/particle data).
 * - original: only the recovered original sources call it; Godot has not wired it.
 * - open:     made for the Godot "open" skin, not in the original bank.
 */
import type { GameEvent } from '../core/types';
import type { MusicScene } from '../platform/audio-types';
import type { SoundName } from '../platform/sfx/recipes';

export type SfxStatus = 'godot' | 'original' | 'open';
export type SfxGroup = 'combat' | 'death' | 'environment' | 'powerups' | 'ui' | 'music' | 'atmos';
export interface WebSound {
  label: string;
  /** A generated sound played directly (loops are auditioned for a few seconds). */
  sound?: SoundName;
  /** Synthetic events fed to GardenAudioGraph.play (position/actorId default to 0). */
  events?: Partial<GameEvent>[];
  /** Or a music scene to audition instead of one-shot effects. */
  scene?: MusicScene;
}
export interface SfxEntry {
  path: string;
  group: SfxGroup;
  zh: string;
  status: SfxStatus;
  /** Representative call site (Godot first, else recovered original source). */
  source: string;
  loop?: boolean;
  /** Parameters the call sites pass, with a typical value. */
  params?: Record<string, number>;
  web: WebSound[];
  /** Why there is no Web sound, or how the Web one differs. */
  note?: string;
}

type Extra = Partial<Pick<SfxEntry, 'loop' | 'params' | 'note'>>;
const groupOf = (path: string): SfxGroup => path.split('/')[1] as SfxGroup;
function e(
  path: string,
  zh: string,
  status: SfxStatus,
  source: string,
  web: WebSound[] = [],
  extra: Extra = {},
): SfxEntry {
  return {
    path: `event:/${path}`,
    group: groupOf(`event:/${path}`),
    zh,
    status,
    source,
    web,
    ...extra,
  };
}
const one = (label: string, event: Partial<GameEvent>): WebSound => ({ label, events: [event] });
const death = (variant: NonNullable<GameEvent['variant']>): WebSound =>
  one(`death · ${variant}`, { type: 'death', variant });
const env = one('environment', { type: 'environment' });
const NO_WEB = 'Web 暂无对应音效';

export const SFX_CATALOG: SfxEntry[] = [
  // ── atmos ──
  e(
    'atmos/mountains',
    '山地关卡环境底噪',
    'godot',
    'godot/original_audio.gd:131（inputs.ambient）',
    [],
    { loop: true, note: 'Web 没有环境底噪' },
  ),
  e('atmos/night', '夜晚关卡环境底噪', 'original', 'recovered-source/Level.cs:165', [], {
    loop: true,
    note: NO_WEB,
  }),

  // ── combat ──
  e('combat/block_disc', '挥砍弹开来镖（弹反）', 'godot', 'godot/original_audio.gd:90', [
    one('deflect · parry', { type: 'deflect', feedback: 'parry' }),
    one('deflect · parry（满蓄）', { type: 'deflect', feedback: 'parry', charged: true }),
  ]),
  e('combat/block_melee', '挥砍互挡（对砍）', 'godot', 'godot/original_audio.gd:90', [
    one('deflect · clash', { type: 'deflect', feedback: 'clash' }),
  ]),
  e('combat/catch', '接住飞回的镖', 'godot', 'godot/original_audio.gd:90', [
    one('catch', { type: 'catch' }),
  ]),
  e(
    'combat/charge',
    '蓄力（开源皮肤自制，不在原版 bank）',
    'open',
    'skins/open/overrides/open_audio.gd:99',
    [{ label: '蓄力循环', sound: 'chargeLoop' }],
  ),
  e('combat/dash', '冲刺', 'godot', 'godot/original_audio.gd:79', [one('dash', { type: 'dash' })]),
  e('combat/dash_end', '冲刺结束收势', 'godot', 'godot/main.gd:590', [
    { label: '冲刺收势', sound: 'dashEnd' },
  ]),
  e('combat/dash_slam', '冲刺撞到人', 'original', 'recovered-source/Actor.cs:1119', [], {
    note: NO_WEB,
  }),
  e(
    'combat/disarm',
    '空手挥击出手',
    'godot',
    'godot/original_audio.gd:81',
    [one('slash', { type: 'slash' })],
    {
      note: 'Web 空手挥击与持镖挥砍同音',
    },
  ),
  e('combat/disarm_hit', '空手缴械命中', 'godot', 'godot/original_audio.gd:86', [
    one('deflect · disarm（掉镖）', { type: 'deflect', feedback: 'disarm', value: 1 }),
    one('deflect · disarm（对方空手）', { type: 'deflect', feedback: 'disarm', value: 0 }),
  ]),
  e('combat/disc_spawn', '补发武器 / 开场发镖', 'godot', 'godot/main.gd:2051', [
    one('equip', { type: 'equip' }),
  ]),
  e('combat/faceplant', '角色扑倒在地', 'godot', 'godot/main.gd:942', [
    { label: '扑倒', sound: 'faceplant' },
  ]),
  e('combat/fire_extinguish', '身上的火被熄灭（冒蒸汽）', 'godot', 'godot/original_audio.gd:104', [
    { label: '熄火冒汽', sound: 'extinguish' },
  ]),
  e('combat/fire_ignite', '被点燃', 'godot', 'godot/original_audio.gd:106', [
    one('burn', { type: 'burn' }),
  ]),
  e(
    'combat/fire_loop',
    '角色燃烧中',
    'godot',
    'godot/original_audio.gd:150',
    [{ label: '燃烧循环', sound: 'burningLoop' }],
    {
      loop: true,
    },
  ),
  e(
    'combat/footstep',
    '脚步（跑步动画关键帧触发，按玩家区分音高）',
    'godot',
    'godot/original_audio.gd:140',
    [{ label: '脚步', sound: 'footstep' }],
    {
      params: { pitch: 0 },
    },
  ),
  e('combat/hop', '走出边缘开始坠落时的小跳', 'godot', 'godot/original_audio.gd:104', [
    { label: '边缘小跳', sound: 'hop' },
  ]),
  e('combat/land', '落地（开源皮肤自制）', 'open', 'skins/open/overrides/open_audio.gd:15', [
    { label: '落地', sound: 'spawnLand' },
  ]),
  e('combat/melee', '持镖挥砍出手', 'godot', 'godot/original_audio.gd:81', [
    one('slash', { type: 'slash' }),
  ]),
  e(
    'combat/retrieve',
    '按住召回飞镖',
    'godot',
    'godot/original_audio.gd:164',
    [{ label: '召回循环', sound: 'recallLoop' }],
    {
      loop: true,
      params: { pitch: 0, retrieveCharge: 0.5 },
    },
  ),
  e('combat/revive', '组队模式复活', 'original', 'recovered-source/Player.cs:2670', [], {
    note: 'Web 无组队模式',
  }),
  e('combat/revive_charge', '组队模式复活充能', 'original', 'recovered-source/Player.cs:2653', [], {
    note: 'Web 无组队模式',
  }),
  e('combat/shield', '护盾（开源皮肤自制）', 'open', 'skins/open/overrides/open_audio.gd:83', [
    one('shield', { type: 'shield' }),
  ]),
  e(
    'combat/spawnin_land',
    '回合入场落地',
    'godot',
    'godot/assets/original/audio-inputs.json（particle_audio 3）',
    [{ label: '入场落地', sound: 'spawnLand' }],
  ),
  e('combat/spawnin_whoosh', '回合入场呼啸', 'godot', 'godot/main.gd:1047', [
    { label: '入场呼啸', sound: 'spawnWhoosh' },
  ]),
  e(
    'combat/telekinesis',
    '遥控镖飞行中',
    'godot',
    'godot/original_audio.gd:166',
    [{ label: '遥控循环', sound: 'telekinesisLoop' }],
    {
      loop: true,
      params: { pitch: 0, velocity: 0.5 },
    },
  ),
  e(
    'combat/throw',
    '投掷（aimPower = 蓄力 0–1）',
    'godot',
    'godot/main.gd:802',
    [
      one('throw · 轻投', { type: 'throw', value: 0 }),
      one('throw · 半蓄', { type: 'throw', value: 0.5 }),
      one('throw · 满蓄', { type: 'throw', value: 1 }),
    ],
    { params: { aimPower: 0 } },
  ),

  // ── death ──
  e('death/burnt', '被烧死', 'godot', 'godot/original_audio.gd:104', [death('burst')], {
    note: 'Web 烧死用 burst 变体',
  }),
  e('death/exploded', '被炸死', 'godot', 'godot/original_audio.gd:97', [death('squash')], {
    note: 'Web 炸死用 squash 变体',
  }),
  e('death/outofbounds', '出界死亡', 'godot', 'godot/original_audio.gd:95', [death('burst')]),
  e(
    'death/outofbounds_warning',
    '出界警告（越接近死亡音越高）',
    'godot',
    'godot/original_audio.gd:147',
    [{ label: '出界警告', sound: 'oobWarning' }],
    {
      params: { pitch: 0.5 },
    },
  ),
  e('death/shatter', '冻住后被打碎', 'godot', 'godot/original_audio.gd:99', [
    { label: '冰冻碎裂', sound: 'shatter' },
  ]),
  e('death/sliced', '被切开', 'godot', 'godot/original_audio.gd:98', [death('slice')]),
  e('death/sliced_coffee', '咖啡角色被切开（专属）', 'godot', 'godot/main.gd:1063', [], {
    note: 'Web 角色不同，无专属死亡音',
  }),
  e('death/sliced_hotsauce', '辣酱角色被切开（专属）', 'godot', 'godot/main.gd:1136', [], {
    note: 'Web 角色不同，无专属死亡音',
  }),
  e(
    'death/sliced_saltandpepper',
    '盐和胡椒角色被切开（专属）',
    'original',
    'recovered-source/CharacterSaltAndPepper.cs:41',
    [],
    {
      note: 'Web 角色不同，无专属死亡音',
    },
  ),
  e('death/spill_liquid', '液体洒出（咖啡 / 辣酱角色）', 'godot', 'godot/main.gd:947', [], {
    note: NO_WEB,
  }),
  e(
    'death/spill_saltandpepper',
    '撒出盐和胡椒',
    'original',
    'recovered-source/CharacterSaltAndPepper.cs:85',
    [],
    { note: NO_WEB },
  ),
  e('death/splash_medium', '落水', 'godot', 'godot/main.gd:1191', [death('water')]),
  e('death/squished', '被压扁', 'godot', 'godot/main.gd:1067', [death('squash')]),
  e('death/squished_small', '碎块被压扁', 'godot', 'godot/main.gd:900', [], { note: NO_WEB }),

  // ── environment ──
  e(
    'environment/break_crate',
    '木箱被打碎',
    'godot',
    'godot/assets/original/level11/behaviors.json',
    [one('crate', { type: 'crate' })],
  ),
  e(
    'environment/break_vase',
    '花瓶被打碎',
    'godot',
    'godot/assets/original/level11/behaviors.json',
    [one('crate', { type: 'crate' })],
    {
      note: 'Web 木箱与花瓶同音',
    },
  ),
  e(
    'environment/cloud_puff',
    '云雾喷出',
    'godot',
    'godot/assets/original/audio-inputs.json（particle_audio 19）',
    [{ label: '云雾', sound: 'cloudPuff' }],
  ),
  e(
    'environment/cloud_puff_mini',
    '小团云雾喷出',
    'godot',
    'godot/assets/original/audio-inputs.json（particle_audio 20）',
    [{ label: '小云雾', sound: 'cloudPuff' }],
  ),
  e('environment/crown_rico', '皇冠落地弹跳', 'original', 'recovered-source/HatDebris.cs:6', [], {
    note: NO_WEB,
  }),
  ...(
    [
      ['bamboo', '竹子'],
      ['shrub', '灌木'],
      ['stone', '石头'],
      ['tree', '树'],
      ['wood', '木头'],
    ] as const
  ).map(([material, zh]) =>
    e(
      `environment/disc_rico_${material}`,
      `飞镖撞到${zh}反弹`,
      'godot',
      'godot/original_audio.gd:229（按障碍材质拼路径）',
      [one('bounce', { type: 'bounce' })],
      { params: { velocity: 0.6 }, note: 'Web 反弹不区分材质' },
    ),
  ),
  e(
    'environment/disc_rico_disc',
    '两镖相撞',
    'godot',
    'godot/original_audio.gd:92',
    [
      one('clash · 不同主人', { type: 'clash', value: 1 }),
      one('clash · 同一主人', { type: 'clash', value: 0 }),
    ],
    { params: { velocity: 0.6 } },
  ),
  e(
    'environment/firecell_loop',
    '地面火焰燃烧',
    'godot',
    'godot/original_audio.gd:132',
    [{ label: '地火循环', sound: 'fireCellLoop' }],
    {
      loop: true,
      params: { intensity: 0.5, plants: 0 },
    },
  ),
  e('environment/firecell_start', '地面开始着火', 'godot', 'godot/original_audio.gd:227', [
    { label: '起火', sound: 'ignite' },
  ]),
  e(
    'environment/floor_cracking',
    '地板开裂',
    'godot',
    'godot/core/original_floor_hazard.gd:39',
    [env],
    { loop: true },
  ),
  e('environment/floor_rise', '地板升起', 'godot', 'godot/core/original_floor_hazard.gd:92', [env]),
  e('environment/floor_sink', '地板下沉', 'godot', 'godot/core/original_floor_hazard.gd:71', [env]),
  e(
    'environment/gong',
    '敲锣（关卡机关）',
    'godot',
    'godot/assets/original/level11/behaviors.json',
    [env],
  ),
  e('environment/icecell_loop', '地面冰面', 'original', 'recovered-source/Disc.cs:664', [], {
    loop: true,
    note: NO_WEB,
  }),
  e('environment/lightning', '闪电', 'original', 'recovered-source/Level.cs:369', [], {
    note: NO_WEB,
  }),
  e(
    'environment/moving_floor',
    '移动地板',
    'godot',
    'godot/assets/original/level29/behaviors.json',
    [env],
    {
      loop: true,
      params: { velocity: 0.3 },
      note: 'Web 只有移动开始时的一声，没有持续音',
    },
  ),
  e(
    'environment/moving_obstacle',
    '移动障碍',
    'godot',
    'recovered-source/MovingFloorReactive.cs:68',
    [env],
    {
      loop: true,
      params: { velocity: 0.5 },
      note: 'Web 只有移动开始时的一声，没有持续音',
    },
  ),
  e(
    'environment/moving_obstacle_butter',
    '黄油障碍滑动',
    'godot',
    'godot/assets/original/level40/behaviors.json',
    [env],
    {
      loop: true,
      params: { velocity: 0.5 },
    },
  ),
  e(
    'environment/moving_obstacle_stop',
    '移动障碍停下',
    'godot',
    'godot/core/original_level3_behaviors.gd:430',
    [env],
  ),
  e(
    'environment/reeds_rustle',
    '穿过芦苇沙沙作响',
    'godot',
    'godot/assets/original/level40/behaviors.json',
    [{ label: '穿过植物', sound: 'reeds' }],
  ),
  e(
    'environment/splash_small',
    '小水花',
    'godot',
    'godot/assets/original/audio-inputs.json（particle_audio 17）',
    [{ label: '小水花', sound: 'splashSmall' }],
  ),
  e('environment/switch', '开关被打中', 'godot', 'godot/core/original_level3_behaviors.gd:607', [
    env,
  ]),
  e(
    'environment/teleportal',
    '角色穿过传送门',
    'godot',
    'godot/main.gd:784',
    [one('teleport', { type: 'teleport' })],
    {
      note: 'Web 传送门与传送道具同音',
    },
  ),
  e('environment/teleportal_disc', '飞镖穿过传送门', 'godot', 'godot/main.gd:784', [
    one('teleport', { type: 'teleport' }),
  ]),
  e(
    'environment/wet_floor',
    '湿地上滑行',
    'godot',
    'godot/original_audio.gd:156',
    [{ label: '湿地滑行', sound: 'slideLoop' }],
    {
      loop: true,
      params: { velocity: 0.5 },
    },
  ),

  // ── music ──
  ...['flutey', 'jungle', 'shuffle', 'skulls', 'stepup', 'surf', 'trap'].map((name) =>
    e(
      `music/gameplay_${name}`,
      `对局 BGM「${name}」（7 首随机轮换）`,
      'godot',
      'godot/original_audio.gd:176（playlist）',
      [
        { label: 'Web 对局 BGM', scene: 'play' },
        { label: 'Web 缩圈 BGM', scene: 'danger' },
      ],
      { loop: true, note: 'Web 只有一首合成 BGM，缩圈时加速' },
    ),
  ),
  e(
    'music/menu',
    '菜单音乐',
    'godot',
    'godot/original_audio.gd:176',
    [{ label: 'Web 菜单 BGM', scene: 'menu' }],
    { loop: true },
  ),
  e('music/sting_victory', '胜利乐句', 'godot', 'godot/original_audio.gd:171', [
    one('win', { type: 'win' }),
    { label: 'Web 胜利 BGM', scene: 'victory' },
  ]),

  // ── powerups ──
  e('powerups/battle_royale', '缩圈开始', 'godot', 'godot/main.gd:1873', [
    one('boundary', { type: 'boundary' }),
  ]),
  e(
    'powerups/charge_golden_boomerang',
    '黄金回旋镖蓄力',
    'original',
    'recovered-source/Player.cs:516',
    [],
    { note: 'Web 无黄金回旋镖模式' },
  ),
  e(
    'powerups/collect_golden_boomerang',
    '拾取黄金回旋镖',
    'original',
    'recovered-source/Player.cs:505',
    [],
    { note: 'Web 无黄金回旋镖模式' },
  ),
  e(
    'powerups/collect_power',
    '拾取道具',
    'godot',
    'godot/main.gd:1182',
    [
      one('pickup（默认）', { type: 'pickup' }),
      one('pickup · 加速', { type: 'pickup', power: 'haste' }),
      one('pickup · 头昏眼花', { type: 'pickup', power: 'reverse' }),
      one('pickup · 冰', { type: 'pickup', power: 'ice' }),
      one('pickup · 火', { type: 'pickup', power: 'fire' }),
    ],
    { note: '原版所有道具同一个拾取音；Web 每种道具一个动机' },
  ),
  e(
    'powerups/dashthroughwalls_out',
    '穿墙冲刺从墙里出来',
    'original',
    'recovered-source/InsidesCollider.cs:17',
    [],
    { note: NO_WEB },
  ),
  e('powerups/decoy_die', '替身被打掉', 'godot', 'godot/main.gd:1600', [
    { label: '替身被打掉', sound: 'decoyDie' },
  ]),
  e('powerups/decoy_spawn', '释放替身', 'godot', 'godot/main.gd:1600', [
    one('decoy', { type: 'decoy' }),
  ]),
  e('powerups/destroy_power', '道具书被摧毁', 'godot', 'godot/main.gd:1193', [], { note: NO_WEB }),
  ...(
    [
      ['explosion', '爆炸'],
      ['explosion_fire', '火焰爆炸'],
      ['explosion_ice', '冰爆'],
      ['explosion_mini', '小型爆炸（分裂镖）'],
      ['explosion_mini_fire', '小型火焰爆炸'],
      ['explosion_mini_ice', '小型冰爆'],
    ] as const
  ).map(([name, zh]) =>
    e(
      `powerups/${name}`,
      zh,
      'godot',
      'godot/assets/original/explosion-inputs.json',
      [one('explosion', { type: 'explosion' })],
      {
        note: name === 'explosion' ? undefined : 'Web 爆炸不分变体',
      },
    ),
  ),
  e('powerups/grenade_blink', '爆炸镖引信闪烁', 'godot', 'godot/main.gd:2008', [
    { label: '引信滴答', sound: 'fuseTick' },
  ]),
  e('powerups/ice_freeze', '被冻住', 'godot', 'godot/original_audio.gd:104', [
    one('freeze', { type: 'freeze' }),
  ]),
  e('powerups/multidisc_burst', '分裂镖爆开', 'original', 'recovered-source/Disc.cs:1192', [
    one('split', { type: 'split' }),
  ]),
  e('powerups/shield_off', '护盾破碎', 'godot', 'godot/original_audio.gd:242', [
    one('shield', { type: 'shield' }),
  ]),
  e('powerups/shield_on', '获得护盾', 'godot', 'godot/original_audio.gd:238', [
    one('pickup · 护盾', { type: 'pickup', power: 'shield' }),
  ]),
  e(
    'powerups/spawn_golden_boomerang',
    '黄金回旋镖出现',
    'original',
    'recovered-source/GameManager.cs:1989',
    [],
    {
      note: 'Web 无黄金回旋镖模式',
    },
  ),
  e('powerups/teleport', '传送镖传送', 'godot', 'godot/main.gd:662', [
    one('teleport', { type: 'teleport' }),
  ]),
  e('powerups/unfreeze', '解冻', 'godot', 'godot/original_audio.gd:104', [
    { label: '解冻', sound: 'unfreeze' },
  ]),

  // ── ui ──
  e('ui/add_bot', '大厅添加机器人', 'original', 'recovered-source/UIMenuLobby.cs:816'),
  e('ui/add_point', '计分板加分', 'original', 'recovered-source/UIScoreRow.cs:191'),
  e('ui/alt_character', '切换角色配色', 'godot', 'godot/ffa_shell.gd:258'),
  e('ui/back', '菜单返回', 'original', 'recovered-source/UILobbyPlayer.cs:565'),
  e('ui/begin', '启动画面开始', 'original', 'recovered-source/UIMenuSplash.cs:94'),
  e('ui/change_hat_left', '换帽子（左）', 'original', 'recovered-source/UILobbyPlayer.cs:657'),
  e('ui/change_hat_right', '换帽子（右）', 'original', 'recovered-source/UILobbyPlayer.cs:663'),
  e('ui/charge_up', '长按按钮充能', 'original', 'recovered-source/UIFillButton.cs:75'),
  e('ui/circlewipe_victory', '胜利圆形幕布', 'godot', 'godot/original_audio.gd:170', [
    one('win', { type: 'win' }),
  ]),
  e('ui/crown_move', '回合结算皇冠移动', 'original', 'recovered-source/UIMenuRoundEnd.cs:313'),
  e('ui/doublekill', '连杀提示', 'godot', 'godot/core/original_powerup_ui.gd:111', [
    one('streak ×2', { type: 'streak', value: 2 }),
    one('streak ×3', { type: 'streak', value: 3 }),
    one('streak ×4', { type: 'streak', value: 4 }),
  ]),
  e('ui/equip_hat', '戴上帽子', 'original', 'recovered-source/UIMenuUnlocked.cs:154'),
  e('ui/gong', '开局锣声', 'original', 'recovered-source/GameManager.cs:2939'),
  e('ui/join', '大厅加入', 'original', 'recovered-source/UILobbyPlayer.cs:519'),
  e(
    'ui/join_team_one',
    '加入一队',
    'original',
    'recovered-source/UIMatchSettingTeamsModule.cs:175',
  ),
  e(
    'ui/join_team_two',
    '加入二队',
    'original',
    'recovered-source/UIMatchSettingTeamsModule.cs:180',
  ),
  e('ui/logo_riser', '启动 logo 上扬', 'original', 'recovered-source/UIMenuSplash.cs:151'),
  e(
    'ui/matchend_show_award_loser',
    '整场结算：显示失败方奖项',
    'original',
    'recovered-source/UIMatchEndPlayer.cs:203',
  ),
  e(
    'ui/matchend_show_award_winner',
    '整场结算：显示胜者奖项',
    'original',
    'recovered-source/UIMatchEndPlayer.cs:199',
  ),
  e(
    'ui/matchend_show_player',
    '整场结算：显示玩家',
    'original',
    'recovered-source/UIMatchEndPlayer.cs:161',
  ),
  e(
    'ui/matchend_show_winner',
    '整场结算：显示胜者',
    'original',
    'recovered-source/UIMatchEndPlayer.cs:178',
  ),
  e('ui/matchend_victory', '整场胜利', 'original', 'recovered-source/UIMenuMatchEnd.cs:154', [
    one('win', { type: 'win' }),
  ]),
  e(
    'ui/matchend_victory_whoosh',
    '整场胜利呼啸',
    'original',
    'recovered-source/UIMenuMatchEnd.cs:165',
  ),
  e('ui/nope', '操作无效', 'original', 'recovered-source/UILobbyPlayer.cs:530'),
  e('ui/off', '开关：关', 'original', 'recovered-source/UIButtonBinding.cs:289'),
  e('ui/on', '开关：开', 'original', 'recovered-source/UIButtonBinding.cs:277'),
  e('ui/progress_complete', '进度条完成', 'original', 'recovered-source/UIProgressBar.cs:65'),
  e('ui/progress_riser', '进度条上扬', 'original', 'recovered-source/UIProgressBar.cs:46'),
  e('ui/progress_show', '进度条出现', 'original', 'recovered-source/UIProgressBar.cs:108'),
  e('ui/ready', '大厅准备', 'original', 'recovered-source/UILobbyPlayer.cs:543'),
  e('ui/remove_bot', '大厅移除机器人', 'original', 'recovered-source/UIMenuLobby.cs:811'),
  e('ui/remove_point', '计分板扣分', 'original', 'recovered-source/UIScoreRow.cs:219'),
  e(
    'ui/restore_defaults',
    '恢复默认设置',
    'original',
    'recovered-source/UIMatchSettingMapsModule.cs:312',
  ),
  e(
    'ui/roundtitle_closeyoureyes',
    '躲猫猫模式「闭眼」标题',
    'original',
    'recovered-source/UIMenuRoundTitles.cs:316',
    [],
    {
      note: 'Web 无躲猫猫模式',
    },
  ),
  e('ui/roundtitle_go', '回合标题「开始！」', 'godot', 'godot/ffa_shell.gd:631', [
    { label: '开始！', sound: 'roundGo' },
  ]),
  e('ui/roundtitle_other', '其他回合标题（第 N 回合等）', 'godot', 'godot/ffa_shell.gd:482', [
    one('round', { type: 'round' }),
  ]),
  e('ui/roundtitle_ready', '回合标题「准备」', 'godot', 'godot/ffa_shell.gd:482', [
    one('countdown', { type: 'countdown' }),
  ]),
  e('ui/select', '菜单选择', 'original', 'recovered-source/UIButtonStyle.cs:120'),
  e('ui/shake', '按钮抖动（不可选）', 'original', 'recovered-source/UIButtonStyle.cs:254'),
  e('ui/show', '面板出现', 'godot', 'godot/ffa_shell.gd:535'),
  e('ui/show_alert', '提示条出现（连杀等）', 'godot', 'godot/core/original_powerup_ui.gd:110', [
    one('streak ×2', { type: 'streak', value: 2 }),
  ]),
  e(
    'ui/show_seeker',
    '躲猫猫模式显示找人者',
    'original',
    'recovered-source/GameManager.cs:2903',
    [],
    { note: 'Web 无躲猫猫模式' },
  ),
  e('ui/slider', '滑块拖动', 'original', 'recovered-source/UIButtonStyle.cs:281'),
  e('ui/startup', '游戏启动', 'original', 'recovered-source/Startup.cs:64'),
  e('ui/submit', '菜单确认', 'godot', 'godot/ffa_shell.gd:502'),
  e('ui/timer', '倒计时滴答', 'original', 'recovered-source/UIManager.cs:821'),
  e('ui/transition_in', '转场进入', 'original', 'recovered-source/GameManager.cs:2892'),
  e('ui/transition_out', '转场退出', 'original', 'recovered-source/GameManager.cs:2963'),
  e('ui/unlock_item', '解锁物品', 'original', 'recovered-source/UIMenuUnlocked.cs:93'),
  e(
    'ui/win_golden_boomerang',
    '黄金回旋镖获胜',
    'original',
    'recovered-source/GameManager.cs:3050',
    [],
    { note: 'Web 无黄金回旋镖模式' },
  ),
  e('ui/winning_point', '赛点', 'original', 'recovered-source/UIScoreRow.cs:206'),
];

/** Web events with no Godot/original counterpart in the catalog. */
export const WEB_ONLY: { label: string; event: Partial<GameEvent>; note: string }[] = [
  { label: 'disguise', event: { type: 'disguise' }, note: '伪装触发；原版伪装没有音效' },
  {
    label: 'pickup · 头昏眼花',
    event: { type: 'pickup', power: 'reverse' },
    note: '负面道具的下滑音；原版拾取音不分道具',
  },
];
