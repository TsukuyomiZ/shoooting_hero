// 狂歡派對：狂熱提早從第 N 輪就觸發（之後照樣每隔幾輪再疊一層，見 shared/game/stage-rules.js）。
// 一關開場時 Match 問 feverFrom（場上玩家裡最早的那個輪數），連同人數一起交給關卡規則；客戶端用 start 的 carry 建同一個 Match，輪數照伺服器的，
// 所以兩邊的 match.fever 一樣。Boss 關照樣沒有狂熱（關卡規則說了算）。
// 狂熱疊上新的一層時，畫面上飄一群氣球（feverFx；只是演出，牌與版本履歷上都不寫）
export const party = {
  id: 'party',
  keys: { feverStartRound: '狂熱提早從第 N 輪就觸發（之後照樣每隔幾輪再疊一層；Boss 關沒有狂熱）' },
  feverFrom: (e) => (e.mods.feverStartRound > 0 ? e.mods.feverStartRound : 0),
  feverFx: (e) => (e.mods.feverStartRound > 0 ? [['ambient', 'balloons', 3.5]] : null),
  chipOrder: 280,
  // 這一關沒有狂熱（Boss 關）時用灰色
  chip(e, c) {
    const n = e.mods.feverStartRound;
    if (!(n > 0)) return null;
    return [`狂歡 第${n}輪`, c.match.rules.feverEvery > 0 ? '#f472b6' : '#64748b'];
  },
};
