const { verifyKey, InteractionType, InteractionResponseType } = require('discord-interactions');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Octokit } = require('@octokit/rest');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const discordPublicKey = process.env.DISCORD_PUBLIC_KEY;
const discordToken = process.env.DISCORD_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;
const targetRepo = process.env.TARGET_REPO;

// Geminiの初期化
const genAI = new GoogleGenerativeAI(geminiApiKey);

// Octokitの初期化
const octokit = new Octokit({ auth: githubToken });

// Lambda Clientの初期化
const lambdaClient = new LambdaClient({});

/**
 * ディスパッチャー: Discordからのリクエストを最初に受け取る
 */
module.exports.interaction = async (event) => {
  // 署名の検証
  const signature = event.headers['x-signature-ed25519'];
  const timestamp = event.headers['x-signature-timestamp'];
  const body = event.body;

  if (!verifyKey(body, signature, timestamp, discordPublicKey)) {
    console.log('Invalid signature');
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'invalid request signature' }),
    };
  }

  const interaction = JSON.parse(body);

  // PINGの処理
  if (interaction.type === InteractionType.PING) {
    return {
      statusCode: 200,
      body: JSON.stringify({ type: InteractionResponseType.PONG }),
    };
  }

  // アプリケーションコマンドの処理
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    // 音声添付ファイルのチェック
    const targetId = interaction.data.target_id;
    const resolvedMessage = interaction.data.resolved?.messages?.[targetId];
    const attachments = resolvedMessage?.attachments || [];
    const audioAttachment = attachments.find(a => a.content_type && a.content_type.startsWith('audio/'));

    if (!audioAttachment) {
      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '❌ 音声ファイルが見つかりませんでした。' },
      });
    }

    if (audioAttachment.size > 20 * 1024 * 1024) {
      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '❌ ファイルサイズが20MBを超えているため処理できません。' },
      });
    }

    // Worker Lambda を非同期で呼び出す
    try {
      const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME.replace(/-interaction$/, '-worker');
      const command = new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event', // 非同期呼び出し
        Payload: JSON.stringify({
          audioUrl: audioAttachment.url,
          interactionToken: interaction.token,
          applicationId: interaction.application_id,
          channelId: interaction.channel_id,
        }),
      });

      await lambdaClient.send(command);

      // Discordに「考えています...」状態（保留）を返す
      return jsonResponse({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      });
    } catch (err) {
      console.error('Worker起動失敗:', err);
      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `❌ システムエラーにより処理を開始できませんでした: ${err.message}` },
      });
    }
  }

  return { statusCode: 404 };
};

/**
 * ワーカー: 実際の重い処理（文字起こし、GitHub保存など）を実行
 */
module.exports.worker = async (event) => {
  const { audioUrl, interactionToken, applicationId, channelId } = event;

  try {
    await processVoiceMemo(audioUrl, interactionToken, applicationId, channelId);
  } catch (err) {
    console.error('Worker処理失敗:', err);
    await sendFollowup(applicationId, interactionToken, `❌ 処理中にエラーが発生しました: ${err.message}`);
  }
};

const jsonResponse = (data) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

/**
 * Discordにフォローアップメッセージを送信する（保留レスポンス後の返信）
 */
async function sendFollowup(applicationId, token, content) {
  const url = `https://discord.com/api/v10/webhooks/${applicationId}/${token}`;
  try {
    await axios.post(url, { content });
  } catch (err) {
    console.error('Followup送信失敗:', err.response?.data || err.message);
  }
}

/**
 * Discordに進捗メッセージを送信するヘルパー（Webhookを使用）
 */
async function sendProgress(applicationId, token, content) {
  const url = `https://discord.com/api/v10/webhooks/${applicationId}/${token}`;
  try {
    await axios.post(url, { content: `> 🔄 **進捗**: ${content}` });
  } catch (err) {
    console.error('Discord進捗送信失敗:', err.response?.data || err.message);
  }
}

/**
 * 指定されたチャンネルにメッセージを投稿するヘルパー（Bot Tokenを使用）
 */
async function postToChannel(channelId, content) {
  if (!channelId || !discordToken) return;
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  try {
    await axios.post(url, { content }, {
      headers: { Authorization: `Bot ${discordToken}` }
    });
  } catch (err) {
    console.error(`チャンネル ${channelId} への送信失敗:`, err.response?.data || err.message);
  }
}

/**
 * 音声メモの処理
 */
