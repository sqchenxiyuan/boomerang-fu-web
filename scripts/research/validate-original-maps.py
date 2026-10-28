"""Verify catalog, raw header pointers, hierarchy, geometry conversion and links."""
from pathlib import Path
import collections,importlib.util,json,math,struct
ROOT=Path(__file__).resolve().parents[2];P=ROOT/'analysis/derived/v5-maps'
spec=importlib.util.spec_from_file_location('convert_maps',ROOT/'scripts/research/convert-original-maps.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
source_maps={};headers=0;local_refs=0;external_refs=0;issues=[];static_batches=0
def refs(value):
    if isinstance(value,dict):
        if set(value)=={'m_FileID','m_PathID'}:yield value
        else:
            for v in value.values():yield from refs(v)
    elif isinstance(value,list):
        for v in value:yield from refs(v)
for index in range(2,61):
    d=c.load(f'level{index}.json');source_maps[d['file']]=d
    tids=set(map(int,d['transforms']));gids=set(map(int,d['gameObjects']))
    known=tids|gids|{v['source']['pathID'] for v in d['colliders']}|{v['source']['pathID'] for v in d['monoBehaviours']}
    for m in d['monoBehaviours']:
        raw=bytes.fromhex(m['rawHex']);actual=m['data']['m_Script'];assert (actual['m_FileID'],actual['m_PathID'])==struct.unpack_from('<iq',raw,16)
        assert len(raw)==m['source']['byteSize'];headers+=1
        for ref in refs(m['data']):
            fid,pid=ref['m_FileID'],ref['m_PathID'];assert 0<=fid<=len(d['externals']),(d['file'],m['source'],ref)
            if pid:
                if fid:external_refs+=1
                else:local_refs+=1
    assert not d['parseFailures']
    for tid,t in d['transforms'].items():
        parent=t['data']['m_Father'];assert parent['m_FileID']==0;assert not parent['m_PathID'] or parent['m_PathID'] in tids
        assert t['data']['m_GameObject']['m_PathID'] in gids
    for mesh in d['visualMeshBounds']:
        p=mesh['boundsProvenance']
        if p['boundsSpace']!='mesh-local':
            static_batches+=1
            assert p['subMeshCount']>0
            assert p['firstSubMesh']+p['subMeshCount']<=len(mesh['mesh']['subMeshes'])
            assert not p['appliedTransformPathID'] or p['appliedTransformPathID'] in tids
        assert all(math.isfinite(v) for key in ('center','extent') for v in mesh['worldBounds'][key])
catalog=c.load('catalog.json');production=json.loads((ROOT/'src/core/original-map-data.json').read_text(encoding='utf8'))
assert len(catalog['items'])==58==len(production)
assert len({x['info']['id'] for x in production})==58
assert sum(not x['info']['tutorial'] for x in production)==57
assert sum(x['info']['requiredDLC']==2 for x in production)==21
count_geometries=0;max_error=0.;counts=collections.Counter();obstacle_layers=0;obstacle_heights=0;rotating_floors=0
for entry in production:
    a=entry['arena'];d=source_maps[entry['provenance']['sceneFile']];cb={x['source']['pathID']:x for x in d['colliders']}
    assert len(a['spawns'])==6,(entry['info']['id'],len(a['spawns']))
    mechanisms=a['environment']['mechanisms'];mids={m['id'] for m in mechanisms};obs={x['id'] for x in a['obstacles']};floors={x['id'] for x in a['floors']};portals={x['id'] for x in a['portals']}
    for m in mechanisms:
        counts[m['kind']]+=1
        assert not m.get('parentId') or m['parentId'] in mids
        assert set(m.get('targetIds',[]))<=mids
        assert set(m.get('obstacleIds',[]))<=obs
        assert set(m.get('floorIds',[]))<=floors
        assert set(m.get('portalIds',[]))<=portals
        visited=set();node=m
        while node.get('parentId'):
            assert node['id'] not in visited,('mechanism cycle',entry['info']['id'],node['id']);visited.add(node['id']);node=next(x for x in mechanisms if x['id']==node['parentId'])
        if m['kind'] in ('movingFloor','reactiveFloor'):
            original=next(x for x in d['monoBehaviours'] if x['source']['pathID']==m['source']['pathId'])
            fields=original['data']
            if fields['useRotations']:
                tid=original['transformPathID'];parent=d['transforms'][str(tid)]['data']['m_Father']['m_PathID']
                parent_angle=c.angle(d['transforms'][str(parent)]['worldMatrix']) if parent else 0.
                points=fields['positionRotations'] if m['kind']=='movingFloor' else fields['positions']
                for waypoint,p in zip(m['waypoints'],points):assert abs(waypoint['angle']-(parent_angle-math.radians(p['z'])))<1e-6
                rotating_floors+=1
    for portal in a['portals']:assert portal['exitId'] in portals
    for row in a['obstacles']:
        collider=cb[int(row['id'].split('-')[1])]
        assert row['sourceLayer']==collider['layer']==8;obstacle_layers+=1
        assert all(math.isfinite(row[key]) for key in ('baseHeight','height'));assert row['height']>=.06;obstacle_heights+=1
    for row in a['obstacles']+a['floors']+a['surfaces']:
        col=cb[int(row['id'].split('-')[1])];expected=c.world_paths(col)
        actual=[[c.rotate(p,row['angle']) for p in path] for path in row['paths']]
        assert len(actual)==len(expected)
        for pa,pb in zip(actual,expected):
            assert len(pa)==len(pb)
            for p,q in zip(pa,pb):
                error=math.hypot(p['x']+row['position']['x']-q['x'],p['y']+row['position']['y']-q['y']);max_error=max(max_error,error)
                assert error<.00001,(entry['info']['id'],row['id'],error)
        count_geometries+=1
four_cogs=next(x for x in production if x['info']['id']=='original-four-cogs')
pole=next(x for x in four_cogs['arena']['obstacles'] if x['id']=='c-2386')
assert abs(pole['baseHeight']-(-.1080524445))<1e-6
assert abs(pole['baseHeight']+pole['height']-4.1424953461)<1e-6
enclosed=next(x for x in production if x['info']['id']=='original-enclosed')
cliff=next(x for x in enclosed['arena']['obstacles'] if x['id']=='c-1694')
assert abs(cliff['baseHeight']-(-2.13999968))<1e-6
assert abs(cliff['baseHeight']+cliff['height']-1.16021678)<1e-6
result={'kind':'static extraction and conversion consistency checks; not original runtime parity',
        'catalog':58,'formalMaps':57,'tutorialMaps':1,'dlcMaps':21,'sceneEntries':59,'monoBehaviourHeadersVerified':headers,
        'localPPtrReferencesWithValidFileID':local_refs,'externalPPtrReferencesWithValidFileID':external_refs,
        'convertedColliderContoursVerified':count_geometries,'maxWorldCoordinateRoundTripError':max_error,'mechanisms':dict(counts),
        'staticBatchRendererBoundsVerified':static_batches,'obstacleSourceLayersVerified':obstacle_layers,
        'obstacleHeightFieldsVerified':obstacle_heights,'rotatingFloorWaypointsVerified':rotating_floors,
        'allProductionLinksResolved':True,'allMapSpawnCounts':6,'issues':issues}
(P/'validation-report.json').write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result,indent=2))
