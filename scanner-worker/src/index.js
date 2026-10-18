const MAX_PAGES = 40;
const MAX_PAGE_CHARS = 12000;
const USER_AGENT = "MarvinBusinessContextScanner/0.1 (+https://www.leoasaservice.com/)";

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = new Set(["https://www.leoasaservice.com", "https://leoasaservice.com", "http://127.0.0.1:8765", "http://localhost:8765"]);
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : "https://www.leoasaservice.com",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Scan-Token",
    "Vary": "Origin"
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request) }
  });
}

function handoffFromBooking(payload) {
  const root = payload?.payload || payload || {};
  const metadata = root.metadata || root.booking?.metadata || root.booking?.eventType?.metadata || {};
  return metadata.handoff_id || metadata.marvin_handoff_id || root.handoff_id || root.marvin_handoff_id || null;
}

async function sendBookingBrief(env, handoff, booking) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.EMAIL_TO) return { status: "email_not_configured" };
  const attendee = booking?.attendees?.[0]?.email || booking?.attendee?.email || "unknown attendee";
  const subject = `Marvin briefing for confirmed booking${booking?.uid ? ` ${booking.uid}` : ""}`;
  const text = [
    "A Cal.com booking was confirmed with a Marvin discovery handoff.",
    "",
    `Booking UID: ${booking?.uid || "unknown"}`,
    `Attendee: ${attendee}`,
    `Business URL: ${handoff.businessUrl || "not provided"}`,
    "",
    "Briefing / conversation transcript:",
    handoff.summary || handoff.transcript || "No briefing was saved.",
    "",
    "This is a private briefing assembled from the visitor's conversation and public-site context. Verify it with the owner before treating it as fact."
  ].join("\n");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [env.EMAIL_TO], subject, text })
  });
  if (!response.ok) return { status: "email_failed", providerStatus: response.status, providerBody: (await response.text()).slice(0, 300) };
  return { status: "email_accepted", provider: await response.json() };
}

function randomToken() {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

function validateUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("Enter a complete website URL, including https://."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only public http:// and https:// websites can be scanned.");
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not accepted.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1" || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.16.") || host.startsWith("172.17.") || host.startsWith("172.18.") || host.startsWith("172.19.") || host.startsWith("172.2")) {
    throw new Error("Private and local network addresses are not accepted.");
  }
  url.hash = "";
  return url;
}

function sameOrigin(candidate, root) {
  return candidate.protocol === root.protocol && candidate.hostname === root.hostname && (candidate.port || "") === (root.port || "");
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function extractPage(html, url) {
  const clean = stripHtml(html);
  const title = (clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const description = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] || "").trim();
  const headings = [...clean.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(m => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 30);
  const links = [...clean.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)].map(m => m[1]).slice(0, 300);
  const text = clean.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_CHARS);
  return { url: url.href, title, description, headings, text, links };
}

