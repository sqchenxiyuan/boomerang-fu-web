"""Convert extracted original scalar geometry/rules to the web Arena contract.

Does not copy textures, meshes, audio, executable bytes or decompiled source.
"""
from pathlib import Path
import argparse, collections, json, math, re

ROOT=Path(__file__).resolve().parents[2]
INPUT=ROOT/'analysis/derived/v5-maps'
OUTPUT=ROOT/'src/core/original-map-data.json'
SCALE=.4
IDENTITY=[1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.]
KINDS={'MovingObstacle':'movingObstacle','MovingObstacleButter':'movingObstacle','MovingObstacleRollingPin':'movingObstacle',
       'MovingFloor':'movingFloor','MovingFloorReactive':'reactiveFloor','MovingDoor':'door',
       'FallingFloor':'fallingFloor','TrapFloor':'trapFloor','Switch':'switch','Plant':'plant',
       'DestructableObstacle':'destructible','AnimatedObstacle':'animated','DestructableObstacleDestroyer':'destroyer','AutoRotate':'movingObstacle'}

def load(name):return json.loads((INPUT/name).read_text(encoding='utf8'))
def vec(x,y):return {'x':x,'y':y}
def transform(m,p):return [sum(m[i*4+j]*p[j] for j in range(3))+m[i*4+3] for i in range(3)]
def web(p):return vec(p[0]*SCALE,-p[1]*SCALE)
def sub(a,b):return vec(a['x']-b['x'],a['y']-b['y'])
def rotate(p,a):return vec(math.cos(a)*p['x']-math.sin(a)*p['y'],math.sin(a)*p['x']+math.cos(a)*p['y'])
def local(p,pos,a):return rotate(sub(p,pos),-a)
def angle(m):return math.atan2(-m[4],m[0])
def slug(name):return re.sub(r'(?<!^)(?=[A-Z])','-',name.removeprefix('Level')).lower()
def round_floats(obj):
    if isinstance(obj,float):return round(obj,7)
    if isinstance(obj,list):return [round_floats(x) for x in obj]
    if isinstance(obj,dict):return {k:round_floats(v) for k,v in obj.items()}
    return obj

def world_paths(c):
    s=c['shape']
    if 'worldPaths' in s:return [[web(p) for p in path] for path in s['worldPaths']]
    if c['source']['type']=='CircleCollider2D':
        center=s['worldCenter'];radius=circle_radius(c)/SCALE
        return [[web([center[0]+radius*math.cos(i*math.tau/32),center[1]+radius*math.sin(i*math.tau/32),center[2]]) for i in range(32)]]
    raise ValueError(('unsupported collider',c['source']))

def circle_radius(c):
    if c['source']['type']!='CircleCollider2D':return None
    # UnityCsReference 2022.3 CircleCollider2DTool.GetRadiusScaleFactor explicitly
    # uses the larger absolute lossyScale X/Y; it does not project a tilted disc.
    # Each full 3D matrix-column length is the corresponding absolute lossy scale.
    bx,by=c['shape']['worldBasisX'],c['shape']['worldBasisY']
    return max(math.sqrt(sum(x*x for x in bx)),math.sqrt(sum(x*x for x in by)))*SCALE

