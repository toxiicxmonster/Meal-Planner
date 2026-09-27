// Supabase Edge Function "import-recipe": fetches a recipe web page for the web app.
// Browsers don't let a web page read other websites directly, so the web app asks this function
// to fetch the page, then reads the recipe itself (extractRecipe in docs/core.js).
//
// Only signed-in people can call it: Supabase checks their sign-in before this code runs
// ("Verify JWT", on by default). It only fetches public http(s) pages, and at most 5 MB.

// Recipe sites turn away requests that don't look like a normal browser visit.
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BYTES = 5_000_000;

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** Refuse addresses that point inside a private network. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === "::1" || /^f[cd]/.test(h);
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ message: "Use POST." }, 405);

  let target: URL;
  try {
    const { url } = await req.json();
    target = new URL(String(url));
  } catch {
    return reply({ message: "That doesn't look like a web address." }, 400);
  }
  if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) {
    return reply({ message: "That doesn't look like a recipe web address." }, 400);
  }

  let resp: Response;
  try {
    resp = await fetch(target.href, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(15000) });
  } catch {
    return reply({ message: "Couldn't open that page — check the link." }, 502);
  }
  if (!resp.ok) {
    const message = [401, 403, 429].includes(resp.status) ? "That site turned the app away."
      : resp.status === 404 ? "That page couldn't be found." : `The site answered with error ${resp.status}.`;
    return reply({ message }, 502);
  }
  const type = resp.headers.get("content-type") || "";
  if (type && !/html|xml|text/i.test(type)) return reply({ message: "That link isn't a web page." }, 415);

  const bytes = new Uint8Array(await resp.arrayBuffer()).slice(0, MAX_BYTES);
  const charset = (type.match(/charset=([\w-]+)/i) || [])[1] || "utf-8";
  let html: string;
  try {
    html = new TextDecoder(charset).decode(bytes);
  } catch {
    html = new TextDecoder("utf-8").decode(bytes);
  }
  return reply({ url: resp.url || target.href, html });
}

// @ts-ignore: Deno is the Supabase Edge Functions runtime
if (typeof Deno !== "undefined") Deno.serve(handle);
