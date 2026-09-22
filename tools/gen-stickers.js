'use strict';

/**
 * 表情包生成器：程序化绘制一套「猫咪」SVG 表情 + 文字表情
 * 用法: node tools/gen-stickers.js  （产物写入 public/stickers/，并生成 index.json 清单）
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'public', 'stickers');
fs.mkdirSync(OUT, { recursive: true });

const INK = '#3B2F23';
const FUR = '#FFD9A0';
const FUR_D = '#E8A04C';
const BLUSH = '#FFA8A8';
const MOUTH_C = '#A3474D';
const TONGUE = '#F08C94';

const HEART = 'M0 6 C -6 -7 -21 -4 -21 4 C -21 13 -8 19 0 25 C 8 19 21 13 21 4 C 21 -4 6 -7 0 6 Z';

const EARS = `<path d="M58 76 L44 22 L106 56 Z" fill="${FUR}" stroke="${FUR_D}" stroke-width="5" stroke-linejoin="round"/>
<path d="M70 68 L64 40 L96 56 Z" fill="#FF9E9E"/>
<path d="M182 76 L196 22 L134 56 Z" fill="${FUR}" stroke="${FUR_D}" stroke-width="5" stroke-linejoin="round"/>
<path d="M170 68 L176 40 L144 56 Z" fill="#FF9E9E"/>`;

const WHISKERS = `<g stroke="${FUR_D}" stroke-width="4" stroke-linecap="round">
<line x1="30" y1="148" x2="60" y2="152"/><line x1="30" y1="166" x2="60" y2="166"/>
<line x1="210" y1="148" x2="180" y2="152"/><line x1="210" y1="166" x2="180" y2="166"/></g>`;

const EYES = {
  open: (x, y) => `<ellipse cx="${x}" cy="${y}" rx="10" ry="14" fill="${INK}"/><circle cx="${x - 3}" cy="${y - 5}" r="3.2" fill="#fff"/>`,
  happy: (x, y) => `<path d="M${x - 14} ${y + 5} Q${x} ${y - 14} ${x + 14} ${y + 5}" stroke="${INK}" stroke-width="6" fill="none" stroke-linecap="round"/>`,
  heart: (x, y) => `<path transform="translate(${x} ${y + 6}) scale(0.85)" d="${HEART}" fill="#F5566B"/>`,
  shock: (x, y) => `<circle cx="${x}" cy="${y}" r="13" fill="${INK}"/><circle cx="${x - 4}" cy="${y - 5}" r="4" fill="#fff"/>`,
  x: (x, y) => `<g stroke="${INK}" stroke-width="6" stroke-linecap="round"><line x1="${x - 11}" y1="${y - 9}" x2="${x + 11}" y2="${y + 9}"/><line x1="${x + 11}" y1="${y - 9}" x2="${x - 11}" y2="${y + 9}"/></g>`,
  sleepy: (x, y) => `<path d="M${x - 14} ${y - 2} Q${x} ${y + 12} ${x + 14} ${y - 2}" stroke="${INK}" stroke-width="6" fill="none" stroke-linecap="round"/><line x1="${x - 17}" y1="${y - 13}" x2="${x - 13}" y2="${y - 5}" stroke="${INK}" stroke-width="4" stroke-linecap="round"/><line x1="${x - 5}" y1="${y - 17}" x2="${x - 3}" y2="${y - 7}" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`,
};

const MOUTHS = {
  smile: `<path d="M98 172 Q120 194 142 172" stroke="${INK}" stroke-width="6" fill="none" stroke-linecap="round"/>`,
  laugh: `<path d="M96 168 Q120 204 144 168 Q120 180 96 168 Z" fill="${MOUTH_C}"/><path d="M106 180 Q120 192 134 180 Q120 188 106 180 Z" fill="${TONGUE}"/>`,
  frown: `<path d="M100 188 Q120 170 140 188" stroke="${INK}" stroke-width="6" fill="none" stroke-linecap="round"/>`,
  wave: `<path d="M94 176 q8 -12 16 0 t16 0 t16 0 t14 0" stroke="${INK}" stroke-width="6" fill="none" stroke-linecap="round"/>`,
  o: `<ellipse cx="120" cy="180" rx="9" ry="11" fill="${MOUTH_C}"/>`,
  smirk: `<path d="M102 180 Q124 190 142 170" stroke="${INK}" stroke-width="6" fill="none" stroke-linecap="round"/>`,
  heart: `<path transform="translate(120 178) scale(0.8)" d="${HEART}" fill="#F5566B"/>`,
};

const EXTRAS = {
  tears: `<path d="M62 148 q-9 18 0 26 q9 -8 0 -26 Z" fill="#7FC8E8"/><path d="M178 148 q-9 18 0 26 q9 -8 0 -26 Z" fill="#7FC8E8"/>`,
  brows: `<line x1="68" y1="104" x2="98" y2="114" stroke="${INK}" stroke-width="7" stroke-linecap="round"/><line x1="172" y1="104" x2="142" y2="114" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>`,
  glasses: `<rect x="60" y="110" width="52" height="28" rx="12" fill="${INK}"/><rect x="128" y="110" width="52" height="28" rx="12" fill="${INK}"/><line x1="112" y1="122" x2="128" y2="122" stroke="${INK}" stroke-width="6"/>`,
  zzz: `<text x="150" y="78" font-size="30" font-weight="bold" fill="#7C6CF0" font-family="sans-serif">z</text><text x="174" y="58" font-size="22" font-weight="bold" fill="#9D8CF5" font-family="sans-serif">z</text>`,
  hearts: `<path transform="translate(52 58) scale(0.5)" d="${HEART}" fill="#F5566B"/><path transform="translate(188 62) scale(0.45)" d="${HEART}" fill="#FF8FA3"/>`,
  stars: `<path d="M58 60 L66 74 L80 78 L68 88 L70 102 L58 94 L46 102 L48 88 L36 78 L50 74 Z" fill="#F5C518"/><path d="M184 52 L190 63 L202 66 L193 75 L195 87 L184 81 L173 87 L175 75 L166 66 L178 63 Z" fill="#FFD54A"/>`,
  bigBlush: `<ellipse cx="64" cy="158" rx="22" ry="13" fill="${BLUSH}" opacity="0.85"/><ellipse cx="176" cy="158" rx="22" ry="13" fill="${BLUSH}" opacity="0.85"/>`,
};

function catSvg(eyes, mouth, extras = []) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">
${EARS}
<ellipse cx="120" cy="138" rx="84" ry="76" fill="${FUR}" stroke="${FUR_D}" stroke-width="5"/>
<ellipse cx="66" cy="158" rx="15" ry="9" fill="${BLUSH}" opacity="0.65"/>
<ellipse cx="174" cy="158" rx="15" ry="9" fill="${BLUSH}" opacity="0.65"/>
${EYES[eyes[0]](88, 128)}
${EYES[eyes[1]](152, 128)}
<ellipse cx="120" cy="162" rx="11" ry="8" fill="#E8869E"/>
${MOUTHS[mouth]}
${WHISKERS}
${extras.map(e => EXTRAS[e]).join('\n')}
</svg>`;
}

const CAT = [
  { f: 'happy',  t: '开心', eyes: ['open', 'open'], mouth: 'smile' },
  { f: 'laugh',  t: '哈哈', eyes: ['happy', 'happy'], mouth: 'laugh' },
  { f: 'love',   t: '爱心', eyes: ['heart', 'heart'], mouth: 'smile', extra: ['hearts'] },
  { f: 'cry',    t: '哭哭', eyes: ['open', 'open'], mouth: 'wave', extra: ['tears'] },
  { f: 'angry',  t: '生气', eyes: ['open', 'open'], mouth: 'frown', extra: ['brows'] },
  { f: 'cool',   t: '酷', eyes: ['open', 'open'], mouth: 'smirk', extra: ['glasses'] },
  { f: 'shock',  t: '震惊', eyes: ['shock', 'shock'], mouth: 'o' },
  { f: 'sleepy', t: '困了', eyes: ['sleepy', 'sleepy'], mouth: 'wave', extra: ['zzz'] },
  { f: 'dizzy',  t: '晕晕', eyes: ['x', 'x'], mouth: 'wave', extra: ['stars'] },
  { f: 'shy',    t: '害羞', eyes: ['happy', 'happy'], mouth: 'smile', extra: ['bigBlush'] },
  { f: 'wink',   t: '调皮', eyes: ['open', 'happy'], mouth: 'laugh' },
  { f: 'kiss',   t: '亲亲', eyes: ['happy', 'happy'], mouth: 'heart', extra: ['hearts'] },
];

const TEXT = ['收到', '谢谢', '加油', '晚安', '哈哈哈', '打call'];
const COLORS = ['#07c160', '#5b8def', '#f5a623', '#fa5151', '#7c6cf0', '#00a896'];

function textSvg(t, color) {
  const size = t.length >= 5 ? 48 : t.length === 4 ? 56 : 68;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">
<rect x="6" y="6" width="228" height="228" rx="44" fill="${color}"/>
<text x="120" y="${size === 68 ? 152 : 146}" font-size="${size}" font-weight="700" fill="#fff" text-anchor="middle" font-family="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">${t}</text>
</svg>`;
}

const manifest = [];
CAT.forEach(c => {
  fs.writeFileSync(path.join(OUT, c.f + '.svg'), catSvg(c.eyes, c.mouth, c.extra || []));
  manifest.push({ file: c.f + '.svg', label: c.t });
});
TEXT.forEach((t, i) => {
  fs.writeFileSync(path.join(OUT, 'text' + i + '.svg'), textSvg(t, COLORS[i % COLORS.length]));
  manifest.push({ file: 'text' + i + '.svg', label: t });
});

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(manifest));
console.log(`已生成 ${manifest.length} 个表情包 -> ${OUT}`);
