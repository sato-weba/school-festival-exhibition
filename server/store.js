/**
 * entries.json + uploads / seeds の読み書き
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const ENTRIES_PATH = path.join(DATA_DIR, "entries.json");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const SEEDS_META_PATH = path.join(ROOT, "seeds", "meta.json");
const SEEDS_IMAGES_DIR = path.join(ROOT, "seeds", "images");

function ensureDirs() {
  for (const dir of [DATA_DIR, UPLOADS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeEntries(entries) {
  ensureDirs();
  fs.writeFileSync(ENTRIES_PATH, JSON.stringify(entries, null, 2), "utf8");
}

/**
 * シードエントリを読み込む（画像パスは /seeds/images/... として公開）
 * @returns {Array<object>}
 */
function loadSeedEntries() {
  const meta = readJsonSafe(SEEDS_META_PATH, { entries: [] });
  const list = Array.isArray(meta.entries) ? meta.entries : [];

  return list
    .filter((item) => item && item.id && item.description && item.filename)
    .map((item) => ({
      id: item.id,
      description: String(item.description),
      filename: item.filename,
      imageUrl: `/seeds/images/${item.filename}`,
      isSeed: true,
      createdAt: item.createdAt || "2026-01-01T00:00:00.000Z",
    }))
    .filter((item) => fs.existsSync(path.join(SEEDS_IMAGES_DIR, item.filename)));
}

/**
 * ユーザー投稿エントリを読み込む
 * @returns {Array<object>}
 */
function loadUserEntries() {
  ensureDirs();
  const data = readJsonSafe(ENTRIES_PATH, { entries: [] });
  const list = Array.isArray(data.entries) ? data.entries : [];

  return list.map((item) => ({
    ...item,
    isSeed: false,
    imageUrl: `/uploads/${item.filename}`,
  }));
}

/**
 * エントリの画像ファイル絶対パスを解決
 * @param {object} entry
 * @returns {string|null}
 */
function resolveImagePath(entry) {
  if (!entry || !entry.filename) return null;
  const filePath = entry.isSeed
    ? path.join(SEEDS_IMAGES_DIR, entry.filename)
    : path.join(UPLOADS_DIR, entry.filename);
  return fs.existsSync(filePath) ? filePath : null;
}

/**
 * マッチ対象プール（シード + ユーザー投稿）
 * 各要素に imagePath（絶対パス）を付与。照合は画像のみ。
 * @returns {Array<object>}
 */
function getPool() {
  return [...loadSeedEntries(), ...loadUserEntries()]
    .map((entry) => ({
      ...entry,
      imagePath: resolveImagePath(entry),
    }))
    .filter((entry) => Boolean(entry.imagePath));
}

/**
 * 投稿をプールへ追加
 * @param {{ id: string, description: string, filename: string, createdAt: string }} entry
 */
function addEntry(entry) {
  ensureDirs();
  const data = readJsonSafe(ENTRIES_PATH, { entries: [] });
  if (!Array.isArray(data.entries)) data.entries = [];
  data.entries.push({
    id: entry.id,
    description: entry.description,
    filename: entry.filename,
    createdAt: entry.createdAt,
  });
  writeEntries(data);
  return entry;
}

function getUploadsDir() {
  ensureDirs();
  return UPLOADS_DIR;
}

function getEntryCount() {
  return {
    seeds: loadSeedEntries().length,
    users: loadUserEntries().length,
    total: getPool().length,
  };
}

module.exports = {
  ROOT,
  ENTRIES_PATH,
  UPLOADS_DIR,
  SEEDS_IMAGES_DIR,
  ensureDirs,
  getPool,
  resolveImagePath,
  addEntry,
  getUploadsDir,
  getEntryCount,
  loadSeedEntries,
  loadUserEntries,
};
