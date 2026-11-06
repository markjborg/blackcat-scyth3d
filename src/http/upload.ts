import type { IncomingMessage } from "node:http";
import Busboy from "busboy";
import { ApiError } from "../errors.js";

export function readSingleUpload(req: IncomingMessage, maxBytes: number): Promise<{ filename: string; data: Buffer }> {
  return new Promise((resolve, reject) => {
    if (!req.headers["content-type"]?.includes("multipart/form-data")) {
      reject(new ApiError(415, "unsupported_media", "Upload the model as multipart/form-data in the file field."));
      return;
    }
    const parser = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: maxBytes, fields: 5 },
    });
    let settled = false;
    let captured: { filename: string; data: Buffer; truncated: boolean } | null = null;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    parser.on("file", (_name, stream, info) => {
      const chunks: Buffer[] = [];
      let truncated = false;
      stream.on("limit", () => {
        truncated = true;
      });
      stream.on("data", (chunk: Buffer) => {
        if (!truncated) chunks.push(chunk);
      });
      stream.on("error", fail);
      stream.on("end", () => {
        if (captured) return;
        captured = { filename: info.filename || "model", data: Buffer.concat(chunks), truncated };
      });
    });
    parser.on("error", fail);
    parser.on("finish", () => {
      if (settled) return;
      settled = true;
      if (!captured) {
        reject(new ApiError(400, "missing_file", "Upload a model in the file field."));
        return;
      }
      if (captured.truncated) {
        reject(new ApiError(413, "file_too_large", `File exceeds the upload limit of ${maxBytes} bytes.`));
        return;
      }
      resolve({ filename: captured.filename, data: captured.data });
    });
    req.pipe(parser);
  });
}
