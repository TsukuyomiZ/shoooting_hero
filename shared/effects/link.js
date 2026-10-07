import { CONFIG } from '../config.js';

// 攜手之伴：選牌時指定一名隊友「連結」（target: 'teammate'：抽牌、選牌、自動代選、選牌畫面都照這個）。
// 連結對象記在角色的 links（雙向，肉鴿流程的 linksOf；Match 建角色時只認這一關真的有的隊友）。
// 被打時：傷害先 -link.damageCutPct%，再跟活著的連結對象平分（share；畫面的連結標記、分擔飄字照 links / damages 畫）
export const link = {
  id: 'link',
  keys: {
    link: {
      desc: `選牌時指定一名隊友「連結」（填 1）：兩人受到的傷害先 -${CONFIG.EQUIP.link.damageCutPct}%，再跟活著的連結對象平分`,
      instant: true, teamOnly: true,
    },
  },
  target: 'teammate',
  // 選牌第一輪：這張牌有連結（now.link）就把指定的隊友記進自己的 links（target = run.js 照選牌訊息、超時代選定下的那位；沒人可選 = null）
  picked(p, now, pool, target) {
    if (now.link > 0 && target) p.links.push(target);
  },
  // 爆炸算好 hit.e 這一下要扣多少之後（還沒扣血）：減傷後取整，每個連結對象分到一樣多，除不盡的餘數算被打的人的；分到 0 就不用分。
  // 分到的那份一樣會被神佑之石擋下（無敵只用掉一次）；清單裡多一筆 shared = 被打的人
  share(match, hit, { alive0, shielded, block, friendly, damages }) {
    const partners = match.linkPartners(hit.e).filter(q => alive0.has(q));
    if (!partners.length) return;
    const cut = Math.max(0, 1 - CONFIG.EQUIP.link.damageCutPct / 100);
    const total = Math.round(hit.own * cut);
    const each = Math.floor(total / (partners.length + 1));
    hit.own = total - each * partners.length;
    if (each > 0) {
      for (const q of partners) {
        const s = { id: q.id, dmg: 0, friendly, shared: hit.e.id };
        damages.push(s);
        if (shielded.has(q)) { block(q); s.blocked = true; }
        else hit.shares.push({ q, entry: s, amount: each });
      }
    }
  },
  chipOrder: 270,
  // 自己選的或被選的都算：活著的才有在分，倒下的另外標
  chip(e, c) {
    if (!e.links.length) return null;
    const partners = c.match.linkPartners(e);
    const nameOf = (id) => { const q = c.match.byId(id); return q ? q.name : id; };
    const up = partners.map(q => q.name).join('、');
    const down = e.links.filter(id => !partners.some(q => q.id === id)).map(nameOf).join('、');
    return partners.length ? [`連結 ${up}${down ? `（${down} 倒下了）` : ''}`, '#f0abfc'] : [`連結（${down} 倒下了）`, '#64748b'];
  },
  // 選牌畫面：拿這張牌要先選一位隊友（others = 那位隊友已經連結的其他人的名字）
  pickText: {
    need: '要選一位隊友',
    none: '隊友都已經跟你連結了',
    title: (card) => `「${card.name}」：選一位隊友成為「連結」`,
    button: (name) => `連結 ${name}`,
    hint(others) {
      const cut = CONFIG.EQUIP.link.damageCutPct;
      return others.length
        ? `他已經跟 ${others.join('、')} 連結：受到的傷害 -${cut}%，再跟連結的人一起平分`
        : `兩人受到的傷害 -${cut}%，再平分`;
    },
  },
};
