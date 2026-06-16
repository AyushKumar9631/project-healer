// Server-only Twilio REST helper using the Lovable connector gateway.
// The gateway prepends /2010-04-01/Accounts/{AccountSid} to every path automatically.

const GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";

function authHeaders() {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const twilioKey = process.env.TWILIO_API_KEY;
  if (!lovableKey) throw new Error("LOVABLE_API_KEY not configured");
  if (!twilioKey) throw new Error("TWILIO_API_KEY not configured (connect Twilio in Connectors)");
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": twilioKey,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

export async function twilioPost(path: string, params: Record<string, string>) {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Twilio ${res.status}: ${text}`);
  }
  return json as Record<string, unknown>;
}
