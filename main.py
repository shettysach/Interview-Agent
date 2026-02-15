"""
Text-only 2-stage multi-agent handoff demo for LiveKit Agents.

What it does:
- Runs inside a LiveKit room using data-channel chat (no VAD/STT/TTS).
- Stage 1: Self-introduction agent collects a few details.
- Handoff to Stage 2: Past-experience agent via @function_tool returning next agent.
- Time-based fallback: if Stage 1 doesn't handoff within a deadline, it forces a
  transition by instructing the model to call the handoff tool.

Requirements:
- LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (worker connects to LiveKit)
- OPENAI_API_KEY (LLM)

Run:
1) Put env vars in .env or environment
2) python text_only_two_stage.py
3) Join the LiveKit room with any chat-capable client and send messages
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional

from dotenv import load_dotenv

from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    RunContext,
    cli,
)
from livekit.agents.llm import function_tool
from livekit.plugins import google

logger = logging.getLogger("text-only-two-stage")

load_dotenv()

SELF_INTRO_MAX_SECONDS = 60.0


@dataclass
class InterviewData:
    stage: str = "self_intro"
    handoff_done: bool = False

    name: Optional[str] = None
    current_role: Optional[str] = None
    intro_summary: Optional[str] = None

    self_intro_deadline_at: float = 0.0


class SelfIntroAgent(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are an interview assistant in a TEXT-ONLY chat.\n"
                "Stage 1: Self-introduction.\n"
                "Ask the user to introduce themselves (name + current role) and one highlight.\n"
                "Ask one question at a time.\n"
                "When you have enough info, call the tool self_intro_complete.\n"
                "Do not call the tool more than once."
            )
        )
        self._deadline_task: asyncio.Task | None = None

    async def on_enter(self):
        ud: InterviewData = self.session.userdata
        ud.stage = "self_intro"
        ud.self_intro_deadline_at = time.time() + SELF_INTRO_MAX_SECONDS

        self._deadline_task = asyncio.create_task(self._deadline_fallback())

        # Kick off with an initial message
        self.session.generate_reply(
            instructions="Greet the user and ask them to introduce themselves."
        )

    async def on_exit(self):
        if self._deadline_task and not self._deadline_task.done():
            self._deadline_task.cancel()

    async def _deadline_fallback(self):
        ud: InterviewData = self.session.userdata
        delay = max(0.0, ud.self_intro_deadline_at - time.time())
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return

        if ud.handoff_done or ud.stage != "self_intro":
            return

        # Force progress by prompting the model to call the tool now.
        self.session.generate_reply(
            instructions=(
                "We need to keep the interview moving. Summarize the self-introduction "
                "based on what's available, then call self_intro_complete with best-effort "
                "values (use null if unknown)."
            )
        )

    @function_tool
    async def self_intro_complete(
        self,
        context: RunContext[InterviewData],
        name: Optional[str] = None,
        current_role: Optional[str] = None,
        intro_summary: Optional[str] = None,
    ):
        """
        Handoff tool: call when Stage 1 is complete.
        Returns (PastExperienceAgent, bridge_message).
        """
        ud: InterviewData = context.userdata

        if ud.handoff_done:
            return None, "Continuing."

        ud.handoff_done = True
        ud.stage = "past_experience"
        ud.name = name or ud.name
        ud.current_role = current_role or ud.current_role
        ud.intro_summary = intro_summary or ud.intro_summary

        logger.info("Handoff to PastExperienceAgent: %s", ud)

        return (
            PastExperienceAgent(),
            "Thanks. Now let’s switch to past experience: tell me about one project "
            "you’re proud of, what you did, and what impact it had.",
        )


class PastExperienceAgent(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are an interview assistant in a TEXT-ONLY chat.\n"
                "Stage 2: Past experience.\n"
                "Ask the user for one project/story. Then ask up to two follow-ups:\n"
                "1) measurable impact, 2) a challenge/tradeoff.\n"
                "Be concise and avoid repetition."
            )
        )

    async def on_enter(self):
        self.session.generate_reply(
            instructions=(
                "Ask the user to describe a past project they significantly contributed to."
            )
        )


server = AgentServer()


def prewarm(proc: JobProcess):
    # Nothing needed for text-only, but we keep this for consistency with examples.
    proc.userdata["ready"] = True


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    # Text-only session: no vad/stt/tts.
    session = AgentSession[InterviewData](
        llm=google.LLM(model="gemini-2.5-flash"),
        userdata=InterviewData(),
    )

    await session.start(
        agent=SelfIntroAgent(),
        room=ctx.room,
    )


if __name__ == "__main__":
    cli.run_app(server)
