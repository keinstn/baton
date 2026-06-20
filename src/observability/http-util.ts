import type { ServerResponse } from "node:http";

export interface ErrorEnvelope {
  error: { code: string; message: string };
}

export const exact =
  (p: string) =>
  (path: string): string[] | null =>
    path === p ? [] : null;

export const pattern =
  (re: RegExp) =>
  (path: string): string[] | null => {
    const m = re.exec(path);
    return m ? m.slice(1) : null;
  };

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headOnly = false,
): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload).toString());
  res.setHeader("Cache-Control", "no-store");
  if (headOnly) {
    res.end();
  } else {
    res.end(payload);
  }
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  const env: ErrorEnvelope = { error: { code, message } };
  sendJson(res, status, env);
}

export function sendMethodNotAllowed(
  res: ServerResponse,
  allowed: string[],
): void {
  res.setHeader("Allow", allowed.join(", "));
  sendError(
    res,
    405,
    "method_not_allowed",
    `allowed methods: ${allowed.join(", ")}`,
  );
}
