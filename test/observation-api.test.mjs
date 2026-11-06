import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { makeProject, ROOT } from './helpers.mjs';

it('reads camera component offsets, explicit bone poses and paused root timeline without substituting missing data', (t) => {
  const proj = makeProject('ApiGame');
  t.after(() => fs.rmSync(proj.root, { recursive: true, force: true }));
  const script = `import sys
from types import SimpleNamespace
import unreal
unreal._fake_init(sys.argv[1], 'ApiGame')
from fake_editor import seed
seed()
from ue_agent_bridge.ops_observe import observe
from ue_agent_bridge.registry import CallContext, Args
world = unreal._S['world']
class CameraComponent(unreal.SceneComponent):
    _props = {'field_of_view': ('float', 60.0), 'aspect_ratio': ('float', 2.0), 'projection_mode': ('str', 'CameraProjectionMode.PERSPECTIVE')}
    def get_world_location(self): return unreal.Vector(100, 200, 300)
    def get_world_rotation(self): return unreal.Rotator()
unreal.CameraComponent = CameraComponent
camera = unreal.CameraActor('ShotCamera', world)
camera._comps.append(CameraComponent('Lens', camera))
world.actors.append(camera)
class SkinnedMeshComponent(unreal.SceneComponent):
    def get_skinned_asset(self): return unreal.EditorAssetLibrary.load_asset('/Engine/BasicShapes/Cube')
    def get_bone_index(self, name): return 0 if name == 'root' else -1
    def get_socket_location(self, name):
        assert name == 'root', 'missing bones must not fall back to component transform'
        return unreal.Vector(10, 20, 30)
    def get_socket_rotation(self, name): return unreal.Rotator()
unreal.SkinnedMeshComponent = SkinnedMeshComponent
skinned = unreal.Actor('Character', world)
skinned._comps.append(SkinnedMeshComponent('Body', skinned))
world.actors.append(skinned)
class Sequence:
    def get_path_name(self): return '/Game/Shot.Shot'
unreal.LevelSequenceEditorBlueprintLibrary = SimpleNamespace(get_current_level_sequence=lambda: Sequence(), get_current_time=lambda: 125, is_playing=lambda: False)
unreal.MovieSceneSequenceExtensions = SimpleNamespace(get_display_rate=lambda seq: SimpleNamespace(numerator=30000, denominator=1001))
srv = SimpleNamespace(paths={'project_file': sys.argv[2]}, rev=4, started_at=123.0)
def capture(args): return observe(CallContext(srv, None, 'observe'), Args(args))
snapshot = capture({'targets': ['Character'], 'camera': 'ShotCamera', 'bones': ['root', 'missing']})
assert snapshot['camera']['location'] == [100, 200, 300], snapshot['camera']
assert snapshot['camera']['hfov'] == 60
assert snapshot['timeline']['frame'] == 125
assert snapshot['timeline']['rate']['denominator'] == 1001
component = snapshot['actors'][0]['components'][1]
assert component['mesh_assigned'] is True
assert component['bones_world'][0]['location'] == [10, 20, 30]
assert component['bones_world'][1]['exists'] is False
assert component['bones_world'][1]['location'] is None
# Optional API failures remain unknown; no fabricated fallback bounds or poses.
skinned.get_actor_bounds = lambda *args: (_ for _ in ()).throw(RuntimeError('unavailable'))
assert capture({'targets': ['Character']})['actors'][0]['bounds'] is None
# Partial component coverage is explicit.
for i in range(20): skinned._comps.append(unreal.SceneComponent('Extra%d' % i, skinned))
partial = capture({'targets': ['Character'], 'components': True})['actors'][0]
assert partial['component_count'] == 22
assert len(partial['components']) == 12
# find_object can resolve an actor from another loaded world. It must not be
# attributed to the current project's editor/PIE world in the observation.
outside = unreal.Actor('OtherWorldActor', world)
original_find = unreal.find_object
unreal.find_object = lambda outer, name: outside if name == outside.get_path_name() else original_find(outer, name)
foreign = capture({'targets': [outside.get_path_name()]})
assert foreign['actors'] == []
assert foreign['missing_targets'] == [outside.get_path_name()]
`;
  const result = spawnSync('python3', ['-c', script, proj.dir, proj.project], {
    env: { ...process.env, HOME: proj.home, PYTHONPATH: [path.join(ROOT, 'test/fake'), path.join(ROOT, 'plugin/UEAgentBridge/Content/Python')].join(path.delimiter) },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});
