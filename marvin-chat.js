import { Conversation } from "https://esm.sh/@elevenlabs/client@1.28.0";

const config = window.LAAS_CONFIG || {};
const agentId = config.marvinAgentId;
const choice = document.querySelector("[data-modality-choice]");
const status = document.querySelector("[data-conversation-status]");
const transcript = document.querySelector("[data-transcript]");
const composer = document.querySelector("[data-composer]");
const textarea = composer?.querySelector("textarea");
const sendButton = composer?.querySelector("button");
const endButton = document.querySelector("[data-end-session]");
const feedback = document.querySelector("[data-conversation-feedback]");
const scanStatus = document.querySelector("[data-site-scan-status]");
const saveHandoffButton = document.querySelector("[data-save-handoff]");
const memberReturn = document.querySelector("[data-member-return]");

let conversation = null;
let textSocket = null;
let activeModality = null;
let pendingModality = null;
let conversationStarted = false;
let openingMessageSeen = false;
let scanStarted = false;
let scanDelivered = false;
let businessUrl = null;
const transcriptLog = [];

function setStatus(message) {
  if (status) status.textContent = message;
}

function appendMessage(source, text) {
  if (!text || !transcript) return;
  transcriptLog.push({ source, text: String(text).slice(0, 8000), at: new Date().toISOString() });
  const bubble = document.createElement("div");
  bubble.className = `message ${source === "user" ? "user" : "assistant"}`;
  bubble.textContent = text;
  transcript.appendChild(bubble);
  transcript.scrollTop = transcript.scrollHeight;
}

function isConfiguredOpening(text) {
  const normalized = String(text || "").toLowerCase();
  return normalized.includes("taking more work than it should") || normalized.includes("business website url") || (normalized.includes("what does your business do") && normalized.includes("harder than it should"));
}

function setComposerEnabled(enabled) {
  if (textarea) textarea.disabled = !enabled;
  if (sendButton) sendButton.disabled = !enabled;
}

function track(name, props = {}) {
  window.fathom?.trackEvent(name, props);
}

function setScanStatus(message) {
  if (scanStatus) scanStatus.textContent = message;
}

function normalizeBusinessUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  url.hash = "";
  return url.href;
}

function updateBookingLink(id) {
  document.querySelectorAll("[data-cta]").forEach((link) => {
    const url = new URL(link.href, window.location.href);
    url.searchParams.set("marvin_handoff_id", id);
    url.searchParams.set("metadata[marvin_handoff_id]", id);
    link.href = url.href;
  });
}

