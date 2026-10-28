"""Reconcile every installed serialized .assets LevelAsset with the live catalog."""
from pathlib import Path
import importlib.util,json
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('map_export',ROOT/'scripts/research/export-original-maps.py');e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator
e.GEN=TypeTreeGenerator('2022.3.62f2');e.GEN.load_local_dll_folder(str(e.DATA/'Managed'))
catalog=json.loads((e.OUT/'catalog.json').read_text());known={(x['source']['file'],x['source']['pathID']) for x in catalog['items']}
items=[];files=[]
for path in sorted(e.DATA.glob('*.assets')):
    env,asset=e.load(path.name);found=[]
    for obj in asset.objects.values():
        if obj.type.name=='MonoBehaviour' and e.cname(obj)=='LevelAsset':
            row={'source':e.source(obj),'data':e.readmono(obj),'catalogued':(path.name,obj.path_id) in known};items.append(row);found.append(obj.path_id)
    files.append({'file':path.name,'sha256':e.sha(path),'levelAssetPathIDs':found})
result={'kind':'all installed top-level serialized .assets files scanned; no game execution','files':files,'count':len(items),'items':items,
        'uncatalogued':[x['source'] for x in items if not x['catalogued']]}
e.dump(e.OUT/'all-level-assets.json',result);print(json.dumps({'files':len(files),'levelAssets':len(items),'uncatalogued':result['uncatalogued']}))
