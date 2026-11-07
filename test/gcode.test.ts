import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDuration, parseGcodeStats, parseModelInfo } from "../src/slicer/gcode.js";
import { applyOverrides } from "../src/slicer/library.js";

describe("gcode stats", () => {
  it("parses OrcaSlicer filament, time, and layer comments", () => {
    const gcode = `; model printing time: 13m 56s; total estimated time: 20m 12s
; total layer number: 100
; filament used [mm] = 1211.31
; filament used [cm3] = 2.91
; filament used [g] = 3.67
`;
    const stats = parseGcodeStats(gcode);
    assert.equal(stats.filamentGrams, 3.67);
    assert.equal(stats.filamentVolumeCm3, 2.91);
    assert.equal(stats.printTimeSeconds, 1212);
    assert.equal(stats.layerCount, 100);
    assert.equal(stats.modelPrintTimeText, "13m 56s");
  });

  it("sums multi-tool filament lines and duration with hours", () => {
    const stats = parseGcodeStats("; total estimated time: 1h 2m 3s\n; filament used [g] = 1.5, 0.25\n");
    assert.equal(stats.filamentGrams, 1.75);
    assert.equal(parseDuration("1h 2m 3s"), 3723);
    assert.equal(stats.printTimeSeconds, 3723);
  });

  it("parses --info geometry", () => {
    const info = parseModelInfo(`size_x = 20
size_y = 20
size_z = 20
min_x = 0
min_y = 0
min_z = 0
max_x = 20
max_y = 20
max_z = 20
volume = 8000
manifold = yes
number_of_facets = 12
`);
    assert.deepEqual(info.sizeMm, { x: 20, y: 20, z: 20 });
    assert.equal(info.volumeMm3, 8000);
    assert.equal(info.manifold, true);
  });
});

describe("profile overrides", () => {
  it("forces the Textured PEI bed and applies infill and supports", () => {
    const machine: Record<string, unknown> = {};
    const process: Record<string, unknown> = { sparse_infill_density: "15%", enable_support: "0" };
    applyOverrides(machine, process, { infillPercent: 30, supports: true });
    assert.equal(machine.curr_bed_type, "Textured PEI Plate");
    assert.equal(machine.default_bed_type, "Textured PEI Plate");
    assert.equal(process.sparse_infill_density, "30%");
    assert.equal(process.enable_support, "1");
  });
});