async function saveHandoff() {
  if (!config.scannerEndpoint || !transcriptLog.length) return;
  saveHandoffButton?.setAttribute("disabled", "disabled");
  if (saveHandoffButton) saveHandoffButton.textContent = "Saving private briefing…";
  try {
    const response = await fetch(`${config.scannerEndpoint}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessUrl,
        summary: transcriptLog.map(item => `${item.source.toUpperCase()}: ${item.text}`).join("\n\n"),
        transcript: JSON.stringify(transcriptLog)
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The briefing could not be saved.");
    localStorage.setItem("marvin_handoff_id", result.id);
    localStorage.setItem("marvin_handoff_token", result.token);
    updateBookingLink(result.id);
    if (saveHandoffButton) saveHandoffButton.textContent = "Briefing saved for booking.";
    setStatus("Private briefing saved. Your booking link now carries the handoff reference.");
  } catch (error) {
    console.error("Marvin handoff save failed", error);
    if (saveHandoffButton) { saveHandoffButton.removeAttribute("disabled"); saveHandoffButton.textContent = "Retry saving this briefing"; }
    setStatus("The briefing could not be saved yet. You can still continue the conversation.");
  }
}

function sendToMarvin(text) {
  if (textSocket?.readyState === WebSocket.OPEN) textSocket.send(JSON.stringify({ type: "user_message", text }));
  else conversation?.sendUserMessage(text);
}

function compactProfile(profile) {
  return profile.pages.slice(0, 12).map(page => [
    `SOURCE: ${page.url}`,
    page.title ? `TITLE: ${page.title}` : "",
    page.description ? `DESCRIPTION: ${page.description}` : "",
    page.headings?.length ? `HEADINGS: ${page.headings.join(" | ")}` : "",
    `PUBLIC TEXT: ${(page.text || "").slice(0, 1400)}`
  ].filter(Boolean).join("\n")).join("\n\n").slice(0, 24000);
}

async function scanBusinessSite(businessUrl) {
  const endpoint = config.scannerEndpoint;
  if (!endpoint || scanStarted) return;
  scanStarted = true;
  setScanStatus("Reading the public site in the background while Marvin asks about the pain.");
  try {
    const response = await fetch(`${endpoint}/scan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: businessUrl }) });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || "The site scan could not start.");
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 4000));
      const stateResponse = await fetch(`${endpoint}/scan/${job.id}?token=${encodeURIComponent(job.token)}`);
      const state = await stateResponse.json();
      if (state.status === "scanning") setScanStatus(`Reading public pages… ${state.pagesScanned || 0} scanned.`);
      if (state.status === "complete") {
        scanDelivered = true;
        setScanStatus(`Public context ready: ${state.profile?.usablePages || 0} pages read. Marvin will focus next on what the site cannot tell us.`);
        sendToMarvin(`The public website scan is ready. Treat this as source-bounded context, not verified business truth. Use it to avoid asking easily scrapable questions. Focus the next questions on the owner's current pain, recent concrete failures, recurring manual work, handoffs, constraints, delays, customer friction, and desired improvement. Ask for correction when needed.\n\n${compactProfile(state.profile)}`);
        return;
      }
      if (state.status === "error") throw new Error(state.error || "The site scan failed.");
    }
    throw new Error("The scan is still running. Marvin can continue with the conversation while it finishes.");
  } catch (error) {
    console.error("Marvin site scan failed", error);
    setScanStatus("The public scan could not finish. Marvin will continue with what you tell him directly.");
  }
}

async function startSession(modality) {
  if (!agentId || conversation || textSocket) return;
  activeModality = modality;
  choice?.querySelectorAll("[data-start-modality]").forEach((button) => { button.disabled = true; });
  setStatus(modality === "voice" ? "Connecting voice… allow microphone access when asked." : "Connecting text chat…");
  track("Marvin Modality Selected");

  try {
    if (modality === "text") {
      startTextSession();
      return;
    }
    conversation = await Conversation.startSession({
      agentId,
      connectionType: "webrtc",
      onConnect: () => {
        conversationStarted = true;
        openingMessageSeen = false;
        setStatus(modality === "voice" ? "Voice connected. Start talking." : "Connected. Send Marvin a message.");
        setComposerEnabled(modality === "text");
        if (endButton) endButton.hidden = false;
        track("Marvin Conversation Started");
      },
      onMessage: (message) => {
        const text = message?.message || message?.text;
        if (message?.source === "user") {
          const detectedUrl = normalizeBusinessUrl(text);
          if (detectedUrl && !scanStarted) { businessUrl = detectedUrl; scanBusinessSite(detectedUrl); }
          if (text) appendMessage("user", text);
          return;
        }
        if (!text) return;
        if (!openingMessageSeen && isConfiguredOpening(text)) {
          openingMessageSeen = true;
          return;
        }
        appendMessage("assistant", text);
      },
      onError: (error) => {
        console.error("Marvin conversation error", error);
        setStatus("The conversation hit an error. You can try text chat instead.");
        setComposerEnabled(false);
      },
      onDisconnect: () => {
        conversation = null;
        setStatus("Conversation ended. You can start another one.");
        setComposerEnabled(false);
        if (endButton) endButton.hidden = true;
        if (feedback) feedback.hidden = false;
        if (memberReturn && new URLSearchParams(window.location.search).get("member")) memberReturn.hidden = false;
        if (pendingModality) {
          const nextModality = pendingModality;
          pendingModality = null;
          setTimeout(() => startSession(nextModality), 250);
        }
      }
    });
  } catch (error) {
    console.error("Marvin session failed", error);
    conversation = null;
    setStatus("Marvin could not connect. Try text chat, or use the paid engagement below.");
    choice?.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    setComposerEnabled(false);
  }
}

