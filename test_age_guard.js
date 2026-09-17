/**
 * test_age_guard.js — applyCollectorAgeGuard() のユニットテスト（自己完結型）。
 *
 * このリポジトリには既存のテストランナー／test_verify.js は見つからなかった
 * （2026-09-17時点、`find . -iname "*test*"` で確認）。panel.jsはビルド無しの
 * vanilla JSで、ブラウザ専用グローバル（chrome.*, document.*等）に依存する箇所が
 * 多いため、ファイル全体をrequireせず、対象関数のソースだけを正規表現で抜き出して
 * new Function() でサンドボックス評価する方式にした。
 *
 * 実行方法: node test_age_guard.js
 */
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, 'panel.js'), 'utf8');

function extractFunction(name) {
  var reStr = 'function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{';
  var re = new RegExp(reStr);
  var m = re.exec(src);
  if (!m) throw new Error('function not found in panel.js: ' + name);
  var start = m.index;
  var braceStart = src.indexOf('{', start);
  var depth = 0;
  var i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.substring(start, i);
}

var normalizeHtsnoSrc = extractFunction('normalizeHtsno');
var guardSrc = extractFunction('applyCollectorAgeGuard');

// normalizeHtsno() と applyCollectorAgeGuard() だけをサンドボックスで評価する
// （applyCollectorAgeGuard() は normalizeHtsno() に依存するため両方必要）。
var sandbox = new Function(
  normalizeHtsnoSrc + '\n' + guardSrc + '\nreturn applyCollectorAgeGuard;'
);
var applyCollectorAgeGuard = sandbox();

