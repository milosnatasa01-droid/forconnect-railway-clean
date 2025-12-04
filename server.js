import express from "express";
import http from "http";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();

// ====== CONFIG ======
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini-realtime-preview";
const OPENAI_VOICE = process.env.OPENAI_VOICE || "verse";
const WS_ENDPOINT = process.env.WS_ENDPOINT;

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY nije podešen");
  process.exit(1);
}

// ====== AUDIO CONSTANTS ======
const TWILIO_SAMPLE_RATE = 8000;
const OPENAI_SAMPLE_RATE = 24000;
const BIT_DEPTH = 16;

// ====== µ-LAW ENCODE/DECODE (bez x-law) ======
function muLawDecode(mu) {
  mu = ~mu & 0xff;
  const sign = mu & 0x80;
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 2);
  if (sign !== 0) sample = -sample;
  return sample;
}

function muLawEncode(sample) {
  const MU = 255;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample += 0x84;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Simple linear resampler
function resampleLinear(int16Array, inRate, outRate) {
  const ratio = outRate / inRate;
  const newLength = Math.round(int16Array.length * ratio);
  const result = new Int16Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i / ratio;
    const idx = Math.floor(srcIndex);
    const frac = srcIndex - idx;
    const s1 = int16Array[idx] || 0;
    const s2 = int16Array[idx + 1] || 0;
    result[i] = s1 + (s2 - s1) * frac;
  }
  return result;
}

// Twilio μ-law → PCM16 24k
function twilioMuLawBase64ToPcm24kBase64(muLawBase64) {
  if (!muLawBase64) return null;

  const muBuf = Buffer.from(muLawBase64, "base64");
  const pcm8 = new Int16Array(muBuf.length);

  for (let i = 0; i < muBuf.length; i++) {
    pcm8[i] = muLawDecode(muBuf[i]);
  }

  const pcm24 = resampleLinear(pcm8, TWILIO_SAMPLE_RATE, OPENAI_SAMPLE_RATE);
  return Buffer.from(pcm24.buffer).toString("base64");
}

// PCM16 24k → μ-law
function pcm24kBase64ToTwilioMuLawBase64(base64) {
  if (!base64) return null;

  const pcmBuf = Buffer.from(base64, "base64");
  const pcm24 = new Int16Array(
    pcmBuf.buffer,
    pcmBuf.byteOffset,
    pcmBuf.byteLength / 2
  );

  const pcm8 = resampleLinear(pcm24, OPENAI_SAMPLE_RATE, TWILIO_SAMPLE_RATE);

  const mu = Buffer.alloc(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) {
    mu[i] = muLawEncode(pcm8[i]);
  }

  return mu.toString("base64");
}

// ====== EXPRESS + HTTP ======
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("ForConnect Twilio ↔ OpenAI Realtime gateway radi ✅");
});

app.post("/incoming-call", (req, res) => {
  const streamUrl = WS_ENDPOINT || `wss://${req.headers.host}/media-stream`;

  res.type("text/xml").send(`
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`);
});

// ====== TWILIO WS SERVER ======
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  console.log("📞 Twilio Media Stream povezan");

  let streamSid = null;
  let openAiWs = null;
  let ready = false;

  // OpenAI WS
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    OPENAI_MODEL
  )}`;

  openAiWs = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openAiWs.on("open", () => {
    console.log("✅ OpenAI WS opened");
    ready = true;

    openAiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          model: OPENAI_MODEL,
          voice: OPENAI_VOICE,
          instructions:
            "You are the ForConnect Voice Agent for Dutch barbershops. Speak Dutch by default.",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        },
      })
    );

    openAiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Begroet de beller kort en vraag hoe je kan helpen met een afspraak."
        },
      })
    );
  });

  // OpenAI → Twilio
  openAiWs.on("message", (data) => {
    const evt = JSON.parse(data.toString());

    if (evt.type === "response.output_audio.delta" && evt.delta && streamSid) {
      const tw = pcm24kBase64ToTwilioMuLawBase64(evt.delta);
      if (!tw) return;

      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: tw },
        })
      );
    }
  });

  // Twilio → OpenAI
  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("▶️ Start stream:", streamSid);
    }

    if (data.event === "media" && ready) {
      const twPayload = data.media.payload;
      const aiAudio = twilioMuLawBase64ToPcm24kBase64(twPayload);

      if (!aiAudio) return;

      openAiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: aiAudio,
        })
      );
    }
  });

  twilioWs.on("close", () => {
    if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.close();
  });
});

// START
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
