"""Read-only complete original map geometry inventory (no target execution).

Usage: bundled-python scripts/research/export-original-maps.py [--sample] [--no-generator]
All coordinates remain Unity coordinates. Optional web points map (x,y)->(.4x,-.4y).
"""
from pathlib import Path
import argparse, collections, hashlib, json, math, struct, sys, time

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'analysis/derived/v5-tools'), str(ROOT/'tools/python')]
import UnityPy

DATA = Path(r'F:\SteamLibrary\steamapps\common\Boomerang Fu\Boomerang Fu_Data')
OUT = ROOT/'analysis/derived/v5-maps'
IDENTITY = [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.]
GEN = None
LAYERS = {}
MESH_BOUNDS = {}

def dump(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',',':'), allow_nan=False), encoding='utf-8')

def sha(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream,'sha256').hexdigest()

def load(name):
    env = UnityPy.load(str(DATA/name))
    if GEN: env.typetree_generator = GEN
    asset = next(a for a in env.assets if Path(a.name).name==name)
    return env, asset

def source(obj):
    return {'file':Path(obj.assets_file.name).name,'pathID':obj.path_id,
            'byteStart':obj.byte_start,'byteSize':obj.byte_size,'type':obj.type.name}

def pref(asset, value):
    if isinstance(value, (tuple,list)): fid,pid=value
    else: fid,pid=value['m_FileID'],value['m_PathID']
    name=Path(asset.name).name if fid==0 else Path(asset.externals[fid-1].path).name
    return {'file':name,'pathID':pid,'fileID':fid}

def deref(env, asset, value):
    ref=pref(asset,value)
    if not ref['pathID']: return None
    if ref['file']==Path(asset.name).name: return asset.objects[ref['pathID']]
    target=env.find_file(ref['file'])
    return target.objects[ref['pathID']]

def cname(obj):
    b=obj.get_raw_data()
    return deref(obj.assets_file.environment,obj.assets_file,struct.unpack_from('<iq',b,16)).read().m_ClassName

def readmono(obj):
    t=obj.read_typetree()
    raw=obj.get_raw_data()
    # Generator 0.0.10 aligns m_Script after reading it, but the native Unity
    # MonoBehaviour header aligns m_Enabled BEFORE m_Script. The total header
    # size is unchanged, so user fields parse correctly; validate and repair
    # only the header pointer using independently verified fixed offsets.
    expected_go=struct.unpack_from('<iq',raw,0)
    assert tuple(t['m_GameObject'][k] for k in ('m_FileID','m_PathID'))==expected_go
    r=Reader(raw,28);name=r.string();assert t['m_Name']==name
    fid,pid=struct.unpack_from('<iq',raw,16)
    t['m_Script']={'m_FileID':fid,'m_PathID':pid}
    assert t['m_Enabled']==raw[12]
    return t

def matrix(tree):
    p,r,s=tree['m_LocalPosition'],tree['m_LocalRotation'],tree['m_LocalScale']
    x,y,z,w=[r[k] for k in ('x','y','z','w')]
    sx,sy,sz=[s[k] for k in ('x','y','z')]
    return [(1-2*y*y-2*z*z)*sx,(2*x*y-2*z*w)*sy,(2*x*z+2*y*w)*sz,p['x'],
            (2*x*y+2*z*w)*sx,(1-2*x*x-2*z*z)*sy,(2*y*z-2*x*w)*sz,p['y'],
            (2*x*z-2*y*w)*sx,(2*y*z+2*x*w)*sy,(1-2*x*x-2*y*y)*sz,p['z'],
            0.,0.,0.,1.]

def mul(a,b): return [sum(a[r*4+k]*b[k*4+c] for k in range(4)) for r in range(4) for c in range(4)]
def point(m,x,y,z=0.): return [m[i*4]*x+m[i*4+1]*y+m[i*4+2]*z+m[i*4+3] for i in range(3)]
def web(p): return [p[0]*.4,-p[1]*.4]

