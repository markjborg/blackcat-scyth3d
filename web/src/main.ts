import "./style.css";
import { parseToolpath, type Toolpath } from "./gcode.js";
import { PrintViewer, type BedSize } from "./viewer.js";

interface Profile {
  id: string;
  name: string;
  layerHeightMm: number;
}
interface Material {
  id: string;
  name: string;
}
interface Printer {
  id: string;
  name: string;
  technology: "fdm" | "resin";
  buildVolumeMm: { xMm: number; yMm: number; zMm: number } | null;
  materials: Material[];
  profiles: Profile[];
}
interface Catalog {
  printers: Printer[];
  materials: Array<{ id: string; name: string; priceEurPerGram: number }>;
}
interface QuoteLine {
  label: string;
  grams: number;
  rateEurPerGram: number;
  rawEur: number;
  netEur: number;
  adjustment: "none" | "line_minimum";
}
interface Quote {
  lines: QuoteLine[];
  linesNetEur: number;
  minimumOrderEur: number;
  minimumOrderApplied: boolean;
  subtotalEur: number;
  vatRate: number;
  vatEur: number;
  totalEur: number;
  shipping: { note: string };
}
interface JobResult {
  filamentGrams?: number;
  grams?: number;
  printTimeText?: string;
  layerCount?: number;
  dimensionsMm?: { x: number; y: number; z: number } | null;
  volumeMl?: number;
  warnings?: string[];
}
interface Job {
  id: string;
  status: string;
  type: "fdm" | "resin";
  result?: JobResult;
  quote?: Quote;
  error?: { message: string };
  downloads?: { gcode: string; threeMf: string };
}

const app = document.querySelector("#app");
if (!app) throw new Error("Missing #app");
app.innerHTML = `
  <div class="app">
    <header class="top">
      <div class="brand">
        <svg viewBox="0 0 34 26" aria-hidden="true"><path fill="#e0a44a" d="M5 24 L10 3 L17 18 Z M29 24 L24 3 L17 18 Z"/></svg>
        <div>
          <h1>BlackCat Scyth3d</h1>
          <p>MakerLab · Malta</p>
        </div>
      </div>
      <form method="post" action="/logout"><button class="ghost" type="submit">Log out</button></form>
    </header>
    <main class="layout">
      <section class="stage" id="stage">
        <canvas id="view"></canvas>
        <div class="drop" id="drop">
          <strong>Drop an STL, 3MF, or OBJ</strong>
          <span>The plate matches the printer you pick.</span>
          <button type="button" class="file-btn" id="browse">Choose file</button>
        </div>
        <p class="hud" id="hud">No model yet</p>
      </section>
      <form class="panel" id="panel">
        <label>Printer<select id="printer"></select></label>
        <label>Material<select id="material"></select></label>
        <div class="row">
          <label>Layer height<select id="layer"></select></label>
          <label class="checks"><input id="supports" type="checkbox"> Supports</label>
        </div>
        <label>Infill <output id="infill-out">15%</output>
          <input id="infill" type="range" min="0" max="100" step="1" value="15">
        </label>
        <label>Scale <output id="scale-out">100%</output>
          <input id="scale" type="range" min="10" max="300" step="1" value="100">
        </label>
        <div class="tools">
          <button type="button" id="rot-x">Rotate X</button>
          <button type="button" id="rot-y">Rotate Y</button>
          <button type="button" id="rot-z">Rotate Z</button>
          <button type="button" id="lay">Lay flat</button>
        </div>
        <button class="primary" id="go" type="submit" disabled>Slice and quote</button>
        <p class="alert" id="alert" hidden></p>
        <div class="stats" id="stats" hidden></div>
        <div class="receipt" id="receipt" hidden></div>
        <p class="muted" id="ship" hidden></p>
        <div class="downloads" id="downloads"></div>
        <label class="preview" id="preview" hidden>Layer preview
          <input id="layer-slider" type="range" min="0" max="0" value="0">
          <span id="layer-label"></span>
        </label>
      </form>
    </main>
  </div>
  <input id="file" type="file" accept=".stl,.obj,.3mf,model/stl" hidden>
`;

