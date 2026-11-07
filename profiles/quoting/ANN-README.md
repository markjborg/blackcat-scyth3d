# Headless quoting toolchain (FDM + resin)

Everything lives in `/home/box/tools/slicer` on the box (persistent, shared).

| Path | What |
|---|---|
| `OrcaSlicer_V2.4.2.AppImage` | Original download (OrcaSlicer v2.4.2, Linux x86_64 Ubuntu 24.04 build) |
| `orca/` | `--appimage-extract` output; CLI entry point `orca/AppRun` (no FUSE/X needed) |
| `orca-datadir/` | OrcaSlicer config dir used by the wrapper (keeps `~/.config` clean) |
| `build-profiles.py` | Rebuilds `profiles/` from Orca's system presets (resolves `inherits`) |
| `profiles/<printer>/` | Flattened `machine.json`, `process.json`, `filament-{PLA,PETG,ASA,ABS,TPU}.json`; `profiles/manifest.json` shows sources |
| `quote-slice.sh` / `quote_slice.py` | FDM quote wrapper (slices with OrcaSlicer, prints JSON) |
| `resin-estimate.py` | Resin/MSLA estimator (geometry-based, prints JSON) |
| `run-tests.sh`, `run-resin-tests.sh` | Sanity tests; last results in `test-results.txt`, `resin-test-results.txt` |
| `samples/` | Test models: `cube20.stl/.3mf`, `benchy.stl` (3DBenchy from Thingiverse), `benchy_orca_project.3mf`, `torus.obj/.3mf` |

System packages installed (apt): `libopengl0 libglu1-mesa libgl1 libegl1 libgtk-3-0t64 libwebkit2gtk-4.1-0 gstreamer libs xvfb`.
Python (user site): `trimesh numpy-stl scipy networkx lxml`. xvfb is installed but not needed: the CLI slices headless.

## FDM: quote-slice.sh

```
/home/box/tools/slicer/quote-slice.sh MODEL.{stl,3mf,obj,step} \
    [--printer p1s|x1c|p2s|h2c|giga]   (default p1s)
    [--material PLA|PETG|ASA|ABS|TPU]  (default PLA)
    [--layer-height 0.2]               (default 0.2 Bambu, 0.3 Giga)
    [--infill 15] [--pattern grid|gyroid|...] [--walls 2]
    [--supports on|off]                (default on = tree(auto), only where needed)
    [--quantity N] [--scale F] [--orient] [--keep-gcode DIR] [--timeout 900]
```

Output (stdout, JSON): `filament_grams`, `filament_meters`, `print_time_seconds`, `print_time_human`
(totals x quantity), `per_unit{...}` (incl. `model_time_seconds` = without printer prep), `bbox_mm`,
`mesh_volume_cm3`, `watertight`, `fits{printer: bool}`, `fits_printers`, `fits_selected_printer`,
`fits_256_cube`, `layers`, `support_generated` (true if the G-code contains support features), settings used. On failure the JSON has an `error` key and a non-zero exit code
(2 bad input, 3 does not fit selected printer, 4 slicer error, 5 timeout).
Numbers are parsed from G-code comments (`; filament used [g|mm|cm3] =`, `; model printing time: ...;
total estimated time: ...` or `; estimated printing time (normal mode) =`). Multi-plate 3MFs are summed.

### Printers / profiles

| key | Base preset (OrcaSlicer 2.4.2 system profile) | Official profile? | Fit volume used (mm) |
|---|---|---|---|
| p1s (default) | Bambu Lab P1S 0.4 nozzle + 0.20mm Standard @BBL X1C | yes | 256x256x250 (spec 256^3; profile caps Z 250) |
| x1c | Bambu Lab X1 Carbon 0.4 nozzle + 0.20mm Standard @BBL X1C | yes | 256x256x250 |
| p2s | Bambu Lab P2S 0.4 nozzle + 0.20mm Standard @BBL P2S | yes | 256x256x256 |
| h2c | **proxy**: Bambu Lab H2D 0.4 nozzle + 0.20mm Standard @BBL H2D, bed reshaped to H2C | **no H2C preset in Orca 2.4.2** | left nozzle 325x320x320 or right 305x320x325 (bambulab.com/en/h2c/specs) |
| giga | Elegoo OrangeStorm Giga 0.6 nozzle + 0.30mm Standard @Elegoo Giga 0.6 | yes | 800x800x1000 (elegoo.com; 30-300 mm/s, 150 default) |

