LiveKit Agents (the `livekit/agents` repo) is a framework for building **real‑time conversational agents**—usually voice-first—inside a LiveKit room. Conceptually, it’s a pipeline that takes **audio from a participant**, turns it into **text**, feeds it into an **LLM that can call tools**, and turns the response back into **audio** (and/or text), all while handling turn-taking in real time.

Below is a “once through” explanation of what it does and what each major component is for.

---

## 1) What the framework does (end-to-end)
At runtime, you typically run a worker process that:

1. **Joins a LiveKit Room** (like a meeting room).
2. Subscribes to a user’s **audio track** (microphone).
3. Runs **VAD** to detect when the user starts/stops speaking.
4. Streams or sends detected speech to **STT** to produce transcripts.
5. Maintains a conversation/session state (`AgentSession`) and passes user turns to an **Agent** (LLM-driven).
6. The agent generates a response (may include **tool calls** / function calls).
7. Converts the agent response to speech with **TTS**.
8. Publishes the agent’s audio back into the room as the assistant voice.

This loop repeats for each turn, with mechanisms for interruption (“barge-in”), timing, and multi-agent handoffs.

---

## 2) Core runtime objects and responsibilities

### A) `AgentSession`
This is the “conversation runtime” container. It wires together:
- VAD (speech segmentation)
- STT (transcription)
- LLM (reasoning + text generation + tool calling)
- TTS (speech synthesis)
- shared `userdata` (your app state)
- the current active `Agent`

It also:
- manages the lifecycle (start/stop)
- routes events (user spoke, transcript ready, agent reply)
- controls how replies are generated (`session.generate_reply(...)`)
- handles which agent is active (especially in handoff flows)

Think of `AgentSession` as: **the engine**.

---

### B) `Agent`
An `Agent` is your conversational “brain and policy” for a particular role or stage.

An agent defines:
- **instructions** (system prompt) and optional `chat_ctx`
- lifecycle hooks (commonly `on_enter`, `on_exit`)
- optional event hooks (e.g., transcript or message callbacks depending on version)
- **tools** using `@function_tool` (functions the LLM can call)

When you call:
- `self.session.generate_reply(...)`

…the session asks the LLM to produce the next assistant response, grounded in:
- the agent instructions
- conversation history
- any extra per-call instructions you provide

---

### C) Tools / Function calling (`@function_tool`)
A `@function_tool` is a Python function exposed to the LLM. The model can call it to:
- write structured data into `context.userdata`
- trigger side effects (API calls, DB writes, etc.)
- return structured outputs

**Multi-agent handoff** is a special pattern:
- A tool returns `(next_agent, handoff_message)`
- The session switches active control to `next_agent`
- The `handoff_message` is spoken immediately (or treated as the next assistant output)

This is how the repo’s “multi-agent” example works.

---

## 3) Audio/Realtime pipeline components

### A) VAD (Voice Activity Detection)
**Purpose:** detect *when* the user is speaking vs silence/background noise.

Why it matters:
- defines turn boundaries (when to start/stop transcribing)
- reduces STT cost/latency by only transcribing speech
- improves UX (assistant doesn’t interrupt; knows when user finished)

In examples, you often see:
- `silero.VAD.load()`  
Silero is a common lightweight VAD model.

VAD output typically produces events like:
- speech started
- speech ended
- (sometimes) probability of speech per audio frame

---

### B) STT (Speech-to-Text)
**Purpose:** convert user audio into text.

Common providers:
- Deepgram, Whisper, etc.

How it’s used:
- after VAD segments speech, the segment is sent/streamed to STT
- STT returns transcripts (partial and/or final)
- final transcript becomes the “user message” for the agent

STT quality affects:
- correctness of content
- whether your switching logic triggers properly (e.g., “I’m done” must be recognized)

---

### C) LLM
**Purpose:** decide what to say next, optionally call tools, and generate text responses.

In LiveKit Agents, LLM can be:
- standard chat completion models (fast, cost-effective)
- realtime models (low-latency streaming, sometimes better voice timing)

The LLM consumes:
- agent instructions
- chat history/context
- any per-turn instructions
- tool schemas

The LLM produces:
- assistant text tokens
- tool calls with arguments (if needed)

---

### D) TTS (Text-to-Speech)
**Purpose:** convert the agent’s text response into audio to play in the room.

TTS choice affects:
- latency (time-to-first-audio)
- naturalness
- barge-in behavior (can we cancel cleanly mid-utterance?)

---

## 4) LiveKit Room / RTC layer
This is the underlying real-time communication system:

- The user is in a LiveKit room (web/mobile app).
- Your agent worker joins the same room as a participant.
- It subscribes to user audio tracks and publishes assistant audio tracks.

This separation is powerful:
- Your agent can run anywhere (server).
- Your front-end can be a thin client.

---

## 5) “Stable performance” considerations in this framework
The main sources of instability are:
- **double replies** (calling `generate_reply` twice concurrently)
- **tool-call loops** (LLM repeatedly calls the same tool)
- **handoff races** (timer triggers while normal transition triggers)
- **barge-in conflicts** (user starts speaking during TTS)

Stability comes from:
- single “active agent” producing output
- explicit state flags in `userdata` (e.g., `handoff_done`)
- canceling timers on `on_exit`
- strict rules about when you call `generate_reply`

---

## 6) How your two-stage interview maps onto this
- Stage 1 = `SelfIntroAgent`  
  - collects info
  - calls a handoff tool returning `PastExperienceAgent`
- Stage 2 = `PastExperienceAgent`  
  - asks project/story questions
- Fallback timers live in Stage 1 (or session-level) and eventually force the tool call/handoff.

---
