from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional

from dotenv import load_dotenv

from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    RunContext,
    cli,
    room_io,
)
from livekit.agents.llm import function_tool
from livekit.plugins import google, deepgram, silero
from livekit.plugins.turn_detector.english import EnglishModel

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

    room: rtc.Room | None = None

    async def broadcast_stage(self):
        """Send stage update to all participants."""
        if self.room and self.room.isconnected():
            data = f'{{"stage": "{self.stage}"}}'.encode()
            await self.room.local_participant.publish_data(
                data, reliable=True, topic="stage"
            )


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
        await ud.broadcast_stage()

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
        await ud.broadcast_stage()

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
                "Be concise and avoid repetition.\n"
                "When you have gathered enough details about impact and challenges, "
                "call the tool past_experience_complete."
            )
        )
        self._followup_count = 0

    async def on_enter(self):
        ud: InterviewData = self.session.userdata
        ud.stage = "past_experience"
        await ud.broadcast_stage()

        self.session.generate_reply(
            instructions=(
                "Ask the user to describe a past project they significantly contributed to."
            )
        )

    @function_tool
    async def past_experience_complete(
        self,
        context: RunContext[InterviewData],
        project_summary: Optional[str] = None,
    ):
        """
        Handoff tool: call when Stage 2 is complete.
        Returns (DoneAgent, closing_message).
        """
        ud: InterviewData = context.userdata
        ud.stage = "done"
        await ud.broadcast_stage()

        logger.info("Interview complete: %s", ud)

        return (
            DoneAgent(),
            "Thank you for sharing! That concludes our mock interview. "
            "You did great discussing your background and project experience.",
        )


class DoneAgent(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "The interview is complete. Thank the user and offer to answer "
                "any questions they have about the interview process."
            )
        )

    async def on_enter(self):
        ud: InterviewData = self.session.userdata
        ud.stage = "done"
        await ud.broadcast_stage()


server = AgentServer()


def prewarm(proc: JobProcess):
    # Nothing needed for text-only, but we keep this for consistency with examples.
    proc.userdata["ready"] = True


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    interview_data = InterviewData(room=ctx.room)

    session = AgentSession[InterviewData](
        llm=google.LLM(model="gemini-2.5-flash-lite"),
        stt=deepgram.STT(),
        tts=deepgram.TTS(),
        vad=silero.VAD.load(),
        turn_detection=EnglishModel(),
        min_endpointing_delay=1.0,
        max_endpointing_delay=6.0,
        userdata=interview_data,
    )

    await session.start(
        agent=SelfIntroAgent(),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            close_on_disconnect=False,
            text_output=room_io.TextOutputOptions(
                sync_transcription=False,
            ),
        ),
    )


if __name__ == "__main__":
    cli.run_app(server)
