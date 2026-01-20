import fs from "fs";

/* ================================
   Read audio like <input type="file">
================================ */
const buffer = fs.readFileSync("./test-audio.wav");

/* ================================
   Browser-style FormData
================================ */
const formData = new FormData();

/* <input type="file"> creates a Blob */
const file = new Blob([buffer], { type: "audio/wav" });

/* Field names MUST match Worker */
formData.append("audio", file, "test-audio.wav");

/* ✅ Force Hindi output */
formData.append("language", "");

console.log("📤 Uploading audio exactly like frontend...");

/* ================================
   POST to AUDIO ENDPOINT
================================ */
const response = await fetch(
  "https://scam-lens.mehak039btit23.workers.dev/analyze-audio",
  {
    method: "POST",
    body: formData
  }
);

/* ================================
   Error handling
================================ */
if (!response.ok) {
  console.error("❌ HTTP Error:", response.status);
  console.error(await response.text());
  process.exit(1);
}

/* ================================
   Success
================================ */
const result = await response.json();
console.log("✅ Audio analysis response:");
console.log(JSON.stringify(result, null, 2));
