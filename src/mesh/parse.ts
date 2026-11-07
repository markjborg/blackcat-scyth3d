import { unzipSync, strFromU8 } from "fflate";
import { ApiError } from "../errors.js";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
}

export interface MeshSummary {
  format: "stl" | "obj" | "3mf";
  triangleCount: number;
  dimensionsMm: Vec3;
  boundingBoxMm: BoundingBox;
  /** Mesh volume in millilitres. Assumes a closed solid and millimetre coordinates. */
  volumeMl: number;
  volumeMm3: number;
}

const MAX_TRIANGLES = 2_000_000;
const MAX_3MF_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export function parseModel(filename: string, bytes: Buffer): MeshSummary {
  const format = formatOf(filename);
  if (bytes.length === 0) {
    throw new ApiError(400, "empty_file", "The uploaded file is empty.");
  }
  const triangles = format === "stl" ? parseStl(bytes) : format === "obj" ? parseObj(bytes.toString("utf8")) : parse3mf(bytes);
  if (triangles.length === 0) {
    throw new ApiError(400, "no_triangles", "The model does not contain any triangles.");
  }
  if (triangles.length > MAX_TRIANGLES) {
    throw new ApiError(400, "mesh_too_large", `Models are limited to ${MAX_TRIANGLES} triangles.`);
  }
  return summarize(format, triangles);
}

export function formatOf(filename: string): "stl" | "obj" | "3mf" {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".stl")) return "stl";
  if (lower.endsWith(".obj")) return "obj";
  if (lower.endsWith(".3mf")) return "3mf";
  throw new ApiError(400, "unsupported_format", "Upload an STL, 3MF, or OBJ file.");
}

function summarize(format: MeshSummary["format"], triangles: Triangle[]): MeshSummary {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let volume6 = 0;
  for (const [a, b, c] of triangles) {
    for (const v of [a, b, c]) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
    }
    volume6 += a.x * (b.y * c.z - b.z * c.y) + a.y * (b.z * c.x - b.x * c.z) + a.z * (b.x * c.y - b.y * c.x);
  }
  const volumeMm3 = Math.abs(volume6) / 6;
  return {
    format,
    triangleCount: triangles.length,
    dimensionsMm: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    boundingBoxMm: {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    },
    volumeMm3,
    volumeMl: volumeMm3 / 1000,
  };
}

type Triangle = [Vec3, Vec3, Vec3];

function parseStl(bytes: Buffer): Triangle[] {
  if (looksLikeBinaryStl(bytes)) return parseBinaryStl(bytes);
  return parseAsciiStl(bytes.toString("utf8"));
}

function looksLikeBinaryStl(bytes: Buffer): boolean {
  if (bytes.length < 84) return false;
  const count = bytes.readUInt32LE(80);
  const expected = 84 + count * 50;
  if (count > 0 && expected === bytes.length) return true;
  // Some exporters append a comment after the binary body.
  if (count > 0 && bytes.length > expected && bytes.length < expected + 256) return true;
  const head = bytes.subarray(0, 5).toString("utf8").toLowerCase();
  return head !== "solid" && count > 0 && expected <= bytes.length;
}

function parseBinaryStl(bytes: Buffer): Triangle[] {
  const count = bytes.readUInt32LE(80);
  if (count > MAX_TRIANGLES) {
    throw new ApiError(400, "mesh_too_large", `Models are limited to ${MAX_TRIANGLES} triangles.`);
  }
  const triangles: Triangle[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = 84 + i * 50;
    if (offset + 48 > bytes.length) break;
    triangles.push([
      { x: bytes.readFloatLE(offset + 12), y: bytes.readFloatLE(offset + 16), z: bytes.readFloatLE(offset + 20) },
      { x: bytes.readFloatLE(offset + 24), y: bytes.readFloatLE(offset + 28), z: bytes.readFloatLE(offset + 32) },
      { x: bytes.readFloatLE(offset + 36), y: bytes.readFloatLE(offset + 40), z: bytes.readFloatLE(offset + 44) },
    ]);
  }
  return triangles;
}

