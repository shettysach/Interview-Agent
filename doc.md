# Take‑Home Design Doc: LiveKit Agents Multi‑Agent Mock Interview (2 Stages)

## 1. Overview
This project implements a two-stage AI mock interview using LiveKit Agents’ **multi-agent handoff** pattern:

1) **Self‑Introduction**  
2) **Past Experience**

The system must provide:
- stable performance with clear interaction logic
- smooth, natural transitions between stages
- no interruptions, conflicts, or repetitive prompts
- a **time-based fallback** ensuring progress if normal switching logic is not triggered

The design uses **one active agent at a time** and performs stage transitions via LiveKit’s recommended **tool-based agent handoff** (returning the next agent from a `@function_tool`).

---

## 2. Goals
### Functional goals
- Implement Self‑Introduction and Past‑Experience stages as distinct agents.
- Provide a reliable handoff from stage 1 → stage 2.
- Ensure the conversation progresses even if:
  - the user is silent,
  - the model does not call the transition tool,
  - the user responses are rambling or ambiguous.

### Interaction goals
- Natural stage transitions with a short “bridge” message.
- No overlapping speech (no two agents speaking at once).
- Avoid repetitive prompts; reprompt is allowed only in controlled cases (e.g., silence).

### Reliability goals
- Exactly-once stage transition (no double handoffs).
- Deterministic fallback behavior governed by explicit timers/thresholds.
- Observability through structured logging of stage/time events.

---

## 3. Non‑Goals
- Scoring, grading, or generating a full interview report (optional future).
- Supporting unlimited stages; only two stages are required.
- Handling complex multimodal inputs beyond voice/text (out of scope unless required).
- “Multi-agent debate” where multiple agents talk concurrently (explicitly avoided to prevent conflicts).

---

## 4. System Architecture

### 4.1 Components
**A) LiveKit Room + AgentSession**
- Provides audio input/output pipeline (VAD → STT → LLM → TTS).
- Maintains a single “active agent” at any moment.
- Routes user utterances to the active agent and plays agent responses.

**B) SelfIntroAgent (Stage 1)**
- Collects minimal intro data (e.g., name, current role, experience highlights).
- Runs stage-specific prompts.
- Triggers handoff to Stage 2 via a tool call (e.g., `self_intro_complete`).

**C) PastExperienceAgent (Stage 2)**
- Asks for one specific project/story and follow-ups (STAR-style).
- Keeps questions concise and non-repetitive.
- Ends after collecting a coherent story (or optionally hands off to a Done agent).

**D) Shared Interview State (UserData)**
A single state object shared across agents, containing:
- current stage
- extracted user info (name/role/summary)
- timers/threshold bookkeeping (stage start time, last activity)
- repetition guards (asked prompts / reprompt counts)
- a transition safety flag (`handoff_done`) for exactly-once handoff

**E) Transition Policy (logical controller)**
Defines:
- normal completion criteria for stage 1
- fallback triggers (time-based and idle-based)
- “exactly once” transition rule

This policy can live inside the stage 1 agent plus shared state.

---

## 5. State Machine

### 5.1 States
- `SELF_INTRO`
- `PAST_EXPERIENCE`
- `DONE`

### 5.2 Transitions
**SELF_INTRO → PAST_EXPERIENCE**
Triggered by:
1) **Normal completion** (preferred): stage 1 agent calls a tool once it has enough information, or
2) **Fallback completion** (guarantee): time-based deadline or idle escalation triggers forced transition.

**PAST_EXPERIENCE → DONE**
Triggered when:
- user provides a complete story + key details (impact/tradeoff),
- or a maximum follow-up limit is reached (to avoid loops).

---

## 6. Stage Behavior and Prompts

### 6.1 Self‑Introduction Stage (Stage 1)
**Purpose:** Quickly establish who the candidate is.

**Data to capture (minimum viable):**
- current role (required)
- one highlight / area of strength (required)
- optional: name, years of experience, target role

**Prompt strategy:**
- ask one question at a time
- keep responses short and conversational
- avoid long multi-part questions