class Reader:
    def __init__(self,b,o=32): self.b,self.o=b,o
    def take(self,f):
        v=struct.unpack_from('<'+f,self.b,self.o); self.o+=struct.calcsize('<'+f)
        return v[0] if len(v)==1 else list(v)
    def ptr(self):
        fid,pid=self.take('iq'); return {'m_FileID':fid,'m_PathID':pid}
    def ptrs(self): return [self.ptr() for _ in range(self.take('i'))]
    def string(self):
        n=self.take('i'); assert 0<=n<=len(self.b)-self.o
        s=self.b[self.o:self.o+n].decode(); self.o=(self.o+n+3)&~3; return s

def level_prefix(obj):
    r=Reader(obj.get_raw_data())
    d={'destroyDiscsOOB':r.take('I'),'box':r.ptr(),'allowPlayersOutOfBounds':r.take('I'),
       'pathfindingGraph':r.ptr(),'playerStartingDiscs':r.take('i'),
       'playerSpawnPoints':r.ptrs(),'discSpawnPoints':r.ptrs()}
    return d,r.o

def shape(kind,t,m):
    off=t.get('m_Offset',{'x':0.,'y':0.})
    paths=[]; info={'offset':off}
    if kind=='BoxCollider2D':
        sx,sy=t['m_Size']['x']/2,t['m_Size']['y']/2
        paths=[[[-sx,-sy],[sx,-sy],[sx,sy],[-sx,sy]]]
        info.update(size=t['m_Size'],edgeRadius=t.get('m_EdgeRadius',0))
    elif kind=='PolygonCollider2D': paths=[[[p['x'],p['y']] for p in path] for path in t['m_Points']['m_Paths']]
    elif kind=='EdgeCollider2D':
        paths=[[[p['x'],p['y']] for p in t['m_Points']]]
        info.update(closed=False,edgeRadius=t.get('m_EdgeRadius',0))
    elif kind=='CircleCollider2D':
        radius=t['m_Radius']
        info.update(radius=radius,worldCenter=point(m,off['x'],off['y']),
                    worldBasisX=[m[0]*radius,m[4]*radius,m[8]*radius],
                    worldBasisY=[m[1]*radius,m[5]*radius,m[9]*radius],
                    worldRadius=radius*max(math.sqrt(sum(m[i*4]**2 for i in range(3))),math.sqrt(sum(m[i*4+1]**2 for i in range(3)))),
                    physicsRule='Unity 2022.3 CircleCollider2DTool.GetRadiusScaleFactor: radius * max(abs(lossyScale.x), abs(lossyScale.y)); center = projected TransformPoint(offset)',
                    exactRepresentation='Physics2D circle; affine basis retained only as authored-transform provenance')
    elif kind=='CapsuleCollider2D': info.update(size=t['m_Size'],direction=t['m_Direction'])
    else: info['unsupportedForDerivedOutline']=True
    if paths:
        world=[[point(m,p[0]+off['x'],p[1]+off['y']) for p in path] for path in paths]
        info.update(localPaths=paths,worldPaths=world,webPaths=[[web(p) for p in path] for path in world])
    return info

