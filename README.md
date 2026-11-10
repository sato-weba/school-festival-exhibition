# ランダム画像照合アプリ

文化祭展示向けの体験型Webアプリです。  
来場者がスマホで**画像＋短い説明文**を送ると、サーバーが過去投稿（＋初期シード）から**画像同士の関連度がいちばん高い一枚**を返します。自分の投稿はプールに追加され、次の来場者への候補になります。

> **照合に使うのは画像のみです。説明文は関連度に含めません**（投稿メタ・結果表示用）。  
> デフォルトは色ヒストグラム等のローカル画像類似度です。`OPENAI_API_KEY` を設定すると、画像のみを Vision で視覚特徴化し Embedding 照合に切り替わります。

## デモの流れ

1. **トップ** — サービス紹介と「はじめる」
2. **注意事項** — 同意しないと投稿不可
3. **投稿** — 画像選択＋説明文入力 → 送信
4. **ローディング** — 検索演出
5. **結果** — マッチ画像・相手の説明・自分のプレビュー

## セットアップ / 起動

Node.js 18 以上が必要です。

```bash
npm install
npm start
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開いてください。  
スマホ幅（375px）でも確認することを推奨します。

環境変数（任意）:

| 変数 | 説明 |
|------|------|
| `PORT` | 待ち受けポート（既定 `3000`） |
| `OPENAI_API_KEY` | 設定時のみ画像 Vision＋Embedding マッチを使用 |
| `OPENAI_VISION_MODEL` | 既定 `gpt-4o-mini`（画像の見た目要約。ユーザー説明文は送らない） |
| `OPENAI_EMBEDDING_MODEL` | 既定 `text-embedding-3-small` |

シード画像を再生成する場合:

```bash
npm run seed:images
```

## API

| Method | Path | 説明 |
|--------|------|------|
| `GET` | `/api/health` | 稼働確認・プール件数 |
| `POST` | `/api/match` | multipart: `image` + `description` → 最適マッチを返し、投稿を保存 |
| `GET` | `/api/entries` | **件数のみ**（一覧は公開しない） |

## ディレクトリ構成

```
school-festival-exhibition/
├── index.html          # フロント（SPA風画面）
├── style.css
├── script.js
├── package.json
├── server/
│   ├── index.js        # Express エントリ
│   ├── match.js        # 画像類似度マッチ / 説明文NGチェック
│   ├── store.js        # entries.json / seeds 読み書き
│   └── generate-seeds.js
├── seeds/
│   ├── meta.json       # 初期シードの説明文
│   └── images/         # 初期画像（SVG）
├── data/
│   └── entries.json    # ユーザー投稿メタ（実行後に生成・gitignore）
├── uploads/            # ユーザー画像実体（gitignore）
└── README.md
```

## 制限・安全策

- 同意モーダルなしでは投稿画面へ進めない（セッション内で同意フラグを保持）
- 画像サイズ上限 **5MB**
- 説明文 **2〜120文字**、簡易 NG ワードチェック（クライアント＋サーバー）
- 不適切画像は運営側で手動削除（下記）

## 不適切投稿の削除手順

1. サーバーを止める（または書き込み中でないことを確認）
2. `data/entries.json` を開き、該当エントリ（`id` / `filename` / `description`）を削除して保存
3. `uploads/` 内の対応ファイル（`filename`）を削除
4. サーバーを再起動し、`GET /api/health` で件数が減っていることを確認

シード画像を外したい場合は `seeds/meta.json` から該当行を削除（または `seeds/images/` のファイルを削除）してください。

`data/entries.json` をまるごと消すと、ユーザー投稿プールだけ初期化されます（シードは残ります）。

```bash
# 例: ユーザー投稿を全クリア
rm data/entries.json
# Windows PowerShell:
Remove-Item data/entries.json -ErrorAction SilentlyContinue
```

`uploads/` 内の孤立ファイルも必要に応じて削除してください。

## 技術スタック

- フロント: HTML / CSS / JavaScript（フレームワークなし）
- バックエンド: Node.js + Express + multer
- 保存: `data/entries.json` + `uploads/`
- 照合: **画像のみ**（ローカル特徴 / OpenAI Vision＋Embedding。説明文は不使用）

## 公開について

展示は紙のQRと説明資料だけです。会場にPCは置きません。QRのリンク先は、インターネット上で動き続ける Node サーバーの `https://...` にしてください。来場者のスマホがそのURLを開くと、投稿はサーバーに保存され、次の来場者の候補になります。

`https://sato-weba.github.io/school-festival-exhibition/` は画面を配信するだけで、投稿を保存できません。このURLはQRに使わないでください。サーバーに繋がらないときは、用意した7枚だけとの照合結果は出しません。

`index.html` をダブルクリックした `file://` でも照合できません。

### Render に出す（会場の外で蓄積する）

`render.yaml` は、有料の Web サービスに 1GB のディスクを載せ、投稿を `/var/data` に残します。無料枠にはディスクが無く、再起動やスリープで来場者の投稿が消えます。

1. [Render](https://render.com) に GitHub アカウントでログインする
2. New → Blueprint で、このリポジトリを選ぶ
3. デプロイ後の `https://....onrender.com` をスマホで開き、写真を2回送る
4. 2回目の結果が、1回目に送った写真になり得ることを確認する
5. そのURLでQRを作る

環境変数 `DATA_DIR` を変えると、`data/entries.json` と `uploads/` の保存先を移動できます。未設定のときはこのフォルダの中です。