def convert(entry):
    meta=entry['data'];index=entry['buildIndices'][0];d=load(f'level{index}.json');lv=d['levels'][0];level=lv['data']
    ts={int(k):v for k,v in d['transforms'].items()};gos={int(k):v for k,v in d['gameObjects'].items()}
    cb={c['source']['pathID']:c for c in d['colliders']};mb={m['source']['pathID']:m for m in d['monoBehaviours']}
    materials_by_transform={m['transformPathID']:m['data']['obstacleMaterial'] for m in d['monoBehaviours'] if 'obstacleMaterial' in m.get('data',{})}
    def parents(tid,include=True):
        if not include:tid=ts[tid]['data']['m_Father']['m_PathID']
        while tid:
            yield tid
            tid=ts[tid]['data']['m_Father']['m_PathID']
    def pose(tid):
        t=ts[tid];return web(t['worldPosition']),angle(t['worldMatrix'])
    def active(m):return gos[m['gameObjectPathID']]['activeInHierarchy'] and bool(m['data']['m_Enabled'])
    selected=[];auto_seen=set()
    for m in d['monoBehaviours']:
        if m['class'] not in KINDS or not active(m):continue
        if m['class']=='AutoRotate':
            if not m['data']['rotateZ'] or not m['data']['speed'] or m['transformPathID'] in auto_seen:continue
            auto_seen.add(m['transformPathID'])
        selected.append(m)
    by_transform={m['transformPathID']:m for m in sorted(selected,key=lambda m:m['class']=='DestructableObstacleDestroyer',reverse=True)}
    def owner(tid,include=True):
        return next((by_transform[t] for t in parents(tid,include) if t in by_transform),None)
    def mid(m):return 'm-'+str(m['source']['pathID'])
    def nearest(c):return owner(c['transformPathID'])
    def geometry(c):
        pos,a=pose(c['transformPathID']);paths=[[local(p,pos,a) for p in path] for path in world_paths(c)]
        return {'position':pos,'angle':a,'paths':paths}
    visuals_by_transform=collections.defaultdict(list)
    for mesh in d.get('visualMeshBounds',[]):
        if mesh['activeInHierarchy'] and mesh.get('renderer',{}).get('enabled',False):
            visuals_by_transform[mesh['transformPathID']].append(mesh)
    def visual_bounds(tid,descend=True):
        matching=[v for t,vs in visuals_by_transform.items() if t==tid or (descend and tid in parents(t)) for v in vs]
        if not matching:return None
        return {'min':[min(v['worldBounds']['center'][i]-v['worldBounds']['extent'][i] for v in matching) for i in range(3)],
                'max':[max(v['worldBounds']['center'][i]+v['worldBounds']['extent'][i] for v in matching) for i in range(3)]}
    def object_height(c):
        bb=visual_bounds(c['transformPathID'])
        if bb:return {'baseHeight':-bb['max'][2]*SCALE,'height':max(.06,(bb['max'][2]-bb['min'][2])*SCALE)}
        return {'baseHeight':0.,'height':.65}
    mechanisms=[];mechanisms_by_id={}
    for m in selected:
        t=ts[m['transformPathID']];fields=m['data'];pos,a=pose(m['transformPathID']);kind=KINDS[m['class']]
        row={'id':mid(m),'kind':kind,'position':pos,'angle':a,'height':-t['worldPosition'][2]*SCALE,
             'active':True,'phase':'idle','source':{'file':d['file'],'pathId':m['source']['pathID'],'className':m['class']}}
        primary=by_transform[m['transformPathID']]
        parent=primary if primary!=m else owner(m['transformPathID'],False)
        if parent:row['parentId']=mid(parent)
        parent_tid=t['data']['m_Father']['m_PathID'];pm=ts[parent_tid]['worldMatrix'] if parent_tid else IDENTITY
        local_z=t['data']['m_LocalPosition']['z']
        if m['class']=='AutoRotate':
            row.update(rotating=True,clockwise=fields['speed']>0,rotationDuration=360/abs(fields['speed']),rotationDurations=[],waypoints=[],targetIndex=0)
        elif kind in ('movingObstacle','movingFloor','reactiveFloor'):
            pts=fields.get('positionRotations',[]) if kind=='movingFloor' else fields.get('positions',[])
            row['waypoints']=[]
            for p in pts:
                waypoint={'position':web(transform(pm,[p['x'],p['y'],local_z]))}
                if kind in ('movingFloor','reactiveFloor') and fields.get('useRotations'):
                    waypoint['angle']=angle(pm)-math.radians(p['z'])
                else:waypoint['angle']=a
                row['waypoints'].append(waypoint)
            row.update(targetIndex=fields.get('posIndex',0) if kind=='movingFloor' else 0,duration=fields.get('moveDur',fields.get('moveDurMin',.5)),
                       preDelay=fields.get('preMoveDur',0),spring=bool(fields.get('isSpring',0)),
                       springPause=fields.get('springPauseDur',0),returnDuration=fields.get('springWindBackDur',0),
                       randomizedStart=bool(fields.get('randomizedStart',0)))
            if kind=='movingObstacle':
                row.update(rotating=bool(fields['isRotatingObstacle']),clockwise=not bool(fields['isRotatingClockwise']),
                           rotationDuration=fields['rotatingDur'],rotationDurations=fields['rotatingDurations'],motion='eased')
                controllers=[x for x in d['monoBehaviours'] if x['class']=='RotatingObstacleController' and active(x) and x['transformPathID'] in parents(m['transformPathID'])]
                if controllers:
                    f=controllers[0]['data'];row['rotationModulation']={'amplitude':f['rotDurationDeltaMagnitude'],'rate':f['speedChangeRate'],'initialDuration':fields['rotatingDur']}
            else:
                row.update(minDuration=fields['moveDurMin'],maxDuration=fields['moveDurMax'],
                           clockwise=bool(fields['counterClockwise']),motion=['linear','circular','eased','supercircular','easedsoft'][fields['movementType']],
                           motionOrigin=web(transform(pm,[0.,0.,0.])),motionAngle=angle(pm))
        elif kind=='door':
            renderer_id=fields['doorRenderer']['m_PathID']
            meshes=[v for vs in visuals_by_transform.values() for v in vs if v.get('renderer',{}).get('source',{}).get('pathID')==renderer_id]
            extent=max((v['worldBounds']['extent'][2] for v in meshes),default=0.)
            if not meshes:
                bb=visual_bounds(m['transformPathID']);extent=(bb['max'][2]-bb['min'][2])/2 if bb else 1.
            row.update(duration=fields['moveDur'],closed=bool(fields['isClosed']),canClose=bool(fields['canClose']),
                       closedHeight=-transform(pm,[t['data']['m_LocalPosition']['x'],t['data']['m_LocalPosition']['y'],fields['closedZ']])[2]*SCALE,
                       openHeight=-transform(pm,[t['data']['m_LocalPosition']['x'],t['data']['m_LocalPosition']['y'],fields['openZ']])[2]*SCALE,
                       solidHeight=-extent*SCALE)
        elif kind=='switch':
            targets=[p['m_PathID'] for key in ('movingObstacles','movingDoors','movingFloors') for p in fields[key] if p['m_PathID']]
            row.update(targetIds=['m-'+str(pid) for pid in targets if pid in mb and active(mb[pid])],
                       cooldownDuration=fields['cooldownDur'],oneShot=bool(fields['oneShotOnly']),active=bool(fields['isActive']))
        elif kind=='fallingFloor':row.update(warningDuration=2.,fallDuration=.75,fallDistance=6.*SCALE)
        elif kind=='trapFloor':row.update(warningDuration=2.5,fallDuration=1.,fallDistance=5.*SCALE,respawnDuration=4.,riseDuration=.5,solidAfter=.2)
        elif kind=='plant':row.update(burnHealth=fields['burnHealth'],duration=fields['tiltDuration'])
        elif kind=='destructible':row.update(hitsLeft=fields['hitsLeft'])
        elif kind=='animated':row.update(cooldownDuration=fields['animationCooldown'])
        mechanisms.append(row);mechanisms_by_id[row['id']]=row
    obstacles=[];floors=[];surfaces=[];cids={};approximations=[]
    for c in d['colliders']:
        if not c['activeInHierarchy']:continue
        own=nearest(c);mechanism=mechanisms_by_id.get(mid(own)) if own else None
        # Authored disabled door colliders must remain available for later closing.
        if not c['isActiveAndEnabled'] and not (mechanism and mechanism['kind']=='door'):continue
        layer=c['layer'];pid=c['source']['pathID'];row=geometry(c)
        if layer==8:
            half=vec(max(abs(p['x']) for path in row['paths'] for p in path),max(abs(p['y']) for path in row['paths'] for p in path))
            row.update(id=f'c-{pid}',kind='crate' if mechanism and mechanism['kind']=='destructible' else 'stone',
                       half=half,broken=False,disabled=not c['isActiveAndEnabled'],sourceName=c['name'],sourceLayer=layer,
                       **object_height(c))
            radius=circle_radius(c)
            if radius is not None:
                row['position']=web(c['shape']['worldCenter']);row['radius']=radius;row['half']=vec(radius,radius)
                row['paths']=[[local(p,row['position'],row['angle']) for p in path] for path in world_paths(c)]
            mat=next((materials_by_transform[t] for t in parents(c['transformPathID']) if t in materials_by_transform),None)
            if mat is not None:row['material']=['stone','wood','bamboo','tree','shrub'][mat]
            else:
                names=' '.join(gos[ts[t]['data']['m_GameObject']['m_PathID']]['data']['m_Name'] for t in list(parents(c['transformPathID']))[:3]).lower()
                row['material']='bamboo' if 'bamboo' in names else 'tree' if 'tree' in names else 'shrub' if 'shrub' in names else 'wood' if any(s in names for s in ('crate','wood','timber','barrel')) else 'stone'
            obstacles.append(row);cids[pid]=row['id']
            if mechanism:row['mechanismId']=mechanism['id'];mechanism.setdefault('obstacleIds',[]).append(row['id'])
        elif layer in (16,29,30):
            row.update(id=f'f-{pid}',kind='moving' if layer==30 else 'falling' if mechanism and mechanism['kind'] in ('trapFloor','fallingFloor') else 'ground',
                       active=c['isActiveAndEnabled'],height=-ts[c['transformPathID']]['worldPosition'][2]*SCALE)
            radius=circle_radius(c)
            if radius is not None:
                row['position']=web(c['shape']['worldCenter']);row['radius']=radius
                row['paths']=[[local(p,row['position'],row['angle']) for p in path] for path in world_paths(c)]
            floors.append(row);cids[pid]=row['id']
            if mechanism:row['mechanismId']=mechanism['id'];mechanism.setdefault('floorIds',[]).append(row['id'])
        elif layer in (4,26):
            row.update(id=f's-{pid}',kind='water' if layer==4 else 'ice')
            radius=circle_radius(c)
            if radius is not None:
                row['position']=web(c['shape']['worldCenter']);row['radius']=radius
                row['paths']=[[local(p,row['position'],row['angle']) for p in path] for path in world_paths(c)]
            surfaces.append(row);cids[pid]=row['id']
        if c['source']['type']=='CircleCollider2D' and layer in (4,8,16,26,29,30):
            approximations.append({'colliderPathID':pid,'method':'32-sided visual contour only; runtime circle uses exact radius with Unity max-lossyScale rule'})
    # Use actual switch / plant / interactive collider shape as trigger geometry.
    for m in selected:
        row=mechanisms_by_id[mid(m)]
        if row['kind'] not in ('switch','plant','animated','destroyer'):continue
        own_colliders=[c for c in d['colliders'] if c['activeInHierarchy'] and c['isActiveAndEnabled']
                       and (c['gameObjectPathID']==m['gameObjectPathID'] if row['kind']=='destroyer' else nearest(c)==m)
                       and (row['kind']=='destroyer' or c['layer'] in {'switch':(24,),'plant':(21,),'animated':(8,)}[row['kind']])]
        if own_colliders:
            circle=own_colliders[0] if len(own_colliders)==1 and own_colliders[0]['source']['type']=='CircleCollider2D' else None
            if circle:
                s=circle['shape'];center=web(s['worldCenter'])
                centered=math.hypot(center['x']-row['position']['x'],center['y']-row['position']['y'])<1e-5
                if centered:row['radius']=circle_radius(circle)
                else:row['paths']=[[local(p,row['position'],row['angle']) for p in path] for path in world_paths(circle)]
            else:row['paths']=[[local(p,row['position'],row['angle']) for p in path] for c in own_colliders for path in world_paths(c)]
    portals=[];portal_rows=[m for m in d['monoBehaviours'] if m['class']=='Teleportal' and active(m)]
    for m in portal_rows:
        fields=m['data'];tid=m['transformPathID'];t=ts[tid];pos,a=pose(tid);mat=t['worldMatrix']
        col=next((c for c in d['colliders'] if c['gameObjectPathID']==m['gameObjectPathID'] and c['source']['type']=='BoxCollider2D' and c['isActiveAndEnabled']),None)
        if not col:raise ValueError(('Teleportal missing box',d['file'],m['source']['pathID']))
        size,off=col['data']['m_Size'],col['data']['m_Offset'];sx=math.hypot(mat[0],mat[4])*SCALE;sy=math.hypot(mat[1],mat[5])*SCALE
        norm=math.hypot(mat[1],mat[5]);direction=vec(mat[1]/norm,-mat[5]/norm)
        pair=min(m['source']['pathID'],fields['exit']['m_PathID']);palette=['#49dbd4','#f3aa56','#b29bff','#ee7bb3']
        row={'id':'p-'+str(m['source']['pathID']),'exitId':'p-'+str(fields['exit']['m_PathID']),
             'position':pos,'angle':a,'direction':direction,'half':vec(size['x']*sx/2,size['y']*sy/2),
             'triggerOffset':local(web(transform(mat,[off['x'],off['y'],0.])),pos,a),
             'thickness':(size['y']/2+off['y'])*sy,'radius':max(size['x']*sx,size['y']*sy)/2,
             'safeForAI':bool(fields['isSafeForAIs']),'color':palette[pair%len(palette)]}
        bb=visual_bounds(tid)
        if bb:row.update(baseHeight=-bb['max'][2]*SCALE,height=(bb['max'][2]-bb['min'][2])*SCALE)
        portals.append(row)
        own=owner(tid)
        if own:mechanisms_by_id[mid(own)].setdefault('portalIds',[]).append(row['id'])
    b=lv['boundary'];bm=b['worldMatrix'];bs=b['data']['m_Size'];bo=b['data']['m_Offset'];bp=world_paths(b)[0]
    center=web(transform(bm,[bo['x'],bo['y'],0.]));bh=vec(bs['x']*math.hypot(bm[0],bm[4])*SCALE/2,bs['y']*math.hypot(bm[1],bm[5])*SCALE/2)
    name=Path(meta['path']).stem;mapid='original-'+slug(name)
    # No serialized pickup spawn list exists: candidate points start from authored
    # player spawns; the simulation validates walkability before spawning pickups.
    spawns=[vec(*p['webPosition']) for p in lv['playerSpawns']]
    if not spawns and level.get('playerSpawnPods'):
        for ptr in level['playerSpawnPods']:
            pod_tid=gos[ptr['m_PathID']]['transformPathID']
            child=next(ts[p['m_PathID']] for p in ts[pod_tid]['data']['m_Children'] if gos[ts[p['m_PathID']]['data']['m_GameObject']['m_PathID']]['data']['m_Name']=='PlayerSpawn')
            spawns.append(vec(*child['webPosition']))
    pickup=[vec(*p['webPosition']) for p in lv['discSpawns']] or list(spawns)
    arena={'id':mapid,'revision':0,'halfWidth':max(abs(p['x']) for p in bp),'halfHeight':max(abs(p['y']) for p in bp),
           'obstacles':obstacles,'floors':floors,'surfaces':surfaces,'pits':[],'spawns':spawns,'pickupSpawns':pickup,'portals':portals,
           'environment':{'mechanisms':mechanisms,'collapse':{'enabled':bool(level['isFallingApart']),'interval':level['fallingApartDuration'],'remaining':level['fallingApartDuration']}},
           'sourceScene':meta['path'],'hazard':'cliff' if level['isCloudLevel'] else 'water',
           'boundary':{'center':center,'half':bh,'angle':angle(bm),'allowOutside':bool(level['allowPlayersOutOfBounds'])}}
    title=name.removeprefix('Level');theme='canal' if any(w in title for w in ['Raft','River','Pools','Pier','Onsen','Bridges']) else 'ruins' if meta['requiredDLC'] else 'garden'
    info={'id':mapid,'name':title,'subtitle':name,'description':'原版关卡几何与机关实例参数。','theme':theme,'source':'original',
          'tutorial':meta['complexity']==0,'minPlayers':meta['minPlayers'],'maxPlayers':meta['maxPlayers'],'complexity':entry['complexityName'],
          'requiredDLC':meta['requiredDLC'],'supportedMatchTypes':entry['supportedMatchTypeNames'],'buildIndices':entry['buildIndices']}
    report={'id':mapid,'sourceFile':d['file'],'colliders':len(d['colliders']),'obstacles':len(obstacles),'floors':len(floors),
            'surfaces':len(surfaces),'mechanisms':dict(collections.Counter(m['kind'] for m in mechanisms)),'portals':len(portals),'spawns':len(spawns),
            'shapeApproximations':approximations,'pickupCandidates':'authored disc spawns if present, otherwise authored player spawns; original pickup placement is runtime generated'}
    return {'info':info,'arena':arena,'provenance':{'sceneFile':d['file'],'sceneSha256':d['sha256'],'levelAssetPathId':entry['source']['pathID']}},report

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--check',action='store_true',help='Recompute and compare with the checked-in JSON without writing files')
    args=parser.parse_args()
    output=[];reports=[]
    for entry in sorted(load('catalog.json')['items'],key=lambda e:e['buildIndices'][0]):
        row,report=convert(entry);output.append(row);reports.append(report)
        print(row['info']['id'],report['obstacles'],report['floors'],sum(report['mechanisms'].values()),flush=True)
    encoded=json.dumps(round_floats(output),ensure_ascii=False,separators=(',',':'),allow_nan=False)
    if args.check:
        assert OUTPUT.read_bytes()==encoded.encode('utf8'),'Recomputed map data differs from src/core/original-map-data.json'
        print('verified byte-for-byte reproduction of',len(output),'maps',OUTPUT.stat().st_size,'bytes',flush=True)
        return
    OUTPUT.write_text(encoded,encoding='utf8')
    (INPUT/'conversion-report.json').write_text(json.dumps(round_floats(reports),ensure_ascii=False,indent=2),encoding='utf8')
    print('wrote',len(output),'maps',OUTPUT.stat().st_size,'bytes',flush=True)

if __name__=='__main__':main()
