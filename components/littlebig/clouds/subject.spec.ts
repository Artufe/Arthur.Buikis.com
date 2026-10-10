import { BoxGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CONFIRM_AFTER, IDLE_EVERY, SubjectObjects } from './subject';

const OPTS = { reach: 1.8, maxInstances: 3000 };

function world() {
  const scene = new Scene();
  const mat = new MeshBasicMaterial();
  const at = new Vector3(10, 50, 3);
  const bird = new Mesh(new BoxGeometry(1, 0.4, 0.8), mat);
  bird.name = 'bird';
  bird.position.copy(at);
  scene.add(bird);
  // Something else nearby but not at the pose, and a crowd of instances elsewhere.
  const tower = new Mesh(new BoxGeometry(2, 8, 2), mat);
  tower.position.set(40, 4, 0);
  scene.add(tower);
  const cars = new InstancedMesh(new BoxGeometry(1, 1, 2), mat, 20);
  for (let i = 0; i < 20; i++) cars.setMatrixAt(i, new Matrix4().makeTranslation(i * 5, 0, -30));
  scene.add(cars);
  scene.updateMatrixWorld(true);
  return { scene, bird, cars, at };
}

describe('the followed thing re-drawn over the clouds', () => {
  it('a subject still popping in (hidden) is found the frame after it shows, when an episode may start', () => {
    const { scene, bird, at } = world();
    const s = new SubjectObjects();
    bird.visible = false;
    s.update(scene, 'bird', undefined, at, 0.6, false, OPTS);
    expect(s.objects).toHaveLength(0);
    bird.visible = true;
    // Urgent (an episode starts / the eye nears the layer): scanned again at once, by frames.
    s.update(scene, 'bird', undefined, at, 0.6, true, OPTS);
    expect(s.objects).toEqual([bird]);
  });

  it('a subject at a scale of ~0 (the cartoon pop) is not taken for drawn, and is found once it grows', () => {
    const { scene, bird, at } = world();
    const s = new SubjectObjects();
    bird.scale.setScalar(0);
    scene.updateMatrixWorld(true);
    s.update(scene, 'bird', undefined, at, 0.6, true, OPTS);
    expect(s.objects).toHaveLength(0);
    bird.scale.setScalar(0.3);
    scene.updateMatrixWorld(true);
    s.update(scene, 'bird', undefined, at, 0.6, true, OPTS);
    expect(s.objects).toEqual([bird]);
  });

  it('when nothing is urgent, a miss is retried within a few frames (frames, not wall time)', () => {
    const { scene, bird, at } = world();
    const s = new SubjectObjects();
    bird.visible = false;
    s.update(scene, 'bird', undefined, at, 0.6, false, OPTS);
    bird.visible = true;
    let frames = 0;
    while (s.objects.length === 0 && frames < 100) {
      s.update(scene, 'bird', undefined, at, 0.6, false, OPTS);
      frames++;
    }
    expect(frames).toBeLessThanOrEqual(IDLE_EVERY);
    expect(s.objects).toEqual([bird]);
  });

  it('finds an instance of an instanced mesh at the pose, and drops it when the subject changes', () => {
    const { scene, cars } = world();
    const s = new SubjectObjects();
    const car7 = new Vector3(35, 0, -30);
    s.update(scene, 'car:7', undefined, car7, 1.2, true, OPTS);
    expect(s.objects).toEqual([cars]);
    s.update(scene, '', undefined, car7, 0, true, OPTS);
    expect(s.objects).toHaveLength(0);
  });

  it('declared objects win, with no scan', () => {
    const { scene, tower, at } = { ...world(), tower: new Mesh(new BoxGeometry(), new MeshBasicMaterial()) };
    scene.add(tower);
    const s = new SubjectObjects();
    s.update(scene, 'station:0', [tower], at, 11, true, OPTS);
    expect(s.objects).toEqual([tower]);
    expect(s.scanned).toBe(false);
  });

  it('a found object hidden mid-episode (an LOD switch) is looked for again at once', () => {
    const { scene, bird, at } = world();
    const s = new SubjectObjects();
    s.update(scene, 'bird', undefined, at, 0.6, true, OPTS);
    expect(s.objects).toEqual([bird]);
    bird.visible = false;
    const twin = bird.clone();
    twin.visible = true;
    scene.add(twin);
    scene.updateMatrixWorld(true);
    s.update(scene, 'bird', undefined, at, 0.6, true, OPTS);
    expect(s.objects).toEqual([twin]);
  });

  it('a fleet that packs its near LOD a frame late: the fresh find is checked again within a few frames', () => {
    const { scene } = world();
    const mat = new MeshBasicMaterial();
    const at = new Vector3(3, 0, 60);
    // Frame 1: the car only in the far pack (dithered away up close: re-drawn alone, a speck).
    const far = new InstancedMesh(new BoxGeometry(1, 1, 2), mat, 4);
    far.setMatrixAt(0, new Matrix4().makeTranslation(at.x, at.y, at.z));
    far.count = 1;
    const near = new InstancedMesh(new BoxGeometry(1, 1, 2), mat, 4);
    near.count = 0;
    scene.add(far, near);
    scene.updateMatrixWorld(true);
    const s = new SubjectObjects();
    s.update(scene, 'car:3', undefined, at, 2.3, true, OPTS);
    expect(s.objects).toEqual([far]);
    // Its owner packs the near mesh on its next update.
    near.setMatrixAt(0, new Matrix4().makeTranslation(at.x, at.y, at.z));
    near.count = 1;
    for (let i = 0; i < CONFIRM_AFTER; i++) s.update(scene, 'car:3', undefined, at, 2.3, true, OPTS);
    expect(s.objects).toContain(near);
    expect(s.objects).toContain(far);
  });

  it('locates the subject among the instances of its mesh every frame (owners repack them), and only it', () => {
    const { scene, cars } = world();
    const s = new SubjectObjects();
    const at = new Vector3(35, 0, -30); // instance 7
    s.update(scene, 'car:7', undefined, at, 1.2, true, OPTS);
    s.locate(at, 1.2, OPTS.reach);
    expect(s.instance).toEqual([7]);
    // Repacked: the same car is now instance 2 (another car right behind it, 3 m away, is not it).
    cars.setMatrixAt(2, new Matrix4().makeTranslation(35.2, 0, -30));
    cars.setMatrixAt(7, new Matrix4().makeTranslation(35, 0, -33));
    s.locate(new Vector3(35.2, 0, -30), 1.2, OPTS.reach);
    expect(s.instance).toEqual([2]);
    // Gone from reach: none (drawn not at all, rather than every instance).
    s.locate(new Vector3(500, 0, 0), 1.2, OPTS.reach);
    expect(s.instance).toEqual([-1]);
  });
});
