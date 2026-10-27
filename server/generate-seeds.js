/**
 * シード用の簡易 SVG 画像を生成する
 * npm run seed:images
 */

const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "seeds", "images");

const PALETTES = [
  ["#6B8AFF", "#C56BFF"],
  ["#5BA3FF", "#8F6DFF"],
  ["#7C9BFF", "#B06BFF"],
  ["#4D8CFF", "#A078FF"],
  ["#6B9AFF", "#D06BFF"],
  ["#8AA8FF", "#C58AFF"],
  ["#5E7FFF", "#9B6DFF"],
  ["#7090FF", "#BE70FF"],
  ["#6B8AE0", "#C56BD0"],
  ["#7A98FF", "#B87AFF"],
  ["#6688FF", "#C060FF"],
  ["#8098FF", "#D080FF"],
  ["#5C85FF", "#A86CFF"],
  ["#6E92FF", "#C070EE"],
  ["#789AFF", "#B86AFF"],
];

function svgFor(index, label) {
  const [c1, c2] = PALETTES[index % PALETTES.length];
  const safe = String(label).replace(/[<>&]/g, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="800" height="800" fill="url(#g)"/>
  <circle cx="400" cy="360" r="140" fill="rgba(255,255,255,0.22)"/>
  <circle cx="520" cy="260" r="60" fill="rgba(255,255,255,0.18)"/>
  <text x="400" y="620" text-anchor="middle" font-family="sans-serif" font-size="36" fill="rgba(255,255,255,0.92)" font-weight="600">${safe}</text>
</svg>
`;
}

const labels = [
  "空", "猫", "コーヒー", "夕焼け", "本",
  "雨", "自転車", "海", "音楽", "街灯",
  "パン", "雲", "電車", "花", "窓",
];

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

labels.forEach((label, i) => {
  const n = String(i + 1).padStart(2, "0");
  const filename = `seed-${n}.svg`;
  fs.writeFileSync(path.join(OUT_DIR, filename), svgFor(i, label), "utf8");
  console.log("wrote", filename);
});

console.log("done:", labels.length, "seed images");
