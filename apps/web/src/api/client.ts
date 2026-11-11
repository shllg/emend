import { ErrorBody, type SessionRequest } from "@emend/contract";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
async function request(path: string, init?: RequestInit, redirect = true) {
  const response = await fetch(path, { ...init, credentials: "same-origin" });
  if (!response.ok) {
    const body = ErrorBody.safeParse(await response.json().catch(() => null));
    if (response.status === 401 && redirect) window.location.assign("/pair");
    throw new ApiError(
      response.status,
      body.success ? body.data.error.code : "unknown",
      body.success ? body.data.error.message : "The request failed. Try again.",
    );
  }
  return response;
}
export async function get<T>(path: string, schema: { parse(value: unknown): T }, signal?: AbortSignal): Promise<T> {
  return schema.parse(await (await request(path, { signal })).json());
}
export async function head(path: string, signal?: AbortSignal) {
  await request(path, { method: "HEAD", signal });
}
export async function change(path: string, method: "POST" | "PATCH" | "DELETE" | "PUT", body?: unknown) {
  await request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}
export async function pair(input: SessionRequest) {
  await request(
    "/api/v1/session",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
    false,
  );
}

export async function getText(path: string, signal?: AbortSignal): Promise<string> {
  return (await request(path, { signal })).text();
}

export async function post<T>(path: string, body: unknown, schema: { parse(value: unknown): T }): Promise<T> {
  const response = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return schema.parse(await response.json());
}

export async function patch<T>(path: string, body: unknown, schema: { parse(value: unknown): T }): Promise<T> {
  const response = await request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return schema.parse(await response.json());
}
