const { Room, RoomEvent, createLocalAudioTrack } = LivekitClient;

let room = null;
let micTrack = null;
let micEnabled = false;

const statusEl = document.getElementById("status");
const connectForm = document.getElementById("connect-form");
const connectBtn = document.getElementById("connect-btn");
const urlInput = document.getElementById("livekit-url");
const tokenInput = document.getElementById("token");
const messagesEl = document.getElementById("messages");
const inputForm = document.getElementById("input-form");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const micBtn = document.getElementById("mic-btn");
const micIcon = document.getElementById("mic-icon");
const micOffIcon = document.getElementById("mic-off-icon");

function addMessage(content, isUser = false, sender = null) {
  const div = document.createElement("div");
  div.className = `message ${isUser ? "user" : "agent"}`;

  const senderDiv = document.createElement("div");
  senderDiv.className = "sender";
  senderDiv.textContent = sender || (isUser ? "You" : "Agent");

  const textDiv = document.createElement("div");
  textDiv.textContent = content;

  div.appendChild(senderDiv);
  div.appendChild(textDiv);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setConnected(connected) {
  statusEl.textContent = connected ? "Connected" : "Disconnected";
  statusEl.classList.toggle("connected", connected);
  messageInput.disabled = !connected;
  sendBtn.disabled = !connected;
  micBtn.disabled = !connected;
  connectBtn.textContent = connected ? "Disconnect" : "Connect";
  
  if (!connected) {
    setMicState(false);
  }
}

function setMicState(enabled) {
  micEnabled = enabled;
  micBtn.classList.toggle("active", enabled);
  micIcon.style.display = enabled ? "none" : "block";
  micOffIcon.style.display = enabled ? "block" : "none";
}

async function connect() {
  const url = urlInput.value.trim();
  const token = tokenInput.value.trim();

  if (!url || !token) {
    alert("Please enter LiveKit URL and token");
    return;
  }

  room = new Room();

  room.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
    const decoder = new TextDecoder();
    const text = decoder.decode(payload);
    
    try {
      const data = JSON.parse(text);
      if (data.text) {
        const isUser = participant?.identity === room.localParticipant?.identity;
        addMessage(data.text, isUser, participant?.identity || "Agent");
      }
    } catch {
      addMessage(text, false, participant?.identity || "Agent");
    }
  });

  room.registerTextStreamHandler("lk.transcription", async (reader, participantInfo) => {
    const message = await reader.readAll();
    const isFinal = reader.info.attributes["lk.transcription_final"] === "true";
    const transcribedTrackId = reader.info.attributes["lk.transcribed_track_id"];
    const segmentId = reader.info.attributes["lk.segment_id"];
    
    if (isFinal && message.trim()) {
      const isAgent = participantInfo?.identity?.includes("agent") || !transcribedTrackId;
      addMessage(message, !isAgent, participantInfo?.identity || (isAgent ? "Agent" : "You"));
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    setConnected(false);
    addMessage("Disconnected from room", false, "System");
  });

  try {
    await room.connect(url, token);
    setConnected(true);
    addMessage("Connected to interview room", false, "System");
  } catch (err) {
    console.error("Connection failed:", err);
    alert(`Connection failed: ${err.message}`);
    room = null;
  }
}

function disconnect() {
  if (micTrack) {
    micTrack.stop();
    micTrack = null;
  }
  if (room) {
    room.disconnect();
    room = null;
  }
  setConnected(false);
}

async function toggleMic() {
  if (!room) return;

  if (micEnabled) {
    if (micTrack) {
      await room.localParticipant.unpublishTrack(micTrack);
      micTrack.stop();
      micTrack = null;
    }
    setMicState(false);
    addMessage("Microphone disabled", false, "System");
  } else {
    try {
      micTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      await room.localParticipant.publishTrack(micTrack);
      setMicState(true);
      addMessage("Microphone enabled - speak now", false, "System");
    } catch (err) {
      console.error("Failed to enable microphone:", err);
      addMessage(`Mic error: ${err.message}`, false, "System");
    }
  }
}

connectBtn.addEventListener("click", () => {
  if (room) {
    disconnect();
  } else {
    connect();
  }
});

micBtn.addEventListener("click", toggleMic);

inputForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = messageInput.value.trim();
  if (!text || !room) return;

  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify({ text }));

  try {
    await room.localParticipant.publishData(data, { reliable: true });
    addMessage(text, true);
    messageInput.value = "";
  } catch (err) {
    console.error("Failed to send message:", err);
  }
});