def export_map(index,scene):
    name=f'level{index}'
    env,a=load(name)
    gameobjects={}; transforms={}; collider_objects=[]; mono_objects=[]; mesh_filters=[]; renderers={}; other_counts=collections.Counter()
    for obj in a.objects.values():
        kind=obj.type.name
        if kind=='GameObject': gameobjects[obj.path_id]={'source':source(obj),'data':obj.read_typetree()}
        elif kind in ('Transform','RectTransform'): transforms[obj.path_id]={'source':source(obj),'data':obj.read_typetree()}
        elif kind.endswith('Collider2D'): collider_objects.append(obj)
        elif kind=='MonoBehaviour': mono_objects.append(obj)
        elif kind=='MeshFilter': mesh_filters.append(obj)
        elif kind=='MeshRenderer':
            rd=obj.read_typetree();renderers[rd['m_GameObject']['m_PathID']]={
                'source':source(obj),'enabled':bool(rd['m_Enabled']),
                'staticBatchInfo':rd['m_StaticBatchInfo'],'staticBatchRoot':pref(a,rd['m_StaticBatchRoot'])}
        else: other_counts[kind]+=1
    go_transform={v['data']['m_GameObject']['m_PathID']:k for k,v in transforms.items()}
    def world(pid):
        node=transforms[pid]
        if 'worldMatrix' in node:return node['worldMatrix']
        local=matrix(node['data']); par=node['data']['m_Father']
        assert par['m_FileID']==0
        node['worldMatrix']=mul(world(par['m_PathID']),local) if par['m_PathID'] else local
        return node['worldMatrix']
    def active(gid):
        go=gameobjects[gid]
        if 'activeInHierarchy' not in go:
            tid=go_transform.get(gid)
            parent=transforms[tid]['data']['m_Father']['m_PathID'] if tid else 0
            go['activeInHierarchy']=bool(go['data']['m_IsActive']) and (active(transforms[parent]['data']['m_GameObject']['m_PathID']) if parent else True)
        return go['activeInHierarchy']
    for pid,node in transforms.items():
        m=world(pid);node['worldPosition']=point(m,0,0);node['webPosition']=web(node['worldPosition'])
    for gid,go in gameobjects.items():
        active(gid);go['transformPathID']=go_transform.get(gid);go['layerName']=LAYERS.get(go['data']['m_Layer'],'')
    visual_meshes=[]
    for obj in mesh_filters:
        ft=obj.read_typetree();gid=ft['m_GameObject']['m_PathID'];ref=pref(a,ft['m_Mesh']);key=(ref['file'],ref['pathID'])
        if not ref['pathID']:continue
        if key not in MESH_BOUNDS:
            mesh=deref(env,a,ft['m_Mesh']);mesh_data=mesh.read();bounds=mesh_data.m_LocalAABB
            MESH_BOUNDS[key]={'source':source(mesh),'center':[getattr(bounds.m_Center,k) for k in ('x','y','z')],
                              'extent':[getattr(bounds.m_Extent,k) for k in ('x','y','z')],
                              'subMeshes':[{'index':i,'center':[getattr(sm.localAABB.m_Center,k) for k in ('x','y','z')],
                                            'extent':[getattr(sm.localAABB.m_Extent,k) for k in ('x','y','z')]}
                                           for i,sm in enumerate(mesh_data.m_SubMeshes)]}
        bb=MESH_BOUNDS[key];renderer=renderers.get(gid);batch=renderer['staticBatchInfo'] if renderer else {}
        first,count=batch.get('firstSubMesh',0),batch.get('subMeshCount',0)
        if count:
            # Static batching stores vertices in the batch-root coordinate space;
            # the Mesh can contain unrelated renderers (including giant floors).
            # Select this renderer's submeshes and apply only the batch root.
            selected=bb['subMeshes'][first:first+count]
            assert len(selected)==count,(name,gid,first,count,len(bb['subMeshes']))
            low=[min(sm['center'][i]-sm['extent'][i] for sm in selected) for i in range(3)]
            high=[max(sm['center'][i]+sm['extent'][i] for sm in selected) for i in range(3)]
            evaluated={'center':[(lo+hi)/2 for lo,hi in zip(low,high)],'extent':[(hi-lo)/2 for lo,hi in zip(low,high)]}
            batch_root=renderer['staticBatchRoot'];root_id=batch_root['pathID']
            assert not root_id or batch_root['file']==name,(name,gid,batch_root)
            m=world(root_id) if root_id else IDENTITY
            bounds_provenance={'boundsSpace':'static-batch-root' if root_id else 'world',
                               'firstSubMesh':first,'subMeshCount':count,'appliedTransformPathID':root_id}
        else:
            evaluated=bb;m=world(go_transform[gid])
            bounds_provenance={'boundsSpace':'mesh-local','appliedTransformPathID':go_transform[gid]}
        center=point(m,*evaluated['center'])
        ext=[sum(abs(m[i*4+j])*evaluated['extent'][j] for j in range(3)) for i in range(3)]
        visual_meshes.append({'source':source(obj),'gameObjectPathID':gid,'transformPathID':go_transform[gid],
                              'renderer':renderer,'activeInHierarchy':gameobjects[gid]['activeInHierarchy'],
                              'mesh':bb,'boundsProvenance':bounds_provenance,
                              'evaluatedBounds':{'center':evaluated['center'],'extent':evaluated['extent']},
                              'worldBounds':{'center':center,'extent':ext}})
    colliders=[]
    for obj in collider_objects:
        t=obj.read_typetree();gid=t['m_GameObject']['m_PathID'];go=gameobjects[gid];tid=go_transform[gid];m=world(tid)
        colliders.append({'source':source(obj),'gameObjectPathID':gid,'transformPathID':tid,'name':go['data']['m_Name'],
                          'layer':go['data']['m_Layer'],'layerName':go['layerName'],
                          'activeInHierarchy':go['activeInHierarchy'],'isActiveAndEnabled':go['activeInHierarchy'] and bool(t['m_Enabled']),
                          'isTrigger':t['m_IsTrigger'],'worldMatrix':m,'shape':shape(obj.type.name,t,m),'data':t})
    mono=[];levels=[];failures=[]
    for obj in mono_objects:
        cls=cname(obj);b=obj.get_raw_data();gid=struct.unpack_from('<q',b,4)[0]
        row={'source':source(obj),'class':cls,'gameObjectPathID':gid,'transformPathID':go_transform.get(gid),'rawHex':b.hex()}
        try:
            row['data']=readmono(obj)
            row['parseStatus']='complete-size-checked'
        except Exception as exc:
            row.update(parseStatus='unparsed',error=str(exc),rawHex=b.hex())
            if cls in ('Level','LevelTutorial'):
                row['data'],end=level_prefix(obj);row.update(parseStatus='prefix-only',parsedPrefixBytes=end,unparsedTailBytes=len(b)-end)
            else: failures.append({'pathID':obj.path_id,'class':cls,'error':str(exc)})
        if cls in ('Level','LevelTutorial'): levels.append(row)
        mono.append(row)
    def spawn(p):
        ref=pref(a,p);assert ref['file']==name
        t=transforms[ref['pathID']]
        return {'source':ref,'worldPosition':t['worldPosition'],'webPosition':t['webPosition'],
                'parentTransformPathID':t['data']['m_Father']['m_PathID']}
    for lv in levels:
        lv['playerSpawns']=[spawn(p) for p in lv['data']['playerSpawnPoints']]
        lv['discSpawns']=[spawn(p) for p in lv['data']['discSpawnPoints']]
        lv['boundary']=next(c for c in colliders if c['source']['pathID']==lv['data']['box']['m_PathID'])
    result={'format':'original-unity-map-v1','kind':'static installation resource extraction; no target execution',
            'file':name,'sha256':sha(DATA/name),'unityVersion':str(a.unity_version),'buildIndex':index,'scenePath':scene,
            'coordinates':{'authoritative':'Unity XY physics; full XYZ transforms preserved','matrix':'row-major 4x4, column-vector multiplication',
                           'webProjection':'x = unity.x * 0.4; y = -unity.y * 0.4','worldScale':.4},
            'externals':[{'fileID':i+1,'path':x.path} for i,x in enumerate(a.externals)],'levels':levels,
            'gameObjects':gameobjects,'transforms':transforms,'colliders':colliders,'monoBehaviours':mono,'visualMeshBounds':visual_meshes,
            'otherObjectTypeCounts':dict(other_counts),'parseFailures':failures}
    path=OUT/f'{name}.json';dump(path,result)
    summary={'file':name,'path':str(path.relative_to(ROOT)).replace('\\','/'),'sha256':result['sha256'],
             'buildIndex':index,'scenePath':scene,'levelComponents':len(levels),'gameObjects':len(gameobjects),'transforms':len(transforms),
             'colliders':len(colliders),'activeColliders':sum(c['isActiveAndEnabled'] for c in colliders),
             'collidersByLayer':dict(collections.Counter(c['layerName'] for c in colliders)),
             'activeCollidersByLayer':dict(collections.Counter(c['layerName'] for c in colliders if c['isActiveAndEnabled'])),
             'monoBehavioursByClass':dict(collections.Counter(c['class'] for c in mono)),
             'parseFailures':len(failures),'playerSpawnCount':[len(l['playerSpawns']) for l in levels]}
    print(json.dumps(summary),flush=True)
    return summary