Overrides applied to every process: 2 walls, 15% grid infill, tree(auto) supports on, Textured PEI plate.
Filaments: Bambu "Generic <mat>" presets (Elegoo presets for Giga; ABS on Giga = Elegoo ASA preset re-typed)
with densities PLA 1.24, PETG 1.27, ASA 1.07, ABS 1.04, TPU 1.21 g/cm3.
To change defaults edit `build-profiles.py` and re-run it.

## Resin: resin-estimate.py

```
/home/box/tools/slicer/resin-estimate.py MODEL \
    [--printer saturn4ultra|saturn4ultra16k|jupiter]  (default saturn4ultra)
    [--layer-height 0.05] [--orient as-is|min-height|tilt|auto] [--tilt-deg 35]
    [--hollow] [--wall 2.0] [--supports-pct 20] [--raise-mm 5]
    [--layer-time S] [--bottom-layers N] [--bottom-exposure S]
    [--scale F] [--quantity N] [--resin-density 1.10]
```

Output: `mesh_volume_ml`, `resin_ml_part` (after hollowing), `resin_ml` (incl. supports allowance, x quantity),
`resin_grams`, `layer_count`, `print_time_seconds/human`, `bbox_mm` (after orientation), `fits{}`,
`fits_printers`, `watertight`, `hollow{removed_ml,...}`.

Presets (layer time = whole cycle per normal layer, not just exposure):
* Saturn 4 Ultra (12K): 218.88x122.88x220 mm; 5.5 s/layer (Elegoo's figure for fast mode with 2.5 s exposure;
  normal mode is ~8 s — pass `--layer-time 8`). 5 bottom layers x 30 s. `saturn4ultra16k`: 211.68x118.37x220.
* Jupiter (6K 12.8"): 277.848x156.264x300 mm; ~11 s/layer derived from Elegoo's official profile
  (2.5-3 s exposure, 3+4 mm lift at 65+180 mm/min, retract 180+65, 0.5 s rest). 6 bottom layers x 30 s.

Model: time = bottom_layers x (bottom_exposure + mechanical overhead) + remaining layers x layer_time;
height includes `--raise-mm` (default 5 mm when supports allowance > 0). Parts that fit side-by-side on one
plate print in the same time as one (time is *not* multiplied by quantity; resin is).
`min-height` lays the part on the convex-hull face that minimises Z; `tilt`/`auto` does that then tilts
`--tilt-deg` about X. Hollowing uses a voxel distance transform (removed = interior further than `--wall`
from the surface); drain holes and trapped resin are not modelled.
UVtools was not used: its CLI operates on already-sliced printer files (.goo/.ctb etc.), it does not slice meshes.

## Known limitations
* Time estimates are OrcaSlicer's, using Bambu's own motion/acceleration limits in the presets; typically within
  ~10% of Bambu Studio. `print_time` includes the printer start sequence (~6 min on P1S/X1C; heat-up waits are
  only roughly modelled); `model_time_seconds` excludes it.
* Supports default ON (tree auto) - this adds material on models with overhangs (Benchy: +3.7 g, +13 min).
  Quote `--supports off` for parts that need none.
* Fit check uses the model's bounding box as supplied (plus 90 deg Z rotation); it does not try other
  orientations unless `--orient` is used for slicing. Bambu P1S/X1C slicer Z limit is 250 mm.
* H2C is approximated with the H2D profile (same H2 platform), single-material, left/right nozzle choice by Orca.
* Quantity multiplies single-part results; batching on one plate would save some start-up time.
* `--scale` pre-scales the mesh with trimesh (OrcaSlicer 2.4.2's CLI `--scale` segfaults), so a scaled 3MF loses
  its embedded per-object settings/colours.
* Multi-colour/AMS purge waste is not included (single filament).
* Non-watertight meshes slice fine in Orca but resin volume/hollowing may be off; JSON flags `watertight`.
