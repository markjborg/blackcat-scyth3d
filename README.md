# BlackCat Scyth3d

Self-hosted slicing and quoting for BlackCat MakerLab in Malta. Version 1 is an HTTP API plus a Model Context Protocol server. A browser slicer comes later; the API is shaped so that UI can upload a model, pick a printer and material, poll a job, and download the G-code or 3MF.

FDM jobs are sliced with [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) 2.4.2, headless, using the Bambu Lab 0.4 mm presets that ship with it. Resin jobs are not sliced. The service measures the mesh and returns volume and grams.

## Licence

This repository is [AGPL-3.0-only](LICENSE). OrcaSlicer is also AGPL-3.0. The Docker image downloads a pinned OrcaSlicer AppImage while it builds and does not vendor the slicer source.

If you run a modified copy as a network service, or you distribute the image, the AGPL requires you to offer the corresponding source of this service and of OrcaSlicer to users who interact with it. See [NOTICE](NOTICE).

PrusaSlicer was the fallback if OrcaSlicer could not run headless. OrcaSlicer 2.4.2 does run on a cheap Linux server under Xvfb, so PrusaSlicer is not bundled.

## What a quote includes

Prices are Mark's approved rates, before VAT:

| Material | Rate |
| --- | --- |
| PLA, PETG | €0.20 / g |
| Standard Resin | €0.35 / g |
| High Quality Resin (ABS-like) | €0.42 / g |

- A line whose raw price is under €2 is charged at €2.50.
- The order minimum is €10 before VAT.
- VAT is 18% on top of that subtotal.
- Shipping is excluded and added separately.

Resin grams use a closed-mesh volume and these densities: Standard Resin 1.10 g/ml, High Quality Resin 1.15 g/ml. Hollows and drain holes count only when they are already in the mesh. FDM grams come from OrcaSlicer.

## Run with Docker Compose

```bash
cp .env.example .env
# put a long random value in SCYTH3D_API_KEY, for example:
# openssl rand -hex 32
docker compose up --build
```

The API listens on port 8080. Models and jobs are stored in the `scyth3d-data` volume and removed after `SCYTH3D_JOB_TTL_HOURS` (default 48).

Do not commit `.env`. The key is read only from the environment.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCYTH3D_API_KEY` | required | Bearer token for the REST API and MCP. At least 8 characters. |
| `PORT` | `8080` | HTTP port inside the container. |
| `HOST` | `0.0.0.0` | Bind address. |
| `SCYTH3D_DATA_DIR` | `data` | Models, jobs, G-code, and 3MF. |
| `SCYTH3D_MAX_UPLOAD_MB` | `100` | Multipart upload limit. |
| `SCYTH3D_MCP_INLINE_MAX_MB` | `8` | Largest model accepted as base64 by an MCP tool. |
| `SCYTH3D_JOB_TTL_HOURS` | `48` | Delete finished jobs and unused models after this age. |
| `SCYTH3D_MAX_CONCURRENT_SLICES` | `1` | Slice queue depth. Keep this at 1 on a small VPS. |
| `SCYTH3D_SLICE_TIMEOUT_SEC` | `900` | Kill a slice that runs longer than this. |
| `SCYTH3D_ALLOWED_HOSTS` | unset | Optional comma-separated `Host` allow list. |
| `ORCA_SLICER_BIN` | `/opt/orcaslicer/bin/orca-slicer` | OrcaSlicer binary. |
| `ORCA_RESOURCES` | `/opt/orcaslicer/resources` | Directory that contains `profiles/`. |

`GET /health` does not require a key, so a process supervisor can probe it. Every other route requires `Authorization: Bearer <key>` or `X-API-Key`.

## HTTP API

`GET /v1/printers`, `GET /v1/materials`, `GET /v1/profiles`, and `GET /v1/catalog` describe the machines.

FDM printers, all 0.4 mm nozzle, PLA and PETG, profiles `0.20mm-standard`, `0.16mm-optimal`, and `0.24mm-draft`:

- `bambu-a1` — Bambu Lab A1, 256 mm cube
- `bambu-a1-mini` — Bambu Lab A1 mini, 180 mm cube
- `bambu-p1p`, `bambu-p1s`, `bambu-x1c`, `bambu-x1e` — 256 mm cube

`resin-msla` is estimate-only.

```bash
export KEY=your-key
export BASE=http://127.0.0.1:8080

curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/printers"

curl -s -H "Authorization: Bearer $KEY" \
  -F "file=@samples/cube20.stl" \
  "$BASE/v1/models"

# Use the id from the upload response.
curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"modelId":"MODEL_ID","printerId":"bambu-a1","materialId":"pla","profileId":"0.20mm-standard","wait":true}' \
  "$BASE/v1/jobs"

curl -sL -H "Authorization: Bearer $KEY" -o print.gcode "$BASE/v1/jobs/JOB_ID/gcode"
curl -sL -H "Authorization: Bearer $KEY" -o print.3mf "$BASE/v1/jobs/JOB_ID/3mf"

curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"modelId":"MODEL_ID","materialId":"standard-resin"}' \
  "$BASE/v1/estimates/resin"

curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"lines":[{"materialId":"pla","grams":12.5},{"materialId":"petg","grams":4}]}' \
  "$BASE/v1/quotes"
```

Omit `wait` to get `202` and poll `GET /v1/jobs/:id`. Optional slice fields are `infillPercent` (0–100) and `supports`. The bed type is Textured PEI, which is what the Bambu PETG presets allow. The Cool Plate rejects PETG.

## MCP

The MCP endpoint is streamable HTTP at `POST /mcp`, using `@modelcontextprotocol/server` and `@modelcontextprotocol/node`. Send `Authorization: Bearer <key>` and `Accept: application/json, text/event-stream`.

Tools:

- `list_profiles` — printers, materials, profiles, and the price rules
- `slice_model` — slice by `modelId`, or by `filename` plus `base64` for a small file
- `estimate_resin` — volume, grams, and a quote
- `get_job` — job status and downloads
- `quote` — price a `jobId` or explicit lines

Cursor, or another client that speaks streamable HTTP, can use:

```json
{
  "mcpServers": {
    "blackcat-scyth3d": {
      "url": "http://127.0.0.1:8080/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

Large models should be uploaded with `POST /v1/models` and then sliced by `modelId`. Inline base64 is capped by `SCYTH3D_MCP_INLINE_MAX_MB`.

## Why the profiles are flattened

OrcaSlicer's CLI applies the JSON passed to `--load-settings` and `--load-filaments`, but it does not walk the `inherits` chain. Without that chain, filament density stays 0 and speeds fall back to slow defaults. Scyth3d flattens the Bambu preset chain (machine, process, filament) and writes the result into the job directory before slicing. G-code and a `.gcode.3mf` are both kept. Bambu printers take the 3MF; the G-code is there for inspection and for the gram, time, and layer counters in its footer.

## Develop and test

Node.js 22 or newer. A real slice also needs Xvfb and the OrcaSlicer 2.4.2 AppImage extracted, which is what CI does on Ubuntu 24.04.

```bash
npm ci
npm test
npm run typecheck
ORCA_SLICER_BIN=/opt/orcaslicer/bin/orca-slicer \
ORCA_RESOURCES=/opt/orcaslicer/resources \
SCYTH3D_API_KEY="$(openssl rand -hex 32)" \
npm run dev
```

`npm test` always runs the pricing, mesh, auth, and API tests. The OrcaSlicer test slices `samples/cube20.stl` when `ORCA_SLICER_BIN` points at a binary (or when the default extract path exists). Set `SCYTH3D_REQUIRE_SLICER=1` to fail instead of skipping, which is what CI does.

## Limits

- No browser UI in this version.
- Resin output is a volume estimate, not a sliced layer stack.
- G-code is Bambu-flavoured OrcaSlicer output for the listed 0.4 mm presets, on a Textured PEI bed.
- One slice runs at a time unless `SCYTH3D_MAX_CONCURRENT_SLICES` is raised.
- Uploads are limited by size and by triangle count (2,000,000).
- Complex 3MF component trees are followed for the resin volume. Build-item transforms are applied. Materials painted inside a 3MF are not.
