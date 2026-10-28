"""Verify static-batch bounds against original vertices; emit only scalar evidence."""
from pathlib import Path
import importlib.util,json

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('map_export',Path(__file__).with_name('export-original-maps.py'))
e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
from UnityPy.helpers.MeshHelper import MeshHandler

env,asset=e.load('level45')
mesh=asset.objects[2].read();handler=MeshHandler(mesh);handler.process()
submesh=mesh.m_SubMeshes[5]
vertices=handler.m_Vertices[submesh.firstVertex:submesh.firstVertex+submesh.vertexCount]
low=[min(v[i] for v in vertices) for i in range(3)]
high=[max(v[i] for v in vertices) for i in range(3)]
boxlow=[getattr(submesh.localAABB.m_Center,k)-getattr(submesh.localAABB.m_Extent,k) for k in 'xyz']
boxhigh=[getattr(submesh.localAABB.m_Center,k)+getattr(submesh.localAABB.m_Extent,k) for k in 'xyz']
error=max(abs(a-b) for a,b in zip(low+high,boxlow+boxhigh))
assert error<1e-5,(low,high,boxlow,boxhigh)
result={'scene':'level45','colliderPathID':2386,'meshFilterPathID':2168,'meshRendererPathID':1881,
        'meshPathID':2,'firstSubMesh':5,'subMeshCount':1,'firstVertex':submesh.firstVertex,'vertexCount':submesh.vertexCount,
        'vertexBounds':{'min':low,'max':high},'subMeshAABBBounds':{'min':boxlow,'max':boxhigh},
        'maxVertexVsSubMeshBoundsError':error,'webBottom':-high[2]*.4,'webTop':-low[2]*.4}
e.dump(e.OUT/'height-evidence.json',result)
print(json.dumps(result,indent=2))
