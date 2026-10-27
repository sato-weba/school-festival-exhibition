/**
 * 予期せぬ一枚 — Express API
 */

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");

const store = require("./store");
const match = require("./match");

const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB

store.ensureDirs();

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));

// 静的ファイル（フロント）
const ROOT = path.join(__dirname, "..");
app.use(express.static(ROOT));
app.use("/uploads", express.static(store.UPLOADS_DIR));
app.use("/seeds/images", express.static(store.SEEDS_IMAGES_DIR));

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, store.getUploadsDir());
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"].includes(ext)
      ? ext
      : ".jpg";
    cb(null, `${Date.now()}-${uuidv4()}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter(_req, file, cb) {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      cb(new Error("画像ファイルのみアップロードできます。"));
      return;
    }
    cb(null, true);
  },
});

app.get("/api/health", (_req, res) => {
  const counts = store.getEntryCount();
  res.json({
    ok: true,
    service: "予期せぬ一枚",
    counts,
    imageMatching: true,
    openaiVision: Boolean(process.env.OPENAI_API_KEY),
  });
});

/** 本番では詳細一覧は公開しない — 件数のみ */
app.get("/api/entries", (_req, res) => {
  res.json({ count: store.getEntryCount().total });
});

app.post("/api/match", (req, res) => {
  upload.single("image")(req, res, async (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "画像サイズは5MB以下にしてください。"
          : err.message || "アップロードに失敗しました。";
      return res.status(400).json({ ok: false, error: message });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: "画像を選択してください。" });
      }

      const validation = match.validateDescription(req.body?.description);
      if (!validation.ok) {
        // 不正な投稿はファイルを残さない
        safeUnlink(req.file.path);
        return res.status(400).json({ ok: false, error: validation.error });
      }

      // 照合は画像のみ。説明文は保存・表示用でスコアに使わない。
      const pool = store.getPool();
      const { match: best, score, method } = await match.findBestMatch(
        req.file.path,
        pool,
        null
      );

      if (!best) {
        safeUnlink(req.file.path);
        return res.status(503).json({
          ok: false,
          error: "マッチできる画像がまだありません。シードデータを確認してください。",
        });
      }

      const newId = uuidv4();
      const createdAt = new Date().toISOString();

      // 成功後に自分の投稿をプールへ追加
      store.addEntry({
        id: newId,
        description: validation.original,
        filename: req.file.filename,
        createdAt,
      });

      return res.json({
        ok: true,
        match: {
          id: best.id,
          description: best.description,
          imageUrl: best.imageUrl,
          isSeed: Boolean(best.isSeed),
        },
        score: Math.round(score * 1000) / 1000,
        scorePhrase: match.scorePhrase(score, method),
        method,
        yours: {
          id: newId,
          description: validation.original,
          imageUrl: `/uploads/${req.file.filename}`,
        },
      });
    } catch (e) {
      console.error("[api/match]", e);
      if (req.file) safeUnlink(req.file.path);
      return res.status(500).json({ ok: false, error: "サーバーエラーが発生しました。" });
    }
  });
});

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

app.listen(PORT, () => {
  const counts = store.getEntryCount();
  console.log(`予期せぬ一枚 listening on http://localhost:${PORT}`);
  console.log(`pool: seeds=${counts.seeds} users=${counts.users} total=${counts.total}`);
});