var cases = [
  {
    name: 'フィギュア 9503000073 + For Ages 15+ → 9503000090に補正',
    code: '9503000073',
    title: 'Used Alter Celty Figure For Ages 15+',
    expectCode: '9503000090',
    expectAdjusted: true
  },
  {
    name: 'おもちゃ 9503000073 + For Ages 6+ → 補正なし',
    code: '9503000073',
    title: 'Used Bandai Toy For Ages 6+',
    expectCode: '9503000073',
    expectAdjusted: false
  },
  {
    name: 'トレカ 9503000071 + For Ages 13+ → 9503000090に補正',
    code: '9503000071',
    title: 'Used Trading Card For Ages 13+',
    expectCode: '9503000090',
    expectAdjusted: true
  },
  {
    name: '既に9503000090 + For Ages 15+ → 補正なし（既にOther）',
    code: '9503000090',
    title: 'Used Figure For Ages 15+',
    expectCode: '9503000090',
    expectAdjusted: false
  },
  {
    name: '膨張式ボール 9503000013 + For Ages 15+ → 9503000090に補正',
    code: '9503000013',
    title: 'Used Ball For Ages 15+',
    expectCode: '9503000090',
    expectAdjusted: true
  },
  {
    name: '非9503コード 4202329550 + For Ages 15+ → 補正なし（対象外の見出し）',
    code: '4202329550',
    title: 'For Ages 15+',
    expectCode: '4202329550',
    expectAdjusted: false
  },
  {
    name: 'タイトル無し 9503000073 + "" → 9503000090に補正（既定For Ages 15+、reason:no_age）' +
      '（2026-09-17 製品オーナー方針拡張: ポケモンセンターぬいぐるみ実例を受け、' +
      '年齢表記が一切無い場合も既定でコレクター扱いに変更）',
    code: '9503000073',
    title: '',
    expectCode: '9503000090',
    expectAdjusted: true,
    expectReason: 'no_age'
  },
  {
    name: 'ドット付き入力 "9503.00.00.73" + For Ages 15+ → 9503000090に補正',
    code: '9503.00.00.73',
    title: 'Used Anime Figure ... For Ages 15+',
    expectCode: '9503000090',
    expectAdjusted: true
  },
  // ---- レビュー指摘によるエッジケース追加（2026-09-17） ----
  {
    name: '単数形 "For Age 15+"（Agesでなく Age）→ 9503000090に補正',
    code: '9503000073',
    title: 'Used Figure For Age 15+',
    expectCode: '9503000090',
    expectAdjusted: true
  },
  {
    name: '小文字＋"+"前にスペース "for ages 15 +" → 9503000090に補正',
    code: '9503000071',
    title: 'used trading card for ages 15 +',
    expectCode: '9503000090',
    expectAdjusted: true
  },
  {
    name: '年齢表記の後に語が続く "For Ages 15+ Boxless" → 9503000090に補正',
    code: '9503000073',
    title: 'Used Figure For Ages 15+ Boxless',
    expectCode: '9503000090',
    expectAdjusted: true
  },
  {
    name: 'コード末尾に空白 "9503000073 " → トリムされて9503000090に補正',
    code: '9503000073 ',
    title: 'Used Figure For Ages 15+',
    expectCode: '9503000090',
    expectAdjusted: true
  },
  {
    name: '8桁コード "95030000"（下2桁なし）→ クラッシュせず補正なし',
    code: '95030000',
    title: 'Used Figure For Ages 15+',
    expectCode: '95030000',
    expectAdjusted: false
  },
  {
    name: '既に9503000090（明示ケース、For Ages 13+側）→ 補正なし',
    code: '9503000090',
    title: 'Used Trading Card For Ages 13+',
    expectCode: '9503000090',
    expectAdjusted: false
  },
  {
    name: 'タイトル全体が小文字 "used figure for ages 15+" → 大文字小文字を区別せず補正',
    code: '9503000073',
    title: 'used figure for ages 15+',
    expectCode: '9503000090',
    expectAdjusted: true
  },
  {
    name: '【境界値】12桁の異常なコード "950300007399" → 10桁ちょうどでないため' +
      '素通り・補正なし（2026-09-17レビュー対応: 厳密10桁チェックを追加済み）',
    code: '950300007399',
    title: 'Used Figure For Ages 15+',
    expectCode: '950300007399',
    expectAdjusted: false
  },
  // ---- 製品オーナー方針拡張（2026-09-17・ポケモンセンターぬいぐるみ実例対応） ----
  // 実例: 新品ポケモンセンターのカイリューぬいぐるみが9503000073＋タイトルに
  // 年齢表記が一切無いまま確定してしまった。9503類はフィギュア/ぬいぐるみの
  // 区別なく既定でFor Ages 15+（コレクター）扱いにする方針のため、
  // タイトルに年齢表記が無い場合も.90へ補正する（reason:'no_age'）。
  {
    name: 'ポケモンセンターのぬいぐるみ 9503000073 + 年齢表記なしタイトル → ' +
      '9503000090に補正（reason:no_age）',
    code: '9503000073',
    title: 'Used Pokemon Charizard Plush',
    expectCode: '9503000090',
    expectAdjusted: true,
    expectReason: 'no_age'
  },
  {
    name: '明示的に12歳以下 9503000073 + For Ages 6+ → 補正なし（既存挙動を維持）',
    code: '9503000073',
    title: 'Used Bandai Toy For Ages 6+',
    expectCode: '9503000073',
    expectAdjusted: false
  },
  {
    name: '既に9503000090 + 年齢表記なし "Used Plush" → 補正なし（既にOther）',
    code: '9503000090',
    title: 'Used Plush',
    expectCode: '9503000090',
    expectAdjusted: false
  },
  {
    name: '非9503コード 4202329550 + 年齢表記なし "Used Bag" → 補正なし（対象外の見出し）',
    code: '4202329550',
    title: 'Used Bag',
    expectCode: '4202329550',
    expectAdjusted: false
  },
  {
    name: '新品ビーチボール 9503000013 + 年齢表記なし → 9503000090に補正（reason:no_age）',
    code: '9503000013',
    title: 'New Beach Ball',
    expectCode: '9503000090',
    expectAdjusted: true,
    expectReason: 'no_age'
  },
  // ---- 2026-09-17再レビュー（no_age拡張）指摘によるエッジケース追加 ----
  {
    name: '【要注意】"Ages"はあるが数字が続かない "For All Ages" → 年齢表記なし扱い' +
      '（no_ageとして.90に補正。厳密には"数字付きAges"の有無で判定しているだけで、' +
      '"Ages"という単語の存在自体は見ていない）',
    code: '9503000073',
    title: 'Used Figure Good For All Ages',
    expectCode: '9503000090',
    expectAdjusted: true,
    expectReason: 'no_age'
  },
  {
    name: '明示12+ "For Ages 12+" → 補正なし（12歳以下は素通りする仕様どおり）',
    code: '9503000073',
    title: 'Used Bandai Toy For Ages 12+',
    expectCode: '9503000073',
    expectAdjusted: false
  },
  {
    name: '【要注意・境界】"For"が無い "Age 15+"（Forを省略）→ 正規表現が拾えず' +
      'no_age扱いになる（結果的に.90で一致するが、ノート文言は「年齢表記なし」に' +
      'なり実際は年齢表記があった旨とズレる。AIが必ず"For Ages N+"の書式で書く' +
      '前提が崩れた場合の頑健性の限界を示すテスト）',
    code: '9503000073',
    title: 'Used Figure Age 15+',
    expectCode: '9503000090',
    expectAdjusted: true,
    expectReason: 'no_age'
  },
  {
    name: '【要注意・境界】年齢表記が2つ含まれるタイトル（先頭が6+、後ろが15+）→ ' +
      '正規表現は最初の一致（6+）だけを見るため補正なしになる（本来15+が正しい' +
      '意図でも、先に別の年齢表記があると子供向けコードのまま確定してしまうリスク）',
    code: '9503000073',
    title: 'Used Figure For Ages 6+ (was For Ages 15+ on source site)',
    expectCode: '9503000073',
    expectAdjusted: false
  }
];

var pass = 0, fail = 0;
cases.forEach(function(c) {
  var r = applyCollectorAgeGuard(c.code, c.title);
  var reasonOk = (c.expectReason === undefined) || (r.reason === c.expectReason);
  var ok = (r.code === c.expectCode) && (r.adjusted === c.expectAdjusted) && reasonOk;
  if (ok) {
    pass++;
    console.log('PASS: ' + c.name + ' => ' + JSON.stringify(r));
  } else {
    fail++;
    console.log('FAIL: ' + c.name);
    console.log('  input: code=' + c.code + ' title=' + JSON.stringify(c.title));
    console.log('  expected: code=' + c.expectCode + ' adjusted=' + c.expectAdjusted +
      (c.expectReason !== undefined ? ' reason=' + c.expectReason : ''));
    console.log('  actual:   code=' + r.code + ' adjusted=' + r.adjusted + ' from=' + r.from +
      ' reason=' + r.reason);
  }
});

console.log('---');
console.log('Total: ' + cases.length + ', Pass: ' + pass + ', Fail: ' + fail);
process.exit(fail > 0 ? 1 : 0);
