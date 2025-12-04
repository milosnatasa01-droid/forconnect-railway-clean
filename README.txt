# ForConnect Railway Deploy

## Steps
1. Upload this folder to Railway as a new project.
2. In Railway → Variables add:
   - OPENAI_API_KEY=yourkey
   - OPENAI_MODEL=gpt-4o-realtime-preview-latest
3. After Railway deploys, copy your domain:
   https://yourapp.up.railway.app

Set WS_ENDPOINT in Railway Variables:
WS_ENDPOINT=wss://yourapp.up.railway.app/media-stream

4. Update Twilio webhook:
A CALL COMES IN → Webhook:
https://yourapp.up.railway.app/incoming-call

5. Test call. AI will speak immediately.