const stage = must<HTMLElement>("#stage");
const hud = must<HTMLElement>("#hud");
const printerSelect = must<HTMLSelectElement>("#printer");
const materialSelect = must<HTMLSelectElement>("#material");
const layerSelect = must<HTMLSelectElement>("#layer");
const supports = must<HTMLInputElement>("#supports");
const infill = must<HTMLInputElement>("#infill");
const infillOut = must<HTMLOutputElement>("#infill-out");
const scale = must<HTMLInputElement>("#scale");
const scaleOut = must<HTMLOutputElement>("#scale-out");
const go = must<HTMLButtonElement>("#go");
const alertBox = must<HTMLElement>("#alert");
const stats = must<HTMLElement>("#stats");
const receipt = must<HTMLElement>("#receipt");
const ship = must<HTMLElement>("#ship");
const downloads = must<HTMLElement>("#downloads");
const preview = must<HTMLElement>("#preview");
const layerSlider = must<HTMLInputElement>("#layer-slider");
const layerLabel = must<HTMLElement>("#layer-label");
const fileInput = must<HTMLInputElement>("#file");
const viewer = new PrintViewer(must<HTMLCanvasElement>("#view"));

let catalog: Catalog | null = null;
let fileName = "model.stl";
let toolpath: Toolpath | null = null;

must<HTMLButtonElement>("#browse").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
});
stage.addEventListener("dragover", (event) => {
  event.preventDefault();
  stage.classList.add("drag");
});
stage.addEventListener("dragleave", () => stage.classList.remove("drag"));
stage.addEventListener("drop", (event) => {
  event.preventDefault();
  stage.classList.remove("drag");
  const file = event.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});
printerSelect.addEventListener("change", () => {
  fillMaterials();
  fillLayers();
  applyBed();
  refreshHud();
});
materialSelect.addEventListener("change", syncMode);
infill.addEventListener("input", () => {
  infillOut.textContent = `${infill.value}%`;
});
scale.addEventListener("input", () => {
  scaleOut.textContent = `${scale.value}%`;
  viewer.setScale(Number(scale.value));
  refreshHud();
});
must<HTMLButtonElement>("#rot-x").addEventListener("click", () => turn("x"));
must<HTMLButtonElement>("#rot-y").addEventListener("click", () => turn("y"));
must<HTMLButtonElement>("#rot-z").addEventListener("click", () => turn("z"));
must<HTMLButtonElement>("#lay").addEventListener("click", () => {
  viewer.layFlat();
  scale.value = "100";
  scaleOut.textContent = "100%";
  refreshHud();
});
layerSlider.addEventListener("input", () => showLayer(Number(layerSlider.value)));
must<HTMLFormElement>("#panel").addEventListener("submit", (event) => {
  event.preventDefault();
  void quote();
});

void boot();

async function boot(): Promise<void> {
  const response = await fetch("/v1/catalog", { credentials: "same-origin" });
  if (response.status === 401) {
    window.location.href = "/login";
    return;
  }
  catalog = (await response.json()) as Catalog;
  for (const printer of catalog.printers) {
    const option = document.createElement("option");
    option.value = printer.id;
    option.textContent = printer.name;
    printerSelect.append(option);
  }
  printerSelect.value = catalog.printers.find((printer) => printer.id === "bambu-a1")?.id ?? catalog.printers[0]?.id ?? "";
  fillMaterials();
  fillLayers();
  applyBed();
}

async function loadFile(file: File): Promise<void> {
  hideError();
  try {
    const triangles = await viewer.load(file);
    fileName = file.name.replace(/\.[^.]+$/, "") || "model";
    stage.classList.add("ready");
    scale.value = "100";
    scaleOut.textContent = "100%";
    go.disabled = false;
    clearResults();
    hud.textContent = `${file.name} · ${triangles.toLocaleString()} triangles`;
    refreshHud();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not read that file.");
  }
}