def export_catalog(scenes):
    env,a=load('level1')
    manager=next(o for o in a.objects.values() if o.type.name=='MonoBehaviour' and cname(o)=='LevelManager')
    tree=readmono(manager)
    dump(OUT/'level-manager.json',{'source':source(manager),'sha256':sha(DATA/'level1'),'data':tree,
                                'externals':[{'fileID':i+1,'path':x.path} for i,x in enumerate(a.externals)]})
    items=[]
    for ptr in tree['levelAssets']:
        obj=deref(env,a,ptr);t=readmono(obj)
        scene=t['path']
        matches=[i for i,s in enumerate(scenes) if s==scene or Path(s).stem==scene or Path(s).stem==Path(scene).stem]
        items.append({'source':source(obj),'sha256':sha(DATA/Path(obj.assets_file.name).name),'data':t,
                      'buildIndices':matches,'complexityName':{0:'Tutorial',1:'Simple',2:'Advanced'}.get(t['complexity']),
                      'supportedMatchTypeNames':[{0:'DeathMatch',1:'GoldenDisc',2:'KingOfTheHill',3:'HideAndSeek'}.get(x,str(x)) for x in t['supportedMatchTypes']]})
    result={'source':source(manager),'catalogField':'levelAssets','count':len(items),'items':items,
            'sceneFilesNotInCatalog':[{'buildIndex':i,'scenePath':s} for i,s in enumerate(scenes) if i>=2 and not any(i in x['buildIndices'] for x in items)]}
    dump(OUT/'catalog.json',result)
    prefab=deref(env,a,{'m_FileID':2,'m_PathID':9661}) if Path(a.externals[1].path).name=='sharedassets1.assets' else None
    if prefab:
        t=readmono(prefab)
        dump(OUT/'player-prefab.json',{'source':source(prefab),'sha256':sha(DATA/'sharedassets1.assets'),'data':t,
             'masks':{k:{'bits':v['m_Bits'],'layers':[LAYERS[i] for i in range(32) if v['m_Bits']&(1<<i)]} for k,v in t.items() if isinstance(v,dict) and 'm_Bits' in v}})
    print(json.dumps({'catalogCount':len(items),'uncataloguedScenes':result['sceneFilesNotInCatalog']}),flush=True)

