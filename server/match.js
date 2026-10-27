/**
 * 画像ベースの類似度マッチ
 *
 * 説明文はバリデーション・表示用のみ。関連度スコアには一切使わない。
 *
 * - デフォルト: 画像の色ヒストグラム＋縮小RGB特徴のコサイン類似度
 * - OPENAI_API_KEY がある場合: 画像のみを Vision で視覚特徴化し Embedding（差し替え口）
 */

const fs = require("fs");
const path = require("path");

const MAX_DESCRIPTION_LENGTH = 120;
const MIN_DESCRIPTION_LENGTH = 2;

/** 簡易 NG ワード（部分一致）— 説明文の投稿チェック用 */
const NG_WORDS = [
  "死ね",
  "殺す",
  "殺害",
  "暴力",
  "強姦",
  "レイプ",
  "裸体",
  "裸",
  "ポルノ",
  "エロ",
  "セックス",
  "児童",
  "わいせつ",
  "麻薬",
  "覚せい剤",
  "大麻",
];

const HIST_BINS = 4; // 4^3 = 64 次元ヒストグラム
const GRID = 8; // 8x8 縮小グリッド

/**
 * 説明文を正規化（NGチェック用。マッチングには使わない）
 * @param {string} text
 * @returns {string}
 */
function normalizeDescription(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 説明文のバリデーション（投稿メタ用。類似度計算には渡さない）
 * @param {string} description
 * @returns {{ ok: true, normalized: string, original: string } | { ok: false, error: string }}
 */
function validateDescription(description) {
  const raw = String(description || "").trim();
  if (raw.length < MIN_DESCRIPTION_LENGTH) {
    return { ok: false, error: `説明文は${MIN_DESCRIPTION_LENGTH}文字以上で入力してください。` };
  }
  if (raw.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: `説明文は${MAX_DESCRIPTION_LENGTH}文字以内にしてください。` };
  }

  const normalized = normalizeDescription(raw);
  const hit = NG_WORDS.find((w) => normalized.includes(normalizeDescription(w)));
  if (hit) {
    return { ok: false, error: "不適切な表現が含まれているため投稿できません。" };
  }

  return { ok: true, normalized, original: raw };
}

/**
 * コサイン類似度
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 生RGBバッファから特徴ベクトル（ヒストグラム + 縮小グリッド）を作る
 * @param {Buffer} raw
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @returns {number[]}
 */
function featuresFromRaw(raw, width, height, channels) {
  const hist = new Array(HIST_BINS ** 3).fill(0);
  const grid = new Array(GRID * GRID * 3).fill(0);
  const cellW = width / GRID;
  const cellH = height / GRID;
  const cellCounts = new Array(GRID * GRID).fill(0);
  let pixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const r = raw[i];
      const g = raw[i + 1];
      const b = raw[i + 2];

      const ri = Math.min(HIST_BINS - 1, Math.floor((r / 256) * HIST_BINS));
      const gi = Math.min(HIST_BINS - 1, Math.floor((g / 256) * HIST_BINS));
      const bi = Math.min(HIST_BINS - 1, Math.floor((b / 256) * HIST_BINS));
      hist[ri * HIST_BINS * HIST_BINS + gi * HIST_BINS + bi] += 1;
      pixels += 1;

      const cx = Math.min(GRID - 1, Math.floor(x / cellW));
      const cy = Math.min(GRID - 1, Math.floor(y / cellH));
      const ci = cy * GRID + cx;
      grid[ci * 3] += r;
      grid[ci * 3 + 1] += g;
      grid[ci * 3 + 2] += b;
      cellCounts[ci] += 1;
    }
  }

  if (pixels > 0) {
    for (let i = 0; i < hist.length; i += 1) hist[i] /= pixels;
  }
  for (let i = 0; i < cellCounts.length; i += 1) {
    const n = cellCounts[i] || 1;
    grid[i * 3] = grid[i * 3] / n / 255;
    grid[i * 3 + 1] = grid[i * 3 + 1] / n / 255;
    grid[i * 3 + 2] = grid[i * 3 + 2] / n / 255;
  }

  return [...hist, ...grid];
}

/**
 * 画像ファイルからローカル特徴ベクトルを抽出
 * @param {string} imagePath
 * @returns {Promise<number[]|null>}
 */