function turn(axis: "x" | "y" | "z"): void {
  viewer.rotate(axis);
  refreshHud();
}

function currentPrinter(): Printer | undefined {
  return catalog?.printers.find((printer) => printer.id === printerSelect.value);
}

function fillMaterials(): void {
  const printer = currentPrinter();
  materialSelect.replaceChildren();
  for (const material of printer?.materials ?? []) {
    const price = catalog?.materials.find((item) => item.id === material.id)?.priceEurPerGram;
    const option = document.createElement("option");
    option.value = material.id;
    option.textContent = price ? `${material.name} · €${price.toFixed(2)}/g` : material.name;
    materialSelect.append(option);
  }
  syncMode();
}

function fillLayers(): void {
  const printer = currentPrinter();
  layerSelect.replaceChildren();
  for (const profile of printer?.profiles ?? []) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.layerHeightMm.toFixed(2)} mm · ${profile.name}`;
    layerSelect.append(option);
  }
  const standard = [...layerSelect.options].find((option) => option.value === "0.20mm-standard");
  if (standard) layerSelect.value = standard.value;
}

function applyBed(): void {
  const printer = currentPrinter();
  const volume = printer?.buildVolumeMm;
  const bed: BedSize = volume
    ? { x: volume.xMm, y: volume.yMm, z: volume.zMm }
    : { x: 200, y: 120, z: 220 };
  viewer.setBed(bed);
}

function syncMode(): void {
  const resin = currentPrinter()?.technology === "resin";
  layerSelect.disabled = resin;
  infill.disabled = resin;
  supports.disabled = resin;
  go.textContent = resin ? "Estimate and quote" : "Slice and quote";
}

function refreshHud(): void {
  const size = viewer.sizeMm();
  if (!size) return;
  const dims = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`;
  hud.textContent = viewer.outsideBed() ? `${dims} · outside the build volume` : dims;
  hud.classList.toggle("warn", viewer.outsideBed());
}

async function quote(): Promise<void> {
  hideError();
  go.disabled = true;
  const resin = currentPrinter()?.technology === "resin";
  go.textContent = resin ? "Estimating…" : "Slicing…";
  try {
    const modelId = await uploadOriented();
    const job = resin ? await estimate(modelId) : await slice(modelId);
    if (job.status === "failed") throw new Error(job.error?.message ?? "The slicer did not finish.");
    renderJob(job);
    if (job.downloads?.gcode) await loadPreview(job.downloads.gcode);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Request failed.");
  } finally {
    go.disabled = false;
    syncMode();
  }
}

async function uploadOriented(): Promise<string> {
  const body = new FormData();
  body.set("file", viewer.toStlBlob(), `${fileName}.stl`);
  const response = await fetch("/v1/models", { method: "POST", body, credentials: "same-origin" });
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("Sign in again.");
  }
  const payload = (await response.json()) as { id?: string; error?: { message: string } };
  if (!response.ok || !payload.id) throw new Error(payload.error?.message ?? "Upload failed.");
  return payload.id;
}

async function slice(modelId: string): Promise<Job> {
  return postJson("/v1/jobs", {
    modelId,
    printerId: printerSelect.value,
    materialId: materialSelect.value,
    profileId: layerSelect.value,
    infillPercent: Number(infill.value),
    supports: supports.checked,
    wait: true,
  });
}

async function estimate(modelId: string): Promise<Job> {
  return postJson("/v1/estimates/resin", { modelId, materialId: materialSelect.value });
}

async function postJson(path: string, body: unknown): Promise<Job> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("Sign in again.");
  }
  const payload = (await response.json()) as Job & { error?: { message: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? "Request failed.");
  return payload;
}

