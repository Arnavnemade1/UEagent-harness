// Model inspection: clips, durations, natural ground speed of locomotion clips (from planted-foot
// motion), height and facing. Lets films drive playback rate from actor speed without foot sliding.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function inspectModel(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });
  const pick = (re) => bones.filter((b) => re.test(b.name));
  const feet = pick(/foot|ankle/i).filter((b) => !/twist|ik|ctrl/i.test(b.name));
  const toes = pick(/toe|ball/i);
  const mixer = new THREE.AnimationMixer(root);
  const v = new THREE.Vector3();
  const facing = (() => {
    if (!feet.length || !toes.length) return null;
    const f = feet[0].getWorldPosition(new THREE.Vector3()), t = toes[0].getWorldPosition(new THREE.Vector3());
    const d = t.sub(f); d.y = 0; d.normalize();
    return Math.abs(d.z) > Math.abs(d.x) ? (d.z > 0 ? '+Z' : '-Z') : (d.x > 0 ? '+X' : '-X');
  })();
  const clips = [];
  for (const clip of gltf.animations) {
    const action = mixer.clipAction(clip);
    mixer.stopAllAction();
    action.reset().play();
    let speed = null;
    if (feet.length >= 2 && clip.duration > 0.1) {
      const steps = Math.max(30, Math.round(clip.duration * 120));
      const dt = clip.duration / steps;
      const samples = [];
      for (let i = 0; i <= steps; i++) {
        mixer.setTime(i * dt);
        root.updateMatrixWorld(true);
        samples.push(feet.slice(0, 2).map((b) => b.getWorldPosition(v).clone()));
      }
      // contact = each foot in the lowest 30% of its own height range; while planted the foot slides
      // backwards (against the facing axis) at the clip's ground speed -> mean backward speed in contact
      const ax = facing && facing.endsWith('X') ? 'x' : 'z', sign = facing && facing.startsWith('-') ? -1 : 1;
      let dist = 0, time = 0;
      for (let k = 0; k < 2; k++) {
        const ys = samples.map((s) => s[k].y);
        const lo = Math.min(...ys), hi = Math.max(...ys);
        const thr = lo + 0.3 * (hi - lo);
        for (let i = 1; i < samples.length; i++) {
          const a = samples[i - 1][k], b = samples[i][k];
          if (a.y < thr && b.y < thr) { dist += -sign * (b[ax] - a[ax]); time += dt; }
        }
      }
      speed = time > clip.duration * 0.1 && dist > 0 ? dist / time : 0;
    }
    clips.push({ name: clip.name, duration: Math.round(clip.duration * 1000) / 1000, groundSpeed: speed == null ? null : Math.round(speed * 100) / 100 });
  }
  return {
    height: Math.round((box.max.y - box.min.y) * 1000) / 1000, size: box.getSize(new THREE.Vector3()).toArray().map((x) => Math.round(x * 1000) / 1000),
    facing, bones: bones.length, feet: feet.map((b) => b.name), materials: [...new Set(gltf.parser.json.materials?.map((m) => m.name) || [])], clips,
  };
}
