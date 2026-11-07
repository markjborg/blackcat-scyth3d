import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { parseModel } from "../src/mesh/parse.js";

const cube = readFileSync(new URL("../samples/cube20.stl", import.meta.url));

describe("mesh", () => {
  it("reads the 20 mm sample cube", () => {
    const mesh = parseModel("cube20.stl", cube);
    assert.equal(mesh.triangleCount, 12);
    assert.equal(mesh.volumeMl, 8);
    assert.deepEqual(mesh.dimensionsMm, { x: 20, y: 20, z: 20 });
    assert.deepEqual(mesh.boundingBoxMm.min, { x: 0, y: 0, z: 0 });
    assert.deepEqual(mesh.boundingBoxMm.max, { x: 20, y: 20, z: 20 });
  });

  it("reads an ASCII STL and an OBJ of the same cube", () => {
    const ascii = `solid cube
facet normal 0 0 1
  outer loop
    vertex 0 0 20
    vertex 20 0 20
    vertex 20 20 20
  endloop
endfacet
facet normal 0 0 1
  outer loop
    vertex 0 0 20
    vertex 20 20 20
    vertex 0 20 20
  endloop
endfacet
endsolid cube
`;
    const partial = parseModel("partial.stl", Buffer.from(ascii));
    assert.equal(partial.triangleCount, 2);
    assert.ok(partial.volumeMl > 0);

    const obj = `v 0 0 0
v 20 0 0
v 20 20 0
v 0 20 0
v 0 0 20
v 20 0 20
v 20 20 20
v 0 20 20
f 1 3 2
f 1 4 3
f 5 6 7
f 5 7 8
f 1 2 6
f 1 6 5
f 4 8 7
f 4 7 3
f 1 5 8
f 1 8 4
f 2 3 7
f 2 7 6
`;
    const mesh = parseModel("cube.obj", Buffer.from(obj));
    assert.equal(mesh.volumeMl, 8);
    assert.equal(mesh.triangleCount, 12);
  });

  it("honours a 3MF build-item transform", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="20" y="0" z="0"/>
          <vertex x="20" y="20" z="0"/>
          <vertex x="0" y="20" z="0"/>
          <vertex x="0" y="0" z="20"/>
          <vertex x="20" y="0" z="20"/>
          <vertex x="20" y="20" z="20"/>
          <vertex x="0" y="20" z="20"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="2" v3="1"/>
          <triangle v1="0" v2="3" v3="2"/>
          <triangle v1="4" v2="5" v3="6"/>
          <triangle v1="4" v2="6" v3="7"/>
          <triangle v1="0" v2="1" v3="5"/>
          <triangle v1="0" v2="5" v3="4"/>
          <triangle v1="3" v2="7" v3="6"/>
          <triangle v1="3" v2="6" v3="2"/>
          <triangle v1="0" v2="4" v3="7"/>
          <triangle v1="0" v2="7" v3="3"/>
          <triangle v1="1" v2="2" v3="6"/>
          <triangle v1="1" v2="6" v3="5"/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" transform="1 0 0 10 0 1 0 0 0 0 1 0"/>
  </build>
</model>`;
    const archive = zipSync({ "3D/3dmodel.model": strToU8(xml) });
    const mesh = parseModel("cube.3mf", Buffer.from(archive));
    assert.equal(mesh.volumeMl, 8);
    assert.equal(mesh.boundingBoxMm.min.x, 10);
    assert.equal(mesh.boundingBoxMm.max.x, 30);
    assert.equal(mesh.dimensionsMm.x, 20);
  });
});
