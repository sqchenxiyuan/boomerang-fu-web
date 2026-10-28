"""Local inspection only: extract catalog sprites and build a contact sheet."""
from pathlib import Path
import hashlib,json,math,sys
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/python'))
import UnityPy
from PIL import Image,ImageDraw,ImageFont
DATA=Path(r'F:\SteamLibrary\steamapps\common\Boomerang Fu\Boomerang Fu_Data')
OUT=ROOT/'analysis/derived/v5-maps/previews';OUT.mkdir(parents=True,exist_ok=True)
catalog=json.loads((OUT.parent/'catalog.json').read_text(encoding='utf8'))
env=UnityPy.load(str(DATA/'sharedassets1.assets'))
asset=next(a for a in env.assets if Path(a.name).name=='sharedassets1.assets')
rows=[]
for entry in sorted(catalog['items'],key=lambda e:e['buildIndices'][0]):
    ptr=entry['data']['mapSprite'];assert ptr['m_FileID']==0
    if not ptr['m_PathID']:
        rows.append({'name':entry['data']['m_Name'],'file':None,'buildIndices':entry['buildIndices'],'requiredDLC':entry['data']['requiredDLC'],'sprite':None,'note':'LevelAsset.mapSprite is null; no source preview available'})
        continue
    obj=asset.objects[ptr['m_PathID']];sprite=obj.read();im=sprite.image.convert('RGBA')
    file=entry['data']['m_Name']+'.png';im.save(OUT/file)
    rows.append({'name':entry['data']['m_Name'],'file':file,'buildIndices':entry['buildIndices'],'requiredDLC':entry['data']['requiredDLC'],
                 'sprite':{'file':'sharedassets1.assets','pathID':obj.path_id,'byteStart':obj.byte_start,'byteSize':obj.byte_size},
                 'size':list(im.size),'sha256':hashlib.sha256((OUT/file).read_bytes()).hexdigest()})
cols=8;cw=220;ch=175
sheet=Image.new('RGB',(cols*cw,math.ceil(len(rows)/cols)*ch),'#182127');draw=ImageDraw.Draw(sheet)
font=ImageFont.truetype(r'C:\Windows\Fonts\arial.ttf',14)
small=ImageFont.truetype(r'C:\Windows\Fonts\arial.ttf',12)
for i,row in enumerate(rows):
    x,y=(i%cols)*cw,(i//cols)*ch
    if row['file']:
        im=Image.open(OUT/row['file']).convert('RGBA');im.thumbnail((cw-12,ch-44))
        sheet.paste(im,(x+(cw-im.width)//2,y+4),im)
    else:draw.text((x+18,y+60),'No preview in LevelAsset',font=font,fill='#a8bcb4')
    draw.text((x+6,y+ch-36),row['name'].removeprefix('Level'),font=font,fill='#e9f0ed')
    draw.text((x+6,y+ch-18),'scene '+','.join(map(str,row['buildIndices']))+(' | Just Desserts' if row['requiredDLC']==2 else ' | base'),font=small,fill='#a8bcb4')
sheet.save(OUT/'contact-sheet.jpg',quality=92)
(OUT/'manifest.json').write_text(json.dumps({'kind':'local extracted map preview sprites; not gameplay screenshots; not distributed with web','count':len(rows),'items':rows},indent=2),encoding='utf8')
print('exported',sum(bool(row['file']) for row in rows),'preview PNGs for',len(rows),'catalog entries and',OUT/'contact-sheet.jpg')
