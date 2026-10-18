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

let conversation = null;
let textSocket = null;
let activeModality = null;
let conversationStarted = false;
let openingMessageSeen = false;

function setStatus(message) {
  if (status) status.textContent = message;
}

function appendMessage(source, text) {
  if (!text || !transcript) return;
  const bubble = document.createElement("div");
  bubble.className = `message ${source === "user" ? "user" : "assistant"}`;
  bubble.textContent = text;
  transcript.appendChild(bubble);
  transcript.scrollTop = transcript.scrollHeight;
}

function isConfiguredOpening(text) {
  const normalized = String(text || "").toLowerCase();
  return normalized.includes("what does your business do") && normalized.includes("harder than it should");
}

function setComposerEnabled(enabled) {
  if (textarea) textarea.disabled = !enabled;
  if (sendButton) sendButton.disabled = !enabled;
}

function track(name, props = {}) {
  window.fathom?.trackEvent(name, props);
}

async function startSession(modality) {
  if (!agentId || conversation) return;
  activeModality = modality;
  choice?.querySelectorAll("button").forEach((button) => { button.disabled = true; });
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
        if (message?.source === "user") return;
        const text = message?.message || message?.text;
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
  });
}

document.querySelectorAll("[data-start-modality]").forEach((button) => {
  button.addEventListener("click", () => startSession(button.dataset.startModality));
});

composer?.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textarea?.value.trim();
  if (!text || activeModality !== "text" || (!conversation && !textSocket)) return;
  appendMessage("user", text);
  textarea.value = "";
  if (textSocket?.readyState === WebSocket.OPEN) {
    textSocket.send(JSON.stringify({ type: "user_message", text }));
  } else {
    conversation?.sendUserMessage(text);
  }
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

if (!agentId) {
  setStatus("Marvin is not configured yet. Use the paid engagement below while we finish the free conversation.");
} else if (!conversationStarted) {
  setStatus("Choose a modality to begin.");
}
