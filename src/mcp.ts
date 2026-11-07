import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { publicCatalog } from "./profiles/catalog.js";
import { presentJob } from "./present.js";
import type { ScythService } from "./service.js";

const modelSource = {
  modelId: z.string().optional().describe("Id returned by POST /v1/models."),
  filename: z.string().optional().describe("Filename, including .stl, .3mf, or .obj, when sending base64."),
  base64: z.string().optional().describe("Base64-encoded model. Use POST /v1/models for files larger than the inline limit."),
};

export function registerTools(server: McpServer, service: ScythService): void {
  server.registerTool(
    "list_profiles",
    {
      title: "List printers, materials, and profiles",
      description:
        "List BlackCat MakerLab printers, materials, and FDM profiles. FDM prices are €0.20/g for PLA and PETG. Resin is estimated from mesh volume, not sliced: Standard Resin €0.35/g, High Quality Resin (ABS-like) €0.42/g. Prices are before VAT.",
      inputSchema: z.object({
        printerId: z.string().optional().describe("Optional printer id, for example bambu-a1."),
      }),
    },
    async ({ printerId }) => jsonResult(filterCatalog(printerId)),
  );

  server.registerTool(
    "slice_model",
    {
      title: "Slice an FDM model",
      description:
        "Slice an STL, 3MF, or OBJ for a Bambu Lab printer with OrcaSlicer. Returns filament grams, print time, layer count, dimensions, bounding box, download paths, and a quote using Mark's price list. Pass modelId from POST /v1/models, or a small base64 file.",
      inputSchema: z.object({
        ...modelSource,
        printerId: z.string().describe("Printer id from list_profiles, for example bambu-a1."),
        materialId: z.enum(["pla", "petg"]),
        profileId: z.string().optional().describe("Defaults to 0.20mm-standard. Also 0.16mm-optimal and 0.24mm-draft."),
        infillPercent: z.number().int().min(0).max(100).optional(),
        supports: z.boolean().optional(),
      }),
    },
    async (input) => {
      try {
        const modelId = await resolveModel(service, input);
        const job = await service.createSlice(
          {
            modelId,
            printerId: input.printerId,
            materialId: input.materialId,
            profileId: input.profileId,
            infillPercent: input.infillPercent,
            supports: input.supports,
          },
          true,
        );
        if (job.status === "failed") {
          return toolError(job.error?.message ?? "Slice failed.", presentJob(job));
        }
        return jsonResult(presentJob(job));
      } catch (error) {
        return toolError(messageOf(error));
      }
    },
  );

  server.registerTool(
    "estimate_resin",
    {
      title: "Estimate resin volume and weight",
      description:
        "Estimate resin from the closed mesh. Returns volume in ml, grams, bounding box, and a quote. standard-resin is 1.10 g/ml at €0.35/g. high-quality-resin is ABS-like resin, labelled High Quality Resin, at 1.15 g/ml and €0.42/g. This does not produce a sliced toolpath.",
      inputSchema: z.object({
        ...modelSource,
        materialId: z.enum(["standard-resin", "high-quality-resin"]),
      }),
    },
    async (input) => {
      try {
        const modelId = await resolveModel(service, input);
        return jsonResult(presentJob(await service.estimateResin(modelId, input.materialId)));
      } catch (error) {
        return toolError(messageOf(error));
      }
    },
  );

  server.registerTool(
    "prepare_plates",
    {
      title: "Orient, arrange, and slice plates",
      description:
        "Auto-orient and arrange one or more uploaded models onto a MakerLab fleet printer, slice every plate, and quote from the sliced grams or resin volume. No Bambu cloud. H2C uses an H2D proxy because OrcaSlicer 2.4.2 has no H2C preset. Elegoo resin printers do not get a fake .goo or .ctb file. The SL1S returns a real .sl1s when PrusaSlicer is configured. Upload models with POST /v1/models first, then pass modelId and quantity. get_job reads the same job.",
      inputSchema: z.object({
        printerId: z.string(),
        materialId: z.enum(["pla", "petg", "standard-resin", "high-quality-resin"]),
        infillPercent: z.number().int().min(0).max(100).optional(),
        supports: z.boolean().optional(),
        models: z
          .array(
            z.object({
              modelId: z.string(),
              quantity: z.number().int().min(1).max(40).optional(),
            }),
          )
          .min(1)
          .max(20),
      }),
    },
    async (input) => {
      try {
        const job = await service.preparePlates(
          {
            printerId: input.printerId,
            materialId: input.materialId,
            infillPercent: input.infillPercent,
            supports: input.supports,
            models: input.models.map((model) => ({ modelId: model.modelId, quantity: model.quantity ?? 1 })),
          },
          true,
        );
        if (job.status === "failed") return toolError(job.error?.message ?? "Plate preparation failed.", presentJob(job));
        return jsonResult(presentJob(job));
      } catch (error) {
        return toolError(messageOf(error));
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get a slice or plate job",
      description: "Fetch a job by id, including plate files, sliced weight or volume, quote, and download paths. Jobs created in the browser are visible here.",
      inputSchema: z.object({ jobId: z.string() }),
    },
    async ({ jobId }) => {
      try {
        return jsonResult(presentJob(await service.getJob(jobId)));
      } catch (error) {
        return toolError(messageOf(error));
      }
    },
  );

  server.registerTool(
    "quote",
    {
      title: "Quote a print",
      description:
        "Apply Mark's prices, before VAT: PLA/PETG €0.20/g, Standard Resin €0.35/g, High Quality Resin (ABS-like) €0.42/g. Any line under €2 becomes €2.50. The minimum order is €10 before VAT. VAT is 18% on top. Shipping is excluded. Pass a jobId or explicit lines.",
      inputSchema: z.object({
        jobId: z.string().optional(),
        lines: z
          .array(
            z.object({
              materialId: z.enum(["pla", "petg", "standard-resin", "high-quality-resin"]),
              grams: z.number().positive(),
              note: z.string().optional(),
            }),
          )
          .optional(),
      }),
    },
    async (input) => {
      try {
        return jsonResult(
          await service.quote({
            jobId: input.jobId,
            lines: input.lines?.map((line) => ({ materialId: line.materialId, grams: line.grams, note: line.note })),
          }),
        );
      } catch (error) {
        return toolError(messageOf(error));
      }
    },
  );
}

async function resolveModel(
  service: ScythService,
  input: { modelId?: string; filename?: string; base64?: string },
): Promise<string> {
  if (input.modelId && (input.base64 || input.filename)) {
    throw new ApiError(400, "ambiguous_model", "Pass modelId or filename plus base64, not both.");
  }
  if (input.modelId) return input.modelId;
  if (input.filename && input.base64) {
    const model = await service.uploadInline(input.filename, input.base64);
    return model.id;
  }
  throw new ApiError(400, "missing_model", "Pass modelId, or filename and base64.");
}

function filterCatalog(printerId: string | undefined): ReturnType<typeof publicCatalog> {
  const catalog = publicCatalog();
  if (!printerId) return catalog;
  return {
    ...catalog,
    printers: catalog.printers.filter((printer) => printer.id === printerId),
    profiles: catalog.profiles.filter((profile) => profile.printerId === printerId),
  };
}

function jsonResult(value: unknown): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value } as Record<string, unknown>,
  };
}

function toolError(message: string, detail?: unknown): { isError: true; content: Array<{ type: "text"; text: string }> } {
  const text = detail ? `${message}\n${JSON.stringify(detail, null, 2)}` : message;
  return { isError: true, content: [{ type: "text", text }] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}
