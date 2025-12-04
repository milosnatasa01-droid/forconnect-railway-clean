import express from "express";
import http from "http";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import { mulaw, utils } from "x-law";

dotenv.config();

// ====== CONFIG ======
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL =
  process.env.OPENAI_MODEL || "gpt-4o-mini-realtime-preview";
const OPENAI_VOICE = process.env.OPENAI_VOICE || "verse"; // VAŽNO: verse je siguran
const WS_ENDPOINT = process.env.WS_ENDPOINT; // npr. wss://ai-voice.forconnect.nl/media-stream

// osnovne provere
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY nije podešen u .env");
  process.exit(1);
}

// ====== KONSTANTE ZA AUDIO ======
const TWILIO_SAMPLE_RATE = 8000;   // Twilio media streams
const OPENAI_SAMPLE_RATE = 24000;  // OpenAI Realtime pcm16 default
const BIT_DEPTH = 16;

// ====== EXPRESS + HTTP ======
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);

// Health-check
app.get("/", (_req, res) => {
  res.send("ForConnect Twilio ↔ OpenAI Realtime gateway radi ✅");
});

// Twilio webhook: /incoming-call -> vracamo TwiML sa <Connect><Stream>
app.post("/incoming-call", (req, res) => {
  const streamUrl =
    WS_ENDPOINT || `wss://${req.headers.host}/media-stream`;

  const twiml = `
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`.trim();

  res.type("text/xml").send(twiml);
});

// ====== POMOĆNE FUNKCIJE ZA AUDIO KONVERZIJU (x-law) ======

/**
 * Twilio μ-law base64 -> PCM16 24kHz base64 (za OpenAI)
 */
function twilioMuLawBase64ToPcm24kBase64(muLawBase64) {
  if (!muLawBase64) return null;

  // 1) base64 -> Buffer (μ-law)
  const muLawBuffer = Buffer.from(muLawBase64, "base64");
  if (muLawBuffer.length === 0) return null;

  // 2) μ-law -> PCM16 8kHz (Buffer)
  const pcm8kBuffer = mulaw.decodeBuffer(muLawBuffer); // Buffer sa 16-bit PCM

  // 3) Buffer -> Int16Array
  const pcm8k = new Int16Array(
    pcm8kBuffer.buffer,
    pcm8kBuffer.byteOffset,
    pcm8kBuffer.byteLength / 2
  );

  // 4) Resample 8k -> 24k (x-law utils.resample radi nad nizom brojeva)
  const resampledArray = utils.resample(
    Array.from(pcm8k),
    TWILIO_SAMPLE_RATE,
    OPENAI_SAMPLE_RATE,
    BIT_DEPTH
  );

  const pcm24k = Int16Array.from(resampledArray);

  // 5) Int16Array -> Buffer -> base64
  const pcm24kBuffer = Buffer.from(pcm24k.buffer);
  return pcm24kBuffer.toString("base64");
}

/**
 * OpenAI PCM16 24kHz base64 -> Twilio μ-law base64
 */
function pcm24kBase64ToTwilioMuLawBase64(pcm24kBase64) {
  if (!pcm24kBase64) return null;

  // 1) base64 -> Buffer PCM16 24kHz
  const pcm24kBuffer = Buffer.from(pcm24kBase64, "base64");

  if (pcm24kBuffer.length === 0) return null;

  // 2) Buffer -> Int16Array
  const pcm24k = new Int16Array(
    pcm24kBuffer.buffer,
    pcm24kBuffer.byteOffset,
    pcm24kBuffer.byteLength / 2
  );

  // 3) Resample 24k -> 8k
  const resampledArray = utils.resample(
    Array.from(pcm24k),
    OPENAI_SAMPLE_RATE,
    TWILIO_SAMPLE_RATE,
    BIT_DEPTH
  );

  const pcm8k = Int16Array.from(resampledArray);

  // 4) Int16Array -> Buffer
  const pcm8kBuffer = Buffer.from(pcm8k.buffer);

  // 5) PCM16 -> μ-law Buffer
  const muLawBuffer = mulaw.encodeBuffer(pcm8kBuffer); // Buffer μ-law

  // 6) μ-law Buffer -> base64
  return muLawBuffer.toString("base64");
}

