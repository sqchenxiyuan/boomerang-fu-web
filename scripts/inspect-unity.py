"""Read-only Unity serialized-file inventory; writes only under the workspace."""
from pathlib import Path
import collections
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools' / 'python'))
import UnityPy

DATA = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r'F:\SteamLibrary\steamapps\common\Boomerang Fu\Boomerang Fu_Data')
OUT = ROOT / 'analysis' / 'derived'
OUT.mkdir(parents=True, exist_ok=True)
paths = [DATA / 'globalgamemanagers', DATA / 'globalgamemanagers.assets', DATA / 'resources.assets']
paths += sorted(DATA.glob('sharedassets*.assets'))
paths += sorted(p for p in DATA.glob('level*') if p.suffix == '')
report = {'source': str(DATA), 'parser': f'UnityPy {UnityPy.__version__}', 'files': [], 'objects': [], 'errors': []}
settings = []
names_to_read = {'MonoScript', 'Mesh', 'Material', 'Texture2D', 'Sprite', 'AnimationClip', 'AnimatorController', 'TextAsset', 'GameObject'}
for path in paths:
    counts = collections.Counter()
    try:
        env = UnityPy.load(str(path))
        # Dependencies can be resolved lazily; inventory only the requested file.
        for asset in env.assets:
            if Path(asset.name).name != path.name:
                continue
            for obj in asset.objects.values():
                kind = obj.type.name
                counts[kind] += 1
                row = {'file': path.name, 'path_id': obj.path_id, 'type': kind}
                if kind in names_to_read:
                    try:
                        row['name'] = obj.peek_name()
                    except Exception as e:
                        row['name_error'] = str(e)[:160]
                report['objects'].append(row)
                if kind in {'BuildSettings', 'TimeManager', 'Physics2DSettings', 'PlayerSettings'}:
                    try:
                        tree = obj.read_typetree()
                        if kind == 'PlayerSettings':
                            keep = {'companyName', 'productName', 'bundleVersion', 'defaultScreenWidth', 'defaultScreenHeight', 'activeColorSpace'}
                            tree = {k: v for k, v in tree.items() if k in keep}
                        settings.append({**row, 'data': tree})
                    except Exception as e:
                        report['errors'].append({**row, 'error': str(e)[:200]})
        report['files'].append({'file': path.name, 'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(path.open('rb'), 'sha256').hexdigest(), 'counts': dict(counts)})
    except Exception as e:
        report['errors'].append({'file': path.name, 'error': str(e)[:300]})
    print(path.name, sum(counts.values()), flush=True)
(OUT / 'unity-inventory.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
(OUT / 'unity-settings.json').write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding='utf-8')
totals = collections.Counter()
for f in report['files']:
    totals.update(f['counts'])
print(json.dumps({'totals': dict(totals), 'errors': len(report['errors'])}, ensure_ascii=False))
