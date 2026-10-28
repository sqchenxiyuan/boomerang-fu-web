"""Bounded scene-prefix decoding and six local map-preview texture samples."""
from pathlib import Path
import hashlib
import json
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools' / 'python'))
import UnityPy
from PIL import Image, ImageDraw, ImageFont

DATA = Path(r'F:\SteamLibrary\steamapps\common\Boomerang Fu\Boomerang Fu_Data')
OUT = ROOT / 'analysis' / 'derived'
OUT.mkdir(parents=True, exist_ok=True)
env = UnityPy.load(str(DATA / 'globalgamemanagers'))
obj = next(o for o in env.objects if o.type.name == 'BuildSettings')
raw = obj.get_raw_data()
offset = 0

def i32():
    global offset
    if offset + 4 > len(raw):
        raise ValueError('array prefix exceeds object')
    value = struct.unpack_from('<i', raw, offset)[0]
    offset += 4
    return value

count = i32()
assert 0 <= count <= 10000
scenes = []
for index in range(count):
    size = i32()
    assert 0 < size <= 4096 and offset + size <= len(raw)
    start = offset
    name = raw[offset:offset + size].decode('utf-8', errors='strict')
    assert name.startswith('Assets/') and name.endswith('.unity')
    offset = (offset + size + 3) & ~3
    scenes.append({'build_index': index, 'path': name, 'source_file_offset': obj.byte_start + start, 'byte_length': size})
scene_result = {
    'file': str(DATA / 'globalgamemanagers'),
    'sha256': hashlib.sha256((DATA / 'globalgamemanagers').read_bytes()).hexdigest(),
    'path_id': obj.path_id,
    'scope': 'Only initial little-endian scene string array decoded; full BuildSettings schema failed in UnityPy 1.23.0',
    'object_bytes': len(raw), 'decoded_prefix_bytes': offset,
    'uninterpreted_tail_bytes': len(raw) - offset, 'scenes': scenes,
}
(OUT / 'build-scenes-prefix.json').write_text(json.dumps(scene_result, indent=2), encoding='utf-8')

names = ['LevelEnclosed', 'LevelCrate', 'LevelTeleportals', 'LevelFourCogs', 'LevelFalling', 'LevelRaftPair']
env = UnityPy.load(str(DATA / 'sharedassets1.assets'))
by_name = {o.peek_name(): o for o in env.objects if o.type.name == 'Texture2D'}
sheet = Image.new('RGB', (1200, 670), '#171d26')
draw = ImageDraw.Draw(sheet)
font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 18)
title = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 24)
draw.text((22, 16), 'Boomerang Fu | packaged map previews', font=title, fill='#f5f6f7')
records = []
for i, name in enumerate(names):
    obj = by_name[name]
    texture = obj.read()
    im = texture.image.convert('RGBA')
    records.append({'file': 'sharedassets1.assets', 'path_id': obj.path_id, 'name': name, 'texture_dimensions': list(im.size)})
    im.thumbnail((376, 250), Image.Resampling.LANCZOS)
    x, y = 12 + (i % 3) * 400, 58 + (i // 3) * 300
    draw.rounded_rectangle((x, y, x + 376, y + 282), radius=10, fill='#26303e')
    sheet.paste(im, (x + (376 - im.width) // 2, y + (250 - im.height) // 2), im)
    draw.text((x + 12, y + 255), name, font=font, fill='#e4e8ed')
sheet.save(OUT / 'map-preview-sheet.png')
(OUT / 'map-preview-manifest.json').write_text(json.dumps({'source_file': 'sharedassets1.assets', 'source_sha256': hashlib.sha256((DATA / 'sharedassets1.assets').read_bytes()).hexdigest(), 'resource_file': 'sharedassets1.assets.resS', 'resource_sha256': hashlib.sha256((DATA / 'sharedassets1.assets.resS').read_bytes()).hexdigest(), 'kind': 'Exported packaged textures, not runtime screenshots', 'textures': records}, indent=2), encoding='utf-8')
print(json.dumps({'scene_count': count, 'first_scenes': scenes[:3], 'uninterpreted_tail_bytes': len(raw) - offset, 'previews': records}, ensure_ascii=False))