function parseAsciiStl(text: string): Triangle[] {
  const triangles: Triangle[] = [];
  const vertex = /vertex\s+([+-eE0-9.]+)\s+([+-eE0-9.]+)\s+([+-eE0-9.]+)/g;
  let current: Vec3[] = [];
  for (const match of text.matchAll(vertex)) {
    current.push({ x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) });
    if (current.length === 3) {
      triangles.push([current[0], current[1], current[2]]);
      current = [];
      if (triangles.length > MAX_TRIANGLES) {
        throw new ApiError(400, "mesh_too_large", `Models are limited to ${MAX_TRIANGLES} triangles.`);
      }
    }
  }
  return triangles;
}

function parseObj(text: string): Triangle[] {
  const vertices: Vec3[] = [];
  const triangles: Triangle[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const parts = line.split(/\s+/);
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if (![x, y, z].every(Number.isFinite)) continue;
      vertices.push({ x, y, z });
    } else if (line.startsWith("f ")) {
      const indices = line
        .split(/\s+/)
        .slice(1)
        .map((token) => Number(token.split("/")[0]))
        .filter((value) => Number.isFinite(value) && value !== 0)
        .map((value) => (value > 0 ? value - 1 : vertices.length + value));
      if (indices.length < 3) continue;
      const face = indices.map((index) => vertices[index]).filter((vertex): vertex is Vec3 => vertex !== undefined);
      for (let i = 1; i < face.length - 1; i += 1) {
        triangles.push([face[0], face[i], face[i + 1]]);
      }
      if (triangles.length > MAX_TRIANGLES) {
        throw new ApiError(400, "mesh_too_large", `Models are limited to ${MAX_TRIANGLES} triangles.`);
      }
    }
  }
  return triangles;
}

interface RawObject {
  id: string;
  vertices: Vec3[];
  triangles: Array<[number, number, number]>;
  components: Array<{ objectId: string; transform: number[] }>;
}

