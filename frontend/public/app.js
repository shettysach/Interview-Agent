const { Room, RoomEvent, createLocalAudioTrack, createLocalVideoTrack, Track } = LivekitClient;

let room = null;
let micTrack = null;
let videoTrack = null;
let micEnabled = false;
let cameraEnabled = false;
let audioElement = null;
let pendingUserText = "";
let userMessageEl = null;

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
const stageIntro = document.getElementById("stage-intro");
const stageExperience = document.getElementById("stage-experience");
const stageDone = document.getElementById("stage-done");
const cameraBtn = document.getElementById("camera-btn");
const localVideo = document.getElementById("local-video");
const videoPlaceholder = document.getElementById("video-placeholder");

// Load saved URL from localStorage
const savedUrl = localStorage.getItem("livekit-url");
if (savedUrl) {
  urlInput.value = savedUrl;
}

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
  cameraBtn.disabled = !connected;
  
  // Hide/show connect form
  urlInput.style.display = connected ? "none" : "block";
  tokenInput.style.display = connected ? "none" : "block";
  connectBtn.textContent = connected ? "Disconnect" : "Connect";
  
  if (!connected) {
    setMicState(false);
    setCameraState(false);
  }
}

function setMicState(enabled) {
  micEnabled = enabled;
  micBtn.classList.toggle("active", enabled);
  micIcon.style.display = enabled ? "none" : "block";
  micOffIcon.style.display = enabled ? "block" : "none";
}

function setCameraState(enabled) {
  cameraEnabled = enabled;
  cameraBtn.classList.toggle("active", enabled);
  localVideo.classList.toggle("active", enabled);
  videoPlaceholder.classList.toggle("hidden", enabled);
}

function updateStage(stage) {
  // Reset all stages
  stageIntro.classList.remove("active", "completed");
  stageExperience.classList.remove("active", "completed");
  stageDone.classList.remove("active", "completed");

  if (stage === "self_intro") {
    stageIntro.classList.add("active");
  } else if (stage === "past_experience") {
    stageIntro.classList.add("completed");
    stageExperience.classList.add("active");
  } else if (stage === "done") {
    stageIntro.classList.add("completed");
    stageExperience.classList.add("completed");
    stageDone.classList.add("active");
  }
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
    
    // Handle stage updates
    if (topic === "stage") {
      try {
        const data = JSON.parse(text);
        if (data.stage) {
          updateStage(data.stage);
        }
      } catch {}
      return;
    }
    
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
    
    if (isFinal && message.trim()) {
      const isUser = participantInfo?.identity === room.localParticipant?.identity;
      
      if (isUser) {
        // Accumulate user speech into one message
        pendingUserText += (pendingUserText ? " " : "") + message.trim();
        
        if (userMessageEl) {
          // Update existing message
          userMessageEl.querySelector("div:last-child").textContent = pendingUserText;
        } else {
          // Create new message element
          userMessageEl = document.createElement("div");
          userMessageEl.className = "message user";
          
          const senderDiv = document.createElement("div");
          senderDiv.className = "sender";
          senderDiv.textContent = "You";
          
          const textDiv = document.createElement("div");
          textDiv.textContent = pendingUserText;
          
          userMessageEl.appendChild(senderDiv);
          userMessageEl.appendChild(textDiv);
          messagesEl.appendChild(userMessageEl);
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else {
        // Agent message - finalize any pending user message
        if (pendingUserText) {
          pendingUserText = "";
          userMessageEl = null;
        }
        addMessage(message, false, "Agent");
      }
    }
  });

  // Play agent audio when track is subscribed
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (track.kind === Track.Kind.Audio) {
      audioElement = track.attach();
      document.body.appendChild(audioElement);
      audioElement.play().catch(console.error);
    }
  });

  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      track.detach().forEach(el => el.remove());
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    setConnected(false);
    addMessage("Disconnected from room", false, "System");
  });

  try {
    // Save URL for next time
    localStorage.setItem("livekit-url", url);
    
    await room.connect(url, token);
    setConnected(true);
    
    // Auto-enable microphone for voice interview
    micTrack = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    await room.localParticipant.publishTrack(micTrack);
    setMicState(true);
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
  if (videoTrack) {
    videoTrack.stop();
    videoTrack = null;
  }
  if (room) {
    room.disconnect();
    room = null;
  }
  setConnected(false);
}

async function toggleCamera() {
  if (!room) return;

  if (cameraEnabled) {
    if (videoTrack) {
      await room.localParticipant.unpublishTrack(videoTrack);
      videoTrack.stop();
      videoTrack = null;
    }
    localVideo.srcObject = null;
    setCameraState(false);
  } else {
    try {
      videoTrack = await createLocalVideoTrack({
        facingMode: "user",
        resolution: { width: 640, height: 480 },
      });
      await room.localParticipant.publishTrack(videoTrack);
      localVideo.srcObject = new MediaStream([videoTrack.mediaStreamTrack]);
      setCameraState(true);
    } catch (err) {
      console.error("Failed to enable camera:", err);
      addMessage(`Camera error: ${err.message}`, false, "System");
    }
  }
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
  } else {
    try {
      micTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      await room.localParticipant.publishTrack(micTrack);
      setMicState(true);
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
cameraBtn.addEventListener("click", toggleCamera);

inputForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = messageInput.value.trim();
  if (!text || !room) return;

  try {
    // Send via lk.chat topic so agent receives it in context
    await room.localParticipant.sendText(text, { topic: "lk.chat" });
    addMessage(text, true, "You");
    messageInput.value = "";
  } catch (err) {
    console.error("Failed to send message:", err);
  }
});
