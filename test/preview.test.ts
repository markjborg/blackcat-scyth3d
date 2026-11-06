import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseToolpath } from "../web/src/gcode.js";
import { dominantFaceNormal } from "../web/src/orient.js";

describe("toolpath and lay-flat", () => {
  it("keeps extrusion moves and drops travels", () => {
    const path = parseToolpath(`
G90
M83
G0 X0 Y0 Z0.2
G1 X10 Y0 E0.2
G1 X10 Y10 E0.2
G1 E-0.4
G0 X0 Y0
`);
    assert.equal(path.layers.length, 1);
    assert.equal(path.layers[0]?.length, 2);
    assert.equal(path.layers[0]?.[0]?.bx, 10);
    assert.equal(path.layers[0]?.[1]?.by, 10);
  });

  it("prefers the downward face when areas tie", () => {
    const up = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const down = [0, 0, 0, 0, 1, 0, 1, 0, 0];
    const normal = dominantFaceNormal([...down, ...up]);
    assert.ok(normal);
    assert.ok((normal?.z ?? 0) < 0);
  });
});
