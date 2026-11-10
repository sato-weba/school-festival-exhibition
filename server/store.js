/**
 * entries.json + uploads / seeds の読み書き
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// DATA_DIR を指定すると、投稿はリポジトリの外（クラウドの永続ディスク）に残る。
const STORAGE_ROOT = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;
const DATA_DIR = path.join(STORAGE_ROOT, "data");
const ENTRIES_PATH = path.join(DATA_DIR, "entries.json");
const UPLOADS_DIR = path.join(STORAGE_ROOT, "uploads");
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

function bucketName() {
  return process.env.SUPABASE_BUCKET || "exhibition";
}

function remoteEnabled() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function storageMode() {
  return remoteEnabled() ? "supabase" : "local";
}

function supabaseOrigin() {
  return String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
}

async function supabaseStorage(pathname, options = {}) {
  const headers = {
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ...(options.headers || {}),
  };
  return fetch(`${supabaseOrigin()}/storage/v1${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
    signal: AbortSignal.timeout(15000),
  });
}

async function ensureRemoteBucket() {
  const res = await supabaseStorage("/bucket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bucketName(),
      name: bucketName(),
      public: false,
      file_size_limit: 5 * 1024 * 1024,
    }),
  });
  if (res.ok || res.status === 409) return;
  const text = await res.text();
  if (res.status === 400 && /exist|duplicate/i.test(text)) return;
  throw new Error(`投稿の保存先を用意できませんでした (${res.status})。Supabase の URL と service_role キーを確認してください。`);
}

async function uploadRemote(objectPath, body, contentType) {
  const res = await supabaseStorage(`/object/${bucketName()}/${objectPath}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body,
  });
  if (res.ok) return;
  const text = await res.text();
  throw new Error(`投稿を保存できませんでした (${res.status}) ${text.slice(0, 180)}`);
}

async function downloadRemote(objectPath) {
  const res = await supabaseStorage(`/object/${bucketName()}/${objectPath}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`保存済みの投稿を読み込めませんでした (${res.status})。`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  return "image/jpeg";
}

/**
 * 無料の Supabase Storage から投稿を手元へ戻す。
 * Render 無料枠が止まってディスクが消えても、次の起動でプールが戻る。
 */
async function prepareStorage() {
  ensureDirs();
  if (process.env.REQUIRE_REMOTE_STORE === "1" && !remoteEnabled()) {
    throw new Error(
      "SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です。無料枠のサーバーは再起動でディスクが消えるため、投稿は Supabase に保存します。"
    );
  }
  if (!remoteEnabled()) return;

  await ensureRemoteBucket();
  const raw = await downloadRemote("data/entries.json");
  const data = raw ? JSON.parse(raw.toString("utf8")) : { entries: [] };
  if (!Array.isArray(data.entries)) data.entries = [];
  writeEntries(data);

  for (const item of data.entries) {
    if (!item || !item.filename) continue;
    const filePath = path.join(UPLOADS_DIR, item.filename);
    if (fs.existsSync(filePath)) continue;
    const image = await downloadRemote(`uploads/${item.filename}`);
    if (!image) continue;
    fs.writeFileSync(filePath, image);
  }
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
async function addEntry(entry) {
  ensureDirs();
  const data = readJsonSafe(ENTRIES_PATH, { entries: [] });
  if (!Array.isArray(data.entries)) data.entries = [];
  const saved = {
    id: entry.id,
    description: entry.description,
    filename: entry.filename,
    createdAt: entry.createdAt,
  };
  data.entries.push(saved);
  writeEntries(data);

  if (remoteEnabled()) {
    try {
      const filePath = path.join(UPLOADS_DIR, entry.filename);
      await uploadRemote(
        `uploads/${entry.filename}`,
        fs.readFileSync(filePath),
        contentTypeFor(entry.filename)
      );
      await uploadRemote(
        "data/entries.json",
        Buffer.from(JSON.stringify(data, null, 2)),
        "application/json"
      );
    } catch (err) {
      data.entries.pop();
      writeEntries(data);
      throw err;
    }
  }
  return saved;
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
  prepareStorage,
  storageMode,
  remoteEnabled,
  loadSeedEntries,
  loadUserEntries,
};
