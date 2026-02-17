import os
from livekit import api
from dotenv import load_dotenv

load_dotenv()
room = "demo"
identity = "meet-user"

token = (
    api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
    .with_identity(identity)
    .with_grants(
        api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True)
    )
    .to_jwt()
)

print(token)
