/* ============================================================
   ENVIRONMENT & TYPES
   ============================================================ */
interface Env {
  // Cloudflare Workers AI
  AI: {
    run: (model: string, input: any) => Promise<any>;
  };

  // Cloudflare D1 Database
  DB: D1Database;
}


interface AnalyzeRequestBody {
  text?: string;
  image_bytes?: number[];
  language?: string;
}

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/* ============================================================
   UTILITIES
   ============================================================ */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function clampRisk(v: unknown): number {
  const n = Number(v);
  if (Number.isNaN(n)) return 0.5;
  return Math.min(Math.max(n, 0), 1);
}

/* ============================================================
   LOGIC 1: AUDIO ANALYSIS (Whisper + Specific Scoring)
   ============================================================ */
async function handleAudioAnalysis(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const audioFile = form.get("audio") as File | null;
  const userLang = form.get("language") as string | null;
  const outputLang = userLang ?? "eng_Latn";

  if (!audioFile) {
    return new Response(JSON.stringify({ error: "Audio file is required" }), { status: 400, headers: CORS_HEADERS });
  }

  // 1. Transcribe
  const audioBase64 = arrayBufferToBase64(await audioFile.arrayBuffer());
  const whisper = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: audioBase64,
    task: "transcribe",
    vad_filter: true
  });

  const transcript = whisper?.text?.trim();
  if (!transcript) {
    return new Response(JSON.stringify({ error: "No speech detected" }), { status: 400, headers: CORS_HEADERS });
  }

  // 2. Translate for analysis
  let text_en = transcript;
  try {
    const t = await env.AI.run("@cf/ai4bharat/indictrans2-en-indic-1B", { text: transcript });
    text_en = t?.translations?.[0] ?? text_en;
  } catch {}

  // 3. Scam Analysis
  const llama = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: "You are a scam detection assistant. Respond ONLY with valid JSON." },
      { role: "user", content: `Return JSON: { "scam_type": string, "psychological_tricks": [], "linguistic_risk": 0-1, "psychological_risk": 0-1, "contextual_risk": 0-1, "explanation_en": string, "action_advice": [] } \n\n Content: "${text_en}"` }
    ],
    temperature: 0
  });

  const analysis = JSON.parse(llama.response);

  // 4. Audio Specific Scoring (Weights: 0.3, 0.3, 0.2)
  const riskScore = clampRisk(
    0.3 * clampRisk(analysis.linguistic_risk) +
    0.3 * clampRisk(analysis.psychological_risk) +
    0.2 * clampRisk(analysis.contextual_risk)
  );

  const riskLabel = riskScore >= 0.60 ? "High Risk" : riskScore >= 0.45 ? "Medium Risk" : "Low Risk";

  // 5. Final Translation
  let explanation = analysis.explanation_en || "";
  let actionAdvice = Array.isArray(analysis.action_advice) ? analysis.action_advice.join("\n") : "";

  if (outputLang !== "eng_Latn") {
    try {
      const e = await env.AI.run("@cf/ai4bharat/indictrans2-en-indic-1B", { text: explanation, target_language: outputLang });
      explanation = e?.translations?.[0] ?? explanation;
      const a = await env.AI.run("@cf/ai4bharat/indictrans2-en-indic-1B", { text: actionAdvice, target_language: outputLang });
      actionAdvice = a?.translations?.[0] ?? actionAdvice;
    } catch {}
  }

  return new Response(JSON.stringify({
    input_type: "audio",
    is_scam: riskScore >= 0.6,
    risk_score: Number(riskScore.toFixed(2)),
    risk_label: riskLabel,
    scam_type: analysis.scam_type || "Unknown",
    psychological_tricks: analysis.psychological_tricks || [],
    explanation,
    action_advice: actionAdvice.split("\n").filter(Boolean),
    language: outputLang
  }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

/* ============================================================
   LOGIC 2: IMAGE/TEXT ANALYSIS (Vision + Specific Scoring)
   ============================================================ */
async function handleImageOrTextAnalysis(body: AnalyzeRequestBody, env: Env): Promise<Response> {
  const userLang = body.language ?? "eng_Latn";
  let extractedText = "";
  let inputType: "text" | "image" = "text";

  // 1. Image OCR
  if (Array.isArray(body.image_bytes)) {
    inputType = "image";
    const ocr = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      image: body.image_bytes,
      prompt: "Carefully transcribe all visible text in this image.",
      max_tokens: 512
    });
    extractedText = (ocr?.description ?? ocr?.response ?? ocr?.output_text ?? "").trim();
    if (extractedText.length < 5) {
      return new Response(JSON.stringify({ error: "No readable text found" }), { status: 400, headers: CORS_HEADERS });
    }
  } else if (typeof body.text === "string") {
    inputType = "text";
    extractedText = body.text.trim();
  }

  // 2. Translate to English
  let textEn = extractedText;
  if (userLang !== "eng_Latn") {
    try {
      const t = await env.AI.run("@cf/ai4bharat/indictrans2-en-indic-1B", { text: extractedText, target_language: "eng_Latn" });
      textEn = t?.translations?.[0] ?? extractedText;
    } catch {}
  }

  // 3. Scam Analysis
  const llama = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: "You are a scam detection engine. Respond ONLY with valid JSON." },
      { role: "user", content: `Return JSON: { "is_scam": boolean, "scam_type": string, "psychological_tricks": [], "linguistic_risk": 0-1, "psychological_risk": 0-1, "contextual_risk": 0-1, "technical_risk": 0-1, "explanation_en": "string", "action_advice": [], "url_red_flags": [] } \n\n Message: "${textEn}"` }
    ],
    temperature: 0.1
  });
  const cleaned = llama.response.replace(/```json|```/g, "").trim();
  const analysis = JSON.parse(cleaned);

  // 4. Image/Text Specific Scoring (Weights: 0.35, 0.30, 0.20, 0.15)
  const riskScore = 0.35 * (analysis.linguistic_risk || 0) + 0.30 * (analysis.psychological_risk || 0) + 0.20 * (analysis.contextual_risk || 0) + 0.15 * (analysis.technical_risk || 0);
  let riskLabel = riskScore >= 0.6 ? "High Risk" : riskScore >= 0.3 ? "Medium Risk" : "Low Risk";

  // 5. Translate Back
  let explanation = analysis.explanation_en;
  let advice = analysis.action_advice;
  if (userLang !== "eng_Latn") {
    try {
      const e = await env.AI.run("@cf/ai4bharat/indictrans2-en-indic-1B", { text: explanation, target_language: userLang });
      const a = await env.AI.run("@cf/ai4bharat/indictrans2-en-indic-1B", { text: advice.join(". "), target_language: userLang });
      explanation = e?.translations?.[0] ?? explanation;
      advice = a?.translations?.[0]?.split(". ") ?? advice;
    } catch {}
  }

  return new Response(JSON.stringify({
    input_type: inputType,
    is_scam: analysis.is_scam,
    risk_score: Number(riskScore.toFixed(2)),
    risk_label: riskLabel,
    scam_type: analysis.scam_type,
    psychological_tricks: analysis.psychological_tricks,
    url_red_flags: analysis.url_red_flags ?? [],
    explanation,
    action_advice: advice,
    language: userLang
  }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

/* ============================================================
   MAIN FETCH HANDLER (ROUTING)
   ============================================================ */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });

    const url = new URL(request.url);
    const contentType = request.headers.get("content-type") || "";

    try {
      // ROUTE 1: Audio Analysis
      if (url.pathname === "/analyze-audio") {
        return await handleAudioAnalysis(request, env);
      }

      // ROUTE 2: Image/Text Analysis
      if (url.pathname === "/analyze-image" || url.pathname === "/analyze-text") {
        if (contentType.includes("application/json")) {
          const body = (await request.json()) as AnalyzeRequestBody;
          return await handleImageOrTextAnalysis(body, env);
        }
        
        if (contentType.includes("multipart/form-data")) {
          const formData = await request.formData();
          const file = formData.get("image") as File | null;
          const language = String(formData.get("language") || "eng_Latn");
          if (!file) throw new Error("Image file required");
          const buffer = new Uint8Array(await file.arrayBuffer());
          return await handleImageOrTextAnalysis({ image_bytes: Array.from(buffer), language }, env);
        }
      }

      return new Response(JSON.stringify({ error: "Endpoint not found" }), { status: 404, headers: CORS_HEADERS });

    } catch (err: any) {
      return new Response(JSON.stringify({ error: "Server Error", details: err.message }), { status: 500, headers: CORS_HEADERS });
    }
  }
};