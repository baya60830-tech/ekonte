# 絵コンテ自動生成 Webアプリ

企画概要から Claude が構成を作り、Nano Banana (Gemini 2.5 Flash Image) が各カットの画像を生成、Googleスプレッドシートに画像つきで出力します。

## 使い方の流れ

1. 企画概要・尺・カット数を入力 → **① 構成を生成**
2. 表が出たら必要に応じてセルを編集 → **② 画像を一括生成**（個別 [再生成] ボタンもあり）
3. **③ Googleスプシに出力** → 画像つき新規スプシが開く

## セットアップ

### 1. 依存インストール
```bash
cd ekonte-app
npm install
```

### 2. APIキーを設定
`.env.example` を `.env.local` にコピーして埋める：
```bash
cp .env.example .env.local
```

- `ANTHROPIC_API_KEY` — https://console.anthropic.com/
- `GEMINI_API_KEY` — https://aistudio.google.com/apikey
- Google OAuth (Sheets/Drive 書き込み用)
  - GCP コンソールで OAuth クライアント (Desktop or Web) を作成
  - リダイレクトURI: `http://localhost:3939/api/oauth/callback`
  - Sheets API と Drive API を有効化
  - クライアントID/シークレットを `.env.local` に貼る

### 3. 起動 & 初回認証
```bash
npm run dev
```
ブラウザで `http://localhost:3939` → フッターの `/api/oauth/start` をクリック → Googleで承認 → 表示される `refresh_token` を `.env.local` の `GOOGLE_REFRESH_TOKEN=` に貼り付け → サーバー再起動。

## 列構成（参照スプシに準拠）

A:カット番号 / B:イメージ(画像) / C:秒 / D:累計 / E:シーン内容 / F:映像 / G:構図・カメラワーク / H:テロップ / I:ナレーション / J:BGM・効果音 / K:訴求ポイント

## 注意

- 画像は Drive にアップ → 公開リンク → `=IMAGE()` 関数で埋め込み。出力スプシと同じGoogleアカウントで開けば問題ありません。第三者と共有する場合は、Driveの画像ファイル側の共有設定を確認してください。
- Drive にアップした画像は削除しないでください（スプシの画像が消えます）。
- 生成した動画ファイルや既存の素材は触りません。
