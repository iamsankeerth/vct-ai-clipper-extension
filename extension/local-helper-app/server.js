import cors from "cors";
import express from "express";
import multer from "multer";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

const app = express();
const PORT = Number(process.env.PORT || 8799);
const TMP_ROOT = path.join(os.tmpdir(), "exact-clip-helper");
const UPLOAD_DIR = path.join(TMP_ROOT, "uploads");
const OUTPUT_DIR = path.join(TMP_ROOT, "outputs");
const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";

await fs.mkdir(UPLOAD_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
});

function sanitizeStem(stem) {
  const cleaned = String(stem || "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || `clip_${Date.now()}`;
}

async function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputPath
    ];

    const child = spawn(FFMPEG_BIN, args, { windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error(`ffmpeg not found. Set FFMPEG_PATH or add ffmpeg to PATH. (${FFMPEG_BIN})`));
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}. ${stderr.slice(-1200)}`));
    });
  });
}

async function safeDelete(filePath) {
  if (!filePath) return;
  await fs.unlink(filePath).catch(() => undefined);
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ffmpeg: FFMPEG_BIN
  });
});

app.post("/transcode/webm-to-mp4", upload.single("file"), async (req, res) => {
  const uploaded = req.file;
  if (!uploaded?.path) {
    res.status(400).send("Missing `file` upload.");
    return;
  }

  const stem = sanitizeStem(req.body?.fileStem || path.parse(uploaded.originalname || "").name);
  const outputPath = path.join(OUTPUT_DIR, `${stem}_${Date.now()}.mp4`);

  try {
    await runFfmpeg(uploaded.path, outputPath);
    const mp4Buffer = await fs.readFile(outputPath);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename=\"${stem}.mp4\"`);
    res.status(200).send(mp4Buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown conversion error.";
    res.status(500).send(message);
  } finally {
    await safeDelete(uploaded.path);
    await safeDelete(outputPath);
  }
});

app.listen(PORT, () => {
  console.log(`Exact clip helper listening on http://127.0.0.1:${PORT}`);
});