function parse3mf(bytes: Buffer): Triangle[] {
  let entries: Record<string, Uint8Array>;
  try {
    let claimedBytes = 0;
    entries = unzipSync(new Uint8Array(bytes), {
      filter(file) {
        claimedBytes += file.originalSize;
        if (file.originalSize > MAX_3MF_UNCOMPRESSED_BYTES || claimedBytes > MAX_3MF_UNCOMPRESSED_BYTES) {
          throw new ApiError(400, "mesh_too_large", "The 3MF archive is larger than the uncompressed limit.");
        }
        return file.name.toLowerCase().endsWith("3d/3dmodel.model");
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_3mf", "The 3MF file is not a valid zip archive.");
  }
  const modelName = Object.keys(entries).find((name) => name.toLowerCase().endsWith("3d/3dmodel.model"));
  if (!modelName) {
    throw new ApiError(400, "invalid_3mf", "The 3MF archive has no 3D/3dmodel.model mesh.");
  }
  const modelBytes = entries[modelName];
  if (modelBytes.byteLength > MAX_3MF_UNCOMPRESSED_BYTES) {
    throw new ApiError(400, "mesh_too_large", "The 3MF mesh is larger than the uncompressed limit.");
  }
  const xml = strFromU8(modelBytes);
  const unit = /<model\b[^>]*\bunit\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1]?.toLowerCase() ?? "millimeter";
  const scale = unitScale(unit);
  const objects = parse3mfObjects(xml);
  const byId = new Map(objects.map((object) => [object.id, object]));
  const buildIds = [...xml.matchAll(/<item\b[^>]*\bobjectid\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((match) => ({
    id: match[1],
    transform: transformOf(match[0]),
  }));
  const roots = buildIds.length > 0 ? buildIds : objects.filter((object) => object.triangles.length > 0).map((object) => ({ id: object.id, transform: identity() }));
  const triangles: Triangle[] = [];
  for (const root of roots) {
    collectObject(root.id, root.transform, byId, triangles, new Set());
  }
  if (scale !== 1) {
    for (const triangle of triangles) {
      for (const vertex of triangle) {
        vertex.x *= scale;
        vertex.y *= scale;
        vertex.z *= scale;
      }
    }
  }
  return triangles;
}

function parse3mfObjects(xml: string): RawObject[] {
  const objects: RawObject[] = [];
  const matcher = /<object\b([^>]*)>([\s\S]*?)<\/object>/gi;
  for (const match of xml.matchAll(matcher)) {
    const attrs = match[1];
    const body = match[2];
    const id = /(?:^|\s)id\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!id) continue;
    const vertices = [...body.matchAll(/<vertex\b[^>]*\bx\s*=\s*["']([^"']+)["'][^>]*\by\s*=\s*["']([^"']+)["'][^>]*\bz\s*=\s*["']([^"']+)["'][^>]*\/?>/gi)].map(
      (vertex) => ({ x: Number(vertex[1]), y: Number(vertex[2]), z: Number(vertex[3]) }),
    );
    const triangles = [...body.matchAll(/<triangle\b[^>]*\bv1\s*=\s*["'](\d+)["'][^>]*\bv2\s*=\s*["'](\d+)["'][^>]*\bv3\s*=\s*["'](\d+)["'][^>]*\/?>/gi)].map(
      (triangle) => [Number(triangle[1]), Number(triangle[2]), Number(triangle[3])] as [number, number, number],
    );
    const components = [...body.matchAll(/<component\b[^>]*\/?>/gi)].map((component) => ({
      objectId: /objectid\s*=\s*["']([^"']+)["']/i.exec(component[0])?.[1] ?? "",
      transform: transformOf(component[0]),
    })).filter((component) => component.objectId);
    objects.push({ id, vertices, triangles, components });
  }
  return objects;
}

function collectObject(
  id: string,
  transform: number[],
  objects: Map<string, RawObject>,
  into: Triangle[],
  seen: Set<string>,
): void {
  if (seen.has(id)) return;
  const object = objects.get(id);
  if (!object) return;
  const nextSeen = new Set(seen);
  nextSeen.add(id);
  for (const [i1, i2, i3] of object.triangles) {
    const a = object.vertices[i1];
    const b = object.vertices[i2];
    const c = object.vertices[i3];
    if (!a || !b || !c) continue;
    into.push([applyTransform(a, transform), applyTransform(b, transform), applyTransform(c, transform)]);
    if (into.length > MAX_TRIANGLES) {
      throw new ApiError(400, "mesh_too_large", `Models are limited to ${MAX_TRIANGLES} triangles.`);
    }
  }
  for (const component of object.components) {
    collectObject(component.objectId, multiply(transform, component.transform), objects, into, nextSeen);
  }
}

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
}

function transformOf(tag: string): number[] {
  const raw = /transform\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
  if (!raw) return identity();
  const values = raw.trim().split(/\s+/).map(Number);
  if (values.length !== 12 || values.some((value) => !Number.isFinite(value))) return identity();
  return values;
}

function applyTransform(v: Vec3, m: number[]): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z + m[3],
    y: m[4] * v.x + m[5] * v.y + m[6] * v.z + m[7],
    z: m[8] * v.x + m[9] * v.y + m[10] * v.z + m[11],
  };
}

function multiply(a: number[], b: number[]): number[] {
  const a4 = to4(a);
  const b4 = to4(b);
  const out = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      out[row * 4 + col] =
        a4[row * 4] * b4[col] + a4[row * 4 + 1] * b4[4 + col] + a4[row * 4 + 2] * b4[8 + col] + a4[row * 4 + 3] * b4[12 + col];
    }
  }
  return [out[0], out[1], out[2], out[3], out[4], out[5], out[6], out[7], out[8], out[9], out[10], out[11]];
}

function to4(m: number[]): number[] {
  return [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1];
}

function unitScale(unit: string): number {
  switch (unit) {
    case "micron":
      return 0.001;
    case "millimeter":
      return 1;
    case "centimeter":
      return 10;
    case "inch":
      return 25.4;
    case "foot":
      return 304.8;
    case "meter":
      return 1000;
    default:
      return 1;
  }
}