async function fetchPage(url) {
  const response = await fetch(url.href, { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9" }, redirect: "manual" });
  if (!response.ok) return { url: url.href, error: `HTTP ${response.status}` };
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml") && !contentType.includes("text/plain")) return { url: url.href, skipped: "not HTML" };
  const html = await response.text();
  return extractPage(html, url);
}

function urlsFromSitemap(xml, root) {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => {
    try { return new URL(m[1].trim()); } catch { return null; }
  }).filter(u => u && sameOrigin(u, root));
}

async function discoverUrls(root) {
  const candidates = new Set([root.href]);
  for (const path of ["/robots.txt", "/sitemap.xml"]) {
    try {
      const response = await fetch(new URL(path, root), { headers: { "User-Agent": USER_AGENT }, redirect: "manual" });
      if (!response.ok) continue;
      const body = await response.text();
      if (path === "/robots.txt") {
        for (const line of body.split(/\r?\n/)) {
          const match = line.match(/^\s*Sitemap:\s*(\S+)/i);
          if (match) {
            try { candidates.add(new URL(match[1]).href); } catch {}
          }
        }
      } else {
        for (const url of urlsFromSitemap(body, root)) candidates.add(url.href);
      }
    } catch {}
  }
  const sitemapUrls = [...candidates].filter(u => /sitemap/i.test(u));
  for (const sitemapUrl of sitemapUrls.slice(0, 5)) {
    try {
      const response = await fetch(sitemapUrl, { headers: { "User-Agent": USER_AGENT }, redirect: "manual" });
      if (response.ok) for (const url of urlsFromSitemap(await response.text(), root)) candidates.add(url.href);
    } catch {}
  }
  return [...candidates].filter(u => !/sitemap/i.test(u)).slice(0, MAX_PAGES);
}

async function runScan(state, save) {
  const root = new URL(state.url);
  const queue = await discoverUrls(root);
  const seen = new Set(queue);
  const pages = [];
  while (queue.length && pages.length < MAX_PAGES) {
    const batchUrls = queue.splice(0, Math.min(4, MAX_PAGES - pages.length));
    const batch = await Promise.all(batchUrls.map(async raw => {
      try { return await fetchPage(new URL(raw)); } catch (error) { return { url: raw, error: error.message }; }
    }));
    pages.push(...batch);
    for (const page of batch) {
      for (const link of page.links || []) {
        try {
          const candidate = new URL(link, page.url);
          candidate.hash = "";
          if (sameOrigin(candidate, root) && !/sitemap/i.test(candidate.pathname) && !seen.has(candidate.href)) {
            seen.add(candidate.href);
            queue.push(candidate.href);
          }
        } catch {}
      }
    }
    await save({ ...state, status: "scanning", pagesScanned: pages.length, pages: pages.map(({ links, ...page }) => page) });
  }
  const usable = pages.filter(page => page.text && !page.error && !page.skipped);
  const profile = {
    businessUrl: root.href,
    pagesScanned: pages.length,
    usablePages: usable.length,
    truncated: queue.length > 0,
    pages: usable,
    scanNotes: ["This is public website context only.", "Private operations, customer experience, constraints, and pain points still need to come from the business owner.", "The scanner does not treat marketing copy as verified business performance."]
  };
  await save({ ...state, status: "complete", completedAt: new Date().toISOString(), pagesScanned: pages.length, pages: undefined, profile });
}

export class ScanJob {
  constructor(state, env) { this.storage = state.storage; this.env = env; this.data = null; }
  async save(next) { this.data = next; await this.storage.put("state", next); }
  async fetch(request) {
    if (!this.data) this.data = await this.storage.get("state");
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request) });
    const token = request.headers.get("X-Scan-Token") || url.searchParams.get("token");
    const internal = this.env.WEBHOOK_SECRET && request.headers.get("X-Webhook-Secret") === this.env.WEBHOOK_SECRET;
    if (!internal && this.data?.token && token !== this.data.token) return json(request, { error: "Not found" }, 404);
    if (request.method === "DELETE" && !internal) {
      await this.storage.deleteAll();
      this.data = null;
      return json(request, { ok: true });
    }
    if (request.method === "GET") return json(request, this.data || { status: "unknown" });
    if (request.method === "POST" && url.pathname === "/") {
      const initial = await request.json();
      await this.save(initial);
      return json(request, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/run") {
      if (!this.data || this.data.status === "complete" || this.data.status === "scanning") return json(request, { ok: true });
      await this.save({ ...this.data, status: "scanning", startedAt: new Date().toISOString() });
      try { await runScan(this.data, next => this.save(next)); }
      catch (error) { await this.save({ ...this.data, status: "error", error: error.message }); }
      return json(request, { ok: true });
    }
    if (internal && request.method === "POST" && url.pathname === "/email") {
      const booking = await request.json();
      const result = await sendBookingBrief(this.env, this.data || {}, booking);
      await this.save({ ...this.data, email: result, emailAttemptedAt: new Date().toISOString() });
      return json(request, result, result.status === "email_failed" ? 502 : 200);
    }
    return json(request, { error: "Not found" }, 404);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request) });
    if (request.method === "POST" && url.pathname === "/scan") {
      try {
        const body = await request.json();
        const root = validateUrl(body.url);
        const id = randomToken();
        const token = randomToken();
        const stub = env.SCAN_JOBS.get(env.SCAN_JOBS.idFromName(id));
        const state = { id, token, url: root.href, status: "queued", createdAt: new Date().toISOString() };
        await stub.fetch("https://job/", { method: "POST", headers: { "Content-Type": "application/json", "X-Scan-Token": token }, body: JSON.stringify(state) });
        ctx.waitUntil(stub.fetch("https://job/run", { method: "POST", headers: { "X-Scan-Token": token } }));
        return json(request, { id, token, status: "queued" }, 202);
      } catch (error) { return json(request, { error: error.message }, 400); }
    }
    if (request.method === "POST" && url.pathname === "/handoff") {
      try {
        const body = await request.json();
        const id = randomToken();
        const token = randomToken();
        const stub = env.SCAN_JOBS.get(env.SCAN_JOBS.idFromName(id));
        const state = { id, token, kind: "handoff", status: "ready", createdAt: new Date().toISOString(), businessUrl: body.businessUrl || null, summary: String(body.summary || "").slice(0, 30000), transcript: String(body.transcript || "").slice(0, 30000) };
        await stub.fetch("https://job/", { method: "POST", headers: { "Content-Type": "application/json", "X-Scan-Token": token }, body: JSON.stringify(state) });
        return json(request, { id, token, status: "ready" }, 201);
      } catch (error) { return json(request, { error: error.message }, 400); }
    }
    if (request.method === "POST" && url.pathname === "/webhooks/calcom") {
      if (!env.WEBHOOK_SECRET || request.headers.get("X-Webhook-Secret") !== env.WEBHOOK_SECRET) return json(request, { error: "Unauthorized" }, 401);
      const payload = await request.json();
      const id = handoffFromBooking(payload);
      if (!id) return json(request, { status: "no_handoff_id" });
      const stub = env.SCAN_JOBS.get(env.SCAN_JOBS.idFromName(id));
      return stub.fetch(new Request("https://job/email", { method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Secret": env.WEBHOOK_SECRET }, body: JSON.stringify(payload.payload || payload) }));
    }
    const handoffDelete = url.pathname.match(/^\/handoff\/([a-f0-9]+)$/);
    if (request.method === "DELETE" && handoffDelete) {
      const token = request.headers.get("X-Scan-Token") || url.searchParams.get("token") || "";
      const stub = env.SCAN_JOBS.get(env.SCAN_JOBS.idFromName(handoffDelete[1]));
      return stub.fetch(new Request("https://job/", { method: "DELETE", headers: { "X-Scan-Token": token, "Origin": request.headers.get("Origin") || "" } }));
    }
    const match = url.pathname.match(/^\/scan\/([a-f0-9]+)$/);
    if (request.method === "GET" && match) {
      const token = request.headers.get("X-Scan-Token") || url.searchParams.get("token");
      const stub = env.SCAN_JOBS.get(env.SCAN_JOBS.idFromName(match[1]));
      return stub.fetch(new Request("https://job/", { headers: { "X-Scan-Token": token || "", "Origin": request.headers.get("Origin") || "" } }));
    }
    return json(request, { error: "Not found" }, 404);
  }
};