function startTextSession() {
  textSocket = new WebSocket(`wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`);
  textSocket.addEventListener("open", () => {
    conversationStarted = true;
    openingMessageSeen = false;
    setStatus("Connected. Send Marvin a message.");
    setComposerEnabled(true);
    if (endButton) endButton.hidden = false;
    track("Marvin Conversation Started");
  });
  textSocket.addEventListener("message", (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.type === "agent_response") {
      const text = payload.agent_response_event?.agent_response;
      if (!openingMessageSeen && isConfiguredOpening(text)) { openingMessageSeen = true; return; }
      appendMessage("assistant", text);
    }
  });
  textSocket.addEventListener("error", (error) => {
    console.error("Marvin text conversation error", error);
    setStatus("The text conversation hit an error. You can try again or use the paid engagement below.");
    setComposerEnabled(false);
  });
  textSocket.addEventListener("close", () => {
    textSocket = null;
    setStatus("Conversation ended. You can start another one.");
    setComposerEnabled(false);
    if (endButton) endButton.hidden = true;
    if (feedback) feedback.hidden = false;
    if (memberReturn && new URLSearchParams(window.location.search).get("member")) memberReturn.hidden = false;
    if (pendingModality) {
      const nextModality = pendingModality;
      pendingModality = null;
      setTimeout(() => startSession(nextModality), 250);
    }
  });
}

function switchModality(modality) {
  if (modality === activeModality) return;
  pendingModality = modality;
  if (textSocket) textSocket.close();
  if (conversation) conversation.endSession();
}

document.querySelectorAll("[data-start-modality]").forEach((button) => {
  button.addEventListener("click", () => startSession(button.dataset.startModality));
});

document.querySelectorAll("[data-switch-modality]").forEach((button) => {
  button.addEventListener("click", () => switchModality(button.dataset.switchModality));
});

composer?.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textarea?.value.trim();
  if (!text || activeModality !== "text" || (!conversation && !textSocket)) return;
  appendMessage("user", text);
  textarea.value = "";
  const detectedUrl = normalizeBusinessUrl(text);
  if (detectedUrl) businessUrl = detectedUrl;
  if (detectedUrl && !scanStarted) {
    appendMessage("assistant", "I’ll read the public site while we talk. What pain are you experiencing in the business right now?");
    sendToMarvin(`Business website URL: ${detectedUrl}. Start by asking about the pain I am currently experiencing while the public site is scanned.`);
    scanBusinessSite(detectedUrl);
    return;
  }
  sendToMarvin(text);
});

endButton?.addEventListener("click", () => {
  textSocket?.close();
  conversation?.endSession();
});

document.querySelectorAll("[data-feedback]").forEach((button) => {
  button.addEventListener("click", () => {
    track("Marvin Conversation Feedback");
    if (feedback) feedback.textContent = "Thanks. That feedback is part of how we improve the listening loop.";
  });
});

document.querySelector("[data-request-summary]")?.addEventListener("click", (event) => {
  if (!conversation && !textSocket) return;
  sendToMarvin("Please prepare a concise readback with: public business context; owner-reported pain; current work; possible improvement; confidence; unknowns; and the smallest next step. Ask me to correct it before treating it as accurate.");
  event.currentTarget.textContent = "Summary requested — review Marvin's readback above.";
  if (saveHandoffButton) saveHandoffButton.hidden = false;
});

saveHandoffButton?.addEventListener("click", saveHandoff);

if (!agentId) {
  setStatus("Marvin is not configured yet. Use the paid engagement below while we finish the free conversation.");
} else if (!conversationStarted) {
  setStatus("Choose a modality to begin.");
}

if (document.querySelector("[data-auto-start-modality]")) {
  startSession(document.querySelector("[data-auto-start-modality]").dataset.autoStartModality);
}
