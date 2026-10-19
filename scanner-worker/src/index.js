const MAX_PAGES = 40;
const MAX_PAGE_CHARS = 12000;
const USER_AGENT = "MarvinBusinessContextScanner/0.1 (+https://www.leoasaservice.com/)";

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = new Set(["https://www.leoasaservice.com", "https://leoasaservice.com", "http://127.0.0.1:8765", "http://localhost:8765"]);
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : "https://www.leoasaservice.com",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Scan-Token, X-Webhook-Secret, X-Cal-Signature-256",
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
  if (handoff.email?.status === "email_accepted") return handoff.email;
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
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [env.EMAIL_TO], reply_to: env.REPLY_TO, subject, text })
  });
  if (!response.ok) return { status: "email_failed", providerStatus: response.status, providerBody: (await response.text()).slice(0, 300) };
  return { status: "email_accepted", provider: await response.json() };
}

async function verifyCalSignature(rawBody, signature, secret) {
  if (signature === "no-secret-provided") return true;
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return expected === signature;
}

function agentFrameHtml(handoff, id, token) {
  const context = JSON.stringify({ id, businessUrl: handoff.businessUrl || null, summary: handoff.summary || "", transcript: handoff.transcript || "" }).replaceAll("<", "\\u003c");
  const frame = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentFrame — BuildHop feedback operator</title><style>:root{color-scheme:dark;font:15px/1.45 system-ui,sans-serif}body{margin:0;background:#111;color:#eee}header{padding:14px 18px;border-bottom:1px solid #333}main{display:grid;grid-template-columns:360px 1fr;height:calc(100vh - 62px)}aside{padding:18px;border-right:1px solid #333;overflow:auto}iframe{width:100%;height:100%;border:0;background:#fff}textarea{width:100%;box-sizing:border-box;min-height:180px;background:#1b1b1b;color:#fff;border:1px solid #555;border-radius:8px;padding:10px}label{display:block;margin:14px 0 6px;color:#aaa}button{margin-top:12px;padding:10px 14px;border:0;border-radius:8px;cursor:pointer}.status{margin-top:14px;padding:10px;background:#1c2b3c;border-left:3px solid #7db7ff}.warning{color:#ffc978}</style></head><body><header><strong>AgentFrame</strong> — internal BuildHop feedback operator</header><main><aside><p class="warning">Internal agent surface. Feedback must be labeled as agent-generated and grounded in the member handoff.</p><p id="source"></p><label for="draft">Agent-generated feedback</label><textarea id="draft" placeholder="Draft from the handoff, then submit through the BuildHop frame."></textarea><label for="vote">Internal vote</label><select id="vote"><option value="up">Up</option><option value="down">Down</option></select><button id="receipt">Record submission receipt</button><div class="status" id="status">Load the frame, submit through BuildHop, then record the receipt.</div></aside><iframe title="BuildHop feedback frame" src="https://buildhop.io/embed/feedback/fe9fdb91-5a6a-4d47-ab83-183ff46f0308?theme=light"></iframe></main><script>const ctx=CONTEXT;document.querySelector('#source').textContent=ctx.businessUrl?'Business: '+ctx.businessUrl:'No business URL';document.querySelector('#draft').value=ctx.summary;window.addEventListener('message',e=>{if(e.origin==='https://buildhop.io'&&e.data?.type==='buildhop:feedback-ready')document.querySelector('#status').textContent='BuildHop frame ready. The agent can operate the form.'});document.querySelector('#receipt').onclick=async()=>{const body={id:ctx.id,token:TOKEN,feedback:document.querySelector('#draft').value.slice(0,12000),vote:document.querySelector('#vote').value,agentGenerated:true,recordedAt:new Date().toISOString()};const r=await fetch('/agentframe/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});document.querySelector('#status').textContent=r.ok?'Receipt recorded.':'Receipt failed.'};</script></body></html>`;
  return frame.replace('CONTEXT', context).replace('TOKEN', JSON.stringify(token));
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
    if (!internal && this.data?.expiresAt && Date.now() > Date.parse(this.data.expiresAt)) return json(request, { error: "Expired" }, 410);
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
    if (request.method === "POST" && url.pathname === "/receipt") {
      const body = await request.json();
      await this.save({ ...this.data, agentReceipt: { feedback: String(body.feedback || "").slice(0, 12000), vote: body.vote === "down" ? "down" : "up", agentGenerated: body.agentGenerated === true, recordedAt: body.recordedAt || new Date().toISOString() } });
      return json(request, { ok: true, recorded: true });
    }
    if (request.method === "POST" && url.pathname === "/feedback") {
      const body = await request.json();
      const review = {
        recognition: ["accurate", "mixed", "off"].includes(body.recognition) ? body.recognition : "unknown",
        correction: String(body.correction || "").slice(0, 12000),
        usefulness: ["yes", "maybe", "no"].includes(body.usefulness) ? body.usefulness : "unknown",
        note: String(body.note || "").slice(0, 6000),
        submittedAt: new Date().toISOString()
      };
      await this.save({ ...this.data, review });
      return json(request, { ok: true, recorded: true, reviewId: this.data.id });
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
        const state = { id, token, kind: "handoff", status: "ready", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), businessUrl: body.businessUrl || null, summary: String(body.summary || "").slice(0, 30000), transcript: String(body.transcript || "").slice(0, 30000) };
        await stub.fetch("https://job/", { method: "POST", headers: { "Content-Type": "application/json", "X-Scan-Token": token }, body: JSON.stringify(state) });
        return json(request, { id, token, status: "ready" }, 201);
      } catch (error) { return json(request, { error: error.message }, 400); }
    }
    if (request.method === "POST" && url.pathname === "/review") {
      try {
        const body = await request.json();
        const root = validateUrl(body.businessUrl);
        const id = randomToken();
        const token = randomToken();
        const stub = env.SCAN_JOBS.get(env.SCAN_JOBS.idFromName(id));
        const state = { id, token, kind: "site-review", status: "ready", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), businessUrl: root.href, source: String(body.source || "outreach").slice(0, 160), scanId: String(body.scanId || "").slice(0, 160), reading: String(body.reading || "").slice(0, 16000) };
        await stub.fetch("https://job/", { method: "POST", headers: { "Content-Type": "application/json", "X-Scan-Token": token }, body: JSON.stringify(state) });
        return json(request, { id, token, status: "ready" }, 201);
      } catch (error) { return json(request, { error: error.message }, 400); }
    }
    if (request.method === "GET" && url.pathname === "/agentframe") {
      const id = url.searchParams.get("handoff");
      const token = url.searchParams.get("token") || "";
      if (!id || !token) return new Response("Not found", { status: 404 });
      const stub = env.SCAN_JOBS.get(env.SCAN_JOBS.idFromName(id));
      const response = await stub.fetch(new Request("https://job/", { headers: { "X-Scan-Token": token } }));
      if (!response.ok) return new Response("Not found", { status: 404 });
      const handoff = await response.json();
      if (handoff.kind !== "handoff") return new Response("Not found", { status: 404 });
      return new Response(agentFrameHtml(handoff, id, token), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname.startsWith("/handoff/")) {
      const id = url.pathname.slice("/handoff/".length);
      const token = url.searchParams.get("token") || "";
      if (!/^[a-f0-9]+$/.test(id) || !token) return json(request, { error: "Not found" }, 404);
      const stub = env.SCAN_JOBS.get(env.SCAN_JOBS.idFromName(id));
      return stub.fetch(new Request("https://job/", { headers: { "X-Scan-Token": token, "Origin": request.headers.get("Origin") || "" } }));
    }
    if (request.method === "GET" && url.pathname.startsWith("/review/")) {
      const id = url.pathname.slice("/review/".length);
      const token = url.searchParams.get("token") || "";
      if (!/^[a-f0-9]+$/.test(id) || !token) return json(request, { error: "Not found" }, 404);
      const stub = env.SCAN_JOBS.get(env.SCAN_JOBS.idFromName(id));
      return stub.fetch(new Request("https://job/", { headers: { "X-Scan-Token": token, "Origin": request.headers.get("Origin") || "" } }));
    }
    if (request.method === "POST" && url.pathname === "/agentframe/receipt") {
      const body = await request.json();
      if (!body.id || !body.token) return json(request, { error: "Not found" }, 404);
      const stub = env.SCAN_JOBS.get(env.SCAN_JOBS.idFromName(body.id));
      return stub.fetch(new Request("https://job/receipt", { method: "POST", headers: { "Content-Type": "application/json", "X-Scan-Token": body.token, "Origin": request.headers.get("Origin") || "" }, body: JSON.stringify(body) }));
    }
    if (request.method === "POST" && url.pathname === "/review/feedback") {
      const body = await request.json();
      if (!body.id || !body.token) return json(request, { error: "Not found" }, 404);
      const stub = env.SCAN_JOBS.get(env.SCAN_JOBS.idFromName(body.id));
      return stub.fetch(new Request("https://job/feedback", { method: "POST", headers: { "Content-Type": "application/json", "X-Scan-Token": body.token, "Origin": request.headers.get("Origin") || "" }, body: JSON.stringify(body) }));
    }
    if (request.method === "POST" && url.pathname === "/webhooks/calcom") {
      const rawBody = await request.text();
      const internal = env.WEBHOOK_SECRET && request.headers.get("X-Webhook-Secret") === env.WEBHOOK_SECRET;
      const calSignature = request.headers.get("X-Cal-Signature-256");
      if (!internal && !(await verifyCalSignature(rawBody, calSignature, env.WEBHOOK_SECRET))) return json(request, { error: "Unauthorized" }, 401);
      let payload;
      try { payload = JSON.parse(rawBody); } catch { return json(request, { error: "Invalid JSON" }, 400); }
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
