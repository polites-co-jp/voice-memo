# Discord Voice Memo Automation

Discordに投稿された音声メッセージを自動で文字起こし・要約し、GitHubに保存するシステムです。

## 🌟 主な機能

- **自動文字起こし・要約**: Google Gemini 2.5 Flashを使用して、音声データの全文文字起こしと要約を生成します。
- **キーワード抽出**: 内容から自動的にキーワードを抽出し、タグ付けします。
- **GitHub保存**: 生成されたドキュメントをMarkdown形式でGitHubリポジトリに保存します。
- **相互リンク**: 音声メモとキーワードの間で相互リンクを生成し、知識ベース（Wiki）のように閲覧可能です。
- **Discord通知**: 処理の進捗と最終結果をDiscordの指定チャンネルにリアルタイムで投稿します。

## 🏗 アーキテクチャ

1.  **Discord (Interaction)**: ユーザーが音声メッセージを右クリック > 「文字起こし」を実行。
2.  **AWS Lambda (Dispatcher)**: 署名を検証し、即座に受付完了をDiscordに返信。裏側でWorkerを起動。
3.  **AWS Lambda (Worker)**: 
    - 音声ファイルをダウンロード。
    - **Gemini API** で解析（文字起こし・要約・キーワード）。
    - **GitHub API** でファイルを保存。
4.  **GitHub**: `音声メモ/` と `キーワード/` フォルダに整理して保存。

## 🚀 セットアップ

詳細な手順は [documents/セットアップガイド.md](documents/セットアップガイド.md) を参照してください。

### 1. 環境変数の設定
`.env` ファイルを作成し、以下の項目を設定します：

```env
DISCORD_PUBLIC_KEY=あなたのDiscordアプリのPublicKey
DISCORD_TOKEN=あなたのDiscordボットのToken
GEMINI_API_KEY=GoogleAIStudioで発行したAPIキー
GITHUB_TOKEN=GitHubのPersonalAccessToken
TARGET_REPO=owner/repo-name
TRANSCRIPT_CHANNEL_ID=文字起こし投稿先チャンネルID
SUMMARY_CHANNEL_ID=要約投稿先チャンネルID
```

### 2. デプロイ
```bash
npm install
npm run deploy  # または serverless deploy
```

### 3. コマンド登録
`register-commands.js` 内の `appId` を書き換え、以下を実行します：
```bash
node register-commands.js
```

## フォルダ構成 (GitHub)

- `音声メモ/`: 日時とタイトルをファイル名にした要約ファイルが保存されます。
- `キーワード/`: 抽出されたキーワードごとのインデックスファイルが保存されます。

## 📄 ライセンス
MIT
