// Thin fetch wrapper around the Soul Hub API. Dumb pipe per ADR-001 — no
// validation, no caching, no auth logic. Errors surface verbatim.

const DEFAULT_BASE = 'http://localhost:2400';

export function baseUrl(): string {
  return process.env.SOUL_HUB_URL?.replace(/\/+$/, '') || DEFAULT_BASE;
}

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, path: string) {
    super(`API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: string, path: string, init: { query?: Record<string, string | number | undefined>; body?: unknown }): Promise<T> {
  const url = new URL(path, baseUrl() + '/');
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v === undefined || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), { method, headers, body });
  } catch (err) {
    throw new ApiError(
      0,
      err instanceof Error ? err.message : String(err),
      url.pathname + url.search,
    );
  }
  const text = await res.text();
  // A structured `{success:false}` body is a DOMAIN failure (refused write —
  // validation/governance), not a transport error. The write verbs handle it
  // via emit() + exitIfApiFailure(), so return it as data even on 4xx. Only
  // transport failures (5xx, empty/non-JSON bodies, bodies without the
  // success envelope) throw ApiError.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(
      res.status,
      res.ok ? `non-JSON response: ${text.slice(0, 200)}` : text,
      url.pathname + url.search,
    );
  }
  if (!res.ok) {
    if (parsed && typeof parsed === 'object' && (parsed as { success?: unknown }).success === false) {
      return parsed as T;
    }
    throw new ApiError(res.status, text, url.pathname + url.search);
  }
  return parsed as T;
}

export function apiGet<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  return request<T>('GET', path, { query });
}

export function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  return request<T>('POST', path, { body });
}

export function apiPut<T = unknown>(path: string, body: unknown): Promise<T> {
  return request<T>('PUT', path, { body });
}

export function apiPatch<T = unknown>(path: string, body: unknown): Promise<T> {
  return request<T>('PATCH', path, { body });
}

export function apiDelete<T = unknown>(path: string): Promise<T> {
  return request<T>('DELETE', path, {});
}
