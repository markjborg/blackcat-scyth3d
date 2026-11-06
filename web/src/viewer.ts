import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { ToolSegment } from "./gcode.js";
import { dominantFaceNormal } from "./orient.js";

export interface BedSize {
  x: number;
  y: number;
  z: number;
}

export class PrintViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly bedGroup = new THREE.Group();
  private readonly model = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ color: "#d9d2c5", roughness: 0.62, metalness: 0.04 }),
  );
  private readonly toolpath = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ vertexColors: true }),
  );
  private bed: BedSize = { x: 256, y: 256, z: 256 };
  private frame = 0;
  private loaded = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.scene.add(new THREE.HemisphereLight("#f4efe4", "#1a1c22", 1.4));
    const key = new THREE.DirectionalLight("#fff6e8", 1.6);
    key.position.set(80, -120, 220);
    this.scene.add(key);
    this.model.visible = false;
    this.toolpath.visible = false;
    this.scene.add(this.bedGroup, this.model, this.toolpath);
    this.setBed(this.bed);
    this.resize();
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement ?? canvas);
  }

  setBed(bed: BedSize): void {
    this.bed = bed;
    this.bedGroup.clear();
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(bed.x, bed.y, 3),
      new THREE.MeshStandardMaterial({ color: "#1a1d24", roughness: 0.9, metalness: 0.05 }),
    );
    plate.position.set(bed.x / 2, bed.y / 2, -1.5);
    this.bedGroup.add(plate);
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(bed.x, bed.y, bed.z)),
      new THREE.LineBasicMaterial({ color: "#e0a44a", transparent: true, opacity: 0.55 }),
    );
    edge.position.set(bed.x / 2, bed.y / 2, bed.z / 2);
    this.bedGroup.add(edge);
    const grid = gridLines(bed.x, bed.y, 20);
    grid.position.z = 0.05;
    this.bedGroup.add(grid);
    this.lookAtBed();
    if (this.loaded) this.seat();
  }

  async load(file: File): Promise<number> {
    const buffer = await file.arrayBuffer();
    const name = file.name.toLowerCase();
    let geometry: THREE.BufferGeometry;
    if (name.endsWith(".stl")) geometry = positionsOnly(new STLLoader().parse(buffer));
    else if (name.endsWith(".obj")) geometry = fromObject(new OBJLoader().parse(new TextDecoder().decode(buffer)));
    else if (name.endsWith(".3mf")) geometry = fromObject(new ThreeMFLoader().parse(buffer));
    else throw new Error("Use an STL, 3MF, or OBJ file.");
    geometry.computeVertexNormals();
    this.model.geometry.dispose();
    this.model.geometry = geometry;
    this.model.position.set(0, 0, 0);
    this.model.quaternion.identity();
    this.model.scale.set(1, 1, 1);
    this.model.visible = true;
    this.loaded = true;
    this.clearToolpath();
    this.seat();
    return geometry.getAttribute("position").count / 3;
  }

  rotate(axis: "x" | "y" | "z"): void {
    if (!this.loaded) return;
    const vector = axis === "x" ? new THREE.Vector3(1, 0, 0) : axis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    this.model.rotateOnWorldAxis(vector, Math.PI / 2);
    this.clearToolpath();
    this.seat();
  }

  layFlat(): void {
    if (!this.loaded) return;
    this.bake();
    const position = this.model.geometry.getAttribute("position");
    const normal = dominantFaceNormal(position.array as ArrayLike<number>);
    if (!normal) return;
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(normal.x, normal.y, normal.z),
      new THREE.Vector3(0, 0, -1),
    );
    this.model.geometry.applyQuaternion(quaternion);
    this.model.geometry.computeVertexNormals();
    this.clearToolpath();
    this.seat();
  }

  setScale(percent: number): void {
    if (!this.loaded) return;
    const scale = percent / 100;
    this.model.scale.setScalar(scale);
    this.clearToolpath();
    this.seat();
  }

  sizeMm(): { x: number; y: number; z: number } | null {
    if (!this.loaded) return null;
    const box = new THREE.Box3().setFromObject(this.model);
    return { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z };
  }

  outsideBed(): boolean {
    if (!this.loaded) return false;
    const box = new THREE.Box3().setFromObject(this.model);
    return box.min.x < -0.5 || box.min.y < -0.5 || box.min.z < -0.5 || box.max.x > this.bed.x + 0.5 || box.max.y > this.bed.y + 0.5 || box.max.z > this.bed.z + 0.5;
  }

  toStlBlob(): Blob {
    this.model.updateWorldMatrix(true, true);
    const geometry = this.model.geometry.clone();
    geometry.applyMatrix4(this.model.matrixWorld);
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    const position = source.getAttribute("position");
    const triangles = position.count / 3;
    const buffer = new ArrayBuffer(84 + triangles * 50);
    const view = new DataView(buffer);
    view.setUint32(80, triangles, true);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (let i = 0; i < triangles; i += 1) {
      a.fromBufferAttribute(position, i * 3);
      b.fromBufferAttribute(position, i * 3 + 1);
      c.fromBufferAttribute(position, i * 3 + 2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      normal.crossVectors(ab, ac).normalize();
      const offset = 84 + i * 50;
      writeVec(view, offset, normal);
      writeVec(view, offset + 12, a);
      writeVec(view, offset + 24, b);
      writeVec(view, offset + 36, c);
      view.setUint16(offset + 48, 0, true);
    }
    geometry.dispose();
    return new Blob([buffer], { type: "model/stl" });
  }

  showToolpath(layers: ToolSegment[][], through: number): void {
    const positions: number[] = [];
    const colors: number[] = [];
    const last = Math.min(through, layers.length - 1);
    for (let layer = 0; layer <= last; layer += 1) {
      const bright = layer === last;
      const color = bright ? [0.94, 0.69, 0.32] : [0.32, 0.28, 0.22];
      for (const segment of layers[layer] ?? []) {
        positions.push(segment.ax, segment.ay, segment.az, segment.bx, segment.by, segment.bz);
        colors.push(color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, color[0] ?? 0, color[1] ?? 0, color[2] ?? 0);
      }
    }
    this.toolpath.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    this.toolpath.geometry = geometry;
    this.toolpath.visible = positions.length > 0;
    const material = this.model.material as THREE.MeshStandardMaterial;
    material.transparent = true;
    material.opacity = this.toolpath.visible ? 0.18 : 1;
  }

  clearToolpath(): void {
    this.toolpath.visible = false;
    const material = this.model.material as THREE.MeshStandardMaterial;
    material.opacity = 1;
    material.transparent = false;
  }

  private bake(): void {
    this.model.updateWorldMatrix(true, true);
    this.model.geometry.applyMatrix4(this.model.matrixWorld);
    this.model.position.set(0, 0, 0);
    this.model.quaternion.identity();
    this.model.scale.set(1, 1, 1);
    this.model.geometry.computeVertexNormals();
  }

  private seat(): void {
    this.model.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;
    this.model.position.x += this.bed.x / 2 - (box.min.x + box.max.x) / 2;
    this.model.position.y += this.bed.y / 2 - (box.min.y + box.max.y) / 2;
    this.model.position.z += -box.min.z;
  }

  private lookAtBed(): void {
    const target = new THREE.Vector3(this.bed.x / 2, this.bed.y / 2, 0);
    const span = Math.max(this.bed.x, this.bed.y, this.bed.z);
    this.camera.position.set(target.x + span * 0.15, target.y - span * 0.95, span * 0.85);
    this.controls.target.copy(target);
    this.controls.update();
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    const width = parent?.clientWidth ?? 640;
    const height = parent?.clientHeight ?? 480;
    if (width < 2 || height < 2) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}

function positionsOnly(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const next = new THREE.BufferGeometry();
  next.setAttribute("position", source.getAttribute("position").clone());
  if (source !== geometry) source.dispose();
  return next;
}

function fromObject(root: THREE.Object3D): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.updateWorldMatrix(true, false);
    const geometry = positionsOnly(mesh.geometry as THREE.BufferGeometry);
    geometry.applyMatrix4(mesh.matrixWorld);
    parts.push(geometry);
  });
  if (parts.length === 0) throw new Error("That file has no mesh.");
  if (parts.length === 1) return parts[0] ?? new THREE.BufferGeometry();
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error("Could not combine the meshes in that file.");
  return merged;
}

function gridLines(width: number, height: number, step: number): THREE.LineSegments {
  const positions: number[] = [];
  for (let x = 0; x <= width; x += step) positions.push(x, 0, 0, x, height, 0);
  for (let y = 0; y <= height; y += step) positions.push(0, y, 0, width, y, 0);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: "#2c313c" }));
}

function writeVec(view: DataView, offset: number, vector: THREE.Vector3): void {
  view.setFloat32(offset, vector.x, true);
  view.setFloat32(offset + 4, vector.y, true);
  view.setFloat32(offset + 8, vector.z, true);
}
