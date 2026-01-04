const axios = require('axios');
require('dotenv').config();

const appId = process.env.DISCORD_APP_ID; // Developer Portal > General Information > Application ID
const token = process.env.DISCORD_TOKEN;

const url = `https://discord.com/api/v10/applications/${appId}/commands`;

const commandData = {
  name: '文字起こし',
  type: 3, // MESSAGE context menu
};

async function registerCommand() {
  try {
    const res = await axios.post(url, commandData, {
      headers: { Authorization: `Bot ${token}` }
    });
    console.log('コマンドの登録に成功しました:', res.data);
  } catch (err) {
    console.error('コマンドの登録に失敗しました:', err.response?.data || err.message);
  }
}

registerCommand();