**Normal completion heuristics:**
Transition if any of the following is true:
- minimum data threshold met (e.g., role + highlight)
- user indicates completion (“that’s my background”)
- maximum turns reached (e.g., 2–3 turns in stage 1)

**Handoff behavior:**
- store a short intro summary in shared state
- return PastExperienceAgent with a bridging message:
  - acknowledgment + clear stage shift + next question

### 6.2 Past‑Experience Stage (Stage 2)
**Purpose:** Elicit one strong example of impact.

**Prompt strategy:**
- ask user to pick one project they’re proud of
- follow-ups focus on:
  - actions/decisions
  - measurable impact
  - constraints/tradeoffs
- cap follow-ups (e.g., max 2) to avoid repetitive probing

**Completion:**
- end after a coherent STAR-like response is obtained, or after max turns/time.

---

## 7. Transition Logic Details

### 7.1 Exactly-once handoff rule
Both normal logic and fallback can attempt to transition. To prevent double transitions:
- Use a shared boolean `handoff_done`.
- Any transition attempt must:
  - check `handoff_done` first
  - if false, set to true and proceed
  - if true, do nothing (no-op)

This avoids:
- repeated bridge messages
- two agents fighting for control
- re-entering the same stage

### 7.2 No interruptions / conflicts
- Only the **active agent** can speak.
- No parallel agent responses are emitted.
- If user barges in (speaks during TTS):
  - stop TTS output
  - prioritize user input
  - do not replay the interrupted prompt verbatim

### 7.3 Anti-repetition guardrails
Shared state tracks:
- prompt IDs asked in each stage
- reprompt count (max 1 reprompt per prompt)
Rules:
- never ask the exact same prompt twice unless in a silence-reprompt scenario
- if reprompt fails, simplify or transition rather than looping

---

## 8. Time‑Based Fallback Mechanism (Guarantee)

### 8.1 Stage deadline fallback (hard guarantee)
Self‑Intro stage has a hard deadline \(T\) (example 60–120 seconds).
If stage time exceeds \(T\) and `handoff_done` is still false:
- force transition to Past‑Experience
- use best-effort summary (“Based on what I heard…”)
- continue to stage 2

### 8.2 Idle escalation fallback (silence handling)
If user does not respond:
- after \(t_1\) seconds: gentle reprompt (once)
- after \(t_2\) seconds: proceed anyway (either ask a simpler question or transition if close to deadline)

### 8.3 Fallback integration with tool-based handoff
To keep handoff consistent and safe:
- normal and fallback transitions should converge on the same handoff mechanism
- fallback must still respect exactly-once transition rule

---

## 9. Observability & Debugging (Stability Evidence)

### 9.1 Event logging (structured)
Log events with timestamps:
- stage enter/exit
- prompt issued (with prompt ID)
- user turn received
- timer started/fired/canceled
- tool invoked
- handoff completed
- fallback invoked (deadline/idle)

### 9.2 Metrics (optional but helpful)
- stage durations
- number of reprompts
- number of barge-ins
- transition reason (normal vs fallback)

These demonstrate stable interaction logic to reviewers.

---

## 10. Failure Modes & Mitigations
**Failure: model never triggers handoff tool**  
Mitigation: stage deadline fallback forces progression.

**Failure: double handoff (timer + tool race)**  
Mitigation: `handoff_done` exactly-once guard.

**Failure: repetitive prompting**  
Mitigation: prompt ID tracking + reprompt caps.

**Failure: interruptions / overlapping audio**  
Mitigation: single active agent; barge-in cancels TTS.

**Failure: user silent**  
Mitigation: idle escalation ladder and eventual transition.

---

## 11. Acceptance Criteria
A demo is considered successful if:
- Stage 1 runs and gathers intro info.
- System transitions smoothly to Stage 2 with a clear bridge message.
- No repeated prompts occur under normal interaction.
- If user stalls (no “completion” trigger), the system still transitions using time-based fallback.
- No overlapping/competing agent outputs are observed.
- Logs clearly show transition reasons and timer behavior.
