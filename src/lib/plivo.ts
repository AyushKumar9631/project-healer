// Server-only Plivo REST helper. Uses HTTP Basic auth with AUTH_ID/AUTH_TOKEN.
// Plivo REST base: https://api.plivo.com/v1/Account/{AUTH_ID}/

const BASE = "https://api.plivo.com/v1/Account";

function authHeader(): string {
  const id = process.env.PLIVO_AUTH_ID;
  const token = process.env.PLIVO_AUTH_TOKEN;
  if (!id || !token) {
    throw new Error("PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN not configured");
  }
  return "Basic " + Buffer.from(`${id}:${token}`).toString("base64");
}

function accountId(): string {
  const id = process.env.PLIVO_AUTH_ID;
  if (!id) throw new Error("PLIVO_AUTH_ID not configured");
  return id;
}

export async function plivoPost<T = Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `${BASE}/${accountId()}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Plivo ${res.status}: ${text}`);
  }
  return json as T;
}

export async function plivoGet<T = Record<string, unknown>>(path: string): Promise<T> {
  const url = `${BASE}/${accountId()}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: authHeader() },
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Plivo GET ${res.status}: ${text}`);
  }
  return json as T;
}

export async function plivoDelete(path: string): Promise<void> {
  const url = `${BASE}/${accountId()}${path}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: authHeader() },
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`Plivo DELETE ${res.status}: ${text}`);
  }
}

// Hang up an in-progress Plivo call by its CallUUID.
export async function plivoHangup(callUuid: string): Promise<void> {
  await plivoDelete(`/Call/${callUuid}/`);
}