async function extractLocalImageFeatures(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;

  try {
    const sharp = require("sharp");
    const { data, info } = await sharp(imagePath)
      .rotate()
      .resize(64, 64, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return featuresFromRaw(data, info.width, info.height, info.channels);
  } catch (err) {
    console.warn("[match] local image features failed:", imagePath, err.message);
    return null;
  }
}

/**
 * 2画像のローカル類似度
 * @param {string} pathA
 * @param {string} pathB
 * @returns {Promise<number>}
 */
async function localImageSimilarity(pathA, pathB) {
  const [fa, fb] = await Promise.all([
    extractLocalImageFeatures(pathA),
    extractLocalImageFeatures(pathB),
  ]);
  if (!fa || !fb) return 0;
  return cosineSimilarity(fa, fb);
}

/**
 * OpenAI Vision で画像のみから短い視覚特徴テキストを得る（ユーザー説明文は送らない）
 *
 * TODO: OpenAI Vision / Embedding
 * OPENAI_API_KEY 設定時のみ。画像の見た目だけを要約し、その要約を Embedding する。
 *
 * @param {string} imagePath
 * @returns {Promise<number[]|null>}
 */
async function fetchImageEmbedding(imagePath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !imagePath || !fs.existsSync(imagePath)) return null;

  try {
    const buf = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase().replace(".", "") || "jpeg";
    const mime =
      ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : ext === "svg"
              ? "image/svg+xml"
              : "image/jpeg";
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

    const visionRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Describe only the visual appearance of this image in English: " +
                  "main subjects, colors, composition, mood. Max 40 words. No guesses about text captions.",
              },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 80,
      }),
    });

    if (!visionRes.ok) {
      console.warn("[match] OpenAI vision failed:", visionRes.status, await visionRes.text());
      return null;
    }

    const visionData = await visionRes.json();
    const visualText = visionData?.choices?.[0]?.message?.content?.trim();
    if (!visualText) return null;

    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
        input: visualText,
      }),
    });

    if (!embRes.ok) {
      console.warn("[match] OpenAI embedding failed:", embRes.status, await embRes.text());
      return null;
    }

    const embData = await embRes.json();
    return embData?.data?.[0]?.embedding || null;
  } catch (err) {
    console.warn("[match] OpenAI image embedding error:", err.message);
    return null;
  }
}

/**
 * プールから画像関連度がいちばん高い1件を返す（同点ならランダム）
 * 説明文は参照しない。
 *
 * @param {string} queryImagePath 投稿画像の絶対パス
 * @param {Array<object>} pool imagePath を持つエントリ配列
 * @param {string|null} excludeId
 * @returns {Promise<{ match: object|null, score: number, method: string }>}
 */
async function findBestMatch(queryImagePath, pool, excludeId = null) {
  const candidates = pool.filter((e) => e.id !== excludeId && e.imagePath);
  if (candidates.length === 0) {
    return { match: null, score: 0, method: "none" };
  }

  let method = "image";
  let scored;

  const queryEmbedding = await fetchImageEmbedding(queryImagePath);

  if (queryEmbedding) {
    method = "image-embedding";
    const withEmb = await Promise.all(
      candidates.map(async (c) => {
        const emb = await fetchImageEmbedding(c.imagePath);
        if (emb) {
          return { entry: c, score: cosineSimilarity(queryEmbedding, emb) };
        }
        const fallback = await localImageSimilarity(queryImagePath, c.imagePath);
        return { entry: c, score: fallback };
      })
    );
    scored = withEmb;
  } else {
    scored = await Promise.all(
      candidates.map(async (c) => ({
        entry: c,
        score: await localImageSimilarity(queryImagePath, c.imagePath),
      }))
    );
  }

  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0].score;

  if (topScore <= 0) {
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    return { match: pick, score: 0, method: "random" };
  }

  const tops = scored.filter((s) => Math.abs(s.score - topScore) < 1e-9);
  const pick = tops[Math.floor(Math.random() * tops.length)];
  return { match: pick.entry, score: pick.score, method };
}

/**
 * 類似度を一言メッセージに変換
 * @param {number} score
 * @param {string} method
 * @returns {string}
 */
function scorePhrase(score, method) {
  if (method === "random" || score <= 0) return "たまたま巡りあった一枚";
  if (score >= 0.85) return "見た目がとても近い一枚";
  if (score >= 0.7) return "色や雰囲気が通じる一枚";
  if (score >= 0.55) return "かすかに重なる一枚";
  return "意外なつながりの一枚";
}

module.exports = {
  MAX_DESCRIPTION_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  NG_WORDS,
  normalizeDescription,
  validateDescription,
  extractLocalImageFeatures,
  localImageSimilarity,
  findBestMatch,
  scorePhrase,
};