def main():
    global GEN,LAYERS
    parser=argparse.ArgumentParser();parser.add_argument('--sample',action='store_true');parser.add_argument('--no-generator',action='store_true');args=parser.parse_args()
    if not args.no_generator:
        from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator
        GEN=TypeTreeGenerator('2022.3.62f2');GEN.load_local_dll_folder(str(DATA/'Managed'))
    env,settings=load('globalgamemanagers')
    tags=next(o.read_typetree() for o in settings.objects.values() if o.type.name=='TagManager')
    LAYERS={i:name for i,name in enumerate(tags['layers'])}
    dump(OUT/'layers.json',{'source':source(next(o for o in settings.objects.values() if o.type.name=='TagManager')),'sha256':sha(DATA/'globalgamemanagers'),'data':tags})
    build=next(o for o in settings.objects.values() if o.type.name=='BuildSettings');r=Reader(build.get_raw_data(),0)
    count=r.take('i');scenes=[r.string() for _ in range(count)]
    dump(OUT/'build-scenes.json',{'source':source(build),'sha256':sha(DATA/'globalgamemanagers'),'scenes':scenes,'parsedPrefixBytes':r.o,'unparsedTailBytes':build.byte_size-r.o})
    if GEN:export_catalog(scenes)
    maps=[]
    for i,scene in enumerate(scenes):
        if i<2:continue
        maps.append(export_map(i,scene))
        if args.sample:break
    dump(OUT/('sample-index.json' if args.sample else 'index.json'),{'kind':'static extraction','sceneCount':len(scenes),'hostScenes':scenes[:2],'maps':maps,'layers':LAYERS})
    if GEN:
        dump(OUT/'serialized-schemas.json',{'generator':'TypeTreeGeneratorAPI 0.0.10',
            'headerCorrection':'MonoBehaviour.m_Script is independently parsed at object byte 16 after m_Enabled alignment; generated header incorrectly aligns after PPtr',
            'duplicateFieldNames':'Raw bytes are retained because dict decoding collapses hidden inherited fields with the same serialized name',
            'assemblies':{p.name:sha(p) for p in (DATA/'Managed').glob('*.dll')},
            'schemas':[{'assembly':key[0],'class':key[1],'nodes':[{'level':n.m_Level,'type':n.m_Type,'name':n.m_Name,'flags':n.m_MetaFlag} for n in node.traverse()]} for key,node in GEN.cache.items()]})

if __name__=='__main__':main()