function renderJob(job: Job): void {
  const result = job.result;
  const grams = result?.filamentGrams ?? result?.grams;
  const size = result?.dimensionsMm;
  const cards = [
    ["Grams", grams !== undefined ? grams.toFixed(2) : "—"],
    ["Time", result?.printTimeText ?? (job.type === "resin" ? "estimate" : "—")],
    ["Layers", result?.layerCount !== undefined ? String(result.layerCount) : "—"],
    ["Size", size ? `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)}` : "—"],
  ];
  if (result?.volumeMl !== undefined) cards.splice(1, 0, ["Volume", `${result.volumeMl.toFixed(2)} ml`]);
  stats.hidden = false;
  stats.replaceChildren(
    ...cards.map(([label, value]) => {
      const card = document.createElement("div");
      card.className = "stat";
      const number = document.createElement("b");
      number.textContent = value ?? "—";
      const caption = document.createElement("span");
      caption.textContent = label ?? "";
      card.append(number, caption);
      return card;
    }),
  );
  renderQuote(job.quote);
  downloads.replaceChildren();
  if (job.downloads?.gcode) downloads.append(link(job.downloads.gcode, "Download G-code"), link(job.downloads.threeMf, "Download 3MF"));
  if (result?.warnings?.length) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = result.warnings.join(" ");
    downloads.before(note);
  }
}

function renderQuote(quote: Quote | undefined): void {
  receipt.hidden = !quote;
  ship.hidden = !quote;
  if (!quote) return;
  const line = quote.lines[0];
  const rows: Array<[string, string]> = [];
  if (line) {
    rows.push([`${line.label} · ${line.grams.toFixed(2)} g · €${line.rateEurPerGram.toFixed(2)}/g`, ""]);
    rows.push(["Raw", eur(line.rawEur)]);
    rows.push([line.adjustment === "line_minimum" ? "Line minimum applied" : "Line minimum", eur(line.netEur)]);
  }
  rows.push([quote.minimumOrderApplied ? "Order minimum applied" : "Order minimum not needed", eur(quote.minimumOrderEur)]);
  rows.push(["Subtotal before VAT", eur(quote.subtotalEur)]);
  rows.push([`VAT ${Math.round(quote.vatRate * 100)}%`, eur(quote.vatEur)]);
  receipt.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement("div");
      const name = document.createElement("span");
      name.textContent = label;
      row.append(name);
      if (value) {
        const amount = document.createElement("span");
        amount.textContent = value;
        row.append(amount);
      }
      return row;
    }),
    totalRow(quote.totalEur),
  );
  ship.textContent = quote.shipping.note;
}

function totalRow(total: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "total";
  const name = document.createElement("span");
  name.textContent = "Total";
  const amount = document.createElement("span");
  amount.textContent = eur(total);
  row.append(name, amount);
  return row;
}

function link(href: string, label: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.className = "download";
  anchor.href = href;
  anchor.textContent = label;
  return anchor;
}

async function loadPreview(href: string): Promise<void> {
  const response = await fetch(href, { credentials: "same-origin" });
  if (!response.ok) return;
  const text = await response.text();
  toolpath = parseToolpath(text);
  if (toolpath.layers.length === 0) {
    preview.hidden = true;
    return;
  }
  preview.hidden = false;
  layerSlider.max = String(toolpath.layers.length - 1);
  layerSlider.value = layerSlider.max;
  showLayer(toolpath.layers.length - 1);
}

function showLayer(index: number): void {
  if (!toolpath) return;
  viewer.showToolpath(toolpath.layers, index);
  const count = toolpath.layers.length;
  layerLabel.textContent = toolpath.truncated
    ? `Preview ${index + 1} / ${count}, truncated`
    : `Preview ${index + 1} / ${count}`;
}

function clearResults(): void {
  stats.hidden = true;
  receipt.hidden = true;
  ship.hidden = true;
  downloads.replaceChildren();
  preview.hidden = true;
  toolpath = null;
  viewer.clearToolpath();
}

function showError(message: string): void {
  alertBox.hidden = false;
  alertBox.textContent = message;
}

function hideError(): void {
  alertBox.hidden = true;
  alertBox.textContent = "";
}

function eur(value: number): string {
  return new Intl.NumberFormat("en-MT", { style: "currency", currency: "EUR" }).format(value);
}

function must<T extends Element>(selector: string): T {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node as T;
}
