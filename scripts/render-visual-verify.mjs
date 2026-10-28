import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// Synthetic presentation fixtures. These do not prove normal gameplay paths.
const base = process.env.GARDEN_TEST_URL ?? 'http://127.0.0.1:5173';
const out = process.env.GARDEN_TEST_OUTPUT ?? 'test-results/v4-rendering';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await page.goto(base);
await page.waitForFunction(() => window.boomerangGarden);
await page.evaluate(async () => {
  window.boomerangGarden.destroy();
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { GameRenderer } = await import('/src/rendering/renderer.ts');
  const { createState } = await import('/src/simulation/state.ts');
  document.body.innerHTML = `<style>
    body{margin:0;background:#152e28;color:#f8f1d6;font-family:Arial,"Microsoft YaHei",sans-serif}
    #stage{width:1280px;height:800px;position:relative}
    #caption{position:absolute;left:38px;top:28px;z-index:5;color:#17382e}
    #caption h1{font-size:27px;margin:0 0 8px}#caption p{font-size:16px;margin:0}
    #note{position:absolute;left:38px;bottom:24px;z-index:5;font-size:14px;color:#17382e}
  </style><div id="stage"><div id="caption"></div><div id="note">V4 · 合成渲染夹具 / 仅验证表现层；真实规则由 SDK 浏览器测试覆盖</div></div>`;
  const container = document.getElementById('stage');
  const reports = [];
  let renderer;
  window.renderFixture = (kind) => {
    renderer?.dispose();
    const state = createState({
      mode: 'local',
      bots: 2,
      difficulty: 'normal',
      seed: 41,
      scoreGoal: 100,
    });
    state.phase = 'playing';
    state.phaseTime = state.time = 10;
    state.weaponsGranted = true;
    state.arena.obstacles = [];
    state.arena.pits = [];
    state.pickups = [];
    state.actors.forEach((a, i) => {
      a.position = { x: -4.5 + i * 3, y: 0 };
      a.previous = { ...a.position };
      a.facing = { x: 0, y: 1 };
      a.velocity = { x: 0, y: 0 };
      a.invulnerable = 0;
      a.armed = true;
      a.heldDiscs = 1;
      a.powers = [];
    });
    const actor = state.actors;
    const makeDisc = (id, powers, mini = false) => ({
      id,
      ownerId: 3,
      damageOwnerId: 3,
      position: { x: 3, y: -2 },
      previous: { x: 3, y: -2 },
      velocity: { x: 12, y: 0 },
      state: 'outbound',
      age: 0.5,
      stateTime: 0.5,
      charge: 1,
      curve: 0,
      bounces: 0,
      explosive: powers.includes('explosive'),
      powers,
      mini,
      fuse: 1,
      grace: 0,
      lastDeflector: -1,
      dead: false,
    });
    let title, subtitle;
    if (kind === 'weapons') {
      title = '武器：蓄力、近战弧光、双回旋镖与连续尾迹';
      subtitle = '从左到右：蓄力提示 / 挥击过程 / 双持 / 投掷及分裂小镖';
      actor[0].charge = 1;
      actor[1].attackTime = 0.11;
      actor[1].attackArmed = true;
      actor[2].heldDiscs = 2;
      actor[2].powers = ['extra'];
      actor[3].armed = false;
      actor[3].heldDiscs = 0;
      state.discs = [makeDisc(101, ['ice']), makeDisc(102, ['fire'], true)];
    } else if (kind === 'elements') {
      title = '元素：火焰、冰面、燃烧与冻结';
      subtitle = '地面范围来自 zone.radius；元素粒子与角色状态共用模拟时钟';
      actor[0].burnTime = 2;
      actor[1].frozenTime = 2;
      state.zones = [
        {
          id: 201,
          kind: 'fire',
          position: { x: 1.5, y: 2.25 },
          ownerId: 2,
          radius: 1.45,
          remaining: 3,
          duration: 4,
        },
        {
          id: 202,
          kind: 'ice',
          position: { x: 4.5, y: 2.25 },
          ownerId: 3,
          radius: 1.45,
          remaining: 3,
          duration: 4,
        },
      ];
    } else {
      title = '状态：伪装、反向操作、遥控与分身';
      subtitle = '木箱伪装 / 紫色状态环 / 绿色遥控环 / 右侧同型分身';
      actor[0].disguised = true;
      actor[1].reverseTime = 3;
      actor[2].controlling = true;
      actor[3].position.x = 3.4;
      actor[3].previous.x = 3.4;
      state.decoys = [
        {
          id: 301,
          ownerId: 3,
          position: { x: 5.3, y: 0 },
          previous: { x: 5.3, y: 0 },
          velocity: { x: 0, y: 0 },
          facing: { x: 0, y: 1 },
          powers: ['decoy'],
          alive: true,
          age: 1,
          dashTime: 0,
        },
      ];
    }
    document.getElementById('caption').innerHTML = `<h1>${title}</h1><p>${subtitle}</p>`;
    renderer = new GameRenderer(container, state);
    // A presentation-only close-up. Game camera behavior is tested separately.
    renderer.camera = new THREE.OrthographicCamera(-7.5, 7.5, 4.6875, -4.6875, 0.1, 180);
    for (let i = 0; i < 24; i++) {
      state.time = 10 + i / 60;
      state.phaseTime = state.time;
      state.discs.forEach((d, j) => {
        d.previous = { ...d.position };
        d.position = { x: 1.3 + i * 0.15, y: 2 + Math.sin(i * 0.1 + j) * 0.7 + j * 1.2 };
      });
      renderer.draw(state, 1, state.time, 1 / 60, false);
    }
    const report = {
      kind,
      render: renderer.stats(),
      weapons: renderer.weapons.stats(),
      effects: renderer.effects.stats(),
      decoys: renderer.decoys.size,
      stateUnchangedByPause: false,
    };
    const before = JSON.stringify(state);
    for (let i = 0; i < 20; i++) renderer.draw(state, 1, state.time, 0, false);
    report.stateUnchangedByPause = before === JSON.stringify(state);
    reports.push(report);
    return report;
  };
  window.fixtureReports = reports;
  window.fixtureDispose = () => renderer?.dispose();
});
for (const kind of ['weapons', 'elements', 'statuses']) {
  await page.evaluate((kind) => window.renderFixture(kind), kind);
  await page.screenshot({ path: `${out}/${kind}.png` });
}
const fixtures = await page.evaluate(() => {
  window.fixtureDispose();
  return window.fixtureReports;
});
const report = { kind: 'synthetic presentation only', url: base, errors, fixtures };
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
await browser.close();
if (errors.length) process.exitCode = 1;