async function processVoiceMemo(fileUrl, interactionToken, applicationId, channelId) {
  // 1. ファイルのダウンロード
  await sendProgress(applicationId, interactionToken, "音声ファイルを検知。処理を開始します...");
  
  const tmpPath = path.join(os.tmpdir(), `audio_${Date.now()}`);
  const writer = fs.createWriteStream(tmpPath);
  
  const response = await axios({
    url: fileUrl,
    method: 'GET',
    responseType: 'stream',
  });

  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  // 2. Geminiによる文字起こしと要約
  await sendProgress(applicationId, interactionToken, "ダウンロード完了。Gemini 2.5 Flash による解析を開始...");
  
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const fileData = fs.readFileSync(tmpPath);
  const audioPart = {
    inlineData: {
      data: fileData.toString('base64'),
      mimeType: response.headers['content-type'] || 'audio/mp3',
    },
  };

  const prompt = `
  この音声ファイルを文字起こしし、以下のフォーマットでMarkdownとして出力してください。
  1行目はタイトル（音声の内容を要約した短いタイトル）にしてください。

  # [タイトル]

  ## キーワード
  (ここにキーワードをカンマ区切りで最大5つ程度抽出してください)

  ## 要約
  (ここに要約)

  ## 文字起こし
  (ここに全文文字起こし)
  `;

  const result = await model.generateContent([prompt, audioPart]);
  let text = result.response.text();

  await sendProgress(applicationId, interactionToken, "Gemini解析完了。GitHubへの保存（アトミックコミット）を開始...");

  // タイトル、キーワードの抽出
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : 'No Title';
  const keywordMatch = text.match(/## キーワード\s*([\s\S]*?)(?=##|$)/);
  let keywords = [];
  if (keywordMatch) {
    const keywordText = keywordMatch[1].trim();
    keywords = keywordText.split(/[,、\n\r]+/).map(k => k.trim()).filter(k => k && k !== '-');
  }
  
  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  
  const baseFilename = `${dateStr}_${title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
  const summaryPath = `音声メモ/${year}/${month}/${baseFilename}`;

  // 本文内のキーワード領域をリンクに書き換え（年月フォルダを考慮して相対パス調整）
  if (keywordMatch) {
    const originalKeywordBlock = keywordMatch[0];
    const linkedKeywords = keywords.map(k => {
      const kwCleanup = k.replace(/[\\/:*?"<>|]/g, '_');
      return `[${k}](../../../キーワード/${kwCleanup}.md)`;  // 音声メモ/YYYY/MM/ から キーワード/ へ
    }).join(', ');
    const newKeywordBlock = `## キーワード\n${linkedKeywords}\n\n`;
    text = text.replace(originalKeywordBlock, newKeywordBlock);
  }

  // 3. GitHubへのアトミックコミット
  const [owner, repo] = targetRepo.split('/');
  
  // コミットするファイルをまとめるためのリスト
  const filesToCommit = [];
  
  // A. 要約ファイルを追加
  filesToCommit.push({
    path: summaryPath,
    content: text
  });

  // B. キーワードインデックスファイルを追加/更新
  for (const keyword of keywords) {
    const kwCleanup = keyword.replace(/[\\/:*?"<>|]/g, '_');
    if (!kwCleanup) continue;
    
    const kwPath = `キーワード/${kwCleanup}.md`;
    const link = `\n- [${baseFilename}](../音声メモ/${year}/${month}/${baseFilename})`;  // 年月フォルダ含むパス
    
    try {
      let newC = '';
      try {
        // 既存ファイルを個別に取得（あとでまとめてcreateTreeするため、ここではコンテントだけ得る）
        const { data: extF } = await octokit.repos.getContent({ owner, repo, path: kwPath });
        newC = Buffer.from(extF.content, 'base64').toString('utf-8') + link;
      } catch (e) {
        if (e.status === 404) newC = `# ${keyword}\n${link}`;
        else throw e;
      }
      
      filesToCommit.push({
        path: kwPath,
        content: newC
      });
    } catch (e) {
      console.error(`Failed to prepare keyword ${keyword}:`, e);
    }
  }

  // Git Data API を使用して1つのコミットにまとめる
  try {
    // 1. 最新のコミットSHAを取得
    const { data: refData } = await octokit.git.getRef({ owner, repo, ref: 'heads/main' });
    const lastCommitSha = refData.object.sha;
    
    // 2. そのコミットのTree SHAを取得
    const { data: commitData } = await octokit.git.getCommit({ owner, repo, commit_sha: lastCommitSha });
    const baseTreeSha = commitData.tree.sha;

    // 3. 新しいTreeオブジェクトを作成
    const tree = filesToCommit.map(f => ({
      path: f.path,
      mode: '100644', // 100644 = file (blob)
      type: 'blob',
      content: f.content
    }));

    const { data: newTreeData } = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: tree
    });

    // 4. 新しいコミットを作成
    const { data: newCommitData } = await octokit.git.createCommit({
      owner,
      repo,
      message: `Add voice memo summary and update keywords: ${title}`,
      tree: newTreeData.sha,
      parents: [lastCommitSha]
    });

    // 5. ブランチの参照を更新
    await octokit.git.updateRef({
      owner,
      repo,
      ref: 'heads/main',
      sha: newCommitData.sha
    });

  } catch (err) {
    console.error('アトミックコミット失敗:', err);
    throw new Error(`GitHubへのアトミックコミットに失敗しました: ${err.message}`);
  }

  await sendProgress(applicationId, interactionToken, "GitHubへの一括保存が完了しました。最終結果を投稿します...");

  // 4. Discordへの投稿
  const transId = process.env.TRANSCRIPT_CHANNEL_ID;
  const summId = process.env.SUMMARY_CHANNEL_ID;

  if (transId) await postToChannel(transId, `📄 **文字起こし全文: ${title}**\n\n${text}`);
  if (summId) {
    const sMatch = text.match(/## 要約\s*([\s\S]*?)(?=##|$)/);
    const summary = sMatch ? sMatch[1].trim() : '要約の抽出に失敗しました。';
    await postToChannel(summId, `📌 **要約: ${title}**\n\n${summary}`);
  }

  // 最終的な完了報告
  await sendFollowup(applicationId, interactionToken, `✅ **処理完了**: 「${title}」を1つのコミットで保存・投稿しました。`);

  // クリーンアップ
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
}