// ====== WEBSOCKET SERVER ZA TWILIO MEDIA STREAM ======
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  console.log("📞 Twilio Media Stream povezan");

  let streamSid = null;
  let openAiWs = null;
  let openAiReady = false;

  // Otvori WS konekciju ka OpenAI Realtime
  const openAiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    OPENAI_MODEL
  )}`;

  openAiWs = new WebSocket(openAiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // Logujemo nekoliko važnih eventova da vidimo da li ide audio
  const LOG_EVENT_TYPES = [
    "session.created",
    "session.updated",
    "response.output_audio.delta",
    "response.output_audio.done",
    "response.output_audio_transcript.delta",
    "response.output_text.delta",
    "response.completed",
    "input_audio_buffer.speech_started",
    "input_audio_buffer.speech_stopped",
  ];

  openAiWs.on("open", () => {
    console.log("✅ OpenAI Realtime WS otvoren");
    openAiReady = true;

    // Konfiguracija sesije
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        model: OPENAI_MODEL,
        voice: OPENAI_VOICE,
        instructions:
          "You are the ForConnect Voice Agent for Dutch barbershops. " +
          "Speak Dutch by default. Be kratak, ljubazan i profesionalan. " +
          "Pomažeš klijentima da zakažu termin za šišanje ili brijanje.",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        // server-side VAD – automatski detektuje kraj rečenice
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
    };

    openAiWs.send(JSON.stringify(sessionUpdate));

    // (opciono) AI da prvi progovori:
    const initialResponse = {
      type: "response.create",
      response: {
        instructions:
          "Begroet de beller kort in het Nederlands, stel jezelf voor als de digitale assistent van de kapsalon en vraag hoe je kunt helpen met een afspraak.",
      },
    };
    openAiWs.send(JSON.stringify(initialResponse));
  });

  openAiWs.on("message", (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch (e) {
      console.error("❌ Greška pri parsiranju OpenAI eventa:", e);
      return;
    }

    if (LOG_EVENT_TYPES.includes(event.type)) {
      console.log("📥 OpenAI event:", event.type);
    }

    // Audio iz OpenAI ka Twilio
    if (
      event.type === "response.output_audio.delta" &&
      event.delta &&
      streamSid
    ) {
      const twilioPayload = pcm24kBase64ToTwilioMuLawBase64(event.delta);
      if (!twilioPayload) return;

      const twilioMediaMsg = {
        event: "media",
        streamSid,
        media: { payload: twilioPayload },
      };

      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify(twilioMediaMsg));
      }
    }

    // Možeš dodati i log transkripta:
    if (
      event.type === "response.output_audio_transcript.delta" &&
      event.delta
    ) {
      console.log("📝 AI transcript delta:", event.delta);
    }
  });

  openAiWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err);
  });

  openAiWs.on("close", () => {
    console.log("🔌 OpenAI WS zatvoren");
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.close();
    }
  });

  // ====== TWILIO → OPENAI ======
  twilioWs.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      console.error("❌ Greška pri parsiranju Twilio WS poruke:", e);
      return;
    }

    const { event } = data;

    if (event === "start") {
      streamSid = data.start.streamSid;
      console.log("▶️ Twilio stream start, streamSid:", streamSid);
   } else if (event === "media") {
  if (!openAiReady) return;

  const twilioPayload = data.media.payload;

  // 🚀 DEBUG LOGGING — OVO UBACUJEMO
  console.log("📥 Twilio raw (first 20 chars):", twilioPayload?.substring(0, 20));

  const openAiAudio = twilioMuLawBase64ToPcm24kBase64(twilioPayload);

  if (!openAiAudio) {
    console.log("❌ NO AUDIO AFTER CONVERSION");
    return;
  }

  console.log("🎤 PCM24 length:", openAiAudio.length);
  // 🚀 DEBUG LOGGING — KRAJ

      const audioAppendEvent = {
        type: "input_audio_buffer.append",
        audio: openAiAudio,
      };

      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify(audioAppendEvent));
      }
    } else if (event === "stop") {
      console.log("⏹️ Twilio stream stop");
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }
    }
  });

  twilioWs.on("close", () => {
    console.log("🔌 Twilio WS zatvoren");
    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WS error:", err);
    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
  });
});

// ====== START SERVER ======
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
