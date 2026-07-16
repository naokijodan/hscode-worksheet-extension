'use strict';

/**
 * panel.js — HSコードワークシート作成君
 * オフライン動作・AIなし・Vanilla JS
 */

// -------------------------------------------------------
// 状態管理
// -------------------------------------------------------
var state = {
  flows: null,         // flows.json の内容
  chapterIndex: null,  // chapter_index.json の内容

  // 検索インデックス（遅延ロード）
  searchIndex: null,      // 配列: [{h, d, c, g}, ...]
  searchMap: null,        // Map: normalizeHtsno(h) -> {d, g}
  searchIndexLoading: false,
  searchIndexCallbacks: [],

  // 別名辞書（遅延ロード）
  aliases: null,          // Object: 別名キー(小文字) -> [正規化コード, ...]
  aliasesLoading: false,
  aliasesCallbacks: [],

  // ウィザード
  currentCategory: null,   // { id, label, chapter, start }
  wizardHistory: [],
  currentNodeId: null,

  leafKey: null,     // leaves のキー
  leafData: null,    // leaves[leafKey]

  // 結果フォーム値
  brand: '',
  model: '',
  customTitle: '',
  country: '',
  qty: 1,
  value: '',
  currency: 'USD',

  // 確認ウィザード
  confirmBlock: 1,
  confirmDone: false,

  // 会社情報
  company: { name: '', nameTitle: '', email: '', phone: '', certifierName: '', address: '', certifierTitle: '' },

  // ブラウズ
  browseChapter: null,     // 現在開いている章 { chapter, title, count }
  browseChapterData: null, // その章のデータ配列（lazy-loaded）

  // CPSC eFiling 機能（v1.1.0）
  cpsc: null,    // cpsc_efiling_hts.json の内容
  cpscWiz: null, // CPSC判定ウィザード状態
  openaiKey: '',

  // TSCA証明書（FedEx）機能（v1.3.0／複数商品対応 v1.4.0）
  tsca: {
    templateLoaded: false,
    pageCount: null,
    products: [],       // 作業中の商品リスト: [{ description }]。同梱発送など複数商品分をここに貯める
    editingIndex: null, // 商品リストの何番目を編集中か（nullなら新規追加モード）
    form: null,  // 確認画面へ進んだ時点のスナップショット（form.products が確定した商品リスト）
    completed: false // PDFダウンロード成功済みフラグ。trueのまま「ホームへ」を押すとフォームを完全クリアする。
                     // フォームに戻って編集を再開した時点でfalseに戻す（編集内容を黙って消さないため）。
  },
};

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------
function showSection(id) {
  var sections = ['sectionHome', 'sectionBrowse', 'sectionSettings', 'sectionWizard',
                  'sectionResult', 'sectionConfirm', 'sectionPrint',
                  'sectionCpscWiz', 'sectionCpscResult', 'sectionTsca',
                  'watch_sectionInput', 'watch_sectionWizard', 'watch_sectionPrint'];
  sections.forEach(function(sid) {
    var el = document.getElementById(sid);
    if (el) el.style.display = (sid === id) ? '' : 'none';
  });
}

function showMessage(el, type, text) {
  el.className = 'message ' + type;
  el.textContent = text;
  el.style.display = '';
}

function normalizeHtsno(code) {
  return code.replace(/[.\-\s]/g, '');
}

/** Strip all dots, hyphens, and spaces from a code for display/storage. */
function stripDots(s) {
  return (s == null ? '' : String(s)).replace(/[.\-\s]/g, '');
}

/**
 * dotCode(s) — periodless code → dotted HTSUS/HS form for USITC URL.
 *   10 digits → 4-2-2-2  e.g. "9503000011" → "9503.00.00.11"
 *    8 digits → 4-2-2    e.g. "91011140"   → "9101.11.40"
 *    6 digits → 4-2      e.g. "950300"     → "9503.00"
 *   other     → returned as-is
 */
function dotCode(s) {
  var c = (s == null ? '' : String(s)).replace(/[.\-\s]/g, '');
  if (c.length === 10) {
    return c.slice(0,4) + '.' + c.slice(4,6) + '.' + c.slice(6,8) + '.' + c.slice(8,10);
  }
  if (c.length === 8) {
    return c.slice(0,4) + '.' + c.slice(4,6) + '.' + c.slice(6,8);
  }
  if (c.length === 6) {
    return c.slice(0,4) + '.' + c.slice(4,6);
  }
  return c;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/** Open USITC HTS search for the current code, or alert if no code set. */
function openVerifyHts() {
  var code = (state.leafData && state.leafData.htsus) ? state.leafData.htsus : '';
  if (!code) {
    alert('先にコードを決めてください');
    return;
  }
  var dotted = dotCode(code);
  var url = 'https://hts.usitc.gov/search?query=' + encodeURIComponent(dotted);
  chrome.tabs.create({ url: url });
}

/** Open CBP CROSS rulings home page. */
function openVerifyCross() {
  chrome.tabs.create({ url: 'https://rulings.cbp.gov/home' });
}

// -------------------------------------------------------
// データロード（起動時: flows.json + chapter_index.json のみ）
// -------------------------------------------------------
function loadFlows(cb) {
  fetch(chrome.runtime.getURL('data/flows.json'))
    .then(function(r){ return r.json(); })
    .then(function(d){ state.flows = d; cb(); })
    .catch(function(e){ console.error('flows.json load error', e); });
}

function loadChapterIndex(cb) {
  fetch(chrome.runtime.getURL('data/chapter_index.json'))
    .then(function(r){ return r.json(); })
    .then(function(d){ state.chapterIndex = d; if (cb) cb(); })
    .catch(function(e){ console.error('chapter_index.json load error', e); if (cb) cb(); });
}

// -------------------------------------------------------
// 遅延ロード: search_index.json（初回アクセス時のみ）
// -------------------------------------------------------
function ensureSearchIndex(cb) {
  // Already loaded
  if (state.searchIndex && state.searchMap) {
    cb();
    return;
  }
  // Queue callback if already loading
  if (state.searchIndexLoading) {
    state.searchIndexCallbacks.push(cb);
    return;
  }

  state.searchIndexLoading = true;
  fetch(chrome.runtime.getURL('data/search_index.json'))
    .then(function(r){ return r.json(); })
    .then(function(d){
      state.searchIndex = d;
      // Build lookup map: normalizeHtsno(h) -> {d, g}
      state.searchMap = new Map();
      d.forEach(function(item) {
        if (item.h) {
          state.searchMap.set(normalizeHtsno(item.h), { d: item.d, g: item.g });
        }
      });
      state.searchIndexLoading = false;
      // Fire all queued callbacks
      var cbs = state.searchIndexCallbacks.splice(0);
      cb();
      cbs.forEach(function(fn){ fn(); });
    })
    .catch(function(e) {
      console.error('search_index.json load error', e);
      state.searchIndexLoading = false;
      // Fallback: try hts_seed.json
      fetch(chrome.runtime.getURL('data/hts_seed.json'))
        .then(function(r){ return r.json(); })
        .then(function(d){
          state.searchIndex = d.map(function(r){
            return { h: r.htsno || '', d: r.description || '', c: '', g: r.general || '' };
          });
          state.searchMap = new Map();
          state.searchIndex.forEach(function(item){
            if (item.h) state.searchMap.set(normalizeHtsno(item.h), { d: item.d, g: item.g });
          });
          cb();
          var cbs = state.searchIndexCallbacks.splice(0);
          cbs.forEach(function(fn){ fn(); });
        })
        .catch(function(){
          state.searchIndex = [];
          state.searchMap = new Map();
          cb();
          var cbs = state.searchIndexCallbacks.splice(0);
          cbs.forEach(function(fn){ fn(); });
        });
    });
}

// -------------------------------------------------------
// 別名辞書ロード
// -------------------------------------------------------
function ensureAliases(cb) {
  if (state.aliases) { cb(); return; }
  if (state.aliasesLoading) { state.aliasesCallbacks.push(cb); return; }
  state.aliasesLoading = true;
  fetch(chrome.runtime.getURL('data/aliases.json'))
    .then(function(r) { return r.json(); })
    .then(function(d) {
      state.aliases = d;
      state.aliasesLoading = false;
      cb();
      var cbs = state.aliasesCallbacks.splice(0);
      cbs.forEach(function(fn) { fn(); });
    })
    .catch(function() {
      state.aliases = {};
      state.aliasesLoading = false;
      cb();
      var cbs = state.aliasesCallbacks.splice(0);
      cbs.forEach(function(fn) { fn(); });
    });
}

// -------------------------------------------------------
// カテゴリリスト構築
// -------------------------------------------------------
function buildCategoryList() {
  var list = document.getElementById('categoryList');
  list.innerHTML = '';
  if (!state.flows) return;
  state.flows.categories.forEach(function(cat) {
    var btn = document.createElement('button');
    btn.className = 'category-btn';
    btn.innerHTML = escapeHtml(cat.label) +
      '<span class="category-chapter">Ch.' + escapeHtml(String(cat.chapter)) + '</span>';
    btn.addEventListener('click', function() {
      startWizard(cat);
    });
    list.appendChild(btn);
  });
}

// -------------------------------------------------------
// ウィザード
// -------------------------------------------------------
function startWizard(cat) {
  state.currentCategory = cat;
  state.wizardHistory = [];
  state.currentNodeId = cat.start;
  state.leafKey = null;
  state.leafData = null;

  document.getElementById('wizardTitle').textContent =
    cat.label.length > 20 ? cat.label.substring(0, 20) + '…' : cat.label;

  showSection('sectionWizard');
  renderWizardNode(state.currentNodeId);
}

function renderWizardNode(nodeId) {
  var node = state.flows.nodes[nodeId];
  if (!node) {
    showMessage(document.getElementById('wizardProgress'), 'error',
      'ノード ' + nodeId + ' が見つかりません。flows.json を確認してください。');
    return;
  }

  updateWizardProgress();

  var body = document.getElementById('wizardBody');
  body.innerHTML = '';

  // パンくず
  if (state.wizardHistory.length > 0) {
    var bc = document.createElement('div');
    bc.className = 'wiz-breadcrumb';
    bc.textContent = state.wizardHistory.map(function(h) {
      return h.answerLabel;
    }).join(' › ');
    body.appendChild(bc);
  }

  // 質問
  var q = document.createElement('div');
  q.className = 'wiz-question';
  q.textContent = node.question;
  body.appendChild(q);

  // 選択肢
  var ansDiv = document.createElement('div');
  ansDiv.className = 'wiz-answers';
  node.answers.forEach(function(ans) {
    var btn = document.createElement('button');
    btn.className = 'wiz-answer-btn';
    btn.textContent = ans.label;
    btn.addEventListener('click', function() {
      handleAnswer(nodeId, node, ans);
    });
    ansDiv.appendChild(btn);
  });
  body.appendChild(ansDiv);

  // 戻るボタン
  if (state.wizardHistory.length > 0) {
    var backBtn = document.createElement('button');
    backBtn.className = 'wiz-back-btn';
    backBtn.textContent = '← 前の質問に戻る';
    backBtn.addEventListener('click', function() {
      goBackWizard();
    });
    body.appendChild(backBtn);
  }
}

function handleAnswer(nodeId, node, ans) {
  // 履歴に追加
  state.wizardHistory.push({
    nodeId: nodeId,
    question: node.question,
    answerLabel: ans.label,
    answers: node.answers
  });

  if (ans.leaf) {
    // 葉ノードに到達
    state.leafKey = ans.leaf;
    state.leafData = state.flows.leaves[ans.leaf] || null;
    state.browseChapter = null;
    showResult();
  } else if (ans.next) {
    state.currentNodeId = ans.next;
    renderWizardNode(ans.next);
  }
}

function goBackWizard() {
  if (state.wizardHistory.length === 0) return;
  state.wizardHistory.pop();
  if (state.wizardHistory.length === 0) {
    state.currentNodeId = state.currentCategory.start;
    renderWizardNode(state.currentNodeId);
  } else {
    var prev = state.wizardHistory[state.wizardHistory.length - 1];
    state.currentNodeId = prev.nodeId;
    renderWizardNode(prev.nodeId);
  }
}

function updateWizardProgress() {
  var steps = state.wizardHistory.length + 1;
  document.getElementById('wizardProgress').textContent =
    'ステップ ' + steps + ' — ' + (state.currentCategory ? state.currentCategory.label : '');
}

// -------------------------------------------------------
// 結果表示
// -------------------------------------------------------
function showResult() {
  var leaf = state.leafData;
  if (!leaf) {
    alert('このコードのデータが見つかりませんでした。キーワード検索か手動入力をお使いください。');
    return;
  }

  document.getElementById('resultHtsus').textContent = stripDots(leaf.htsus || state.leafKey || '');
  document.getElementById('resultHs6').textContent = stripDots(leaf.hs6 || '');
  document.getElementById('resultDesc').textContent = leaf.desc || '';
  document.getElementById('resultDuty').textContent = leaf.duty || '(情報なし)';
  document.getElementById('manualHtsus').value = stripDots(leaf.htsus || '');

  // 入力フィールドをクリア
  document.getElementById('inputBrand').value = state.brand || '';
  document.getElementById('inputModel').value = state.model || '';
  var condSel = document.getElementById('inputCondition'); if (condSel && state.condition) condSel.value = state.condition;
  document.getElementById('inputTitle').value = '';
  document.getElementById('inputCountry').value = state.country || '';
  document.getElementById('inputQty').value = state.qty || 1;
  document.getElementById('inputValue').value = state.value || '';
  document.getElementById('inputCurrency').value = state.currency || 'USD';

  showSection('sectionResult');
  saveProgress();
  renderCpscAlert(stripDots(leaf.htsus || state.leafKey || ''));
}

// 与えられたコードが flows に登録済みの直接コード葉なら、そのテンプレを返す（未登録なら汎用）
function templateForCode(clean) {
  var lf = (state.flows && state.flows.leaves) ? state.flows.leaves[clean] : null;
  return (lf && lf.title_template) ? lf.title_template : '{brand} Item';
}

function generateTitle() {
  var leaf = state.leafData;
  if (!leaf) return '';
  var template = leaf.title_template || '{brand} Item';
  var hasCondition = template.indexOf('{condition}') !== -1;
  // {condition}入りテンプレ（コレクター帯）はブランド未入力でも 'Used' を入れない（状態語が別途入るため重複防止）
  var brand = document.getElementById('inputBrand').value.trim() || (hasCondition ? '' : 'Used');
  var model = document.getElementById('inputModel').value.trim();
  var condEl = document.getElementById('inputCondition');
  var condition = condEl ? condEl.value : 'Pre-Owned';
  var title = template.replace(/{condition}/g, condition).replace(/{brand}/g, brand).replace(/{model}/g, model);
  title = title.replace(/{strap_material}/g, 'Leather/Metal');
  title = title.replace(/{item_type}/g, 'Jewelry');
  if (model && title.indexOf(model) === -1) {
    title = title + ' ' + model;
  }
  return title.replace(/\s+/g, ' ').trim();
}

// -------------------------------------------------------
// キーワード検索（search_index.json 全98章対象 + 別名辞書）
// -------------------------------------------------------
function doSearch(keyword) {
  keyword = keyword.trim().toLowerCase();
  if (!keyword) return;

  var container = document.getElementById('searchResults');
  container.innerHTML = '<div class="search-no-results">検索中…</div>';
  container.style.display = '';

  // search_index と aliases を両方ロードしてから検索実行
  ensureSearchIndex(function() {
    ensureAliases(function() {
      if (!state.searchIndex || state.searchIndex.length === 0) {
        container.innerHTML = '<div class="search-no-results">検索データが読み込めませんでした。</div>';
        return;
      }

      // --- (1) 別名辞書ヒット（先頭に追加） ---
      var seenCodes = {};  // 重複排除用: 正規化コード -> true
      var aliasResults = [];
      var aliases = state.aliases || {};
      // 完全一致: keyword がそのまま alias キー
      // 部分一致: keyword がキーを含む or キーが keyword を含む
      Object.keys(aliases).forEach(function(aliasKey) {
        if (aliasKey === '_comment') return;
        var matched = (aliasKey === keyword) ||
                      (aliasKey.indexOf(keyword) !== -1) ||
                      (keyword.indexOf(aliasKey) !== -1);
        if (!matched) return;
        var codes = aliases[aliasKey];
        if (!Array.isArray(codes)) return;
        codes.forEach(function(nc) {
          if (seenCodes[nc]) return;
          var mapEntry = state.searchMap ? state.searchMap.get(nc) : null;
          if (!mapEntry) return;
          seenCodes[nc] = true;
          // search_index の元エントリを引く（h を含む完全なオブジェクトで渡す）
          // searchMap は {d, g} のみなので、h を再組み立て
          aliasResults.push({ h: nc, d: mapEntry.d, c: '', g: mapEntry.g });
        });
      });

      // --- (2) 英語説明・コード照合（既存ロジック） ---
      var keywordNorm = normalizeHtsno(keyword);
      var engResults = [];
      state.searchIndex.forEach(function(item) {
        if (!item.h) return;
        var nc = normalizeHtsno(item.h);
        if (seenCodes[nc]) return;  // alias 済みは除外（重複排除）
        var desc = (item.d || '').toLowerCase();
        var htsno = (item.h || '').toLowerCase();
        var htsnoNorm = normalizeHtsno(htsno);
        if (desc.indexOf(keyword) !== -1 ||
            htsno.indexOf(keyword) !== -1 ||
            (keywordNorm && htsnoNorm.indexOf(keywordNorm) !== -1)) {
          seenCodes[nc] = true;
          engResults.push(item);
        }
      });

      // 英語ヒットは 10桁コード優先でソート
      engResults.sort(function(a, b) {
        var aLen = normalizeHtsno(a.h || '').length;
        var bLen = normalizeHtsno(b.h || '').length;
        return bLen - aLen;
      });

      // alias ヒットを先頭、英語ヒットを後続に結合
      var results = aliasResults.concat(engResults);

      container.innerHTML = '';

      if (results.length === 0) {
        var div = document.createElement('div');
        div.className = 'search-no-results';
        div.textContent = '「' + keyword + '」に一致するコードが見つかりませんでした。英語キーワードもお試しください。';
        container.appendChild(div);
        return;
      }

      var shown = results.slice(0, 30);
      shown.forEach(function(item) {
        var el = document.createElement('div');
        el.className = 'search-result-item';
        el.innerHTML =
          '<div class="search-result-code">' + escapeHtml(stripDots(item.h || '')) + '</div>' +
          '<div class="search-result-desc">' + escapeHtml(item.d || '') + '</div>';
        el.addEventListener('click', function() {
          selectSearchResult(item);
        });
        container.appendChild(el);
      });

      if (results.length > 30) {
        var more = document.createElement('div');
        more.className = 'search-no-results';
        more.textContent = '他 ' + (results.length - 30) + ' 件（キーワードを絞ると絞り込めます）';
        container.appendChild(more);
      }
    });
  });
}

function selectSearchResult(item) {
  var htsno = item.h || '';
  var clean = normalizeHtsno(htsno);
  var hs6 = clean.substring(0, 6);

  state.leafData = {
    htsus: clean,
    hs6: hs6,
    desc: item.d || '',
    duty: item.g || '(情報なし)',
    title_template: templateForCode(clean)
  };
  state.leafKey = clean;
  state.currentCategory = null;
  state.browseChapter = null;

  document.getElementById('searchResults').style.display = 'none';
  document.getElementById('keywordInput').value = '';

  showResult();
}

// -------------------------------------------------------
// 手動コード適用（search_index で lookup）
// -------------------------------------------------------
function applyManualCode() {
  var val = document.getElementById('manualHtsus').value.trim();
  if (!val) return;
  var clean = normalizeHtsno(val);

  // コードを変更していない場合は既存 leafData（ウィザードで選んだ種類別テンプレ）を維持し、上書きしない
  var currentClean = state.leafData ? normalizeHtsno(state.leafData.htsus || '') : '';
  if (state.leafData && state.leafData.title_template && clean === currentClean) {
    document.getElementById('resultHtsus').textContent = stripDots(state.leafData.htsus || '');
    document.getElementById('resultHs6').textContent = stripDots(state.leafData.hs6 || '');
    return;
  }

  ensureSearchIndex(function() {
    var found = state.searchMap ? state.searchMap.get(clean) : null;
    if (found) {
      state.leafData = {
        htsus: clean,
        hs6: clean.substring(0, 6),
        desc: found.d || '',
        duty: found.g || '(情報なし)',
        title_template: templateForCode(clean)
      };
      state.leafKey = clean;
    } else {
      // コードがデータにない場合でも手動で設定
      state.leafData = state.leafData || {};
      state.leafData.htsus = clean || val;
      state.leafData.hs6 = clean.length >= 6 ? clean.substring(0, 6) : clean;
      alert('このコードはデータベースに見つかりませんでした。手動入力として処理します。');
    }
    document.getElementById('resultHtsus').textContent = stripDots(state.leafData.htsus);
    document.getElementById('resultHs6').textContent = stripDots(state.leafData.hs6 || '');
    if (found) {
      document.getElementById('resultDesc').textContent = state.leafData.desc;
      document.getElementById('resultDuty').textContent = state.leafData.duty;
    }
    renderCpscAlert(state.leafData.htsus || '');
  });
}

// -------------------------------------------------------
// 章ブラウズ — Step A: 章リスト
// -------------------------------------------------------
function showBrowse() {
  state.browseChapter = null;
  state.browseChapterData = null;
  document.getElementById('browseTitle').textContent = '章から探す';
  document.getElementById('browseStepA').style.display = '';
  document.getElementById('browseStepB').style.display = 'none';
  document.getElementById('chapterFilterInput').value = '';
  renderChapterList('');
  showSection('sectionBrowse');
}

function renderChapterList(filter) {
  var list = document.getElementById('chapterList');
  list.innerHTML = '';
  if (!state.chapterIndex) {
    list.innerHTML = '<div class="search-no-results">章リストが読み込めませんでした。</div>';
    return;
  }
  var filterLow = filter.toLowerCase().trim();
  var shown = 0;
  state.chapterIndex.forEach(function(ch) {
    var chNum = ch.chapter || '';
    var chTitle = ch.title || '';
    if (filterLow) {
      var numMatch = chNum.indexOf(filterLow) !== -1;
      var titleMatch = chTitle.toLowerCase().indexOf(filterLow) !== -1;
      if (!numMatch && !titleMatch) return;
    }
    var item = document.createElement('div');
    item.className = 'chapter-item';
    item.innerHTML =
      '<span class="chapter-item-label">第' + escapeHtml(chNum) + '章 ' + escapeHtml(chTitle) + '</span>' +
      '<span class="chapter-item-count">' + (ch.count || 0) + '行</span>';
    item.addEventListener('click', function() {
      openChapterTree(ch);
    });
    list.appendChild(item);
    shown++;
  });
  if (shown === 0) {
    list.innerHTML = '<div class="search-no-results">「' + escapeHtml(filter) + '」に一致する章が見つかりませんでした。</div>';
  }
}

// -------------------------------------------------------
// 章ブラウズ — Step B: 章内ツリー
// -------------------------------------------------------
function openChapterTree(ch) {
  state.browseChapter = ch;
  document.getElementById('browseTitle').textContent = '第' + ch.chapter + '章';
  document.getElementById('browseChapterTitle').textContent = '第' + ch.chapter + '章: ' + ch.title;
  document.getElementById('browseStepA').style.display = 'none';
  document.getElementById('browseStepB').style.display = '';

  var treeDiv = document.getElementById('browseTree');
  treeDiv.innerHTML = '<div class="search-no-results">読み込み中…</div>';

  // Lazy-load chapter data
  var chNum = ch.chapter;
  fetch(chrome.runtime.getURL('data/chapters/ch' + chNum + '.json'))
    .then(function(r){ return r.json(); })
    .then(function(data){
      state.browseChapterData = data;
      renderTree(treeDiv, data);
    })
    .catch(function(e){
      console.error('ch' + chNum + '.json load error', e);
      treeDiv.innerHTML = '<div class="search-no-results">データの読み込みに失敗しました。</div>';
    });
}

/**
 * renderTree — indent値でグループ分けして collapsible ツリーを構築。
 * indent=0 をトップレベルとし、各行を親-子関係で DOM に構築する。
 * 初期状態はトップレベル（indent=0/1）のみ表示、それ以下は折りたたみ。
 */
function renderTree(container, rows) {
  container.innerHTML = '';

  // Build tree nodes structure
  // Each node: { row, children: [], parentEl: null, childrenEl: null }
  var treeNodes = rows.map(function(row) {
    return { row: row, children: [], el: null, childrenEl: null, expanded: false };
  });

  // Assign children via indent levels
  // Stack-based approach: maintain a stack per indent level
  var stack = []; // [{indent, node}]
  treeNodes.forEach(function(node) {
    var indent = parseInt(node.row.indent || '0', 10);
    // Pop stack until top has indent < current
    while (stack.length > 0 && stack[stack.length-1].indent >= indent) {
      stack.pop();
    }
    if (stack.length > 0) {
      stack[stack.length-1].node.children.push(node);
    }
    stack.push({ indent: indent, node: node });
  });

  // Find root nodes (those without a parent in the tree)
  // Root nodes are those at indent 0, or if no indent-0 rows exist, the minimum indent
  var rootNodes = [];
  treeNodes.forEach(function(node) {
    node._isChild = false;
  });
  treeNodes.forEach(function(node) {
    node.children.forEach(function(child) {
      child._isChild = true;
    });
  });
  treeNodes.forEach(function(node) {
    if (!node._isChild) rootNodes.push(node);
  });

  // Render root nodes into container — cap at 500 for performance (ch99 etc.)
  var ROOT_CAP = 500;
  var initialRoots = rootNodes.length > ROOT_CAP ? rootNodes.slice(0, ROOT_CAP) : rootNodes;
  initialRoots.forEach(function(node) {
    renderTreeNode(container, node, 0);
  });

  if (rootNodes.length > ROOT_CAP) {
    var remaining = rootNodes.length - ROOT_CAP;
    var showAllBtn = document.createElement('button');
    showAllBtn.className = 'btn btn-ghost btn-sm';
    showAllBtn.style.margin = '8px 0';
    showAllBtn.textContent = 'すべて表示（残り ' + remaining + ' 件）';
    showAllBtn.addEventListener('click', function() {
      showAllBtn.remove();
      rootNodes.slice(ROOT_CAP).forEach(function(node) {
        renderTreeNode(container, node, 0);
      });
    });
    container.appendChild(showAllBtn);
  }
}

function renderTreeNode(parentEl, node, depth) {
  var row = node.row;
  var hasChildren = node.children.length > 0;
  var htsno = row.htsno || '';
  var clean = normalizeHtsno(htsno);
  var desc = row.description || '';
  var general = row.general || '';
  var hasCode = htsno.trim() !== '';

  // Determine if this is a "recommended" (leaf/full) code
  // 10-digit or 8-digit codes are the deepest selectable codes
  var isRecommended = hasCode && clean.length >= 8;

  // Build row element
  var rowEl = document.createElement('div');
  rowEl.className = 'tree-row';
  if (hasChildren) rowEl.classList.add('tree-expandable');
  if (!hasCode) rowEl.classList.add('tree-heading-row');
  if (isRecommended) rowEl.classList.add('tree-recommended');

  // Indent via padding
  var indentPx = depth * 14;
  rowEl.style.paddingLeft = (8 + indentPx) + 'px';

  // Toggle icon
  var toggleEl = document.createElement('span');
  toggleEl.className = 'tree-toggle';
  if (hasChildren) {
    toggleEl.textContent = '▶';
  } else {
    toggleEl.textContent = '';
  }
  rowEl.appendChild(toggleEl);

  // Code display
  var codeEl = document.createElement('span');
  codeEl.className = 'tree-code';
  codeEl.textContent = hasCode ? stripDots(htsno) : '';
  rowEl.appendChild(codeEl);

  // Description
  var descEl = document.createElement('span');
  descEl.className = 'tree-desc';
  descEl.textContent = desc;
  rowEl.appendChild(descEl);

  // Select button (only for rows with a code)
  if (hasCode) {
    var selBtn = document.createElement('button');
    selBtn.className = 'tree-select-btn';
    selBtn.textContent = '選択';
    selBtn.title = 'このコードで進む';
    selBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      selectTreeCode(htsno, desc, general);
    });
    rowEl.appendChild(selBtn);
  }

  // Expand/collapse on row click (for expandable rows)
  if (hasChildren) {
    var childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children';
    childrenEl.style.display = 'none';
    node.expanded = false;
    node.childrenEl = childrenEl;
    node.toggleEl = toggleEl;

    rowEl.addEventListener('click', function(e) {
      if (e.target.classList.contains('tree-select-btn')) return;
      if (!node.expanded) {
        // Lazy-render children on first expand
        if (childrenEl.childNodes.length === 0) {
          node.children.forEach(function(child) {
            renderTreeNode(childrenEl, child, depth + 1);
          });
        }
        childrenEl.style.display = '';
        toggleEl.textContent = '▼';
        node.expanded = true;
      } else {
        childrenEl.style.display = 'none';
        toggleEl.textContent = '▶';
        node.expanded = false;
      }
    });

    parentEl.appendChild(rowEl);
    parentEl.appendChild(childrenEl);
  } else {
    parentEl.appendChild(rowEl);
  }
}

function selectTreeCode(htsno, desc, general) {
  var clean = normalizeHtsno(htsno);
  var hs6 = clean.substring(0, 6);

  state.leafData = {
    htsus: clean,
    hs6: hs6,
    desc: desc || '',
    duty: general || '(情報なし)',
    title_template: templateForCode(clean)
  };
  state.leafKey = clean;
  state.currentCategory = null;

  showResult();
}

// -------------------------------------------------------
// CPSC eFiling 対応機能（v1.1.0）
// 機能A: 600リスト照合アラート
// 機能B: CPSC判定サブウィザード
// 機能C: Regulatory Robotガイド
// -------------------------------------------------------

/** CPSC規制マッピング（参考のみ・断定禁止） */
var CPSC_STANDARDS = {
  toys:                       ['ASTM F963 (16 CFR Part 1250)／玩具安全', '16 CFR Part 1501／小部品', '16 CFR Part 1303／鉛塗料（塗装あり）', '16 CFR Part 1500／有害物質'],
  clothing:                   ['16 CFR Part 1610／可燃性', '16 CFR Part 1615・1616／子ども用寝巻き・パジャマ', '装飾金具等の鉛含有'],
  child_chairs:               ['耐久型育児製品 16 CFR Part 1231等', '鉛 16 CFR Part 1303', '小部品規制', 'トラッキングラベル'],
  carriages_and_strollers:    ['16 CFR Part 1227'],
  infant_sleep_products:      ['16 CFR Part 1236（Safe Sleep規則）'],
  pacifiers:                  ['16 CFR Part 1511'],
  other_childrens_furniture:  ['鉛 16 CFR Part 1303', '小部品規制', 'トラッキングラベル'],
  mattresses:                 ['16 CFR Part 1632・1633／可燃性'],
  carpets_and_rugs:           ['16 CFR Part 1630・1631／可燃性'],
  bicycle_helmets:            ['16 CFR Part 1203'],
  bicycles:                   ['16 CFR Part 1512'],
  cigarette_lighters:         ['16 CFR Part 1210（チャイルドレジスタント）'],
  button_cell_batteries:      ["Reese's Law（16 CFR Part 1263）"],
  imitation_jewelry:          ['鉛・カドミウム（CPSIA鉛含有／16 CFR Part 1303）'],
  shoes:                      ['16 CFR Part 1610／可燃性（繊維製）'],
  atvs:                       ['16 CFR Part 1420'],
  gates_and_enclosures:       ['育児用ゲート ASTM（16 CFR Part 1239等）'],
  fireworks:                  ['16 CFR Part 1500・1507'],
  matchbooks:                 ['16 CFR Part 1202'],
  drywall:                    ['CPSC石膏ボード規則'],
  lawn_mowers:                ['16 CFR Part 1205'],
  poison_prevention_packaging:['PPPA 16 CFR Part 1700'],
  cb_antennae:                ['16 CFR Part 1402']
};

/** 児童製品のみのカテゴリ（13歳以上なら児童規制は不適用→参考表示に格下げ） */
var CPSC_CHILDRENS_ONLY = ['toys', 'child_chairs', 'carriages_and_strollers',
  'infant_sleep_products', 'pacifiers', 'other_childrens_furniture'];

/** 対象年齢に関係なく規制が適用される一般製品カテゴリ */
var CPSC_GENERAL = ['mattresses', 'carpets_and_rugs', 'bicycle_helmets', 'bicycles',
  'cigarette_lighters', 'button_cell_batteries', 'shoes', 'lawn_mowers', 'atvs',
  'cb_antennae', 'fireworks', 'matchbooks', 'drywall', 'gates_and_enclosures',
  'poison_prevention_packaging'];
// clothing と imitation_jewelry は個別扱い

/** CPSCデータロード（起動時） */
function loadCpscData() {
  fetch(chrome.runtime.getURL('data/cpsc_efiling_hts.json'))
    .then(function(r) { return r.json(); })
    .then(function(d) { state.cpsc = d; })
    .catch(function(e) { console.error('cpsc_efiling_hts.json load error', e); });
}

/**
 * 機能A: cpscCheck(code10) — 10桁コードをCPSC対象リストと照合
 * @returns {{level:'red'|'yellow'|'gray', catKey, nameJa, certHint, chapter}}
 */
function cpscCheck(code10) {
  var norm = normalizeHtsno(code10);
  // 10桁ガード: 不完全コードは章一致による誤yellowを避け gray とする
  if (norm.length !== 10) {
    return { level: 'gray', catKey: null, nameJa: null, certHint: null, chapter: '' };
  }
  var chapter = norm.substring(0, 2);
  if (!state.cpsc) return { level: 'gray', catKey: null, nameJa: null, certHint: null, chapter: chapter };

  // 1. byCode で完全一致（red）
  var catKey = (state.cpsc.byCode && norm) ? (state.cpsc.byCode[norm] || null) : null;
  if (catKey) {
    var cat = null;
    (state.cpsc.categories || []).forEach(function(c) { if (c.key === catKey) cat = c; });
    return {
      level: 'red',
      catKey: catKey,
      nameJa: cat ? cat.name_ja : catKey,
      certHint: cat ? cat.cert_hint : null,
      chapter: chapter
    };
  }

  // 2. 章（2桁）で部分一致（yellow）
  var chapMatch = !!(state.cpsc.chapters && chapter &&
    state.cpsc.chapters.indexOf(chapter) !== -1);
  if (chapMatch) {
    return { level: 'yellow', catKey: null, nameJa: null, certHint: null, chapter: chapter };
  }

  // 3. 不一致（gray）
  return { level: 'gray', catKey: null, nameJa: null, certHint: null, chapter: chapter };
}

/**
 * 機能A: renderCpscAlert(code10) — #cpscAlertBox に赤/黄/灰アラートを描画。
 * showResult() と applyManualCode() の両方から呼ぶ。
 */
function renderCpscAlert(code10) {
  var box = document.getElementById('cpscAlertBox');
  if (!box) return;
  box.innerHTML = '';
  if (!code10 || !state.cpsc) return;

  var r = cpscCheck(code10);
  var div = document.createElement('div');
  div.className = 'cpsc-alert cpsc-alert-' + r.level;

  var titleText, bodyText;
  if (r.level === 'red') {
    titleText = '⚠ CPSC eFiling 対象リストに該当';
    bodyText  = 'このHTSコードはCPSCの電子申告スクリーニング対象（' + (r.nameJa || r.catKey) +
                'カテゴリ）で、米国の税関で確認されます。必要な対応（適合証明の提出 か「対象外（disclaim）」申告）は、商品の対象年齢などで変わります。下の「CPSCの対象か詳しく調べる」で確認してください。';
  } else if (r.level === 'yellow') {
    titleText = '⚠ CPSC eFiling 対象の可能性';
    bodyText  = 'このコードは対象リストに一致しませんでしたが、同じHTS章（第' + r.chapter +
                '類）に対象品があります。対象かどうか・必要な対応は対象年齢などで変わります。下の判定と Regulatory Robot で確認してください。';
  } else {
    titleText = 'ℹ 600コードリストには一致しませんでした';
    bodyText  = 'ただしこのリストは全ての対象を網羅していません。対象外と断定せず、念のため確認してください。';
  }

  var titleEl = document.createElement('div');
  titleEl.className = 'cpsc-alert-title';
  titleEl.textContent = titleText;

  var bodyEl = document.createElement('div');
  bodyEl.className = 'cpsc-alert-body';
  bodyEl.textContent = bodyText;

  var btn = document.createElement('button');
  btn.className = 'btn-cpsc btn-cpsc-' + r.level;
  btn.textContent = 'CPSCの対象か詳しく調べる ▶';
  btn.addEventListener('click', function() { startCpscWizard(r); });

  var robotNote = document.createElement('div');
  robotNote.className = 'cpsc-alert-note';
  robotNote.textContent = '※最終確認はCPSC公式ツール（Regulatory Robot）で行ってください';

  var disclaimerNote = document.createElement('div');
  disclaimerNote.className = 'cpsc-alert-note';
  disclaimerNote.textContent = '最終的な分類・申告の責任は輸出者にあります。';

  div.appendChild(titleEl);
  div.appendChild(bodyEl);
  div.appendChild(btn);
  div.appendChild(robotNote);
  div.appendChild(disclaimerNote);
  box.appendChild(div);
}

// -------------------------------------------------------
// 機能B: CPSC判定サブウィザード
// -------------------------------------------------------

function startCpscWizard(cpscResult) {
  state.cpscWiz = {
    level:     cpscResult.level,
    catKey:    cpscResult.catKey,
    nameJa:    cpscResult.nameJa,
    certHint:  cpscResult.certHint,
    chapter:   cpscResult.chapter,
    step:      1,
    hasStep2:  false,
    ageGroup:  null,
    isPajamas: null,
    features:  [],
    breadcrumb: []
  };
  showSection('sectionCpscWiz');
  renderCpscWizBody();
}

function renderCpscWizBody() {
  var wiz = state.cpscWiz;
  var body = document.getElementById('cpscWizBody');
  body.innerHTML = '';

  // ステップ表示計算
  var totalSteps, displayStep;
  if (wiz.step === 1) {
    totalSteps = 3; displayStep = 1;
  } else if (wiz.step === 2) {
    totalSteps = 3; displayStep = 2;
  } else {
    totalSteps  = wiz.hasStep2 ? 3 : 2;
    displayStep = totalSteps;
  }
  document.getElementById('cpscWizProgress').textContent =
    'CPSC判定 — ステップ ' + displayStep + ' / ' + totalSteps;

  // パンくず
  var catLabel = wiz.nameJa || ('第' + wiz.chapter + '類');
  var bc = document.createElement('div');
  bc.className = 'wiz-breadcrumb';
  bc.textContent = [catLabel].concat(wiz.breadcrumb).join(' › ');
  body.appendChild(bc);

  if (wiz.step === 1) {
    renderCpscStep1(body);
  } else if (wiz.step === 2) {
    renderCpscStep2(body);
  } else {
    renderCpscStep3(body);
  }
}

function renderCpscStep1(body) {
  var q = document.createElement('div');
  q.className = 'wiz-question';
  q.textContent = 'この商品は誰向けですか？';
  body.appendChild(q);

  var ansDiv = document.createElement('div');
  ansDiv.className = 'wiz-answers';
  var choices = [
    { label: '0〜12歳向け（子ども向け）', value: '0-12' },
    { label: '13歳以上向け',              value: '13plus' }
  ];
  choices.forEach(function(ch) {
    var btn = document.createElement('button');
    btn.className = 'wiz-answer-btn';
    btn.textContent = ch.label;
    (function(val, lbl) {
      btn.addEventListener('click', function() {
        state.cpscWiz.ageGroup = val;
        state.cpscWiz.breadcrumb.push(lbl);
        var isClothingChild = (state.cpscWiz.catKey === 'clothing') && (val === '0-12');
        state.cpscWiz.hasStep2 = isClothingChild;
        state.cpscWiz.step = isClothingChild ? 2 : 3;
        renderCpscWizBody();
      });
    }(ch.value, ch.label));
    ansDiv.appendChild(btn);
  });
  body.appendChild(ansDiv);
}

function renderCpscStep2(body) {
  var q = document.createElement('div');
  q.className = 'wiz-question';
  q.textContent = '子ども用の寝巻き・パジャマですか？';
  body.appendChild(q);

  var ansDiv = document.createElement('div');
  ansDiv.className = 'wiz-answers';
  var choices = [
    { label: 'はい（寝巻き・パジャマ・ナイトウェア）', value: true },
    { label: 'いいえ（それ以外の子ども服）',           value: false }
  ];
  choices.forEach(function(ch) {
    var btn = document.createElement('button');
    btn.className = 'wiz-answer-btn';
    btn.textContent = ch.label;
    (function(val, lbl) {
      btn.addEventListener('click', function() {
        state.cpscWiz.isPajamas = val;
        state.cpscWiz.breadcrumb.push(lbl);
        state.cpscWiz.step = 3;
        renderCpscWizBody();
      });
    }(ch.value, ch.label));
    ansDiv.appendChild(btn);
  });
  body.appendChild(ansDiv);

  var backBtn = document.createElement('button');
  backBtn.className = 'wiz-back-btn';
  backBtn.textContent = '← 前の質問に戻る';
  backBtn.addEventListener('click', function() {
    state.cpscWiz.step = 1;
    state.cpscWiz.ageGroup = null;
    state.cpscWiz.hasStep2 = false;
    state.cpscWiz.breadcrumb.pop();
    renderCpscWizBody();
  });
  body.appendChild(backBtn);
}

function renderCpscStep3(body) {
  var q = document.createElement('div');
  q.className = 'wiz-question';
  q.textContent = '当てはまる特徴はどれですか？（複数可）';
  body.appendChild(q);

  var featureDefs = [
    { key: 'battery',    label: '電池・充電が必要' },
    { key: 'flammable',  label: '可燃性の素材を含む' },
    { key: 'painted',    label: '塗装・コーティングあり' },
    { key: 'smallparts', label: '小さな部品あり（3歳未満が誤飲するリスク）' },
    { key: 'none',       label: '特に当てはまらない' }
  ];

  var selected = {};
  var ansDiv = document.createElement('div');
  ansDiv.className = 'wiz-answers';

  featureDefs.forEach(function(feat) {
    var btn = document.createElement('button');
    btn.className = 'wiz-answer-btn';
    btn.setAttribute('data-feat', feat.key);
    btn.textContent = feat.label;
    (function(fkey, fbtn) {
      fbtn.addEventListener('click', function() {
        if (fkey === 'none') {
          Object.keys(selected).forEach(function(k) { delete selected[k]; });
          ansDiv.querySelectorAll('.wiz-answer-btn').forEach(function(b) {
            b.classList.remove('wiz-answer-selected');
          });
          selected['none'] = true;
          fbtn.classList.add('wiz-answer-selected');
        } else {
          delete selected['none'];
          var noneBtn = ansDiv.querySelector('[data-feat="none"]');
          if (noneBtn) noneBtn.classList.remove('wiz-answer-selected');
          if (selected[fkey]) {
            delete selected[fkey];
            fbtn.classList.remove('wiz-answer-selected');
          } else {
            selected[fkey] = true;
            fbtn.classList.add('wiz-answer-selected');
          }
        }
      });
    }(feat.key, btn));
    ansDiv.appendChild(btn);
  });
  body.appendChild(ansDiv);

  var backBtn = document.createElement('button');
  backBtn.className = 'wiz-back-btn';
  backBtn.textContent = '← 前の質問に戻る';
  backBtn.addEventListener('click', function() {
    if (state.cpscWiz.hasStep2) {
      state.cpscWiz.step = 2;
      state.cpscWiz.isPajamas = null;
      state.cpscWiz.breadcrumb.pop();
    } else {
      state.cpscWiz.step = 1;
      state.cpscWiz.ageGroup = null;
      state.cpscWiz.breadcrumb.pop();
    }
    renderCpscWizBody();
  });
  body.appendChild(backBtn);

  var doneDiv = document.createElement('div');
  doneDiv.style.marginTop = '14px';
  var doneBtn = document.createElement('button');
  doneBtn.className = 'btn btn-primary';
  doneBtn.textContent = '判定結果を見る →';
  doneBtn.addEventListener('click', function() {
    state.cpscWiz.features = Object.keys(selected);
    showCpscResult();
  });
  doneDiv.appendChild(doneBtn);
  body.appendChild(doneDiv);
}

// -------------------------------------------------------
// 機能B: 判定結果カード + 機能C: Regulatory Robotガイド
// -------------------------------------------------------

/** Q3特徴（battery/smallparts/painted/flammable）による追加規制を base 配列に重複なく加える */
function addFeatureStandards(stds) {
  var feats = (state.cpscWiz && state.cpscWiz.features) || [];
  if (feats.indexOf('painted') !== -1 &&
      stds.indexOf('16 CFR Part 1303／鉛塗料（塗装あり）') === -1) {
    stds.push('16 CFR Part 1303／鉛塗料（塗装あり）');
  }
  if (feats.indexOf('flammable') !== -1 &&
      stds.indexOf('16 CFR Part 1610／可燃性') === -1) {
    stds.push('16 CFR Part 1610／可燃性');
  }
  if (feats.indexOf('smallparts') !== -1 &&
      stds.indexOf('16 CFR Part 1501／小部品') === -1) {
    stds.push('16 CFR Part 1501／小部品');
  }
  if (feats.indexOf('battery') !== -1 &&
      stds.indexOf("16 CFR Part 1263／ボタン電池・コイン電池（Reese's Law）") === -1) {
    stds.push("16 CFR Part 1263／ボタン電池・コイン電池（Reese's Law）");
  }
  return stds;
}

/**
 * 機能B: 年齢・カテゴリ依存の判定を組み立てて返す。
 * @returns 判定オブジェクト（バッジ/主文/補足/規制リスト/参考規制）
 */
function cpscDetermine() {
  var wiz = state.cpscWiz;
  var catKey = wiz.catKey;
  var age = wiz.ageGroup; // '0-12' | '13plus'
  var isChildrensOnly = CPSC_CHILDRENS_ONLY.indexOf(catKey) !== -1;
  var isGeneral = CPSC_GENERAL.indexOf(catKey) !== -1;
  var baseRegs = (catKey && CPSC_STANDARDS[catKey]) ? CPSC_STANDARDS[catKey].slice() : [];

  var d = {
    badgeText: '', badgeColor: null,
    mainText: '',  mainColor: null,
    subText: '',   subColor: null,
    regs: [],
    refRegs: null, refRegsTitle: null
  };

  if (age === '0-12') {
    if (isGeneral) {
      d.badgeText = '製品規制の対象（児童製品）';
      d.mainText  = 'この製品規制の対象 → 一般適合証明（GCC）が必要';
      d.subText   = '子ども向けに販売する場合はCPC相当の試験が必要なこともあります';
      d.regs = addFeatureStandards(baseRegs);
    } else {
      // CHILDRENS_ONLY / clothing / imitation_jewelry
      d.badgeText = "児童製品（Children's Product）";
      d.mainText  = '児童製品 → CPC（児童製品証明書）＋第三者試験（CPSC公認ラボ）が必要';
      d.subText   = '';
      d.regs = addFeatureStandards(baseRegs);
    }
  } else {
    // 13歳以上
    if (isChildrensOnly) {
      d.badgeColor = '#F9A825';
      d.badgeText  = '13歳以上向け（児童製品ではありません）';
      d.mainColor  = '#E65100';
      d.mainText   = '児童製品ではありません（13歳以上向け）→ CPC不要';
      d.subColor   = '#BF360C';
      d.subText    = '該当する強制規制が無ければ適合証明も不要で、税関では「対象外（disclaim）」として申告できる場合があります。'
                   + 'ただし「13歳以上向け」であることを示せる根拠（商品説明・パッケージ・対象年齢表示）が必要です。'
                   + '最終確認は Regulatory Robot / CPSC で。';
      d.regs = addFeatureStandards([]);
      d.refRegsTitle = '（参考）0〜12歳向けの場合に適用される規制';
      d.refRegs = baseRegs;
    } else if (isGeneral) {
      d.badgeColor = '#F9A825';
      d.badgeText  = '製品規制の対象';
      d.mainColor  = '#E65100';
      d.mainText   = '大人向けでも、この製品規制は対象年齢に関係なく適用されます → 一般適合証明（GCC）が必要';
      d.subText    = '';
      d.regs = addFeatureStandards(baseRegs);
    } else if (catKey === 'clothing') {
      d.badgeColor = '#F9A825';
      d.badgeText  = '大人用アパレル';
      d.mainColor  = '#E65100';
      d.mainText   = '大人用アパレル → 可燃性規制（16 CFR Part 1610）の対象 → 一般適合証明（GCC）';
      d.subColor   = '#BF360C';
      d.subText    = 'ただし現在は任意フラグ運用のケースあり。最終確認はRobot/CPSC。';
      d.regs = addFeatureStandards(['16 CFR Part 1610／可燃性（※現在は任意フラグ運用）']);
    } else if (catKey === 'imitation_jewelry') {
      d.badgeColor = '#F9A825';
      d.badgeText  = '大人向けアクセサリー';
      d.mainColor  = '#E65100';
      d.mainText   = '大人向け → 通常CPC不要';
      d.subColor   = '#BF360C';
      d.subText    = '鉛・カドミウム規制は主に子ども向けです。該当する一般規制が無ければ「対象外（disclaim）」申告になりうる。最終確認はRobot/CPSCで。';
      d.regs = addFeatureStandards([]);
      d.refRegsTitle = '（参考）子ども向けの場合に適用される規制';
      d.refRegs = baseRegs;
    } else {
      // フォールバック（カテゴリ不明）
      d.badgeColor = '#F9A825';
      d.badgeText  = '一般製品（13歳以上向け）';
      d.mainColor  = '#E65100';
      d.mainText   = '対象規制があれば一般適合証明（GCC）が必要';
      d.subColor   = '#BF360C';
      d.subText    = '13歳以上向けであることを示せる根拠（パッケージ/表示/設計）が必要。最終確認はRobot/CPSCで。';
      d.regs = addFeatureStandards(baseRegs);
    }
  }
  return d;
}

/** Q3で選択した特徴を日本語ラベルの配列で返す（none/未選択は除外） */
function getSelectedFeatureLabels() {
  var feats = (state.cpscWiz && state.cpscWiz.features) || [];
  var labelMap = {
    battery:    '電池・充電',
    flammable:  '可燃性素材',
    painted:    '塗装・コーティング',
    smallparts: '小さな部品'
  };
  var labels = [];
  feats.forEach(function(f) {
    if (labelMap[f]) labels.push(labelMap[f]);
  });
  return labels;
}

function showCpscResult() {
  var wiz = state.cpscWiz;
  var content = document.getElementById('cpscResultContent');
  content.innerHTML = '';

  // 判定結果カード
  var card = document.createElement('div');
  card.className = 'cpsc-result-card';

  var det = cpscDetermine();

  var badge = document.createElement('div');
  badge.className = 'cpsc-result-badge';
  badge.textContent = det.badgeText;
  if (det.badgeColor) badge.style.background = det.badgeColor;
  card.appendChild(badge);

  var main = document.createElement('div');
  main.className = 'cpsc-result-main';
  main.textContent = det.mainText;
  if (det.mainColor) main.style.color = det.mainColor;
  card.appendChild(main);

  if (det.subText) {
    var sub = document.createElement('div');
    sub.className = 'cpsc-result-sub';
    sub.textContent = det.subText;
    if (det.subColor) sub.style.color = det.subColor;
    card.appendChild(sub);
  }

  // 規制リスト（該当・参考、いずれも断定しない）
  if (det.regs && det.regs.length > 0) {
    var regsDiv = document.createElement('div');
    regsDiv.className = 'cpsc-result-regs';
    var regsTitle = document.createElement('strong');
    regsTitle.textContent = '該当しそうな規制（参考・要確認）';
    regsDiv.appendChild(regsTitle);
    det.regs.forEach(function(s) {
      var line = document.createElement('div');
      line.textContent = '・' + s;
      regsDiv.appendChild(line);
    });
    card.appendChild(regsDiv);
  }

  // 参考規制（13歳以上のCHILDRENS_ONLY等。必須ではなく参考）
  if (det.refRegs && det.refRegs.length > 0) {
    var refDiv = document.createElement('div');
    refDiv.className = 'cpsc-result-regs';
    refDiv.style.background = '#F3F8FF';
    refDiv.style.color = '#37474F';
    var refTitle = document.createElement('strong');
    refTitle.style.color = '#1565C0';
    refTitle.textContent = det.refRegsTitle || '（参考）規制';
    refDiv.appendChild(refTitle);
    det.refRegs.forEach(function(s) {
      var line = document.createElement('div');
      line.textContent = '・' + s;
      refDiv.appendChild(line);
    });
    card.appendChild(refDiv);
  }

  // 選択した特徴（あれば表示）
  var featLabels = getSelectedFeatureLabels();
  if (featLabels.length > 0) {
    var featDiv = document.createElement('div');
    featDiv.className = 'cpsc-result-sub';
    featDiv.style.marginTop = '8px';
    featDiv.textContent = '選択した特徴: ' + featLabels.join(', ');
    card.appendChild(featDiv);
  }

  var noteDiv = document.createElement('div');
  noteDiv.className = 'cpsc-result-note';
  noteDiv.textContent = '必要な対応は対象年齢で変わります。子ども向け（特に寝巻き）は児童製品としてCPC＋試験。13歳以上で児童製品でない場合はCPC不要で、根拠を示せば「対象外（disclaim）」申告になりうる。最終確認はRegulatory Robot／CPSCで。';
  card.appendChild(noteDiv);
  content.appendChild(card);

  // Regulatory Robotボタン
  var robotBtn = document.createElement('button');
  robotBtn.className = 'btn btn-primary';
  robotBtn.style.marginTop = '8px';
  robotBtn.textContent = 'Regulatory Robot で最終確認する →';
  robotBtn.addEventListener('click', function() {
    var robotSection = document.getElementById('cpscRobotGuide');
    if (robotSection) {
      robotSection.style.display = '';
      robotSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  content.appendChild(robotBtn);

  // 分類結果に戻るリンク
  var backLink = document.createElement('button');
  backLink.className = 'link-btn';
  backLink.style.display   = 'block';
  backLink.style.marginTop = '10px';
  backLink.style.fontSize  = '11px';
  backLink.textContent = '← 分類結果に戻る';
  backLink.addEventListener('click', function() { showSection('sectionResult'); });
  content.appendChild(backLink);

  // 機能C: Regulatory Robotガイド（ボタン押下まで非表示）
  var guide = renderRobotGuide(wiz);
  guide.id = 'cpscRobotGuide';
  guide.style.display = 'none';
  content.appendChild(guide);

  showSection('sectionCpscResult');
}

/** 機能C: Regulatory Robotガイドを DOM 要素として生成して返す */
function renderRobotGuide(wiz) {
  var guide = document.createElement('div');
  guide.className = 'robot-guide';
  guide.style.marginTop = '14px';

  var guideTitle = document.createElement('div');
  guideTitle.className = 'robot-guide-title';
  guideTitle.textContent = 'Regulatory Robot で最終確認する';
  guide.appendChild(guideTitle);

  var linkLabel = document.createElement('div');
  linkLabel.className = 'robot-guide-subtitle';
  linkLabel.textContent = '公式サイト';
  guide.appendChild(linkLabel);

  var linkEl = document.createElement('a');
  linkEl.className = 'robot-link';
  linkEl.href = 'https://business.cpsc.gov/robot/';
  linkEl.target = '_blank';
  linkEl.rel = 'noopener';
  linkEl.textContent = 'https://business.cpsc.gov/robot/（英語サイト・日本語非対応）';
  guide.appendChild(linkEl);

  var entryLabel = document.createElement('div');
  entryLabel.className = 'robot-guide-subtitle';
  entryLabel.textContent = 'ご利用手順';
  guide.appendChild(entryLabel);

  var stepUl = document.createElement('ul');
  ['Step 1: 任意のタイトルを入力', 'Step 2: 利用規約に同意（Agree and Continue）'].forEach(function(t) {
    var li = document.createElement('li');
    li.textContent = t;
    stepUl.appendChild(li);
  });
  guide.appendChild(stepUl);

  var fillLabel = document.createElement('div');
  fillLabel.className = 'robot-guide-subtitle';
  fillLabel.textContent = 'この商品での回答ガイド';
  guide.appendChild(fillLabel);

  var fillUl = document.createElement('ul');
  var ageText      = (wiz.ageGroup === '0-12') ? '0〜12歳（児童製品）' : '13歳以上';
  var clothingText = (wiz.catKey === 'clothing') ? 'はい' : 'いいえ';
  var catText      = wiz.nameJa || ('第' + wiz.chapter + '類');
  var fillItems = [
    { label: '対象年齢',     value: ageText },
    { label: '衣類か',       value: clothingText },
    { label: 'カテゴリ',     value: catText },
    { label: 'その他の質問', value: '画面の案内に従って回答' }
  ];
  fillItems.forEach(function(item) {
    var li = document.createElement('li');
    li.textContent = item.label + ' = ';
    var strong = document.createElement('strong');
    strong.textContent = item.value;
    li.appendChild(strong);
    fillUl.appendChild(li);
  });
  guide.appendChild(fillUl);

  // 13歳以上向けのとき disclaim の補足を追加
  if (wiz.ageGroup === '13plus') {
    var disclaimHint = document.createElement('div');
    disclaimHint.className = 'robot-guide-finish';
    disclaimHint.textContent = '13歳以上向けで児童製品でない場合、Robotでも「not a children\'s product」と出れば、税関対応は適合証明ではなく「対象外（disclaim）」申告になり得ます（最終確認はCPSC）。';
    guide.appendChild(disclaimHint);
  }

  var finishDiv = document.createElement('div');
  finishDiv.className = 'robot-guide-finish';
  finishDiv.textContent = '仕上げ: 結果をPDF保存 → eFilingSupport@cpsc.gov に送って書面で確認';
  guide.appendChild(finishDiv);

  var disclaimerEl = document.createElement('div');
  disclaimerEl.className = 'disclaimer';
  disclaimerEl.textContent = 'このツールの判定は参考です。最終責任は輸出者にあります。';
  guide.appendChild(disclaimerEl);

  return guide;
}

// -------------------------------------------------------
// 確認ウィザード
// -------------------------------------------------------
var CONFIRM_BLOCKS = 4;

function goToConfirm() {
  if (!state.leafData) return;

  // 値を保存
  state.brand   = document.getElementById('inputBrand').value.trim();
  state.model   = document.getElementById('inputModel').value.trim();
  state.condition = document.getElementById('inputCondition').value;
  state.customTitle = document.getElementById('inputTitle').value.replace(/\s+/g, ' ').trim();
  state.country = document.getElementById('inputCountry').value.trim();
  state.qty     = document.getElementById('inputQty').value || 1;
  state.value   = document.getElementById('inputValue').value || '';
  state.currency = document.getElementById('inputCurrency').value || 'USD';

  if (!state.customTitle) {
    state.customTitle = generateTitle();
  }

  // Block 1 — コード
  document.getElementById('cf_htsus').value = stripDots(state.leafData.htsus || '');
  document.getElementById('cf_hs6').value   = stripDots(state.leafData.hs6 || '');
  document.getElementById('cf_desc').value  = state.leafData.desc || '';

  // Block 2 — 商品情報
  document.getElementById('cf_title').value   = state.customTitle;
  document.getElementById('cf_brand').value   = state.brand;
  document.getElementById('cf_model').value   = state.model;
  document.getElementById('cf_country').value = state.country;

  // Block 3 — 価格
  document.getElementById('cf_qty').value      = state.qty;
  document.getElementById('cf_value').value    = state.value;
  document.getElementById('cf_currency').value = state.currency;

  // Block 4 — 会社情報
  document.getElementById('cf_awb').value      = '';
  document.getElementById('cf_company').value  = state.company.name || '';
  document.getElementById('cf_nameTitle').value = state.company.nameTitle || '';
  document.getElementById('cf_email').value    = state.company.email || '';

  state.confirmBlock = 1;
  state.confirmDone = false;

  showConfirmBlock(1);
  showSection('sectionConfirm');
}

function showConfirmBlock(num) {
  for (var i = 1; i <= CONFIRM_BLOCKS; i++) {
    var el = document.getElementById('cblock' + i);
    if (el) el.style.display = (i === num) ? '' : 'none';
  }
  document.getElementById('confirmProgress').textContent =
    'Block ' + num + ' / ' + CONFIRM_BLOCKS + ' を確認中';
}

function confirmNext(blockNum) {
  if (blockNum < CONFIRM_BLOCKS) {
    state.confirmBlock = blockNum + 1;
    showConfirmBlock(blockNum + 1);
  }
}

function confirmPrev(blockNum) {
  if (blockNum > 1) {
    state.confirmBlock = blockNum - 1;
    showConfirmBlock(blockNum - 1);
  }
}

function confirmDone() {
  // 最新値を収集（確認画面で手修正された場合もドットなしに正規化）
  state.leafData.htsus = stripDots(document.getElementById('cf_htsus').value);
  state.leafData.hs6   = stripDots(document.getElementById('cf_hs6').value);
  state.leafData.desc  = document.getElementById('cf_desc').value;
  state.customTitle    = document.getElementById('cf_title').value.replace(/\s+/g, ' ').trim();
  state.brand          = document.getElementById('cf_brand').value;
  state.model          = document.getElementById('cf_model').value;
  state.country        = document.getElementById('cf_country').value;
  state.qty            = document.getElementById('cf_qty').value;
  state.value          = document.getElementById('cf_value').value;
  state.currency       = document.getElementById('cf_currency').value;
  var awb              = document.getElementById('cf_awb').value;
  state.company.name      = document.getElementById('cf_company').value;
  state.company.nameTitle = document.getElementById('cf_nameTitle').value;
  state.company.email     = document.getElementById('cf_email').value;

  state.confirmDone = true;

  // 印刷データを準備（ドットなしを保証）
  var payload = {
    htsus:    stripDots(state.leafData.htsus),
    hs6:      stripDots(state.leafData.hs6),
    desc:     state.leafData.desc,
    duty:     state.leafData.duty || '',
    title:    state.customTitle,
    brand:    state.brand,
    model:    state.model,
    country:  state.country,
    qty:      state.qty,
    value:    state.value,
    currency: state.currency,
    awb:      awb,
    company:  state.company.name,
    nameTitle: state.company.nameTitle,
    email:    state.company.email,
    generatedAt: new Date().toLocaleString('ja-JP')
  };

  chrome.storage.local.set({ _hsPrintPayload: JSON.stringify(payload) }, function() {
    showPrintPreview(payload);
  });
}

// -------------------------------------------------------
// 印刷プレビュー
// -------------------------------------------------------
function showPrintPreview(payload) {
  var table = document.getElementById('previewTable');
  renderWorksheet(table, payload);
  showSection('sectionPrint');
}

function renderWorksheet(tableEl, p) {
  tableEl.innerHTML = '';

  function row(labelText, valueText, labelClass, trClass) {
    var tr = document.createElement('tr');
    if (trClass) tr.className = trClass;

    var tdL = document.createElement('td');
    tdL.textContent = labelText;
    tdL.className = labelClass || 'ws-label';

    var tdV = document.createElement('td');
    tdV.textContent = valueText;
    tdV.className = 'ws-data';

    tr.appendChild(tdL);
    tr.appendChild(tdV);
    tableEl.appendChild(tr);
  }

  function titleRow(text) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 2;
    td.textContent = text;
    td.className = 'ws-title';
    tr.appendChild(td);
    tableEl.appendChild(tr);
  }

  function headerRow(text) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 2;
    td.textContent = text;
    td.className = 'ws-header';
    tr.appendChild(td);
    tableEl.appendChild(tr);
  }

  titleRow('HS Code Worksheet / 通関用HSコードワークシート');

  headerRow('HTS / HS Code');
  row('HTSUS Code (10-digit)', stripDots(p.htsus || ''), 'ws-label', 'ws-section-hts');
  row('HS Code (6-digit)',     stripDots(p.hs6   || ''), 'ws-label', 'ws-section-hts');
  row('Official Description', p.desc  || '', 'ws-label', 'ws-section-hts');
  row('Duty Rate (General)',   p.duty  || '', 'ws-label', 'ws-section-hts');

  headerRow('Product Information / 商品情報');
  row('Customs Title (English)',    p.title   || '', 'ws-label', 'ws-section-goods');
  row('Brand / Manufacturer',       p.brand   || '', 'ws-label', 'ws-section-goods');
  row('Model / Reference',          p.model   || '', 'ws-label', 'ws-section-goods');
  row('Country of Origin',          p.country || '', 'ws-label', 'ws-section-goods');

  headerRow('Value / 申告価格');
  row('Quantity',                   String(p.qty || 1), 'ws-label', 'ws-section-value');
  row('Declared Value',             p.value ? p.value + ' ' + (p.currency || 'USD') : '',
                                    'ws-label', 'ws-section-value');

  headerRow('Shipper Information / 輸出者情報');
  row('Company Name',   p.company   || '', 'ws-label', 'ws-section-company');
  row('Name and Title', p.nameTitle || '', 'ws-label', 'ws-section-company');
  row('E-mail',         p.email     || '', 'ws-label', 'ws-section-company');
  row('AWB Number',     p.awb       || '', 'ws-label', 'ws-section-company');

  // 免責
  var td = document.createElement('td');
  td.colSpan = 2;
  td.className = 'ws-disclaimer';
  td.textContent =
    '【免責】このワークシートのHSコードはガイドウィザードによる候補です。' +
    '最終的な分類・申告責任は輸出者にあります。不明な場合は通関士にご相談ください。' +
    ' | Generated: ' + (p.generatedAt || '');
  var disclaimerTr = document.createElement('tr');
  disclaimerTr.className = 'ws-disclaimer';
  disclaimerTr.appendChild(td);
  tableEl.appendChild(disclaimerTr);
}

// -------------------------------------------------------
// 永続化
// -------------------------------------------------------
function saveProgress() {
  var data = {
    leafKey:  state.leafKey,
    leafData: state.leafData,
    brand:    state.brand,
    model:    state.model,
    country:  state.country,
    qty:      state.qty,
    value:    state.value,
    currency: state.currency
  };
  chrome.storage.local.set({ _hsProgress: JSON.stringify(data) });
}

function restoreProgress() {
  chrome.storage.local.get(['_hsProgress', '_hsCompany'], function(stored) {
    if (stored._hsCompany) {
      try { state.company = JSON.parse(stored._hsCompany); } catch(e) {}
    }
    if (!stored._hsProgress) {
      alert('保存された作業が見つかりませんでした。');
      return;
    }
    try {
      var d = JSON.parse(stored._hsProgress);
      state.leafKey  = d.leafKey;
      state.leafData = d.leafData;
      state.brand    = d.brand;
      state.model    = d.model;
      state.country  = d.country;
      state.qty      = d.qty;
      state.value    = d.value;
      state.currency = d.currency;
      state.currentCategory = null;
      if (state.leafData) showResult();
    } catch(e) {
      alert('復元に失敗しました: ' + e.message);
    }
  });
}

// -------------------------------------------------------
// 設定（会社情報）
// -------------------------------------------------------
function loadSettings() {
  chrome.storage.local.get(['_hsCompany', '_hsOpenAiKey'], function(stored) {
    if (stored._hsCompany) {
      try {
        state.company = JSON.parse(stored._hsCompany);
        document.getElementById('companyName').value  = state.company.name || '';
        document.getElementById('nameAndTitle').value = state.company.nameTitle || '';
        document.getElementById('email').value        = state.company.email || '';
        var phoneEl = document.getElementById('companyPhone');
        if (phoneEl) phoneEl.value = state.company.phone || '';
      } catch(e) {}
    }
    var certifierNameEl = document.getElementById('certifierName');
    if (certifierNameEl) {
      // 保存済みのcertifierNameがあればそれを、なければName and Titleの氏名部分を初期値として流用（保存はしない）
      certifierNameEl.value = state.company.certifierName ||
        tscaSplitNameTitle(state.company.nameTitle).name || '';
    }
    var addressEl = document.getElementById('companyAddress');
    if (addressEl) addressEl.value = state.company.address || '';
    var certifierTitleEl = document.getElementById('certifierTitle');
    if (certifierTitleEl) {
      // 保存済みのcertifierTitleがあればそれを、なければName and Titleの肩書き部分を初期値として提示（保存はしない）
      certifierTitleEl.value = state.company.certifierTitle ||
        tscaSplitNameTitle(state.company.nameTitle).title || '';
    }
    if (stored._hsOpenAiKey) {
      state.openaiKey = stored._hsOpenAiKey;
      var el = document.getElementById('openaiKey');
      if (el) el.value = state.openaiKey;
    }
  });
}

function saveSettings(e) {
  e.preventDefault();
  state.company.name      = document.getElementById('companyName').value.trim();
  state.company.nameTitle = document.getElementById('nameAndTitle').value.trim();
  state.company.email     = document.getElementById('email').value.trim();
  var companyPhoneEl = document.getElementById('companyPhone');
  state.company.phone     = companyPhoneEl ? companyPhoneEl.value.trim() : (state.company.phone || '');
  var certifierNameEl = document.getElementById('certifierName');
  state.company.certifierName = certifierNameEl ? certifierNameEl.value.trim() : (state.company.certifierName || '');
  var addressEl = document.getElementById('companyAddress');
  state.company.address = addressEl ? addressEl.value.trim() : (state.company.address || '');
  var certifierTitleEl = document.getElementById('certifierTitle');
  state.company.certifierTitle = certifierTitleEl ? certifierTitleEl.value.trim() : (state.company.certifierTitle || '');
  var keyEl = document.getElementById('openaiKey');
  if (keyEl) state.openaiKey = keyEl.value.trim();
  var toSave = { _hsCompany: JSON.stringify(state.company) };
  if (state.openaiKey) toSave._hsOpenAiKey = state.openaiKey;
  chrome.storage.local.set(toSave, function() {
    var msg = document.getElementById('settingsMsg');
    showMessage(msg, 'success', '保存しました。');
    setTimeout(function() { showSection('sectionHome'); }, 800);
  });
}

// -------------------------------------------------------
// 初期化
// -------------------------------------------------------
window.addEventListener('load', function() {

  // 起動時ロード: flows.json + chapter_index.json のみ
  loadFlows(function() {
    buildCategoryList();
    loadSettings();
  });

  loadChapterIndex(null);
  loadCpscData();

  // ---- ホーム ----
  document.getElementById('openSettingsLink').addEventListener('click', function() {
    showSection('sectionSettings');
  });

  document.getElementById('searchBtn').addEventListener('click', function() {
    doSearch(document.getElementById('keywordInput').value);
  });

  document.getElementById('keywordInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doSearch(this.value);
  });

  document.getElementById('restoreBtn').addEventListener('click', restoreProgress);

  document.getElementById('browseBtn').addEventListener('click', function() {
    showBrowse();
  });

  // ---- ブラウズ ----
  document.getElementById('backFromBrowse').addEventListener('click', function() {
    state.browseChapter = null;
    state.browseChapterData = null;
    showSection('sectionHome');
  });

  document.getElementById('backToChapterList').addEventListener('click', function() {
    document.getElementById('browseStepB').style.display = 'none';
    document.getElementById('browseStepA').style.display = '';
    document.getElementById('browseTitle').textContent = '章から探す';
  });

  document.getElementById('chapterFilterInput').addEventListener('input', function() {
    renderChapterList(this.value);
  });

  // ---- 設定 ----
  document.getElementById('settingsForm').addEventListener('submit', saveSettings);
  document.getElementById('backFromSettings').addEventListener('click', function() {
    showSection('sectionHome');
  });
  document.getElementById('cancelSettings').addEventListener('click', function() {
    showSection('sectionHome');
  });

  // ---- ウィザード ----
  document.getElementById('backFromWizard').addEventListener('click', function() {
    showSection('sectionHome');
  });

  // ---- 結果 ----
  document.getElementById('backFromResult').addEventListener('click', function() {
    if (state.currentCategory) {
      showSection('sectionWizard');
    } else if (state.browseChapter) {
      showSection('sectionBrowse');
    } else {
      showSection('sectionHome');
    }
  });

  document.getElementById('applyManualCode').addEventListener('click', applyManualCode);

  document.getElementById('genTitleBtn').addEventListener('click', function() {
    var t = generateTitle();
    document.getElementById('inputTitle').value = t;
  });

  document.getElementById('goToConfirmBtn').addEventListener('click', goToConfirm);

  // ---- 確認ウィザード ----
  document.getElementById('backFromConfirm').addEventListener('click', function() {
    showSection('sectionResult');
  });

  document.querySelectorAll('.wiz-next-c').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var blockNum = parseInt(this.getAttribute('data-block'), 10);
      confirmNext(blockNum);
    });
  });

  document.querySelectorAll('.wiz-prev-c').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var blockNum = parseInt(this.getAttribute('data-block'), 10);
      confirmPrev(blockNum);
    });
  });

  document.getElementById('confirmDoneBtn').addEventListener('click', confirmDone);

  // ---- 印刷 ----
  document.getElementById('backFromPrint').addEventListener('click', function() {
    showSection('sectionConfirm');
  });

  document.getElementById('openPrintWindowBtn').addEventListener('click', function() {
    if (!state.confirmDone) {
      alert('印刷前にすべての確認ブロックを完了してください。');
      return;
    }
    chrome.tabs.create({ url: chrome.runtime.getURL('print.html') });
  });

  document.getElementById('startOverBtn').addEventListener('click', function() {
    state.leafKey = null;
    state.leafData = null;
    state.wizardHistory = [];
    state.currentCategory = null;
    state.browseChapter = null;
    showSection('sectionHome');
  });

  // ---- コードの裏取り ----
  document.getElementById('verifyHtsBtn_result').addEventListener('click', openVerifyHts);
  document.getElementById('verifyCrossBtn_result').addEventListener('click', openVerifyCross);
  document.getElementById('verifyHtsBtn_confirm').addEventListener('click', openVerifyHts);
  document.getElementById('verifyCrossBtn_confirm').addEventListener('click', openVerifyCross);

  // ---- CPSC ウィザード/結果 ----
  document.getElementById('backFromCpscWiz').addEventListener('click', function() {
    showSection('sectionResult');
  });
  document.getElementById('backFromCpscResult').addEventListener('click', function() {
    if (state.cpscWiz) { showSection('sectionCpscWiz'); renderCpscWizBody(); }
    else { showSection('sectionResult'); }
  });

  // ---- AI解析 ----
  document.getElementById('aiAnalyzeBtn').addEventListener('click', startAiFlow);
  document.getElementById('tscaAiBtn').addEventListener('click', startTscaAiFlow);

  // 初期表示
  showSection('sectionHome');
});

// -------------------------------------------------------
// AI入力補助
// -------------------------------------------------------

function showAiBadge(show) {
  var el = document.getElementById('aiResultBadge');
  if (el) el.style.display = show ? '' : 'none';
}

function startAiFlow() {
  var msg = document.getElementById('aiAnalyzeMsg');
  var btn = document.getElementById('aiAnalyzeBtn');

  if (!state.openaiKey) {
    showMessage(msg, 'error', 'APIキーが未設定です。設定画面で OpenAI APIキーを入力してください。');
    msg.style.display = '';
    return;
  }

  btn.disabled = true;
  showMessage(msg, 'info', '分析中…');
  msg.style.display = '';

  getPageInfo(function(pageInfo, errReason) {
    if (!pageInfo) {
      showMessage(msg, 'error', (errReason || 'ページ情報を取得できませんでした') + '。商品ページを開いてから試してください。');
      msg.style.display = '';
      btn.disabled = false;
      return;
    }
    callOpenAI(pageInfo, function(err, aiData) {
      btn.disabled = false;
      if (err || !aiData) {
        showMessage(msg, 'error', 'AI呼び出しに失敗しました: ' + (err ? err.message : '不明なエラー'));
        return;
      }
      msg.style.display = 'none';
      showResultFromAi(aiData);
    });
  });
}

function getPageInfo(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (!tabs || !tabs[0]) { cb(null, 'タブが見つかりません'); return; }
    var tab = tabs[0];
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
      cb(null, '拡張機能や設定ページでは使えません。商品ページを開いてください'); return;
    }
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function() {
        var url = location.href;
        var host = location.hostname;

        function getText(selectors) {
          for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el && el.textContent.trim()) return el.textContent.trim().substring(0, 400);
          }
          return '';
        }
        function getMeta(names) {
          for (var i = 0; i < names.length; i++) {
            var el = document.querySelector('meta[property="' + names[i] + '"],meta[name="' + names[i] + '"]');
            if (el && el.getAttribute('content')) return el.getAttribute('content');
          }
          return '';
        }

        // JSON-LD Product schema
        var jsonldProduct = null;
        var scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (var si = 0; si < scripts.length; si++) {
          try {
            var d = JSON.parse(scripts[si].textContent);
            var items = d['@graph'] ? d['@graph'] : (Array.isArray(d) ? d : [d]);
            for (var ii = 0; ii < items.length; ii++) {
              if (items[ii]['@type'] === 'Product') { jsonldProduct = items[ii]; break; }
            }
            if (jsonldProduct) break;
          } catch(e) {}
        }

        var productName = '';
        var brand = '';
        var condition = '';
        var description = '';
        var category = '';

        // --- サイト別抽出 ---
        // Mercari Japan
        if (host.includes('mercari.com')) {
          productName = getText(['h1[class*="name"]','h1[data-testid="name"]','h1','p[data-testid="product-name"]']);
          description = getText(['[data-testid="description"]','p[class*="description"]','[class*="ItemDescription"]']).substring(0,300);
          condition   = getText(['[data-testid="condition"]','[class*="condition"]','span[class*="status"]']);
          category    = getText(['[data-testid="breadcrumb"]','nav[aria-label="breadcrumb"]','.breadcrumb']).substring(0,100);
          brand       = getText(['[data-testid="brand"]','[class*="brand"]']);
        }
        // Yahoo Auctions Japan
        else if (host.includes('auctions.yahoo.co.jp') || host.includes('buyee.jp')) {
          productName = getText(['h1[class*="Product__title"]','.Product__title','h1']);
          description = getText(['.ProductExplanation__itemDescription','.ProductDetail__description','[class*="description"]']).substring(0,300);
          condition   = getText(['.ProductDetail__condition','[class*="condition"]']);
        }
        // Hard Off / Book Off
        else if (host.includes('hardoff.co.jp') || host.includes('bookoff.co.jp')) {
          productName = getText(['h1','.item-name','.product-name']);
          description = getText(['.item-detail','.product-detail','.description']).substring(0,300);
        }
        // eBay
        else if (host.includes('ebay.com')) {
          productName = getText(['h1#itemTitle','h1[itemprop="name"]','h1']);
          description = getText(['#viTabs_0_is','#itemDescriptionURL','[itemprop="description"]']).substring(0,300);
          brand       = getText(['[itemprop="brand"]','[data-testid="x-item-specifics"] [class*="brand"]']);
          condition   = getText(['#condText','[itemprop="itemCondition"]']);
        }

        // JSON-LDで補完
        if (jsonldProduct) {
          if (!productName) productName = jsonldProduct.name || '';
          if (!brand && jsonldProduct.brand) brand = typeof jsonldProduct.brand === 'string' ? jsonldProduct.brand : (jsonldProduct.brand.name || '');
          if (!description && jsonldProduct.description) description = String(jsonldProduct.description).substring(0,300);
          if (!condition && jsonldProduct.itemCondition) condition = String(jsonldProduct.itemCondition).replace(/https?:\/\/schema\.org\//,'').replace('Condition','');
        }

        // 汎用フォールバック
        if (!productName) productName = getText(['h1']) || getMeta(['og:title']) || document.title;
        if (!description) description = getMeta(['og:description','description']).substring(0,300);

        return {
          url: url,
          host: host,
          productName: productName,
          brand: brand,
          condition: condition,
          description: description,
          category: category
        };
      }
    }, function(results) {
      if (chrome.runtime.lastError) {
        cb(null, chrome.runtime.lastError.message); return;
      }
      if (results && results[0] && results[0].result) {
        cb(results[0].result, null);
      } else {
        cb(null, 'ページ情報を取得できませんでした');
      }
    });
  });
}

function callOpenAI(pageInfo, cb) {
  var lines = [
    'Product URL: ' + pageInfo.url,
    'Product name: ' + (pageInfo.productName || ''),
  ];
  if (pageInfo.brand)       lines.push('Brand: ' + pageInfo.brand);
  if (pageInfo.condition)   lines.push('Condition: ' + pageInfo.condition);
  if (pageInfo.category)    lines.push('Category on site: ' + pageInfo.category);
  if (pageInfo.description) lines.push('Description: ' + pageInfo.description);

  var userContent = lines.join('\n');

  var systemPrompt = [
    'You are a US customs (HTSUS) classification expert for Japanese secondhand goods exported to the US.',
    'Given product information, return ONLY a JSON object with these exact fields:',
    '  "htsus": 10-digit HTSUS number, digits only, no dots (e.g. "9503000090")',
    '  "hs6": first 6 digits of htsus (e.g. "950300")',
    '  "description": official English HTS category description (e.g. "Toys representing animals or non-human creatures")',
    '  "brand": brand name extracted from product info, or "Generic" if unknown',
    '  "model": model number or product/character name',
    '  "title": customs declaration title in plain English, max 40 chars, no marketing language, no Japanese characters. Format: "[Brand] [Character/Model] [Item Type] [Age]". Always include brand name and character or model name when available. Append age requirement at the end when applicable: use "For Ages 15+" for anime/manga figures and collectibles (not toys for actual play), "For Ages 13+" for trading cards and card games, "For Ages X+" for toys with a clear target age. Omit age if the product is not a toy or collectible. Example: "Bandai Gundam RX-78-2 Figure For Ages 15+"',
    '  "country": country of origin — default "Japan" for secondhand Japanese marketplace items unless clearly otherwise',
    '  "reason": one sentence in Japanese explaining why you chose this HTSUS code',
    'Return ONLY the JSON object. No markdown, no explanation outside the JSON.'
  ].join('\n');

  fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + state.openaiKey
    },
    body: JSON.stringify({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      max_completion_tokens: 400
    })
  })
  .then(function(r) {
    if (!r.ok) {
      return r.json().then(function(errBody) {
        throw new Error((errBody.error && errBody.error.message) || ('HTTP ' + r.status));
      });
    }
    return r.json();
  })
  .then(function(data) {
    var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('AIからの応答が空でした');
    // JSON部分だけ抽出（余計なテキストを除去）
    var match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AIの応答にJSONが含まれていませんでした');
    try {
      cb(null, JSON.parse(match[0]));
    } catch(e) {
      throw new Error('JSONの解析に失敗しました: ' + e.message);
    }
  })
  .catch(function(e) {
    cb(e, null);
  });
}

function showResultFromAi(aiData) {
  state.leafData = {
    htsus: (aiData.htsus || '').replace(/[.\-\s]/g, ''),
    hs6:   (aiData.hs6   || '').replace(/[.\-\s]/g, ''),
    desc:  aiData.description || '',
    duty:  ''
  };
  state.leafKey        = state.leafData.htsus;
  state.currentCategory = null;
  state.browseChapter   = null;
  state.brand     = aiData.brand   || '';
  state.model     = aiData.model   || '';
  state.country   = aiData.country || 'Japan';
  state.condition = 'Pre-Owned';

  showResult();
  document.getElementById('inputTitle').value = aiData.title || '';

  // AI判定理由を表示
  var badge = document.getElementById('aiResultBadge');
  if (badge) {
    var reasonText = aiData.reason ? '💡 ' + aiData.reason : '';
    badge.innerHTML = '✨ <strong>AI入力補助</strong> — 内容を確認・修正してから次へ進んでください' +
      (reasonText ? '<div class="ai-reason">' + escapeHtml(reasonText) + '</div>' : '');
    badge.style.display = '';
  }
}

// -------------------------------------------------------
// ホーム: AIでTSCA書類を作成する（開いているページ→TSCA商品説明を自動生成）
// -------------------------------------------------------

/** TSCAフォーム内のAI入力補助バッジの表示切り替え */
function showTscaAiResultBadge(show) {
  var el = document.getElementById('tscaAiResultBadge');
  if (el) el.style.display = show ? '' : 'none';
}

/** AI生成の共通システムプロンプト（通関用タイトル＋詳細説明のJSONを返させる）。
 *  title の文字数の目安（合計で最大85文字）は、様式の商品説明欄の拡張後の幅
 *  (TSCA_DESC_MAX_WIDTH=450pt) に太字(Helvetica-Bold 10pt)で収まる文字数を
 *  pdf-libのwidthOfTextAtSizeで実測して決めた（平均約5.1pt/文字 → 450ptで約88文字。
 *  太字・大文字が多い場合の余裕をみて上限85文字とした）。
 *  玩具・コレクティブルの年齢文 ", Not for Children (Age 15+)" は28文字・実測129.2pt
 *  固定なので、年齢文より前の本文は約55文字以下を目安とする（55文字×約5.1pt＋129.2pt
 *  ≒ 410pt < 450pt。85文字上限との整合も実測確認済み）。
 *  タイトルが実際に1行幅へ収まるかは、AI生成直後（tscaFinalizeAiTitle。超過時は
 *  1回だけAIに短縮を再依頼）と、確認画面へ進む前・PDF生成時の両方で機械的に
 *  再チェックされる（収まらない場合はエラー表示して止める。黙って切らない）。
 *  年齢文の方針（2026-07-16 ユーザー承認）: コレクター品・玩具は Age 15+ に統一、
 *  トレカ・カードゲームのみ Age 13+。ページ上の他セラー由来の年齢表記（4+等）は無視。
 *  タイトルのConditionは「Used」のみ（2026-07-16 ユーザー指示。"(secondhand)"は
 *  冗長のためタイトルから削除して定型部分を13字軽くする。description側はCPSC上の
 *  理由から従来どおり "Used (secondhand)" を維持）。
 *  sourceLabel は元情報の呼び方（"product page information" or "given text"）。 */
function tscaAiSystemPrompt(sourceLabel) {
  return [
    'You are helping prepare a US customs document (FedEx TSCA certification) for a shipment',
    'of used/secondhand consumer goods exported from Japan to the US.',
    'Given the ' + sourceLabel + ' below, produce BOTH of the following in English.',
    'Factual, no exaggeration, no marketing or promotional language.',
    '1. "title" - a short customs product title for ONE line of the form:',
    '   - ONE single line only (no line breaks). NEVER exceed 85 characters in total, including the',
    '     age statement. The 85-character limit is an ABSOLUTE requirement, not a target.',
    '   - Prioritize fitting over completeness: shorten or omit the brand name if needed.',
    '   - For toys and collectibles (see the age statement rules below), use this exact format:',
    '     <Condition> Collectible <short item type> "<product name>"[, by <brand>], Not for Children (Age NN+)',
    '   - For all other products (kitchenware, clothing, electronics, etc.), use this format',
    '     with NO "Collectible" and NO age statement:',
    '     <Condition> <short item type> "<product name>"[, by <brand>]',
    '   - Age statement rules (FIXED values, appended at the END of the title):',
    '     * Trading cards and card games: append ", Not for Children (Age 13+)". Always exactly 13+.',
    '     * ALL other toys and collectibles - anime/manga figures, character goods, plush toys,',
    '       model kits, dolls, AND toys meant for actual play: append ", Not for Children (Age 15+)".',
    '       These are exported as collector items for adults, so Age 15+ is ALWAYS used,',
    '       even for products originally marketed to young children.',
    '     * IGNORE any age label that appears in the ' + sourceLabel + ' (e.g. "4+", "Ages 3 and up",',
    '       "対象年齢6歳以上"). Such labels come from the manufacturer or other sellers and MUST NOT be',
    '       copied into the title. Use ONLY the fixed values above: Age 13+ for trading cards and',
    '       card games, Age 15+ for every other toy or collectible.',
    '     * Omit the age statement (and the word "Collectible") only when the product is not a toy or collectible.',
    '   - Character budget (how to ALWAYS stay within 85 characters):',
    '     * The fixed parts (condition + "Collectible" + item type + quotes + age statement)',
    '       already use about 50-60 characters, so keep the quoted product name to AT MOST',
    '       20 characters. For long names keep only the core character/product name',
    '       (e.g. "Ultimate Madoka & Devil Homura" -> "Madoka & Homura").',
    '     * OMIT ", by <brand>" whenever the total would otherwise exceed 85 characters.',
    '     * Use the shortest generic noun for the item type (figure / plush / cards / model kit).',
    '   - The fixed suffix ", Not for Children (Age 15+)" is about 28 characters, so keep the part',
    '     of the title before the suffix to roughly 55 characters or less.',
    '   - Example (figure): Used Collectible figure "Son Goku", Not for Children (Age 15+)',
    '   - Example (trading card): Used Collectible trading card "Pikachu", Not for Children (Age 13+)',
    '   - Example (non-toy, no age statement): Used ceramic coffee mug "Sakura Blossom"',
    '2. "description" - a detailed factual description:',
    '   - One factual sentence starting with the condition, then item type, product name in quotes, and brand,',
    '     followed by a "Materials:" bullet list. Maximum 350 characters total.',
    '   - ALWAYS include the material composition, because FedEx may ask about materials.',
    '   - Use explicit line breaks exactly like this:',
    '     <one factual sentence>',
    '     Materials:',
    '     - <material name (full chemical name in parentheses if applicable)>: approx. <percent>%',
    '     - <material name>: approx. <percent>%',
    'Condition rules (both the title and the description MUST state the condition):',
    '- In the "title", write the condition as just "Used" or "New". Do NOT write "(secondhand)"',
    '  in the title - the one-line form is too narrow for it.',
    '- In the "description", write "Used (secondhand)" or "New" (KEEP "(secondhand)" there).',
    '- If the ' + sourceLabel + ' indicates a secondhand item (中古, used, pre-owned, 目立った傷や汚れなし, etc.), the item is Used.',
    '- Write "New" ONLY when the ' + sourceLabel + ' clearly states the item is new/unused/unopened (新品, 未使用, 未開封, etc.).',
    '- If the condition cannot be determined, treat the item as Used (items handled by this tool come from Japanese secondhand marketplaces).',
    'Material rules (for the description):',
    '- If the ' + sourceLabel + ' states materials (素材, 材質, "Material", etc.), use them, translated into standard English material names. This takes priority.',
    '- Otherwise use the industry-standard composition for the product category (e.g. painted finished figures = PVC approx. 90% / ABS approx. 10%; trading cards and board games = paper and cardboard; plush toys = polyester fabric and stuffing).',
    '- Give each material an approximate percentage prefixed with "approx.", adding up to roughly 100%.',
    '- Write a percentage WITHOUT "approx." only when that exact figure is explicitly stated in the ' + sourceLabel + '.',
    '- List at most 4 materials.',
    'Return ONLY a single JSON object with exactly the keys "title" and "description".',
    'No markdown, no code fences, no explanation. Example output:',
    '{"title": "Used Collectible figure \\"Son Goku\\", Not for Children (Age 15+)", "description": "Used (secondhand) painted finished figure \\"Son Goku\\" by Banpresto.\\nMaterials:\\n- PVC (polyvinyl chloride): approx. 90%\\n- ABS (acrylonitrile butadiene styrene): approx. 10%"}'
  ].join('\n');
}

/** AI応答テキストから {title, description} を取り出す。コードフェンス（```json）や前後の
 *  説明文が混ざっていても、最初の '{' から最後の '}' までをJSONとして解析する。
 *  解析できない・titleが無い場合は Error を投げる（呼び出し側の.catchでエラー表示に落ち、
 *  ボタンは通常どおり復帰する。拡張機能自体は落とさない）。 */
function tscaParseAiJson(content) {
  var s = (content || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  var start = s.indexOf('{');
  var end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('AIの応答がJSON形式ではありませんでした');
  var obj;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    throw new Error('AIの応答（JSON）を解析できませんでした');
  }
  var title = (typeof obj.title === 'string') ? obj.title.replace(/\s+/g, ' ').trim() : '';
  var description = (typeof obj.description === 'string') ? obj.description.trim() : '';
  if (!title) throw new Error('AIの応答にタイトル(title)が含まれていませんでした');
  return { title: title, description: description };
}

/** OpenAI Chat Completions を呼び、応答を tscaParseAiJson で {title, description} に変換して
 *  cb(null, result) で返す共通処理。失敗（HTTP/空応答/不正JSON）は cb(err, null)。
 *  エンドポイント・モデル・認証は既存のOpenAI利用パターンをそのまま踏襲する。 */
function tscaCallAiJson(systemPrompt, userContent, cb) {
  fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + state.openaiKey
    },
    body: JSON.stringify({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      max_completion_tokens: 400
    })
  })
  .then(function(r) {
    if (!r.ok) {
      return r.json().then(function(errBody) {
        throw new Error((errBody.error && errBody.error.message) || ('HTTP ' + r.status));
      });
    }
    return r.json();
  })
  .then(function(data) {
    var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('AIからの応答が空でした');
    cb(null, tscaParseAiJson(content));
  })
  .catch(function(e) {
    cb(e, null);
  });
}

/** 開いているページをAIで分析し、TSCA用の英語商品説明を生成して入力欄（下書き）にセットする共通処理。
 *  ホームの赤ボタン（tscaAiBtn）・TSCAフォーム内のボタン（tscaAiFromPageBtn）の両方から呼ばれる。
 *  複数商品（同梱発送）の運用: このボタンを押すと、直前の入力欄の内容が自動的に商品リストへ
 *  確定されてから、新しいページの説明が入力欄にセットされる（下書き・編集中の扱いはどちらの
 *  ボタンでも同じ挙動に統一する）。
 *  btn: 処理中に無効化するボタン要素。msg: 進捗・エラーメッセージの表示先。
 *  openSection: true ならホーム→TSCAフォームへの画面遷移（openTscaSection）を行う（ホーム赤ボタン用）。
 *    false なら画面遷移しない（フォーム内ボタン用。既にフォームが表示されており、openTscaSection →
 *    tscaEnterForm を呼ぶと「商品0件・下書き空」のとき isFreshStart 扱いになって Waybill・証明区分・
 *    Certifier 欄などの入力済み値がリセットされてしまうため）。 */
function runTscaAiFromPageFlow(btn, msg, openSection) {
  if (!state.openaiKey) {
    showMessage(msg, 'error', 'APIキーが未設定です。設定画面で OpenAI APIキーを入力してください。');
    msg.style.display = '';
    return;
  }

  // 前回の下書きが入力欄に残っていれば、先に商品リストへ確定させる
  tscaCommitDraft();

  btn.disabled = true;
  showMessage(msg, 'info', '分析中…');
  msg.style.display = '';

  getPageInfo(function(pageInfo, errReason) {
    if (!pageInfo) {
      btn.disabled = false;
      msg.style.display = 'none';
      if (openSection) openTscaSection();
      var aiMsg1 = document.getElementById('tscaAiMsg');
      showMessage(aiMsg1, 'error', (errReason || 'ページ情報を取得できませんでした') + '。商品情報は手動で入力してください。');
      return;
    }
    callTscaDescriptionAi(pageInfo, function(err, result) {
      if (err || !result) {
        btn.disabled = false;
        msg.style.display = 'none';
        if (openSection) openTscaSection();
        var aiMsg2 = document.getElementById('tscaAiMsg');
        showMessage(aiMsg2, 'error', 'AI呼び出しに失敗しました: ' + (err ? err.message : '不明なエラー') + '。商品情報は手動で入力してください。');
        return;
      }
      // 幅チェック→（超過なら1回だけ自動短縮リトライ）→年齢ガード。
      // リトライ中もボタンは無効のまま・進行表示はボタン脇の msg に出る。
      // エラーがあってもタイトルは欄に入れたまま（ユーザーが修正できるように）、
      // 確認画面へ進む前の最終ゲート（tscaGoToConfirm）でも同じ検査で再度ブロックされる。
      tscaFinalizeAiTitle(result, msg, function(finalTitle, errText) {
        btn.disabled = false;
        msg.style.display = 'none';
        if (openSection) openTscaSection();
        document.getElementById('tscaProductTitle').value = finalTitle;
        document.getElementById('tscaProductDesc').value = result.description;
        showTscaAiResultBadge(true);
        if (errText) {
          var aiMsg3 = document.getElementById('tscaAiMsg');
          showMessage(aiMsg3, 'error', errText);
        }
      });
    });
  });
}

/** ホームの赤ボタン: 開いているページをAIで分析し、TSCA用の英語商品説明を生成してTSCAフォームを開く。 */
function startTscaAiFlow() {
  var msg = document.getElementById('tscaAiHomeMsg');
  var btn = document.getElementById('tscaAiBtn');
  runTscaAiFromPageFlow(btn, msg, true);
}

/** 開いているページの情報からTSCA用の {title, description}（通関用タイトル＋詳細説明）を生成する。
 *  cb(err, result): 成功時 result = { title, description }。 */
function callTscaDescriptionAi(pageInfo, cb) {
  var lines = [
    'Product URL: ' + pageInfo.url,
    'Product name: ' + (pageInfo.productName || '')
  ];
  if (pageInfo.brand)       lines.push('Brand: ' + pageInfo.brand);
  if (pageInfo.condition)   lines.push('Condition: ' + pageInfo.condition);
  if (pageInfo.category)    lines.push('Category on site: ' + pageInfo.category);
  if (pageInfo.description) lines.push('Description: ' + pageInfo.description);

  tscaCallAiJson(tscaAiSystemPrompt('product page information'), lines.join('\n'), cb);
}

// -------------------------------------------------------
// TSCA証明書（FedEx）機能（v1.3.0）
// 様式PDF（ユーザー提供）の2ページ目（単発発送用）に、
// AcroFormを使わずHelveticaテキスト＋ポリライン(チェックマーク)を
// 直接焼き付けてフラット化したPDFを生成する。
// -------------------------------------------------------

/** 様式PDF（612x792pt, USレター）の2ページ目における各項目の座標。
 *  本日実際にFedExへ提出したPDF(TSCA_874297801136.pdf)をpdfplumberで
 *  実測して得た値（PDF標準の左下原点・pt単位）。 */
var TSCA_TEMPLATE_PAGE_INDEX = 1; // 3ページ構成の様式の2ページ目（単発発送用）
var TSCA_FONT_SIZE = 10;
/** 商品説明欄の折り返し幅(pt)。以前は様式の印字下線の範囲(280pt)だったが、
 *  下線をコードで右マージンまで延長する方式に変更したため全幅に拡大した。
 *  実測根拠: 記入開始x=87、延長後の下線右端 TSCA_DESC_LINE_END_X=540（下記）。
 *  540-87=453 から数ptの安全マージンを引いて450。 */
var TSCA_DESC_MAX_WIDTH = 450;
var TSCA_DETAILS_NOTE = 'Details: see attached product list.'; // 詳細を続紙へ送るときの案内文

/** 様式に印字済みの商品説明欄の下線（"_"グリフの連なり、Helvetica 約9.96pt）の右端。
 *  data/tsca_template.pdf 2ページ目をpdfplumberで文字単位に実測した値（x1=372.05〜372.11）。
 *  下線の延長描画はこの位置から開始する（0.6ptだけ重ねて隙間を防ぐ）。 */
var TSCA_DESC_PRINTED_END_X = 372.1;

/** 延長後の下線の右端。様式本文パラグラフの右端の実測値539.34pt（証明文言の段落、
 *  pdfplumberで全文字のx1を実測した最大値）に合わせて540とした。ページ幅612ptに対して
 *  右マージン72ptとなり、続紙ページのマージン(72pt)とも一致する。 */
var TSCA_DESC_LINE_END_X = 540;

/** 下線延長の描画位置と太さ。印字下線は Arial-BoldMT 9.96pt の "_" グリフで、
 *  生成PDFを200dpiでラスタライズしてインクのピクセル位置を実測した結果、
 *  インクの中心は記入ベースライン(TSCA_COORD.descRows[].y)の 3.5pt 下
 *  （1行目: ベースライン323.9に対しインク中心320.40）、太さ約1.05pt（3px/200dpi）。
 *  Helveticaの"_"グリフは位置(319.3)も太さも印字と合わないため、グリフではなく
 *  チェックマークと同じ drawLine で実測値どおりの水平線を引く。 */
var TSCA_DESC_LINE_Y_OFFSET = 3.5;   // 記入ベースラインから下線中心までの距離(pt)
var TSCA_DESC_LINE_THICKNESS = 1.05; // 印字下線の実測太さ(pt)

var TSCA_COORD = {
  date:           { x: 104.0, y: 690.9 },
  waybill:        { x: 307.0, y: 666.9 },
  companyName:    { x: 220.0, y: 507.96 },
  companyAddress: { x: 220.0, y: 484.92 },
  certifierName:  { x: 220.0, y: 461.9 },
  certifierTitle: { x: 220.0, y: 438.96 },
  certifierPhone: { x: 220.0, y: 415.9 },
  certifierEmail: { x: 220.0, y: 392.9 },
  signature:      { x: 220.0, y: 369.9 },
  descRows: [
    { x: 87.0, y: 323.9 },
    { x: 87.0, y: 300.84 },
    { x: 87.0, y: 277.92 },
    { x: 87.0, y: 254.88 },
    { x: 87.0, y: 231.84 },
    { x: 87.0, y: 208.92 },
    { x: 87.0, y: 185.88 }
  ]
};

/** Positive/Negative Certification チェックボックスの左下座標（AcroFormウィジェット実測値） */
var TSCA_CHECKBOX = {
  positive: { x0: 67.9464, y0: 619.411 },
  negative: { x0: 67.948,  y0: 527.526 }
};

/** チェックマーク（✓）のポリライン。ボックス左下からの相対オフセット。
 *  実際に手描きでチェックされたPDFのベクター線を実測して得た形状。 */
var TSCA_CHECK_OFFSETS = [
  { dx: 3.552,  dy: 9.974 },
  { dx: 7.552,  dy: 4.474 },
  { dx: 15.052, dy: 15.474 }
];

/** 下部フィールドの利用可能幅(pt)。data/tsca_template.pdf の2ページ目をpdfplumberで
 *  文字単位に実測し、各項目の下線（アンダースコアの連続）が実際に終わるx座標を求めて、
 *  そこから各項目の開始x座標（TSCA_COORDのx=220.0）を引いた値から、安全マージンを引いて決めた。
 *  実測値（下線終端x）: Company name/address ≈488.46、Certifier name/title ≈488.43〜488.44、
 *  Certifier phone/email/signature ≈493.94〜493.97（いずれも左下原点pt、フォームのページ幅612pt）。
 *  安全マージンとして実測値から約6〜8pt差し引いている。 */
var TSCA_FIELD_WIDTH = {
  companyName:    262,
  companyAddress: 262,
  certifierName:  262,
  certifierTitle: 262,
  certifierPhone: 268,
  certifierEmail: 268,
  signature:      268
};

/** 下部フィールドが幅に収まらない場合に許容する最小フォントサイズ(pt) */
var TSCA_MIN_FONT_SIZE = 7;

// ---- base64 <-> ArrayBuffer ヘルパー ----
function tscaArrayBufferToBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var chunkSize = 0x8000;
  var chunks = [];
  for (var i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(''));
}

function tscaBase64ToUint8Array(base64) {
  var binary = atob(base64);
  var len = binary.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function tscaFormatDateMMDDYYYY(d) {
  var mm = d.getMonth() + 1;
  var dd = d.getDate();
  return (mm < 10 ? '0' + mm : String(mm)) + '/' + (dd < 10 ? '0' + dd : String(dd)) + '/' + d.getFullYear();
}

/** ファイル名用の生成日（YYYYMMDD）。Waybill番号が未入力の場合のファイル名に使う。 */
function tscaFormatDateYYYYMMDD(d) {
  var mm = d.getMonth() + 1;
  var dd = d.getDate();
  return String(d.getFullYear()) + (mm < 10 ? '0' + mm : String(mm)) + (dd < 10 ? '0' + dd : String(dd));
}

/** サブビュー切り替え（#sectionTsca 内の .tsca-sub 要素のみ対象） */
function showTscaSub(id) {
  document.querySelectorAll('.tsca-sub').forEach(function(el) {
    el.style.display = (el.id === id) ? '' : 'none';
  });
}

/** 会社情報設定の「Name and Title」から氏名部分だけを取り出す（カンマ区切り想定） */
function tscaSplitNameTitle(nameTitle) {
  var s = (nameTitle || '').trim();
  var idx = s.indexOf(',');
  if (idx === -1) return { name: s, title: '' };
  return { name: s.substring(0, idx).trim(), title: s.substring(idx + 1).trim() };
}

/** #sectionTsca を開く。様式PDF（差し替え済みならそれ、なければ同梱の様式）で記入フォームへ直接進む。 */
function openTscaSection() {
  showSection('sectionTsca');
  tscaEnterForm();
}

/** 様式PDFの状態表示（差し替え済み／同梱）と差し替えリセットボタンの表示を更新する */
function tscaUpdateTemplateStatus() {
  chrome.storage.local.get(['_hsTscaTemplatePdf'], function(stored) {
    var hasCustom = !!stored._hsTscaTemplatePdf;
    state.tsca.templateLoaded = hasCustom;
    var statusEl = document.getElementById('tscaTemplateStatusText');
    var resetBtn = document.getElementById('tscaResetTemplateBtn');
    if (statusEl) {
      statusEl.textContent = hasCustom
        ? '差し替えた様式を使用中です。'
        : '同梱の様式（FedEx TSCA Certification）を使用中です。';
    }
    if (resetBtn) resetBtn.style.display = hasCustom ? '' : 'none';
  });
}

/** 様式PDFのバイト列を取得する。差し替え済みならchrome.storage.localから、
 *  なければ同梱の data/tsca_template.pdf を fetch(chrome.runtime.getURL(...)) で読み込む
 *  （拡張機能内のローカルファイル読み込みであり、外部通信ではない）。
 *  callback(bytes) または失敗時 callback(null, err) を呼ぶ。 */
function tscaGetTemplateBytes(callback) {
  chrome.storage.local.get(['_hsTscaTemplatePdf'], function(stored) {
    if (stored._hsTscaTemplatePdf) {
      callback(tscaBase64ToUint8Array(stored._hsTscaTemplatePdf));
      return;
    }
    fetch(chrome.runtime.getURL('data/tsca_template.pdf'))
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function(buf) { callback(new Uint8Array(buf)); })
      .catch(function(err) { callback(null, err); });
  });
}

/** ファイル選択時（差し替え）: PDFを読み込み、base64でローカル保存。ページ数を軽く検証（警告のみ）。 */
function tscaHandleFileSelect(file) {
  var msgEl = document.getElementById('tscaUploadMsg');
  if (!file) return;
  if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name || '')) {
    showMessage(msgEl, 'error', 'PDFファイルを選択してください。');
    return;
  }
  showMessage(msgEl, 'info', '読み込み中…');

  var reader = new FileReader();
  reader.onload = function(e) {
    var arrayBuffer = e.target.result;
    var base64 = tscaArrayBufferToBase64(arrayBuffer);

    if (typeof PDFLib === 'undefined') {
      showMessage(msgEl, 'error', 'PDF処理ライブラリの読み込みに失敗しました。拡張機能を再読み込みしてください。');
      return;
    }

    PDFLib.PDFDocument.load(arrayBuffer).then(function(doc) {
      var pageCount = doc.getPageCount();
      chrome.storage.local.set({ _hsTscaTemplatePdf: base64, _hsTscaPageCount: pageCount }, function() {
        state.tsca.templateLoaded = true;
        state.tsca.pageCount = pageCount;
        if (pageCount !== 3) {
          showMessage(msgEl, 'warn',
            '差し替えました。ただしページ数が想定（3ページ）と異なります（' + pageCount + 'ページ）。' +
            '様式が違う可能性がありますが、このまま続行できます。2ページ目が単発発送用の様式であることをご確認ください。' +
            '文字の位置がずれる可能性があります。');
        } else {
          showMessage(msgEl, 'success', '差し替えた様式PDFを読み込みました（3ページ構成を確認しました）。');
        }
        tscaUpdateTemplateStatus();
      });
    }).catch(function(err) {
      showMessage(msgEl, 'error', 'PDFの読み込みに失敗しました: ' + (err && err.message ? err.message : String(err)));
    });
  };
  reader.onerror = function() {
    showMessage(msgEl, 'error', 'ファイルの読み込みに失敗しました。');
  };
  reader.readAsArrayBuffer(file);
}

/** 差し替えた様式PDFを削除し、同梱の様式に戻す */
function tscaResetTemplate() {
  chrome.storage.local.remove(['_hsTscaTemplatePdf', '_hsTscaPageCount'], function() {
    state.tsca.templateLoaded = false;
    state.tsca.pageCount = null;
    document.getElementById('tscaFileInput').value = '';
    var msgEl = document.getElementById('tscaUploadMsg');
    msgEl.style.display = 'none';
    tscaUpdateTemplateStatus();
  });
}

/** 記入フォーム表示。既定値・会社情報設定からのプリフィルを行う。
 *  同梱発送で複数商品を登録する運用（商品ページを切り替えて赤ボタンを押し直す）に対応するため、
 *  商品リスト（state.tsca.products）と入力中の下書き（#tscaProductDesc）が既にある場合は
 *  「作業継続中のドキュメント」とみなし、Date/Waybill/会社情報などはリセットしない。
 *  商品リストも下書きも空の場合のみ「新規ドキュメント」として初期値を入れ直す。 */
function tscaEnterForm() {
  tscaUpdateTemplateStatus();

  // フォームに入った時点で「PDF完了」フラグを解除する（＝入力保持モードに戻す）。
  // PDF生成後にフォームへ戻って編集を続けるケースで、後から「ホームへ」を押しても
  // 編集内容が黙って消えないようにするため。
  state.tsca.completed = false;

  var draftEl = document.getElementById('tscaProductDesc');
  var titleDraftEl = document.getElementById('tscaProductTitle');
  var isFreshStart = (state.tsca.products.length === 0) && !draftEl.value.trim() &&
    !(titleDraftEl && titleDraftEl.value.trim());

  if (isFreshStart) {
    document.getElementById('tscaDate').value = tscaFormatDateMMDDYYYY(new Date());
    document.getElementById('tscaWaybill').value = '';
    document.getElementById('tscaCertNegative').checked = true;
    document.getElementById('tscaCertPositive').checked = false;

    var nt = tscaSplitNameTitle(state.company.nameTitle);
    document.getElementById('tscaCertifierName').value  = state.company.certifierName || nt.name || '';
    document.getElementById('tscaCertifierTitle').value = state.company.certifierTitle || nt.title || '';
    document.getElementById('tscaCertifierPhone').value = state.company.phone || '';
    document.getElementById('tscaCertifierEmail').value = state.company.email || '';
    document.getElementById('tscaCompanyName').value    = state.company.name || '';
    document.getElementById('tscaCompanyAddress').value = state.company.address || '';
  }

  var aiMsg = document.getElementById('tscaAiMsg');
  if (aiMsg) aiMsg.style.display = 'none';
  showTscaAiResultBadge(false);
  tscaUpdateAddProductBtnLabel();
  tscaRenderProductList();

  // 設定にCertifier情報が何も保存されていなければ、設定画面への案内を表示
  var hintEl = document.getElementById('tscaSettingsHint');
  if (hintEl) {
    var hasCertifierInfo = !!(state.company.certifierName || state.company.phone || state.company.email);
    hintEl.style.display = hasCertifierInfo ? 'none' : '';
  }

  showTscaSub('tscaSubForm');
}

/** AIで英語の通関用タイトル・詳細説明を生成（既存のOpenAI利用パターンを踏襲）。
 *  タイトル欄・詳細欄のどちらに書かれた内容でも元情報として使い、
 *  生成結果（title + description）を両方の欄にセットする。 */
function tscaGenerateDescription() {
  var msgEl = document.getElementById('tscaAiMsg');
  var btn = document.getElementById('tscaAiDescBtn');
  var titleEl = document.getElementById('tscaProductTitle');
  var textEl = document.getElementById('tscaProductDesc');

  if (!state.openaiKey) {
    showMessage(msgEl, 'error', 'APIキーが未設定です。設定画面で OpenAI APIキーを入力してください。');
    return;
  }
  var source = (titleEl.value.trim() + '\n' + textEl.value.trim()).trim();
  if (!source) {
    showMessage(msgEl, 'error', '商品名など、元になる情報を先に入力してください（日本語可）。');
    return;
  }

  btn.disabled = true;
  showMessage(msgEl, 'info', '生成中…');

  tscaCallAiJson(tscaAiSystemPrompt('given text'), source, function(err, result) {
    if (err || !result) {
      btn.disabled = false;
      showMessage(msgEl, 'error', 'AI呼び出しに失敗しました: ' + (err ? err.message : '不明なエラー'));
      return;
    }
    // 幅チェック→（超過なら1回だけ自動短縮リトライ）→年齢ガード。
    // リトライ中もボタンは無効のまま・進行表示は msgEl に出る。
    // エラーがあってもタイトルは欄に入れたまま（ユーザーが修正できるように）、
    // 確認画面へ進む前の最終ゲート（tscaGoToConfirm）でも同じ検査で再度ブロックされる。
    tscaFinalizeAiTitle(result, msgEl, function(finalTitle, errText) {
      btn.disabled = false;
      titleEl.value = finalTitle;
      textEl.value = result.description;
      if (errText) {
        showMessage(msgEl, 'error', errText);
        return;
      }
      msgEl.style.display = 'none';
    });
  });
}

// -------------------------------------------------------
// TSCA証明書: 複数商品（同梱発送）対応の商品リスト管理
// -------------------------------------------------------

/** #tscaProductDesc の入力内容を整形して返す。改行(\n)は保持する（AIが生成する説明文は
 *  "\nMaterials:\n- ..." のような箇条書き形式のため、改行を潰すと tscaWrapDescription が
 *  各行を独立した1行として折り返せなくなる）。各行内の連続空白は1つにまとめ、行ごとに
 *  前後の空白を除去し、空行は詰める（行番号がずれないように）。 */
function tscaNormalizeProductText(raw) {
  return (raw || '')
    .split(/\r?\n/)
    .map(function(s) { return s.replace(/[ \t]+/g, ' ').trim(); })
    .filter(function(s) { return s; })
    .join('\n')
    .trim();
}

/** タイトル入力欄の内容を1行に正規化する（改行・連続空白は1スペースに） */
function tscaNormalizeTitleText(raw) {
  return (raw || '').replace(/\s+/g, ' ').trim();
}

// -------------------------------------------------------
// TSCA証明書: タイトルの年齢表記の機械検査
// -------------------------------------------------------

/** 年齢表記エラーの共通メッセージ（AI生成直後・確認前検証で同一文言を使う） */
var TSCA_AGE_LABEL_ERROR =
  '年齢表記は Age 13+（トレカ・カードゲーム）または Age 15+（その他の玩具・コレクター品）' +
  'のみ使用できます。タイトルを修正してください';

/** タイトル内の年齢表記を機械的に検出し、13/15 以外の年齢が含まれていれば
 *  その表記文字列の配列を返す（問題なければ空配列）。
 *  AIがページ上の他セラー由来の年齢表記（4+ 等）をコピーしてしまう問題への
 *  決定的なガード。プロンプトの指示には頼らない。黙って書き換え・削除はしない
 *  （検出したら呼び出し側でエラー表示して止め、修正はユーザーが行う）。
 *
 *  検出パターン（大文字小文字問わず）:
 *   A) 「Age/Ages + 数字 + (+ / and up / or older / and over / & up)」の組み合わせ。
 *      例: "Age 13+" "For Ages 4+" "Ages 3 and up" "AGE 6 & UP"
 *      数字の後に + や and up 等の年齢マーカーを必須にすることで、
 *      商品名中の "Ice Age 3" のような語を年齢と誤判定しない。
 *   B) 裸の「数字+」。ただし誤検知を避けるため、
 *      「数字がトークンの先頭（行頭・空白・カンマ・開き括弧・引用符の直後）で始まり、
 *       かつ 数字+ が末尾またはカンマ直前（閉じ括弧・引用符は挟んでよい）にある」
 *      場合のみ年齢とみなす。例: "... Toy 4+" "... (4+)" はB該当、
 *      "RX-78-2" "TD-384" "Figure #4" は + が無い・トークン先頭でないため非該当。
 *      "DMC-GF7+" のような型番末尾の + も、数字が英字・ハイフンに続いておりトークン
 *      先頭でないため非該当。 */
function tscaFindInvalidAgeLabels(title) {
  var t = String(title || '');
  var invalid = [];
  var m, n;

  // A) Age/Ages という語 + 数字 + 年齢マーカー
  var reWord = /\bages?\s*:?\s*(\d{1,3})\s*(?:\+|(?:and|&|or)\s+(?:up|older|over|above))/gi;
  while ((m = reWord.exec(t)) !== null) {
    n = parseInt(m[1], 10);
    if (n !== 13 && n !== 15) invalid.push(m[0].replace(/\s+/g, ' ').trim());
  }

  // B) 裸の「数字+」（トークン先頭始まり・末尾またはカンマ直前のみ）
  var reBare = /(^|[\s,("'“])(\d{1,3})\s*\+(?=[)"'”]*\s*(?:$|,))/g;
  while ((m = reBare.exec(t)) !== null) {
    n = parseInt(m[2], 10);
    if (n !== 13 && n !== 15) invalid.push(m[2] + '+');
  }

  // 重複表記を除去（AとBの両方に一致した場合など）
  return invalid.filter(function(v, i) { return invalid.indexOf(v) === i; });
}

// -------------------------------------------------------
// TSCA証明書: AI生成タイトルの幅チェック＋自動短縮リトライ
// -------------------------------------------------------

/** タイトル幅超過エラーの共通メッセージ */
var TSCA_TITLE_WIDTH_ERROR =
  'タイトルが様式の1行（英語で約85文字が上限の目安）に収まりません。' +
  'タイトル欄を手動で短くしてください（商品名は核心部分だけ残す・ブランド名を外す等）。';

/** タイトルが様式の1行幅（太字10pt・TSCA_DESC_MAX_WIDTH=450pt）に収まるかを判定して
 *  cb(fits) を呼ぶ。確認前ゲート（tscaGoToConfirm→tscaBuildFormLayout）と同一基準。
 *  PDFLibが使えない環境では判定せず true を返す（その場合も確認前ゲート・PDF生成時に
 *  必ず同じ基準で再チェックされるため、すり抜けて出力されることはない）。 */
function tscaTitleFitsWidth(title, cb) {
  if (!title || typeof PDFLib === 'undefined') { cb(true); return; }
  PDFLib.PDFDocument.create().then(function(doc) {
    return doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
  }).then(function(bold) {
    cb(bold.widthOfTextAtSize(title, TSCA_FONT_SIZE) <= TSCA_DESC_MAX_WIDTH);
  }).catch(function() { cb(true); });
}

/** 幅超過タイトルの短縮をAIに1回だけ再依頼するときのシステムプロンプト。
 *  Condition と年齢サフィックスは維持させ、商品名の短縮・ブランド省略だけを行わせる。 */
function tscaShortenTitlePrompt() {
  return [
    'The customs product title below is too long to fit on one line of a US customs form.',
    'Rewrite it so that the WHOLE title is 85 characters or fewer. This is an ABSOLUTE requirement.',
    'Rules:',
    '- Keep the same overall format and meaning. Do not add anything new.',
    '- Keep the condition word at the start as just "Used" or "New". If the title starts with',
    '  "Used (secondhand)", shorten that to "Used".',
    '- If an age statement suffix like ", Not for Children (Age 15+)" is present, keep it',
    '  EXACTLY unchanged at the end.',
    '- Shorten the quoted product name to at most 20 characters, keeping only the core',
    '  character/product name (e.g. "Ultimate Madoka & Devil Homura" -> "Madoka & Homura").',
    '- Remove ", by <brand>" if needed.',
    'Return ONLY a JSON object: {"title": "<shortened title>"}. No markdown, no explanation.'
  ].join('\n');
}

/** AI生成直後のタイトル受け入れ共通処理。
 *  1) 幅チェック（太字10pt・450pt。確認前ゲートと同一基準）
 *  2) 超過していたら自動で「1回だけ」AIに短縮を再依頼（description は1回目の結果を
 *     維持し、title だけ差し替える）。リトライ中は msgEl に進行表示を出す。
 *  3) 最終タイトルに年齢ガード（tscaFindInvalidAgeLabels）を適用。
 *  done(finalTitle, errText) を必ず1回呼ぶ。errText は null（問題なし）または
 *  ユーザー向けエラーメッセージ（幅超過と年齢violationの両方があれば改行で併記）。
 *  このコードがタイトルを機械的に切り捨てることはない（黙って切らない原則）。
 *  超過が解消しない場合もタイトルは欄に残し、修正はユーザーが行う。 */
function tscaFinalizeAiTitle(result, msgEl, done) {
  function finish(title, tooWide) {
    var errs = [];
    if (tooWide) errs.push(TSCA_TITLE_WIDTH_ERROR);
    var bad = tscaFindInvalidAgeLabels(title);
    if (bad.length) errs.push(TSCA_AGE_LABEL_ERROR + '（検出: ' + bad.join(', ') + '）');
    done(title, errs.length ? errs.join('\n') : null);
  }

  tscaTitleFitsWidth(result.title, function(fits) {
    if (fits) { finish(result.title, false); return; }

    // 自動短縮リトライ（1回だけ）
    showMessage(msgEl, 'info', 'タイトルが長いため短縮中…');
    tscaCallAiJson(tscaShortenTitlePrompt(), result.title, function(err, retry) {
      if (err || !retry || !retry.title) {
        // リトライ失敗: 1回目のタイトルのまま超過エラーとして返す
        finish(result.title, true);
        return;
      }
      tscaTitleFitsWidth(retry.title, function(fits2) {
        finish(retry.title, !fits2);
      });
    });
  });
}

/** 商品1件を {title, description} 形式に正規化して返す。
 *  旧データ構造（descriptionのみ）の下書き・stateが残っていても壊れないよう、
 *  タイトルが無い場合は詳細説明の1行目をタイトルに繰り上げ、残りを詳細として扱う。 */
function tscaEffectiveProduct(p) {
  var title = tscaNormalizeTitleText(p && p.title);
  var desc = (p && p.description) ? String(p.description).trim() : '';
  if (!title && desc) {
    var lines = desc.split('\n');
    title = tscaNormalizeTitleText(lines.shift());
    desc = lines.join('\n').trim();
  }
  return { title: title, description: desc };
}

/** 入力欄（#tscaProductTitle / #tscaProductDesc）の内容を商品リストへ確定する。
 *  state.tsca.editingIndex が設定されていれば、その位置を上書きする（編集の確定）。
 *  そうでなければ末尾に新規追加する。両方の入力欄が空の場合は何もしない。
 *  タイトルが空で詳細だけがある場合（旧形式の下書きなど）も内容を失わないよう、
 *  詳細の1行目をタイトルに繰り上げて確定する（tscaEffectiveProductと同じ規則）。
 *  戻り値: 確定した場合は true、入力が空で何もしなかった場合は false。 */
function tscaCommitDraft() {
  var titleEl = document.getElementById('tscaProductTitle');
  var textEl = document.getElementById('tscaProductDesc');
  if (!titleEl || !textEl) return false;
  var product = tscaEffectiveProduct({
    title: titleEl.value,
    description: tscaNormalizeProductText(textEl.value)
  });
  if (!product.title && !product.description) return false;

  var idx = state.tsca.editingIndex;
  if (idx != null && idx >= 0 && idx < state.tsca.products.length) {
    state.tsca.products[idx] = product;
  } else {
    state.tsca.products.push(product);
  }
  state.tsca.editingIndex = null;
  titleEl.value = '';
  textEl.value = '';
  showTscaAiResultBadge(false);
  tscaRenderProductList();
  tscaUpdateAddProductBtnLabel();
  return true;
}

/** 「＋ 商品リストに追加」ボタンのラベルを、新規追加モード／編集モードに応じて切り替える。
 *  編集モード中は「キャンセル」ボタン（tscaCancelEdit）も表示する。 */
function tscaUpdateAddProductBtnLabel() {
  var btn = document.getElementById('tscaAddProductBtn');
  var cancelBtn = document.getElementById('tscaCancelEditBtn');
  var editing = (state.tsca.editingIndex != null);
  if (btn) btn.textContent = editing ? '更新してリストへ反映' : '＋ 商品リストに追加';
  if (cancelBtn) cancelBtn.style.display = editing ? '' : 'none';
}

/** 商品リストUIの再描画。0件の場合は非表示にする（1商品だけの場合の入力の手間を増やさないため）。 */
function tscaRenderProductList() {
  var listEl = document.getElementById('tscaProductList');
  if (!listEl) return;
  var products = state.tsca.products;
  listEl.innerHTML = '';

  if (products.length === 0) {
    listEl.style.display = 'none';
    return;
  }
  listEl.style.display = '';

  products.forEach(function(p, i) {
    var row = document.createElement('div');
    row.className = 'tsca-product-row';
    if (state.tsca.editingIndex === i) row.className += ' tsca-product-row-editing';

    var num = document.createElement('span');
    num.className = 'tsca-product-num';
    num.textContent = (i + 1) + '.';

    var text = document.createElement('span');
    text.className = 'tsca-product-text';
    var ep = tscaEffectiveProduct(p);
    var preview = ep.title + (ep.description ? ' — ' + ep.description.replace(/\s+/g, ' ').trim() : '');
    if (preview.length > 70) preview = preview.substring(0, 70) + '…';
    text.textContent = preview;

    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-ghost btn-xs';
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', function() { tscaEditProduct(i); });

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-ghost btn-xs tsca-product-del';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', function() { tscaDeleteProduct(i); });

    row.appendChild(num);
    row.appendChild(text);
    row.appendChild(editBtn);
    row.appendChild(delBtn);
    listEl.appendChild(row);
  });
}

/** 商品リストの1件を編集用に入力欄へ読み込む。編集中でも項目自体はリストに残したままにし、
 *  「更新してリストへ反映」（tscaCommitDraft）を押した時点で初めてその内容を上書きする
 *  （編集中に別の操作へ移っても内容が消えないようにするため、編集開始時にリストから外さない）。
 *  確定は明示的な「更新してリストへ反映」操作のみで行う。既に別項目を編集中、または
 *  未確定の新規下書きがある状態で別項目の「編集」を押した場合も、その内容を黙って商品
 *  リストへ確定はしない（入力欄の中身は新しい編集対象の内容で置き換わる。確定していない
 *  下書き自体はまだリストに存在しないので、消えるのは「保存されていない未確定の入力」の
 *  みで、既存の商品データが上書きされることはない）。 */
function tscaEditProduct(index) {
  var p = state.tsca.products[index];
  if (!p) return;
  var ep = tscaEffectiveProduct(p);
  state.tsca.editingIndex = index;
  document.getElementById('tscaProductTitle').value = ep.title;
  document.getElementById('tscaProductDesc').value = ep.description;
  showTscaAiResultBadge(false);
  tscaRenderProductList();
  tscaUpdateAddProductBtnLabel();
}

/** 編集モードのキャンセル。商品リストの該当項目は編集開始以降一切変更していないため
 *  （更新は明示的な「更新してリストへ反映」でのみ行われる）、リスト側は何もせず、
 *  editingIndexをクリアして入力欄を空に戻すだけでよい。 */
function tscaCancelEdit() {
  state.tsca.editingIndex = null;
  document.getElementById('tscaProductTitle').value = '';
  document.getElementById('tscaProductDesc').value = '';
  showTscaAiResultBadge(false);
  tscaRenderProductList();
  tscaUpdateAddProductBtnLabel();
}

/** 商品リストから1件削除する。編集中の項目を削除した場合は入力欄もクリアする。 */
function tscaDeleteProduct(index) {
  state.tsca.products.splice(index, 1);
  if (state.tsca.editingIndex === index) {
    state.tsca.editingIndex = null;
    document.getElementById('tscaProductTitle').value = '';
    document.getElementById('tscaProductDesc').value = '';
    showTscaAiResultBadge(false);
  } else if (state.tsca.editingIndex != null && state.tsca.editingIndex > index) {
    state.tsca.editingIndex--;
  }
  tscaRenderProductList();
  tscaUpdateAddProductBtnLabel();
}

/** 商品リスト（{title, description}）の様式2ページ目への出力レイアウトを組み立てる。
 *  戻り値: { mode, lines, needsContinuation, errors }
 *   - lines: 様式の1.〜7.に上から順に描画する {text, kind} の配列（最大7要素）。
 *     kind: 'title'（太字）/ 'detail'（通常）/ 'note'（案内文・太字・中央寄せ）/ 'more'（"+ N more items"・通常）。
 *   - needsContinuation: true なら続紙（別紙）に全商品のタイトル＋詳細説明を付ける。
 *   - errors: 1行幅(TSCA_DESC_MAX_WIDTH)に収まらないタイトル等のエラーメッセージ配列。
 *     1件でもあれば呼び出し側でエラー表示して止める（黙って切らない）。
 *  mode の内訳:
 *   - 'single'：商品1件。1行目=タイトル、2行目以降=詳細説明（残り6行に収まる場合）。
 *   - 'single-continuation'：商品1件だが詳細が残り6行に収まらない。2行目に案内文、詳細は続紙へ（エラーにしない）。
 *   - 'titles'：商品2〜7件。各行にタイトル。空き行があれば次の行に案内文。詳細は続紙へ。
 *   - 'overflow'：商品8件以上。1〜6行目=最初の6件のタイトル、7行目="+ N more items ..."。全商品は続紙へ。
 *  font=Helvetica（詳細行・more行の描画/計測用）、boldFont=Helvetica-Bold（タイトル行の描画/計測用）。
 *  タイトルは太字で描画するため、幅チェックも太字で行う。 */
function tscaBuildFormLayout(font, boldFont, products) {
  var rows = TSCA_COORD.descRows.length; // 7
  var errors = [];
  function fits(text, f) {
    return f.widthOfTextAtSize(text, TSCA_FONT_SIZE) <= TSCA_DESC_MAX_WIDTH;
  }

  // 全商品のタイトルを一律で幅チェックする（続紙にしか載らない8件目以降も含む。
  // 後から商品を削除して様式面に繰り上がっても通るよう、基準を統一しておく）。
  products.forEach(function(p, i) {
    var t = p.title || '';
    if (!t) {
      errors.push('商品' + (i + 1) + 'のタイトルが空です。');
    } else if (!fits(t, boldFont)) {
      errors.push('商品' + (i + 1) + 'のタイトルが様式の1行に収まりません（英語で約85文字が上限の目安です）: ' + t);
    }
  });

  var lines = [];
  var needsContinuation = false;
  var mode;

  if (products.length === 1) {
    var p0 = products[0];
    lines.push({ text: p0.title || '', kind: 'title' });
    if (p0.description) {
      var wrap = tscaWrapDescription(font, p0.description, TSCA_DESC_MAX_WIDTH, rows - 1);
      if (wrap.overflow) {
        mode = 'single-continuation';
        lines.push({ text: TSCA_DETAILS_NOTE, kind: 'note' });
        needsContinuation = true;
      } else {
        mode = 'single';
        wrap.lines.forEach(function(t) { lines.push({ text: t, kind: 'detail' }); });
      }
    } else {
      mode = 'single';
    }
  } else if (products.length <= rows) {
    mode = 'titles';
    products.forEach(function(p) { lines.push({ text: p.title || '', kind: 'title' }); });
    var anyDetails = products.some(function(p) { return p.description; });
    if (anyDetails) {
      needsContinuation = true;
      if (lines.length < rows) lines.push({ text: TSCA_DETAILS_NOTE, kind: 'note' }); // 7件ちょうどのときは空き行が無いので省略
    }
  } else {
    mode = 'overflow';
    var visible = rows - 1; // 6
    products.slice(0, visible).forEach(function(p) { lines.push({ text: p.title || '', kind: 'title' }); });
    var moreLine = '+ ' + (products.length - visible) + ' more items (see attached product list)';
    if (!fits(moreLine, font)) {
      errors.push('"' + moreLine + '" が様式の1行に収まりません。');
    }
    lines.push({ text: moreLine, kind: 'more' });
    needsContinuation = true;
  }

  return { mode: mode, lines: lines, needsContinuation: needsContinuation, errors: errors };
}

/** 様式2ページ目の商品欄（1.〜7.）に layout.lines を描画する。
 *  - 書き込みがある行だけ、印字済み下線の右端(TSCA_DESC_PRINTED_END_X)から
 *    TSCA_DESC_LINE_END_X まで下線を延長する。チェックマークと同じ drawLine による
 *    水平線で、y位置・太さは印字下線のインクをラスタ実測した値に合わせる
 *    （TSCA_DESC_LINE_Y_OFFSET / TSCA_DESC_LINE_THICKNESS）。
 *    未使用の行は様式の印字下線がそのまま残るため延長しない（様式の見た目を変えない）。
 *  - kind='title' は太字、'note' は太字＋行全幅に対して中央寄せ、その他は通常フォント。 */
function tscaDrawFormProductLines(page, helv, helvBold, layout) {
  var black = PDFLib.rgb(0, 0, 0);
  layout.lines.forEach(function(entry, i) {
    var coord = TSCA_COORD.descRows[i];
    if (!coord || !entry.text) return;

    // 下線の延長（書き込みがある行のみ）。印字下線と僅かに重ねて隙間を防ぐ。
    var lineY = coord.y - TSCA_DESC_LINE_Y_OFFSET;
    page.drawLine({
      start: { x: TSCA_DESC_PRINTED_END_X - 0.6, y: lineY },
      end:   { x: TSCA_DESC_LINE_END_X, y: lineY },
      thickness: TSCA_DESC_LINE_THICKNESS,
      color: black
    });

    if (entry.kind === 'note') {
      var w = helvBold.widthOfTextAtSize(entry.text, TSCA_FONT_SIZE);
      var cx = coord.x + ((TSCA_DESC_LINE_END_X - coord.x) - w) / 2;
      page.drawText(entry.text, { x: cx, y: coord.y, size: TSCA_FONT_SIZE, font: helvBold, color: black });
    } else {
      var f = (entry.kind === 'title') ? helvBold : helv;
      page.drawText(entry.text, { x: coord.x, y: coord.y, size: TSCA_FONT_SIZE, font: f, color: black });
    }
  });
}

/** 下部フィールド1つが指定幅に収まる最大フォントサイズ(pt)を返す。
 *  TSCA_FONT_SIZE(10pt)から0.5pt刻みでTSCA_MIN_FONT_SIZE(7pt)まで縮小して試す。
 *  最小サイズでも収まらない場合は null を返す（呼び出し側でエラー扱いにする）。 */
function tscaFitFontSize(font, text, maxWidth) {
  if (!text) return TSCA_FONT_SIZE;
  for (var size = TSCA_FONT_SIZE; size >= TSCA_MIN_FONT_SIZE - 0.001; size -= 0.5) {
    if (font.widthOfTextAtSize(text, size) <= maxWidth) return size;
  }
  return null;
}

/** 記入フォーム → 確認画面。
 *  下部フィールド（会社情報・Certifier情報）が様式の欄の幅に収まるか、
 *  商品説明（1件なら7行、複数件ならレイアウト判定）が収まるかを確認してから進む。 */
function tscaGoToConfirm() {
  var waybill = document.getElementById('tscaWaybill').value.replace(/[^0-9]/g, '');
  // Waybill番号は任意入力。入力されている場合のみ12桁の数字であることを検証する。
  if (waybill.length !== 0 && waybill.length !== 12) {
    alert('Waybill番号は12桁の数字で入力してください（現在 ' + waybill.length + '桁）。未入力のままでも進められます。');
    return;
  }
  document.getElementById('tscaWaybill').value = waybill;

  var certType = document.getElementById('tscaCertPositive').checked ? 'positive' : 'negative';

  var f = {
    date:            document.getElementById('tscaDate').value.trim(),
    waybill:         waybill,
    certType:        certType,
    certifierName:   document.getElementById('tscaCertifierName').value.trim(),
    certifierPhone:  document.getElementById('tscaCertifierPhone').value.trim(),
    certifierEmail:  document.getElementById('tscaCertifierEmail').value.trim(),
    companyName:     document.getElementById('tscaCompanyName').value.trim(),
    companyAddress:  document.getElementById('tscaCompanyAddress').value.trim(),
    certifierTitle:  document.getElementById('tscaCertifierTitle').value.trim()
  };

  if (!f.certifierName) {
    alert('Certifier name を入力してください。');
    return;
  }

  // 入力欄に残っている下書きを商品リストへ確定してから、商品が1件以上あるか確認する
  tscaCommitDraft();
  if (state.tsca.products.length === 0) {
    alert('商品の通関用タイトル（または詳細説明）を入力してください。');
    return;
  }
  // 旧形式（descriptionのみ）のstateが残っていても壊れないよう、ここで正規化する
  f.products = state.tsca.products.map(tscaEffectiveProduct);

  // 年齢表記の機械検査（確認画面へ進む前の最終ゲート）。
  // AI生成・手入力・編集後のどの経路でも、確定済み商品リストの全タイトルをここで検査する。
  // 13/15以外の年齢表記が1つでもあれば進めない（黙って書き換え・削除はしない）。
  var ageErrors = [];
  f.products.forEach(function(p, i) {
    var bad = tscaFindInvalidAgeLabels(p.title);
    if (bad.length) {
      ageErrors.push('商品' + (i + 1) + ': 「' + bad.join('」「') + '」 — ' + p.title);
    }
  });
  if (ageErrors.length) {
    alert(TSCA_AGE_LABEL_ERROR + '。\n\n' + ageErrors.join('\n'));
    return;
  }

  if (typeof PDFLib === 'undefined') {
    alert('PDF処理ライブラリの読み込みに失敗しました。拡張機能を再読み込みしてください。');
    return;
  }

  PDFLib.PDFDocument.create().then(function(tmpDoc) {
    return Promise.all([
      tmpDoc.embedFont(PDFLib.StandardFonts.Helvetica),
      tmpDoc.embedFont(PDFLib.StandardFonts.HelveticaOblique),
      tmpDoc.embedFont(PDFLib.StandardFonts.HelveticaBold)
    ]);
  }).then(function(fonts) {
    var helv = fonts[0], helvOblique = fonts[1], helvBold = fonts[2];

    // 1) 下部フィールド（会社情報・Certifier情報）の幅チェック
    var fieldChecks = [
      ['Company name', f.companyName, TSCA_FIELD_WIDTH.companyName, helv],
      ['Company address', f.companyAddress, TSCA_FIELD_WIDTH.companyAddress, helv],
      ['Certifier name', f.certifierName, TSCA_FIELD_WIDTH.certifierName, helv],
      ['Certifier title', f.certifierTitle, TSCA_FIELD_WIDTH.certifierTitle, helv],
      ['Certifier phone', f.certifierPhone, TSCA_FIELD_WIDTH.certifierPhone, helv],
      ['Certifier email', f.certifierEmail, TSCA_FIELD_WIDTH.certifierEmail, helv]
    ];
    var tooLong = fieldChecks.filter(function(c) {
      return c[1] && tscaFitFontSize(c[3], c[1], c[2]) == null;
    }).map(function(c) { return c[0]; });
    if (tooLong.length) {
      alert('以下の項目が長すぎて様式の欄に収まりません。短くしてください。\n\n' + tooLong.join('\n'));
      return;
    }

    // 2) 商品レイアウトの判定・チェック（タイトルが様式の1行幅に収まらない場合は
    //    ここでエラー表示して止める。黙って切らない。詳細説明が収まらない場合は
    //    エラーではなく続紙（別紙）に自動的に切り替わる）
    var layout = tscaBuildFormLayout(helv, helvBold, f.products);
    if (layout.errors.length) {
      alert('以下の内容が様式の1行に収まりません。短くしてください。\n\n' + layout.errors.join('\n'));
      return;
    }
    f.layoutMode = layout.mode;
    f.needsContinuation = layout.needsContinuation;

    tscaProceedToConfirm(f);
  }).catch(function(err) {
    console.error('TSCA form validation error', err);
    alert('入力内容のチェックに失敗しました: ' + (err && err.message ? err.message : String(err)));
  });
}

/** 各種チェック通過後、確認画面を構築して表示する。商品リスト全件を表示する。 */
function tscaProceedToConfirm(f) {
  state.tsca.form = f;

  var rows = [
    ['Date', f.date || '(未入力)'],
    ['Waybill番号', f.waybill || '（未入力・後で手書き）'],
    ['証明区分', f.certType === 'positive' ? 'Positive Certification' : 'Negative Certification'],
    ['Certifier name', f.certifierName],
    ['Certifier phone', f.certifierPhone || '(未入力)'],
    ['Certifier email', f.certifierEmail || '(未入力)']
  ];

  var multi = f.products.length > 1;
  var descLabel = multi ? ('商品（' + f.products.length + '件）') : '商品';
  var descValue = f.products.map(function(p, i) {
    var head = (multi ? (i + 1) + '. ' : '') + p.title;
    return p.description ? (head + '\n' + p.description) : head;
  }).join('\n\n');
  rows.push([descLabel, descValue]);

  var rowsCount = TSCA_COORD.descRows.length;
  var layoutNote = '';
  if (f.layoutMode === 'single') {
    layoutNote = '様式の1行目に通関用タイトル、2行目以降に詳細説明を記載します。';
  } else if (f.layoutMode === 'single-continuation') {
    layoutNote = '詳細説明が様式の残り' + (rowsCount - 1) + '行に収まらないため、様式にはタイトルと「' +
      TSCA_DETAILS_NOTE + '」を記載し、詳細説明は続紙（別紙）に記載します。';
  } else if (f.layoutMode === 'titles') {
    layoutNote = '様式の各行に各商品の通関用タイトルを記載し、' +
      (f.needsContinuation
        ? '全商品のタイトルと詳細説明を続紙（別紙）に記載します' +
          (f.products.length >= rowsCount
            ? '（様式に空き行が無いため「' + TSCA_DETAILS_NOTE + '」の行は省略されます）。'
            : '（空き行に「' + TSCA_DETAILS_NOTE + '」を記載します）。')
        : '詳細説明の入力が無いため続紙は付きません。');
  } else if (f.layoutMode === 'overflow') {
    layoutNote = '商品が' + f.products.length + '件（8件以上）のため、様式には最初の' + (rowsCount - 1) +
      '件のタイトルと「+ ' + (f.products.length - (rowsCount - 1)) + ' more items (see attached product list)」を記載し、' +
      '全商品のタイトルと詳細説明を続紙（別紙）に記載します。';
  }
  if (layoutNote) rows.push(['出力形式', layoutNote]);

  rows.push(['Company name', f.companyName || '(未入力・任意)']);
  rows.push(['Company address', f.companyAddress || '(未入力・任意)']);
  rows.push(['Certifier title', f.certifierTitle || '(未入力・任意)']);

  var table = document.getElementById('tscaConfirmTable');
  table.innerHTML = '';
  rows.forEach(function(r) {
    var tr = document.createElement('tr');
    var tdL = document.createElement('td');
    tdL.className = 'tsca-confirm-label';
    tdL.textContent = r[0];
    var tdV = document.createElement('td');
    tdV.className = 'tsca-confirm-value';
    tdV.textContent = r[1];
    tr.appendChild(tdL);
    tr.appendChild(tdV);
    table.appendChild(tr);
  });

  var checkEl = document.getElementById('tscaConfirmCheck');
  checkEl.checked = false;
  document.getElementById('tscaGenerateBtn').disabled = true;

  showTscaSub('tscaSubConfirm');
}

/** Helveticaフォントで商品説明を欄の幅に収まるよう複数行に折り返す（最大7行＝様式の1.〜7.）。
 *  明示的な改行(\n)は尊重する: まず\nで分割し、各セグメントを幅で折り返す
 *  （Materials:の箇条書きが様式の1行ずつに載るようにする）。空行はスキップ。
 *  幅チェックを最後まで行い、maxLinesに収まらない場合も行を切り捨てたり結合したりせず、
 *  overflow: true と実際の行数(lineCount)を添えて返す。呼び出し側で必ずoverflowを確認すること。
 *  スペースを含まない1語がmaxWidthを超える場合は、その語を文字単位で分割して折り返す
 *  （連結した型番・URL等でも必ず幅チェックを通す）。 */
function tscaWrapDescription(font, text, maxWidth, maxLines) {
  var lines = [];

  (text || '').split('\n').forEach(function(segment) {
    var words = segment.split(' ').filter(function(w) { return w; });
    if (words.length === 0) return; // 空行は様式の行を消費させない
    var current = '';

    function splitLongWord(word) {
      // 1語だけでmaxWidthを超える場合、文字単位で分割して行に積む
      var chunk = current;
      for (var i = 0; i < word.length; i++) {
        var ch = word.charAt(i);
        var test = chunk + ch;
        if (font.widthOfTextAtSize(test, TSCA_FONT_SIZE) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk = test;
        }
      }
      current = chunk;
    }

    words.forEach(function(w) {
      var test = current ? (current + ' ' + w) : w;
      var width = font.widthOfTextAtSize(test, TSCA_FONT_SIZE);
      if (width <= maxWidth) {
        current = test;
        return;
      }
      // testが幅超過。まず現在行を確定し、wordだけで幅に収まるか再確認する。
      if (current) {
        lines.push(current);
        current = '';
      }
      if (font.widthOfTextAtSize(w, TSCA_FONT_SIZE) > maxWidth) {
        splitLongWord(w);
      } else {
        current = w;
      }
    });
    if (current) lines.push(current);
  });

  if (lines.length === 0) lines = [''];
  return { lines: lines, lineCount: lines.length, overflow: lines.length > maxLines };
}

/** 続紙（別紙）ページ群を outDoc に追加し、全商品を「番号＋タイトル（太字）」＋
 *  その下に詳細説明（改行保持・折り返し）の形式で描画する。
 *  様式（テンプレート）そのものは改変せず、まっさらなレターサイズページを追加する。
 *  1ページに収まらない場合は複数ページに分ける。同じPDFファイル内に追加されるだけで、
 *  出力は最後まで1つのPDFファイルのまま。 */
function tscaDrawContinuationPages(outDoc, helv, helvBold, products, waybill, dateStr) {
  var black = PDFLib.rgb(0, 0, 0);
  var pageWidth = 612, pageHeight = 792;
  var marginLeft = 72, marginRight = 72, marginTop = 72, marginBottom = 72;
  var maxWidth = pageWidth - marginLeft - marginRight;
  var titleSize = 12, headerSize = 10, bodySize = 10, lineHeight = 14;
  var indent = 24; // 番号（"1." 等）ぶんのぶら下げインデント
  var itemMaxWidth = maxWidth - indent;

  var page = null;
  var y = 0;

  function newPage() {
    page = outDoc.addPage([pageWidth, pageHeight]);
    y = pageHeight - marginTop;
    page.drawText('TSCA Certification - Product List (continued)', { x: marginLeft, y: y, size: titleSize, font: helvBold, color: black });
    y -= titleSize + 6;
    var refLine = waybill ? ('Waybill: ' + waybill) : ('Date: ' + (dateStr || ''));
    page.drawText(refLine, { x: marginLeft, y: y, size: headerSize, font: helv, color: black });
    y -= headerSize + 14;
  }

  newPage();

  products.forEach(function(p, idx) {
    var label = (idx + 1) + '.';
    var titleWrap = tscaWrapDescription(helvBold, p.title || '', itemMaxWidth, Number.MAX_SAFE_INTEGER);
    titleWrap.lines.forEach(function(line, li) {
      if (y < marginBottom + lineHeight) newPage();
      if (li === 0) page.drawText(label, { x: marginLeft, y: y, size: bodySize, font: helvBold, color: black });
      page.drawText(line, { x: marginLeft + indent, y: y, size: bodySize, font: helvBold, color: black });
      y -= lineHeight;
    });
    if (p.description) {
      var descWrap = tscaWrapDescription(helv, p.description, itemMaxWidth, Number.MAX_SAFE_INTEGER);
      descWrap.lines.forEach(function(line) {
        if (y < marginBottom + lineHeight) newPage();
        page.drawText(line, { x: marginLeft + indent, y: y, size: bodySize, font: helv, color: black });
        y -= lineHeight;
      });
    }
    y -= 6; // 商品間の余白
  });
}

/** PDF生成本体。AcroFormは使わず、Helveticaテキストとチェックマークのポリラインを
 *  様式PDFの2ページ目に直接描画してフラット化する。 */
function tscaGeneratePdf() {
  var btn = document.getElementById('tscaGenerateBtn');
  var f = state.tsca.form;
  if (!f) { alert('入力内容が見つかりません。フォームからやり直してください。'); return; }
  if (typeof PDFLib === 'undefined') {
    alert('PDF処理ライブラリの読み込みに失敗しました。拡張機能を再読み込みしてください。');
    return;
  }

  btn.disabled = true;
  btn.textContent = '生成中…';

  tscaGetTemplateBytes(function(templateBytes, err) {
    if (!templateBytes) {
      alert('様式PDFの読み込みに失敗しました: ' + (err && err.message ? err.message : String(err || '')));
      btn.disabled = false;
      btn.textContent = 'PDFを生成してダウンロード';
      return;
    }

    PDFLib.PDFDocument.load(templateBytes).then(function(templateDoc) {
      var pageCount = templateDoc.getPageCount();
      var pageIndex = (pageCount > TSCA_TEMPLATE_PAGE_INDEX) ? TSCA_TEMPLATE_PAGE_INDEX : (pageCount - 1);

      return PDFLib.PDFDocument.create().then(function(outDoc) {
        return outDoc.copyPages(templateDoc, [pageIndex]).then(function(copiedPages) {
          outDoc.addPage(copiedPages[0]);
          // 様式由来のAcroFormウィジェット注釈のみ除去してフラット化する。
          // ウィジェット注釈はページ内容の上に描画されるため、白背景(/MK /BG [1 1 1])の
          // チェックボックスウィジェットが残っていると、焼き付けたチェックマークが
          // 隠れて見えなくなる（11/2025版様式で実測）。
          // ハイライト等ウィジェット以外の注釈は様式の見た目の一部なので残す。
          (function removeWidgetAnnots(pageNode) {
            var annotsName = PDFLib.PDFName.of('Annots');
            var annots = pageNode.lookup(annotsName);
            if (!annots || typeof annots.size !== 'function') return;
            var kept = outDoc.context.obj([]);
            for (var ai = 0; ai < annots.size(); ai++) {
              var annotDict = annots.lookup(ai);
              var subtype = annotDict && annotDict.get ? annotDict.get(PDFLib.PDFName.of('Subtype')) : null;
              if (subtype === PDFLib.PDFName.of('Widget')) continue;
              kept.push(annots.get(ai));
            }
            pageNode.set(annotsName, kept);
          })(copiedPages[0].node);
          return Promise.all([
            outDoc.embedFont(PDFLib.StandardFonts.Helvetica),
            outDoc.embedFont(PDFLib.StandardFonts.HelveticaOblique),
            outDoc.embedFont(PDFLib.StandardFonts.HelveticaBold)
          ]).then(function(fonts) {
            var helv = fonts[0];
            var helvOblique = fonts[1];
            var helvBold = fonts[2];
            var page = outDoc.getPage(0);
            var black = PDFLib.rgb(0, 0, 0);

            function draw(text, coord, font) {
              if (!text) return;
              page.drawText(text, { x: coord.x, y: coord.y, size: TSCA_FONT_SIZE, font: font || helv, color: black });
            }

            /** 幅チェック付きの描画。収まらない場合はフォントサイズを段階的に縮小（10pt→最小7pt）する。
             *  blocking!==false のときは最小サイズでも収まらなければエラーを投げてPDF生成を止める。
             *  blocking===false のときは最小サイズで best-effort 描画する（ブロックしない）。 */
            function drawFitted(text, coord, maxWidth, font, fieldLabel, blocking) {
              if (!text) return;
              var size = tscaFitFontSize(font, text, maxWidth);
              if (size == null) {
                if (blocking === false) {
                  size = TSCA_MIN_FONT_SIZE;
                } else {
                  throw new Error((fieldLabel || '入力内容') + 'が長すぎて様式の欄に収まりません。短くしてください。');
                }
              }
              page.drawText(text, { x: coord.x, y: coord.y, size: size, font: font, color: black });
            }

            draw(f.date, TSCA_COORD.date);
            draw(f.waybill, TSCA_COORD.waybill);
            drawFitted(f.companyName,    TSCA_COORD.companyName,    TSCA_FIELD_WIDTH.companyName,    helv, 'Company name');
            drawFitted(f.companyAddress, TSCA_COORD.companyAddress, TSCA_FIELD_WIDTH.companyAddress, helv, 'Company address');
            drawFitted(f.certifierName,  TSCA_COORD.certifierName,  TSCA_FIELD_WIDTH.certifierName,  helv, 'Certifier name');
            drawFitted(f.certifierTitle, TSCA_COORD.certifierTitle, TSCA_FIELD_WIDTH.certifierTitle, helv, 'Certifier title');
            drawFitted(f.certifierPhone, TSCA_COORD.certifierPhone, TSCA_FIELD_WIDTH.certifierPhone, helv, 'Certifier phone');
            drawFitted(f.certifierEmail, TSCA_COORD.certifierEmail, TSCA_FIELD_WIDTH.certifierEmail, helv, 'Certifier email');
            // signatureはCertifier nameと同じ文字列を使う。Certifier name自体は既に幅チェック済みで、
            // signature欄の方が幅に余裕があるため通常はそのまま収まるが、念のためbest-effortで縮小する
            // （spec上はsignatureを明示的なブロッキング対象にしていないため、ここではブロックしない）。
            drawFitted(f.certifierName, TSCA_COORD.signature, TSCA_FIELD_WIDTH.signature, helvOblique, 'Certifier signature', false);

            // 商品欄: 確認画面前と同じレイアウト判定を再実行し、収まらないタイトルが
            // あればここでもエラーにして止める（黙って切らない）。
            var layout = tscaBuildFormLayout(helv, helvBold, f.products);
            if (layout.errors.length) {
              throw new Error('様式の1行に収まらない内容があります。フォームに戻って短くしてください。\n' + layout.errors.join('\n'));
            }
            tscaDrawFormProductLines(page, helv, helvBold, layout);
            if (layout.needsContinuation) {
              tscaDrawContinuationPages(outDoc, helv, helvBold, f.products, f.waybill, f.date);
            }

            var box = TSCA_CHECKBOX[f.certType === 'positive' ? 'positive' : 'negative'];
            var pts = TSCA_CHECK_OFFSETS.map(function(o) {
              return { x: box.x0 + o.dx, y: box.y0 + o.dy };
            });
            page.drawLine({ start: pts[0], end: pts[1], thickness: 1.6, color: black });
            page.drawLine({ start: pts[1], end: pts[2], thickness: 1.6, color: black });

            return outDoc.save();
          });
        });
      });
    }).then(function(bytes) {
      var blob = new Blob([bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var filename = f.waybill
        ? ('TSCA_' + f.waybill + '.pdf')
        : ('TSCA_' + tscaFormatDateYYYYMMDD(new Date()) + '.pdf');
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function() { URL.revokeObjectURL(url); }, 4000);

      btn.disabled = false;
      btn.textContent = 'PDFを生成してダウンロード';
      document.getElementById('tscaDoneMsg').textContent = filename + ' をダウンロードしました。';
      // ダウンロード成功。この状態で「ホームへ」を選んだ場合はフォームを完全クリアする
      // （前回の商品リスト・Waybill等が次回に残らないようにする）。
      // 作業途中（PDF未生成）の「ホームへ」は従来どおり入力保持（M-1対策は不変）。
      state.tsca.completed = true;
      showTscaSub('tscaSubDone');
    }).catch(function(err) {
      console.error('TSCA PDF generation error', err);
      alert('PDFの生成に失敗しました: ' + (err && err.message ? err.message : String(err)));
      btn.disabled = false;
      btn.textContent = 'PDFを生成してダウンロード';
    });
  });
}

/** TSCA機能を初期状態に戻してホームへ */
function tscaStartOver() {
  state.tsca.form = null;
  state.tsca.products = [];
  state.tsca.editingIndex = null;
  // 完了フラグも解除する（残したままだと、この後に新規作成した内容が
  // 「ホームへ」で誤ってクリアされてしまうため）。
  state.tsca.completed = false;
  showSection('sectionHome');
}

/** PDFダウンロード完了後に「ホームへ」を選んだときの完全クリア。
 *  商品リスト・下書き・Waybill・証明区分・確認チェックを初期状態に戻す。
 *  日付・Certifier・会社情報の各欄は、次回 tscaEnterForm() が
 *  isFreshStart（商品0件・下書き空）と判定して従来どおり設定から再ロード・
 *  再初期化するため、ここでは触らない（従来の新規開始時の初期化と同じ扱い）。 */
function tscaClearAfterComplete() {
  state.tsca.form = null;
  state.tsca.products = [];
  state.tsca.editingIndex = null;
  state.tsca.completed = false;

  var titleEl = document.getElementById('tscaProductTitle');
  if (titleEl) titleEl.value = '';
  var descEl = document.getElementById('tscaProductDesc');
  if (descEl) descEl.value = '';
  var waybillEl = document.getElementById('tscaWaybill');
  if (waybillEl) waybillEl.value = '';
  var negEl = document.getElementById('tscaCertNegative');
  if (negEl) negEl.checked = true;
  var posEl = document.getElementById('tscaCertPositive');
  if (posEl) posEl.checked = false;
  var checkEl = document.getElementById('tscaConfirmCheck');
  if (checkEl) checkEl.checked = false;
  var genBtn = document.getElementById('tscaGenerateBtn');
  if (genBtn) genBtn.disabled = true;
}

// -------------------------------------------------------
// TSCA証明書機能: イベント登録
// -------------------------------------------------------
window.addEventListener('load', function() {
  document.getElementById('tscaManualLink').addEventListener('click', function() {
    // 下書き（#tscaProductDesc）は自動確定しない。確定は「＋商品リストに追加」
    // 「確認画面へ進む」「AI追加の直前」の明示操作のみで行う（黙って商品リストに
    // 確定され、次回セッションへ持ち越されるのを防ぐため）。下書きの内容はテキスト
    // エリアにそのまま残る。
    openTscaSection();
  });
  document.getElementById('backFromTsca').addEventListener('click', function() {
    // 同上。「戻る」でも下書きは確定しない（テキストエリアに残したまま、消しも
    // 確定もしない）。
    // ただし PDFダウンロード完了後（state.tsca.completed）に「ホームへ」を選んだ
    // 場合だけは、前回値が次回に残らないようフォームを完全クリアする。
    // 作業途中（PDF未生成、またはPDF生成後に編集を再開してフラグが解除された状態）は
    // 従来どおり入力保持。
    if (state.tsca.completed) tscaClearAfterComplete();
    showSection('sectionHome');
  });
  var tscaSettingsHintLink = document.getElementById('tscaSettingsHintLink');
  if (tscaSettingsHintLink) {
    tscaSettingsHintLink.addEventListener('click', function() {
      showSection('sectionSettings');
    });
  }

  document.getElementById('tscaFileInput').addEventListener('change', function(e) {
    var file = e.target.files && e.target.files[0];
    tscaHandleFileSelect(file);
  });
  document.getElementById('tscaResetTemplateBtn').addEventListener('click', tscaResetTemplate);

  document.getElementById('tscaWaybill').addEventListener('input', function() {
    this.value = this.value.replace(/[^0-9]/g, '').slice(0, 12);
  });

  document.getElementById('tscaAiDescBtn').addEventListener('click', tscaGenerateDescription);
  document.getElementById('tscaAddProductBtn').addEventListener('click', function() {
    var msgEl = document.getElementById('tscaAiMsg');
    var committed = tscaCommitDraft();
    if (!committed) {
      showMessage(msgEl, 'error', '通関用タイトル（または詳細説明）を入力してから追加してください。');
      return;
    }
    msgEl.style.display = 'none';
  });
  var tscaCancelEditBtn = document.getElementById('tscaCancelEditBtn');
  if (tscaCancelEditBtn) tscaCancelEditBtn.addEventListener('click', tscaCancelEdit);
  document.getElementById('tscaAiFromPageBtn').addEventListener('click', function() {
    // 第3引数 false: 既にフォーム表示中なので画面遷移（openTscaSection）を行わない。
    // openTscaSection → tscaEnterForm は「商品0件・下書き空」のとき入力済みの
    // Waybill・証明区分・Certifier欄を初期値でリセットしてしまうため（B-2対策）。
    runTscaAiFromPageFlow(this, document.getElementById('tscaAiMsg'), false);
  });
  document.getElementById('tscaGoToConfirmBtn').addEventListener('click', tscaGoToConfirm);

  document.getElementById('tscaConfirmCheck').addEventListener('change', function() {
    document.getElementById('tscaGenerateBtn').disabled = !this.checked;
  });
  document.getElementById('tscaGenerateBtn').addEventListener('click', tscaGeneratePdf);
  document.getElementById('tscaBackToFormBtn').addEventListener('click', function() {
    showTscaSub('tscaSubForm');
  });

  document.getElementById('tscaStartOverBtn').addEventListener('click', tscaStartOver);

  // フォーム内のどれかの欄を編集した時点でも「PDF完了」フラグを解除する
  // （tscaEnterForm での解除に加えた保険。編集済みの内容が「ホームへ」で
  // 黙ってクリアされる事故を確実に防ぐ）。
  var tscaFormSub = document.getElementById('tscaSubForm');
  if (tscaFormSub) {
    ['input', 'change'].forEach(function(evt) {
      tscaFormSub.addEventListener(evt, function() {
        state.tsca.completed = false;
      });
    });
  }
});

// =========================================================
// Watch Worksheet作成君 機能（WatchWorksheet_Extension からの移植）
// =========================================================
//
// 元ファイル: WatchWorksheet_Extension/panel.js（このファイルとは別拡張機能）
// 移植時の変更点（挙動そのものは変えていない）:
//   - HTML の id はすべて watch_ / watch- プレフィックスに改名（16件の衝突を回避）。
//     関数名の衝突は showSection と startAiFlow の2件のみ:
//       * showSection      … 新規定義せず、上の showSection() の sections 配列に
//                             watch_sectionInput / watch_sectionWizard /
//                             watch_sectionPrint を追加する形で統合。
//       * startAiFlow      … runWatchAiFlow（共通ロジック）+ startWatchAiFlow
//                             （セクション内ボタン用）+ startWatchAiFlowHome
//                             （ホームの緑ボタン用）に分割。TSCA機能の
//                             runTscaAiFromPageFlow / startTscaAiFlow と同じ構成。
//     他の関数名・変数名は移植元のまま（衝突なしを確認済み）。
//   - Watch専用の設定画面（会社情報・APIキー入力）は移植していない。
//     APIキーは既存の state.openaiKey（_hsOpenAiKey）を、会社情報は既存の
//     state.company（_hsCompany）を watchGetCompanyConfig() 経由でそのまま流用する
//     （時計用に入れ直す必要はない）。これに伴い、元は
//     chrome.storage.local.get(['companyName','nameAndTitle','email'], ...) という
//     非同期コールバックで会社情報を取得していた箇所（handleCreate /
//     handleDirectCreate / handleDirectToPreview）を、既にロード済みの
//     state.company を同期的に読む形に書き換えている（値の出所が変わるだけで、
//     worksheet.js に渡す config オブジェクトの形は完全に同一）。
//   - 印刷は window.open ではなく chrome.tabs.create を使用（HSコード側の
//     openPrintWindowBtn ハンドラと同じ方式に統一）。保存先ストレージキーも
//     _printPayload ではなく _watchPrintPayload、開くページも print.html では
//     なく print-watch.html（既存 print.html / print.js は完全に無改変）。
//   - worksheet.js（createWatchWorksheetData / parseChatGPTData / normalizeData /
//     calculateValueBreakout 等のロジック）は1バイトも変更せずそのまま追加。
// =========================================================

/** worksheet.js の createWatchWorksheetData / buildDirectData が返したデータ（正規化済み） */
let gData = null;

/** ウィザードで確認・編集されたセルの値（行番号→値の文字列マップ） */
let gCells = {};

/** 全7ブロックを通過したか */
let gAllBlocksDone = false;

/** state.company（_hsCompany、既に loadSettings() でロード済み）を
 *  worksheet.js の config 引数の形（companyName/nameAndTitle/email）に変換する。 */
function watchGetCompanyConfig() {
  var c = state.company || {};
  return {
    companyName: c.name || '',
    nameAndTitle: c.nameTitle || '',
    email: c.email || ''
  };
}

// ---------------------------------------------------------
// 入力セクション — タブ切り替え
// ---------------------------------------------------------

function setupInputSection() {
  document.getElementById('watch_tabPaste').addEventListener('click', function () {
    switchInputMode('paste');
  });
  document.getElementById('watch_tabDirect').addEventListener('click', function () {
    switchInputMode('direct');
  });

  var form = document.getElementById('watch_worksheetForm');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    handleCreate();
  });

  // Ctrl/Cmd + Enter で送信（貼り付けモード時のみ）
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      var inputSection = document.getElementById('watch_sectionInput');
      if (inputSection && inputSection.style.display !== 'none') {
        var modePaste = document.getElementById('watch_modePaste');
        if (modePaste && modePaste.style.display !== 'none') {
          form.dispatchEvent(new Event('submit'));
        }
      }
    }
  });

  // 設定リンク（Watch専用の設定画面は持たず、既存の会社情報設定画面を共用する）
  document.getElementById('watch_openSettingsLink').addEventListener('click', function () {
    showSection('sectionSettings');
  });

  // 直接入力フォームのセットアップ
  setupDirectForm();

  // AI読み取りボタン（セクション内）
  document.getElementById('watch_aiAnalyzeBtn').addEventListener('click', startWatchAiFlow);
}

function switchInputMode(mode) {
  var tabPaste  = document.getElementById('watch_tabPaste');
  var tabDirect = document.getElementById('watch_tabDirect');
  var modePaste = document.getElementById('watch_modePaste');
  var modeDirect = document.getElementById('watch_modeDirect');

  if (mode === 'paste') {
    tabPaste.classList.add('watch-tab-active');
    tabDirect.classList.remove('watch-tab-active');
    tabPaste.setAttribute('aria-selected', 'true');
    tabDirect.setAttribute('aria-selected', 'false');
    modePaste.style.display = '';
    modeDirect.style.display = 'none';
  } else {
    tabPaste.classList.remove('watch-tab-active');
    tabDirect.classList.add('watch-tab-active');
    tabPaste.setAttribute('aria-selected', 'false');
    tabDirect.setAttribute('aria-selected', 'true');
    modePaste.style.display = 'none';
    modeDirect.style.display = '';
  }
}

// ---------------------------------------------------------
// 入力セクション — ChatGPT貼り付けモード
// ---------------------------------------------------------

function handleCreate() {
  var chatgptData = document.getElementById('watch_chatgptData').value.trim();

  if (!chatgptData) {
    showInputMessage('ChatGPTデータを入力してください。', 'error');
    return;
  }
  if (
    !chatgptData.includes('=== WATCH WORKSHEET DATA ===') ||
    !chatgptData.includes('=== END DATA ===')
  ) {
    showInputMessage(
      'ChatGPTデータの形式が正しくありません。\n「=== WATCH WORKSHEET DATA ===」から「=== END DATA ===」までの部分が必要です。',
      'error'
    );
    return;
  }

  setInputLoading(true);
  hideInputMessage();

  var config = watchGetCompanyConfig();
  var result = createWatchWorksheetData('', chatgptData, config);

  setInputLoading(false);

  if (!result.success) {
    showInputMessage(result.message, 'error');
    return;
  }

  gData = result.data;
  gAllBlocksDone = false;
  gCells = {};

  initWizard(gData);
  showSection('watch_sectionWizard');
}

function setInputLoading(show) {
  var loading = document.getElementById('watch_inputLoading');
  var btn = document.getElementById('watch_createBtn');
  loading.style.display = show ? 'block' : 'none';
  btn.disabled = show;
}

function showInputMessage(text, type) {
  var el = document.getElementById('watch_inputMessage');
  el.textContent = text;
  el.className = 'message ' + type;
  el.style.display = 'block';
  if (type === 'error') {
    setTimeout(function () {
      el.style.display = 'none';
    }, 12000);
  }
}

function hideInputMessage() {
  var el = document.getElementById('watch_inputMessage');
  el.style.display = 'none';
}

// ---------------------------------------------------------
// 直接入力フォーム
// ---------------------------------------------------------

function setupDirectForm() {
  // ムーブメント変更時: Jewels表示制御、バッテリー国自動設定
  document.getElementById('watch_di_movementType').addEventListener('change', function () {
    onDirectMovementChange();
    updateHtsHint();
  });

  // ケース素材変更時: HTSUS候補再計算
  document.getElementById('watch_di_caseMaterial').addEventListener('change', function () {
    updateHtsHint();
  });

  // 製造国一括セット
  document.getElementById('watch_di_countryMain').addEventListener('change', function () {
    applyMainCountry();
  });

  // HTSUSコードのリアルタイム形式チェック
  document.getElementById('watch_di_htsCode').addEventListener('input', function () {
    validateHtsFormat(this.value);
  });

  // タイトル自動生成ボタン
  document.getElementById('watch_di_genTitleBtn').addEventListener('click', function () {
    generateDirectTitle();
  });

  // フォームサブミット
  document.getElementById('watch_directForm').addEventListener('submit', function (e) {
    e.preventDefault();
    handleDirectCreate();
  });

  // AI読み取り後の「印刷プレビューへ直接進む」ボタン
  var printDirectBtn = document.getElementById('watch_di_printDirectBtn');
  if (printDirectBtn) {
    printDirectBtn.addEventListener('click', function () {
      handleDirectToPreview();
    });
  }

  // 初期化
  onDirectMovementChange();
  updateHtsHint();
}

/** ムーブメント変更時の副作用 */
function onDirectMovementChange() {
  var mt = document.getElementById('watch_di_movementType').value;
  var isQuartz = (mt === 'Quartz');
  var jewelsGroup = document.getElementById('watch_di_jewelsGroup');
  var jewelsNote = document.getElementById('watch_di_jewelsNote');
  var batterySel = document.getElementById('watch_di_batteryCountry');

  // Jewelsフィールドの表示制御
  if (jewelsGroup) {
    jewelsGroup.style.opacity = isQuartz ? '0.5' : '1';
  }
  if (jewelsNote) {
    jewelsNote.style.display = isQuartz ? 'block' : 'none';
  }

  // バッテリー原産国の自動設定
  if (batterySel) {
    batterySel.value = isQuartz ? 'Japan' : 'N/A';
  }
}

/** 製造国一括セット */
function applyMainCountry() {
  var country = document.getElementById('watch_di_countryMain').value;
  if (!country) return;

  var partSelIds = ['watch_di_movementCountry', 'watch_di_caseCountry', 'watch_di_bandCountry'];
  partSelIds.forEach(function (id) {
    var sel = document.getElementById(id);
    if (sel) sel.value = country;
  });

  // バッテリーはムーブメント種別に依存
  var mt = document.getElementById('watch_di_movementType').value;
  var batterySel = document.getElementById('watch_di_batteryCountry');
  if (batterySel) {
    batterySel.value = (mt === 'Quartz') ? 'Japan' : 'N/A';
  }
}

// ---------------------------------------------------------
// HTSUS候補ロジック（G項）
// ---------------------------------------------------------

/**
 * ムーブメント種別 × ケース素材（貴金属か否か）から候補を提示。
 * ルール5の代表コード3つのみ。網羅的分類はしない。
 */
function getHtsCandidates(movementType, caseMaterial) {
  var isQuartz     = (movementType === 'Quartz');
  var isPrecious   = (caseMaterial === 'Wholly of Precious Metal');
  var isMechanical = (movementType === 'Automatic' || movementType === 'Manual');

  var candidates = [];

  if (isQuartz && !isPrecious) {
    candidates.push({ code: '9102.21.5040', desc: '腕時計 / クオーツ / 非貴金属ケース' });
  } else if (isMechanical && !isPrecious) {
    candidates.push({ code: '9102.21.7010', desc: '腕時計 / 機械式 / 非貴金属ケース' });
  } else if (isMechanical && isPrecious) {
    candidates.push({ code: '9102.11.9500', desc: '腕時計 / 機械式 / 貴金属ケース' });
  }

  return candidates;
}

function updateHtsHint() {
  var mt  = document.getElementById('watch_di_movementType').value;
  var cm  = document.getElementById('watch_di_caseMaterial').value;
  var hint = document.getElementById('watch_di_htsHint');
  if (!hint) return;

  var candidates = getHtsCandidates(mt, cm);

  if (candidates.length === 0) {
    hint.textContent = '候補なし: 正しいコードを手入力してください。';
    hint.className = 'watch-hts-hint watch-hts-hint-warn';
    return;
  }

  hint.className = 'watch-hts-hint watch-hts-hint-info';
  hint.innerHTML = '';

  var label = document.createElement('strong');
  label.textContent = '候補コード（参考のみ）: ';
  hint.appendChild(label);

  candidates.forEach(function (c, i) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'watch-hts-candidate-btn';
    btn.textContent = c.code + ' — ' + c.desc;
    btn.addEventListener('click', function () {
      document.getElementById('watch_di_htsCode').value = c.code;
      validateHtsFormat(c.code);
    });
    hint.appendChild(btn);
    if (i < candidates.length - 1) {
      hint.appendChild(document.createElement('br'));
    }
  });
}

/**
 * 10桁形式チェック: ####.##.#### の形式か確認。
 */
function validateHtsFormat(val) {
  var errEl = document.getElementById('watch_di_htsError');
  if (!errEl) return;
  var trimmed = val.trim();
  if (!trimmed) {
    errEl.style.display = 'none';
    return;
  }
  // 形式: 4桁.2桁.4桁 = 10桁数字 + 2ドット
  var ok = /^\d{4}\.\d{2}\.\d{4}$/.test(trimmed);
  if (!ok) {
    errEl.textContent = '形式が正しくありません。例: 9102.21.5040 (10桁・ドット区切り)';
    errEl.style.display = 'block';
  } else {
    errEl.style.display = 'none';
  }
}

// ---------------------------------------------------------
// タイトル自動生成（D項 — ルール11準拠）
// ---------------------------------------------------------

function generateDirectTitle() {
  var brand    = document.getElementById('watch_di_brand').value.trim();
  var ref      = document.getElementById('watch_di_reference').value.trim();
  var mt       = document.getElementById('watch_di_movementType').value;
  var caseDet  = document.getElementById('watch_di_caseDetail').value.trim();
  var bandMat  = document.getElementById('watch_di_bandMaterial').value;
  var jewels   = parseInt(document.getElementById('watch_di_jewelCount').value || '0', 10);

  if (!brand && !ref) {
    showDirectMessage('タイトル生成にはブランドか型番が必要です。', 'error');
    return;
  }

  if (!caseDet) {
    showDirectMessage('ケース素材（詳細）が未入力です。入力するとタイトルに反映されます。', 'warn');
  }

  var parts = [];

  if (brand) parts.push(brand);
  if (ref)   parts.push(ref);

  // Movement
  parts.push(mt);

  // Jewels: 機械式のみ (数値+J)
  if (mt !== 'Quartz' && jewels > 0) {
    parts.push(jewels + 'J');
  }

  // Case Material (詳細優先)
  if (caseDet) parts.push(caseDet);

  // Band Material
  if (bandMat && bandMat !== 'No Band') {
    parts.push(bandMat + ' Band');
  }

  parts.push('Watch');

  var title = parts.join(' ');

  var styleRefEl = document.getElementById('watch_di_styleRef');
  styleRefEl.value = title;

  var previewEl = document.getElementById('watch_di_titlePreview');
  if (previewEl) {
    previewEl.textContent = '生成済み: ' + title;
    previewEl.style.display = 'block';
  }
}

// ---------------------------------------------------------
// 直接入力 → normalizeData 形式へ変換
// ---------------------------------------------------------

/**
 * 直接入力フォームの値を、normalizeData の出力オブジェクトと同じ形式に組み立てる。
 * worksheet.js の calculateValueBreakout / mapJewelsToDropdown を再利用する。
 */
function buildDirectData(config) {
  var mt       = document.getElementById('watch_di_movementType').value;
  var isQuartz = (mt === 'Quartz');

  var priceRaw = parseFloat(document.getElementById('watch_di_price').value || '0');
  var currency = document.getElementById('watch_di_currency').value || 'USD';
  var jewCount = parseInt(document.getElementById('watch_di_jewelCount').value || '0', 10);

  var styleRef = document.getElementById('watch_di_styleRef').value.trim();
  var htsRaw   = document.getElementById('watch_di_htsCode').value.trim();

  // Value Breakout
  var breakout = calculateValueBreakout(priceRaw, mt);

  var data = {
    styleRef:         styleRef,
    totalValue:       priceRaw,
    currency:         currency,
    movementType:     mt,
    displayType:      document.getElementById('watch_di_displayType').value,
    htsCode:          htsRaw.replace(/\./g, ''),   // ドットなし数字列で保持（buildFinalCellsと整合）
    jewels:           isQuartz ? '0 to 1 Jewels' : mapJewelsToDropdown(jewCount),
    jewelCount:       isQuartz ? 0 : jewCount,
    quantity:         parseInt(document.getElementById('watch_di_quantity').value || '1', 10),

    bandMaterial:     document.getElementById('watch_di_bandMaterial').value,
    bandDetail:       document.getElementById('watch_di_bandDetail').value.trim(),
    caseMaterial:     document.getElementById('watch_di_caseMaterial').value,
    caseDetail:       document.getElementById('watch_di_caseDetail').value.trim(),
    backplateMaterial: document.getElementById('watch_di_backplateMaterial').value,
    backplateDetail:  document.getElementById('watch_di_backplateDetail').value.trim(),

    movementCountry:  document.getElementById('watch_di_movementCountry').value,
    caseCountry:      document.getElementById('watch_di_caseCountry').value,
    bandCountry:      document.getElementById('watch_di_bandCountry').value,
    batteryCountry:   document.getElementById('watch_di_batteryCountry').value,
    // backplateCountry はワークシートに項目がないため収集しない

    primaryFunction:  document.getElementById('watch_di_primaryFunction').value,
    otherMaterials:   '',

    movementValue:    breakout.movement,
    caseValue:        breakout.case,
    strapValue:       breakout.strap,
    batteryValue:     breakout.battery,

    companyName:      (config || {}).companyName || '',
    nameAndTitle:     (config || {}).nameAndTitle || '',
    email:            (config || {}).email || '',
    awbNumber:        ''
  };

  // over12mm はウィザードB4（f_over12mm）に直接セットする
  data._over12mm = document.getElementById('watch_di_over12mm').value;

  return data;
}

/**
 * 直接入力フォームの送信処理。
 * バリデーション → buildDirectData → initWizard の順で流す。
 */
function handleDirectCreate() {
  // バリデーション
  var brand   = document.getElementById('watch_di_brand').value.trim();
  var ref     = document.getElementById('watch_di_reference').value.trim();
  var price   = document.getElementById('watch_di_price').value.trim();
  var styleRef = document.getElementById('watch_di_styleRef').value.trim();

  if (!brand && !ref) {
    showDirectMessage('ブランドまたは型番を入力してください。', 'error');
    return;
  }
  if (!price || parseFloat(price) <= 0) {
    showDirectMessage('販売価格を正しく入力してください。', 'error');
    return;
  }
  if (!styleRef) {
    showDirectMessage('Style name/No/Reference が空です。「タイトルを生成」ボタンを押すか手入力してください。', 'error');
    return;
  }

  // HTSUS形式チェック（入力されている場合のみ）
  var htsVal = document.getElementById('watch_di_htsCode').value.trim();
  if (htsVal && !/^\d{4}\.\d{2}\.\d{4}$/.test(htsVal)) {
    showDirectMessage('HTSUSコードの形式が正しくありません。例: 9102.21.5040', 'error');
    return;
  }

  var config = watchGetCompanyConfig();
  var data = buildDirectData(config);

  gData = data;
  gAllBlocksDone = false;
  gCells = {};

  initWizard(gData);
  showSection('watch_sectionWizard');
}

/**
 * AI読み取り後の「印刷プレビューへ直接進む」処理。
 * バリデーション → confirm → buildDirectData → buildPreviewAndShow
 */
function handleDirectToPreview() {
  var brand    = document.getElementById('watch_di_brand').value.trim();
  var ref      = document.getElementById('watch_di_reference').value.trim();
  var price    = document.getElementById('watch_di_price').value.trim();
  var styleRef = document.getElementById('watch_di_styleRef').value.trim();
  var htsVal   = document.getElementById('watch_di_htsCode').value.trim();

  if (!brand && !ref) {
    showDirectMessage('ブランドまたは型番を入力してください。', 'error');
    return;
  }
  if (!price || parseFloat(price) <= 0) {
    showDirectMessage('申告価格を入力してください（出品価格と異なる場合は正しい申告価格を入力してください）。', 'error');
    return;
  }
  if (!styleRef) {
    showDirectMessage('Style name/No/Reference が空です。「タイトルを生成」ボタンを押すか手入力してください。', 'error');
    return;
  }
  if (!htsVal) {
    showDirectMessage('HTSUSコードを入力してください。', 'error');
    return;
  }
  if (!/^\d{4}\.\d{2}\.\d{4}$/.test(htsVal)) {
    showDirectMessage('HTSUSコードの形式が正しくありません。例: 9102.21.5040', 'error');
    return;
  }

  var currency = document.getElementById('watch_di_currency').value || 'USD';
  var confirmed = window.confirm(
    '印刷プレビューに進む前に、以下をすべて確認しましたか？\n\n' +
    '✅ ブランド・型番\n' +
    '✅ ムーブメント種別・素材\n' +
    '✅ 原産国\n' +
    '✅ HTSUSコード\n' +
    '✅ 申告価格: ' + price + ' ' + currency + '\n\n' +
    '⚠️ 特に価格は出品価格と申告価格が異なる場合があります。\n' +
    '   正しい申告価格が入力されているか必ず確認してください。\n\n' +
    '問題なければ「OK」を押してください。'
  );
  if (!confirmed) return;

  var config = watchGetCompanyConfig();
  var data = buildDirectData(config);
  gData = data;
  gCells = {};
  gAllBlocksDone = true;
  buildPreviewAndShow();
}

function showDirectMessage(text, type) {
  var el = document.getElementById('watch_directInputMessage');
  el.textContent = text;
  el.className = 'message ' + type;
  el.style.display = 'block';
  if (type === 'error' || type === 'warn') {
    setTimeout(function () {
      el.style.display = 'none';
    }, 10000);
  }
}

// ---------------------------------------------------------
// 確認ウィザード
// ---------------------------------------------------------

/**
 * ウィザード用フィールド定義。
 * blockId: 1〜7
 * fieldId: HTMLのinput id（watch_ プレフィックス）
 * rowNum: スプレッドシート行番号（参考情報・gCells のキー。DOM idではない）
 * getInitial(data): gDataから初期値を取り出す関数
 */
var WIZARD_FIELDS = [
  // Block 1
  { blockId: 1, fieldId: 'watch_f_styleRef',       rowNum: 3,  getInitial: function(d){ return d.styleRef || ''; } },
  { blockId: 1, fieldId: 'watch_f_styleOfWatch',   rowNum: 4,  getInitial: function()  { return 'Wrist'; } },
  { blockId: 1, fieldId: 'watch_f_styleOther',     rowNum: 5,  getInitial: function()  { return ''; } },
  { blockId: 1, fieldId: 'watch_f_quantity',       rowNum: 6,  getInitial: function(d){ return String(d.quantity || 1); } },
  // Block 2
  { blockId: 2, fieldId: 'watch_f_hts1',           rowNum: 7,  getInitial: function(d){ return (d.htsCode || '').replace(/\./g, ''); } },
  { blockId: 2, fieldId: 'watch_f_hts2',           rowNum: 8,  getInitial: function()  { return ''; } },
  { blockId: 2, fieldId: 'watch_f_hts3',           rowNum: 9,  getInitial: function()  { return ''; } },
  { blockId: 2, fieldId: 'watch_f_hts4',           rowNum: 10, getInitial: function()  { return ''; } },
  // Block 3
  { blockId: 3, fieldId: 'watch_f_primaryFunc',    rowNum: 11, getInitial: function(d){
      var known = ['Timekeeping','GPS','Heart Monitor','Wi-Fi','Pedometer'];
      return (d.primaryFunction && known.indexOf(d.primaryFunction) === -1) ? 'Other' : (d.primaryFunction || 'Timekeeping');
    }
  },
  { blockId: 3, fieldId: 'watch_f_primaryFuncOther', rowNum: 12, getInitial: function(d){
      var known = ['Timekeeping','GPS','Heart Monitor','Wi-Fi','Pedometer'];
      return (d.primaryFunction && known.indexOf(d.primaryFunction) === -1) ? d.primaryFunction : '';
    }
  },
  { blockId: 3, fieldId: 'watch_f_powered',        rowNum: 13, getInitial: function(d){
      var mt = String(d.movementType || '').toLowerCase();
      if (mt.indexOf('quartz') !== -1) return 'Electric (Battery)';
      if (mt.indexOf('automatic') !== -1) return 'Automatic Winding (Self Winding)';
      return 'Manual';
    }
  },
  { blockId: 3, fieldId: 'watch_f_batteryOrigin',  rowNum: 14, getInitial: function(d){
      var mt = String(d.movementType || '').toLowerCase();
      return mt.indexOf('quartz') !== -1 ? (d.batteryCountry || 'Japan') : 'N/A';
    }
  },
  // Block 4
  { blockId: 4, fieldId: 'watch_f_movementDisplay', rowNum: 15, getInitial: function(d){
      return (d.movementType || '') + ', ' + (d.displayType || 'Analog');
    }
  },
  { blockId: 4, fieldId: 'watch_f_over12mm',       rowNum: 16, getInitial: function(d){
      // 直接入力モードの場合は _over12mm が入っている
      return d._over12mm || 'No';
    }
  },
  { blockId: 4, fieldId: 'watch_f_jewels',         rowNum: 17, getInitial: function(d){ return String(d.jewelCount || 0); } },
  { blockId: 4, fieldId: 'watch_f_movementOrigin', rowNum: 18, getInitial: function(d){ return d.movementCountry || ''; } },
  // Block 5
  { blockId: 5, fieldId: 'watch_f_bandMaterial',   rowNum: 19, getInitial: function(d){
      var known = ['Textile','Metal','Leather','No Band'];
      return (d.bandMaterial && known.indexOf(d.bandMaterial) === -1) ? 'Other' : (d.bandMaterial || '');
    }
  },
  { blockId: 5, fieldId: 'watch_f_bandLeather',    rowNum: 20, getInitial: function(d){
      return (d.bandMaterial === 'Leather' && d.bandDetail) ? d.bandDetail : '';
    }
  },
  { blockId: 5, fieldId: 'watch_f_bandMetal',      rowNum: 21, getInitial: function(d){
      return (d.bandMaterial === 'Metal' && d.bandDetail) ? d.bandDetail : '';
    }
  },
  { blockId: 5, fieldId: 'watch_f_bandOther',      rowNum: 22, getInitial: function(d){
      var known = ['Textile','Metal','Leather','No Band'];
      return (d.bandMaterial && known.indexOf(d.bandMaterial) === -1) ? d.bandMaterial : '';
    }
  },
  { blockId: 5, fieldId: 'watch_f_bandOrigin',     rowNum: 23, getInitial: function(d){ return d.bandCountry || ''; } },
  { blockId: 5, fieldId: 'watch_f_caseMaterial',   rowNum: 24, getInitial: function(d){
      if (d.caseDetail) {
        var dl = String(d.caseDetail).toLowerCase();
        if (dl.indexOf('plated') !== -1 || dl.indexOf('gold') !== -1 || dl.indexOf('silver') !== -1 || dl.indexOf('precious') !== -1) {
          return d.caseDetail;
        }
        return d.caseDetail + ', ' + (d.caseMaterial || '');
      }
      return d.caseMaterial || '';
    }
  },
  { blockId: 5, fieldId: 'watch_f_caseOther',      rowNum: 25, getInitial: function()  { return ''; } },
  { blockId: 5, fieldId: 'watch_f_caseOrigin',     rowNum: 26, getInitial: function(d){ return d.caseCountry || ''; } },
  { blockId: 5, fieldId: 'watch_f_backplateMaterial', rowNum: 27, getInitial: function(d){
      return d.backplateDetail ? d.backplateDetail : (d.backplateMaterial || '');
    }
  },
  { blockId: 5, fieldId: 'watch_f_backplateOther', rowNum: 28, getInitial: function()  {
      // 直接入力モードでは使用しない（裏蓋原産国はワークシートに項目なし）
      return '';
    }
  },
  // Block 6
  { blockId: 6, fieldId: 'watch_f_movementValue',  rowNum: 30, getInitial: function(d){
      var cur = d.currency || 'USD';
      return d.movementValue ? d.movementValue.toFixed(2) + ' ' + cur : '';
    }
  },
  { blockId: 6, fieldId: 'watch_f_caseValue',      rowNum: 31, getInitial: function(d){
      var cur = d.currency || 'USD';
      return d.caseValue ? d.caseValue.toFixed(2) + ' ' + cur : '';
    }
  },
  { blockId: 6, fieldId: 'watch_f_strapValue',     rowNum: 32, getInitial: function(d){
      var cur = d.currency || 'USD';
      return d.strapValue ? d.strapValue.toFixed(2) + ' ' + cur : '';
    }
  },
  { blockId: 6, fieldId: 'watch_f_batteryValue',   rowNum: 33, getInitial: function(d){
      var cur = d.currency || 'USD';
      return d.batteryValue ? d.batteryValue.toFixed(2) + ' ' + cur : '';
    }
  },
  { blockId: 6, fieldId: 'watch_f_totalValue',     rowNum: 34, getInitial: function(d){
      var cur = d.currency || 'USD';
      return d.totalValue ? d.totalValue.toFixed(2) + ' ' + cur : '';
    }
  },
  // Block 7
  { blockId: 7, fieldId: 'watch_f_awb',            rowNum: 39, getInitial: function()  { return ''; } },
  { blockId: 7, fieldId: 'watch_f_wiz_companyName', rowNum: 36, getInitial: function(d){ return d.companyName || ''; } },
  { blockId: 7, fieldId: 'watch_f_wiz_nameAndTitle', rowNum: 37, getInitial: function(d){ return d.nameAndTitle || ''; } },
  { blockId: 7, fieldId: 'watch_f_wiz_email',      rowNum: 38, getInitial: function(d){ return d.email || ''; } }
];

var TOTAL_BLOCKS = 7;
/** 各ブロックが通過済みかどうかのフラグ */
var blockDone = {};

function initWizard(data) {
  // 全ブロックのフィールドに初期値を設定
  WIZARD_FIELDS.forEach(function (f) {
    var el = document.getElementById(f.fieldId);
    if (el) el.value = f.getInitial(data);
  });

  // 全ブロックのdone状態をリセット
  for (var i = 1; i <= TOTAL_BLOCKS; i++) blockDone[i] = false;
  gAllBlocksDone = false;
  gCells = {};

  // Block1を表示、他を隠す
  showBlock(1);
  updateProgress();
}

function setupWizardSection() {
  document.getElementById('watch_backToInputFromWizard').addEventListener('click', function () {
    gData = null;
    showSection('watch_sectionInput');
  });

  // 各ブロックの「次へ」「戻る」ボタン
  document.querySelectorAll('.watch-wiz-next').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var blockId = parseInt(this.getAttribute('data-block'), 10);
      collectBlock(blockId);
      blockDone[blockId] = true;
      updateProgress();
      showBlock(blockId + 1);
    });
  });

  document.querySelectorAll('.watch-wiz-prev').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var blockId = parseInt(this.getAttribute('data-block'), 10);
      collectBlock(blockId);
      showBlock(blockId - 1);
    });
  });

  // 「確認完了」ボタン
  document.getElementById('watch_confirmDoneBtn').addEventListener('click', function () {
    collectBlock(7);
    blockDone[7] = true;
    gAllBlocksDone = true;
    updateProgress();
    buildPreviewAndShow();
  });
}

function showBlock(blockId) {
  for (var i = 1; i <= TOTAL_BLOCKS; i++) {
    var el = document.getElementById('watch_block' + i);
    if (el) el.style.display = (i === blockId) ? '' : 'none';
  }
}

function updateProgress() {
  var doneCount = Object.keys(blockDone).filter(function (k) { return blockDone[k]; }).length;
  var el = document.getElementById('watch_wizardProgress');
  if (el) {
    el.textContent = doneCount + ' / ' + TOTAL_BLOCKS + ' 確認済み';
  }
}

/**
 * 指定ブロックのフィールド値を gCells に収集する。
 */
function collectBlock(blockId) {
  WIZARD_FIELDS.filter(function (f) { return f.blockId === blockId; }).forEach(function (f) {
    var el = document.getElementById(f.fieldId);
    if (el) gCells[f.rowNum] = el.value;
  });
}

// ---------------------------------------------------------
// 印刷セクション
// ---------------------------------------------------------

function setupPrintSection() {
  document.getElementById('watch_backToWizardBtn').addEventListener('click', function () {
    showSection('watch_sectionWizard');
    showBlock(7);
  });

  document.getElementById('watch_backToInputFinalBtn').addEventListener('click', function () {
    gData = null;
    gCells = {};
    gAllBlocksDone = false;
    showSection('watch_sectionInput');
  });

  document.getElementById('watch_openPrintWindowBtn').addEventListener('click', function () {
    openPrintWindow();
  });
}

/**
 * ウィザードの gCells を反映した最終39行分のセル値マップを組み立てる。
 */
function buildFinalCells() {
  var col = {};
  var data = gData;

  col[3]  = data.styleRef || '';
  col[4]  = 'Wrist';
  col[5]  = '';
  col[6]  = String(data.quantity || 1);

  var htsNumeric = (data.htsCode || '').replace(/\./g, '');
  col[7]  = htsNumeric;
  col[8]  = '';
  col[9]  = '';
  col[10] = '';

  var known = ['Timekeeping','GPS','Heart Monitor','Wi-Fi','Pedometer'];
  if (data.primaryFunction && known.indexOf(data.primaryFunction) === -1) {
    col[11] = 'Other';
    col[12] = data.primaryFunction;
  } else {
    col[11] = data.primaryFunction || 'Timekeeping';
    col[12] = '';
  }

  var mt = String(data.movementType || '').toLowerCase();
  if (mt.indexOf('quartz') !== -1)         col[13] = 'Electric (Battery)';
  else if (mt.indexOf('automatic') !== -1) col[13] = 'Automatic Winding (Self Winding)';
  else                                     col[13] = 'Manual';

  col[14] = mt.indexOf('quartz') !== -1 ? (data.batteryCountry || 'Japan') : 'N/A';

  col[15] = (data.movementType || '') + ', ' + (data.displayType || 'Analog');
  col[16] = data._over12mm || 'No';
  col[17] = String(data.jewelCount || 0);
  col[18] = data.movementCountry || '';

  var knownBands = ['Textile','Metal','Leather','No Band'];
  if (data.bandMaterial && knownBands.indexOf(data.bandMaterial) === -1) {
    col[19] = 'Other';
    col[20] = '';
    col[21] = '';
    col[22] = data.bandMaterial;
  } else {
    col[19] = data.bandMaterial || '';
    col[20] = (data.bandMaterial === 'Leather' && data.bandDetail) ? data.bandDetail : '';
    col[21] = (data.bandMaterial === 'Metal' && data.bandDetail) ? data.bandDetail : '';
    col[22] = '';
  }
  col[23] = data.bandCountry || '';

  if (data.caseDetail) {
    var dl = String(data.caseDetail).toLowerCase();
    if (dl.indexOf('plated') !== -1 || dl.indexOf('gold') !== -1 || dl.indexOf('silver') !== -1 || dl.indexOf('precious') !== -1) {
      col[24] = data.caseDetail;
    } else {
      col[24] = data.caseDetail + ', ' + (data.caseMaterial || '');
    }
  } else {
    col[24] = data.caseMaterial || '';
  }
  col[25] = '';
  col[26] = data.caseCountry || '';
  col[27] = data.backplateDetail ? data.backplateDetail : (data.backplateMaterial || '');
  col[28] = '';

  var currency = data.currency || 'USD';
  col[29] = '';
  col[30] = data.movementValue ? data.movementValue.toFixed(2) + ' ' + currency : '';
  col[31] = data.caseValue     ? data.caseValue.toFixed(2)     + ' ' + currency : '';
  col[32] = data.strapValue    ? data.strapValue.toFixed(2)    + ' ' + currency : '';
  col[33] = data.batteryValue  ? data.batteryValue.toFixed(2)  + ' ' + currency : '';
  col[34] = data.totalValue    ? data.totalValue.toFixed(2)    + ' ' + currency : '';

  col[35] = '';
  col[36] = data.companyName  || '';
  col[37] = data.nameAndTitle || '';
  col[38] = data.email        || '';
  col[39] = '';

  // gCells の値で上書き（ウィザードで編集した値が最終出力に反映）
  Object.keys(gCells).forEach(function (rowNum) {
    col[parseInt(rowNum, 10)] = gCells[rowNum];
  });

  return col;
}

/**
 * ラベル定義（Watch Worksheet専用の39行レイアウト）
 */
var ROW_LABELS = [
  'Style name/No/Reference',
  'Style of watch',
  '  If Other, provide type',
  'Quantity',
  'HTSUS Number (if known)',
  'HTSUS Number (if known)',
  'HTSUS Number (if known)',
  'HTSUS Number (if known)',
  'What is the primary function of watch',
  '  If Other, provide primary function',
  'How is the watch powered',
  'Country of Origin of the battery',
  'Movement/ Display type',
  "Is the movement's size over 12mm in thickness and 50mm in width, length, or diameter?",
  'Number of Jewels in Movement',
  'Country of Origin of Movement',
  'Material of Band (Strap)',
  '  If Leather, provide type of animal',
  '  If Metal, provide type of metal',
  '  If Other, provide material',
  'Country of Origin of Band (Strap)',
  'Material of Case',
  '  If Other, provide material',
  'Country of Origin of Case',
  'Material of Backplate',
  '  If Other, provide material',
  'Value Breakout (amount and currency)',
  '  Movement',
  '  Case',
  '  Strap',
  '  Battery',
  '  Total Watch Value',
  '',
  'Company Name',
  'Name and Title',
  'E-mail',
  'AWB Number'
];

var VALUE_BREAKOUT_ROWS = new Set([29,30,31,32,33,34]);
var COMPANY_ROWS        = new Set([36,37,38,39]);

function renderTable(tableEl, col) {
  tableEl.innerHTML = '';

  var trTitle = document.createElement('tr');
  var tdTitle = document.createElement('td');
  tdTitle.colSpan = 2;
  tdTitle.textContent = 'Watch Worksheet';
  tdTitle.className = 'ws-title';
  trTitle.appendChild(tdTitle);
  tableEl.appendChild(trTitle);

  var trHeader = document.createElement('tr');
  var tdHLabel = document.createElement('td');
  tdHLabel.textContent = '';
  tdHLabel.className = 'ws-header';
  var tdHValue = document.createElement('td');
  tdHValue.textContent = 'Watch 1';
  tdHValue.className = 'ws-header';
  trHeader.appendChild(tdHLabel);
  trHeader.appendChild(tdHValue);
  tableEl.appendChild(trHeader);

  ROW_LABELS.forEach(function (label, idx) {
    var rowNum = idx + 3;
    var isSub  = label.indexOf('  ') === 0;
    var isVB   = VALUE_BREAKOUT_ROWS.has(rowNum);
    var isCo   = COMPANY_ROWS.has(rowNum);

    var tr = document.createElement('tr');
    if (isVB) tr.classList.add('watch-value-breakout');
    if (isCo) tr.classList.add('watch-company-row');

    var tdLabel = document.createElement('td');
    tdLabel.textContent = label;
    tdLabel.className   = isSub ? 'ws-label-sub' : 'ws-label';

    var tdValue = document.createElement('td');
    tdValue.textContent = col[rowNum] || '';
    tdValue.className   = 'ws-data';

    tr.appendChild(tdLabel);
    tr.appendChild(tdValue);
    tableEl.appendChild(tr);
  });
}

function buildPreviewAndShow() {
  var col   = buildFinalCells();
  var table = document.getElementById('watch_previewTable');
  renderTable(table, col);
  showSection('watch_sectionPrint');
}

// ---------------------------------------------------------
// 印刷ウィンドウ
// ---------------------------------------------------------
// 元実装は window.open + _printPayload + print.html。
// 本体（HSコード側）の openPrintWindowBtn ハンドラと方式を揃えるため、
// chrome.tabs.create + _watchPrintPayload + print-watch.html に変更している
// （挙動は「印刷用の別タブが開く」という点で同一）。

function openPrintWindow() {
  var col     = buildFinalCells();
  var payload = JSON.stringify(col);

  chrome.storage.local.set({ _watchPrintPayload: payload }, function () {
    if (chrome.runtime.lastError) {
      var note = document.querySelector('#watch_sectionPrint .print-note');
      if (note) {
        var errSpan = document.createElement('span');
        errSpan.style.color = '#b71c1c';
        errSpan.textContent = ' データ保存エラー: ' + chrome.runtime.lastError.message;
        note.appendChild(errSpan);
      }
      return;
    }
    chrome.tabs.create({ url: chrome.runtime.getURL('print-watch.html') });
  });
}

// ---------------------------------------------------------
// AI入力補助（商品ページ読み取り）
// ---------------------------------------------------------

/**
 * 開いている商品ページをAIで読み取り、時計の直接入力フォームへ自動入力する共通ロジック。
 * btn/msg: 呼び出し元のボタンとメッセージ要素。
 * openSection: true の場合、結果が出た時点で watch_sectionInput を開く
 * （ホームの緑ボタンから呼ばれた場合）。false の場合は既に watch_sectionInput
 * 内にいるので画面遷移しない（TSCA機能の runTscaAiFromPageFlow と同じ構成）。
 */
function runWatchAiFlow(btn, msg, openSection) {
  if (!state.openaiKey) {
    showMessage(msg, 'error', 'APIキーが未設定です。設定画面で OpenAI APIキーを入力してください。');
    msg.style.display = '';
    return;
  }

  btn.disabled = true;
  showMessage(msg, 'info', '分析中…');
  msg.style.display = '';

  getWatchPageInfo(function (pageInfo, errReason) {
    if (!pageInfo) {
      btn.disabled = false;
      msg.style.display = 'none';
      if (openSection) showSection('watch_sectionInput');
      var aiMsg1 = document.getElementById('watch_aiAnalyzeMsg');
      showMessage(aiMsg1, 'error', (errReason || 'ページ情報を取得できませんでした') + '。商品ページを開いてから試してください。');
      return;
    }
    callOpenAIWatch(pageInfo, function (err, aiData) {
      btn.disabled = false;
      msg.style.display = 'none';
      if (openSection) showSection('watch_sectionInput');
      if (err || !aiData) {
        var aiMsg2 = document.getElementById('watch_aiAnalyzeMsg');
        showMessage(aiMsg2, 'error', 'AI呼び出しに失敗しました: ' + (err ? err.message : '不明なエラー'));
        return;
      }
      fillFromAi(aiData);
    });
  });
}

/** セクション内の「🤖 商品ページをAIで読み取る」ボタン用 */
function startWatchAiFlow() {
  var msg = document.getElementById('watch_aiAnalyzeMsg');
  var btn = document.getElementById('watch_aiAnalyzeBtn');
  runWatchAiFlow(btn, msg, false);
}

/** ホームの緑ボタン「⌚ AIでWatch Worksheetを作成する」用 */
function startWatchAiFlowHome() {
  var msg = document.getElementById('watchAiHomeMsg');
  var btn = document.getElementById('watchAiHomeBtn');
  runWatchAiFlow(btn, msg, true);
}

function getWatchPageInfo(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || !tabs[0]) { cb(null, 'タブが見つかりません'); return; }
    var tab = tabs[0];
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
      cb(null, '拡張機能や設定ページでは使えません。商品ページを開いてください'); return;
    }
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function () {
        var url = location.href;
        var host = location.hostname;

        function getText(selectors) {
          for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el && el.textContent.trim()) return el.textContent.trim().substring(0, 400);
          }
          return '';
        }
        function getMeta(names) {
          for (var i = 0; i < names.length; i++) {
            var el = document.querySelector('meta[property="' + names[i] + '"],meta[name="' + names[i] + '"]');
            if (el && el.getAttribute('content')) return el.getAttribute('content');
          }
          return '';
        }

        // JSON-LD Product schema
        var jsonldProduct = null;
        var scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (var si = 0; si < scripts.length; si++) {
          try {
            var d = JSON.parse(scripts[si].textContent);
            var items = d['@graph'] ? d['@graph'] : (Array.isArray(d) ? d : [d]);
            for (var ii = 0; ii < items.length; ii++) {
              if (items[ii]['@type'] === 'Product') { jsonldProduct = items[ii]; break; }
            }
            if (jsonldProduct) break;
          } catch (e) {}
        }

        var productName = '', brand = '', condition = '', description = '', price = '', currency = '';

        if (host.includes('mercari.com')) {
          productName = getText(['h1[class*="name"]', 'h1[data-testid="name"]', 'p[data-testid="product-name"]', 'h1']);
          description = getText(['[data-testid="description"]', 'p[class*="description"]', '[class*="ItemDescription"]']).substring(0, 300);
          condition   = getText(['[data-testid="condition"]', '[class*="condition"]', 'span[class*="status"]']);
          brand       = getText(['[data-testid="brand"]', '[class*="brand"]']);
          price       = getText(['[data-testid="price"]', '[class*="price"] span', '[class*="ItemPrice"]']).replace(/[^0-9]/g, '');
          currency    = 'JPY';
        } else if (host.includes('auctions.yahoo.co.jp') || host.includes('buyee.jp')) {
          productName = getText(['h1[class*="Product__title"]', '.Product__title', 'h1']);
          description = getText(['.ProductExplanation__itemDescription', '.ProductDetail__description', '[class*="description"]']).substring(0, 300);
          condition   = getText(['.ProductDetail__condition', '[class*="condition"]']);
          price       = getText(['.Price__value', '.Auction__price', '.ProductDetail__price', '[class*="price"]']).replace(/[^0-9]/g, '');
          currency    = 'JPY';
        } else if (host.includes('hardoff.co.jp') || host.includes('bookoff.co.jp')) {
          productName = getText(['h1', '.item-name', '.product-name']);
          description = getText(['.item-detail', '.product-detail', '.description']).substring(0, 300);
          price       = getText(['.price', '.item-price', '[class*="price"]']).replace(/[^0-9]/g, '');
          currency    = 'JPY';
        } else if (host.includes('ebay.com')) {
          productName = getText(['h1#itemTitle', 'h1[itemprop="name"]', 'h1']);
          description = getText(['#viTabs_0_is', '#itemDescriptionURL', '[itemprop="description"]']).substring(0, 300);
          brand       = getText(['[itemprop="brand"]', '[data-testid="x-item-specifics"] [class*="brand"]']);
          condition   = getText(['#condText', '[itemprop="itemCondition"]']);
          price       = getText(['.x-price-primary span', '[itemprop="price"]', '#prcIsum']).replace(/[^0-9.]/g, '');
          currency    = 'USD';
        }

        if (jsonldProduct) {
          if (!productName) productName = jsonldProduct.name || '';
          if (!brand && jsonldProduct.brand) brand = typeof jsonldProduct.brand === 'string' ? jsonldProduct.brand : (jsonldProduct.brand.name || '');
          if (!description && jsonldProduct.description) description = String(jsonldProduct.description).substring(0, 300);
          if (!condition && jsonldProduct.itemCondition) condition = String(jsonldProduct.itemCondition).replace(/https?:\/\/schema\.org\//, '').replace('Condition', '');
        }

        if (!productName) productName = getText(['h1']) || getMeta(['og:title']) || document.title;
        if (!description) description = getMeta(['og:description', 'description']).substring(0, 300);

        return { url: url, host: host, productName: productName, brand: brand, condition: condition, description: description, price: price, currency: currency };
      }
    }, function (results) {
      if (chrome.runtime.lastError) { cb(null, chrome.runtime.lastError.message); return; }
      if (results && results[0] && results[0].result) {
        cb(results[0].result, null);
      } else {
        cb(null, 'ページ情報を取得できませんでした');
      }
    });
  });
}

function callOpenAIWatch(pageInfo, cb) {
  var lines = ['Product URL: ' + pageInfo.url, 'Product name: ' + (pageInfo.productName || '')];
  if (pageInfo.brand)       lines.push('Brand: ' + pageInfo.brand);
  if (pageInfo.condition)   lines.push('Condition: ' + pageInfo.condition);
  if (pageInfo.description) lines.push('Description: ' + pageInfo.description);
  if (pageInfo.price)       lines.push('Price: ' + pageInfo.price + (pageInfo.currency ? ' ' + pageInfo.currency : ''));

  var userContent = lines.join('\n');

  var systemPrompt = [
    'You are a watch customs expert. Given product information from a Japanese secondhand watch listing, extract watch details.',
    'Return ONLY a JSON object with these exact fields:',
    '  "brand": watch brand name (e.g. "Citizen", "Seiko", "Casio")',
    '  "reference": model number or reference (e.g. "BM8180-03E")',
    '  "movementType": one of exactly: "Quartz", "Automatic", "Manual"',
    '  "displayType": one of exactly: "Analog", "Digital", "Analog-Digital"',
    '  "bandMaterial": one of exactly: "Textile", "Metal", "Leather", "No Band"',
    '  "bandDetail": specific band material (e.g. "Stainless Steel", "Leather (Cow)", "Rubber")',
    '  "caseMaterial": one of exactly: "NOT Gold/Silver Plated", "Gold/Silver Plated", "Metal Clad w/Precious Metal", "Wholly of Precious Metal", "Other"',
    '  "caseDetail": specific case base material (e.g. "Stainless Steel", "Titanium", "Brass")',
    '  "backplateMaterial": one of exactly: "Other", "Wholly of Precious Metal"',
    '  "backplateDetail": specific backplate material (e.g. "Stainless Steel", "Titanium")',
    '  "country": country of origin, default "Japan" for Japanese marketplace listings',
    '  "htsus": suggested HTSUS code, 10 digits no dots (e.g. "9102215040"). Use 9102215040 for quartz non-precious-case wristwatch, 9102217010 for mechanical non-precious-case.',
    '  "reason": one sentence in Japanese summarizing what was identified',
    'Return ONLY the JSON. No markdown, no explanation.'
  ].join('\n');

  fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.openaiKey },
    body: JSON.stringify({
      model: 'gpt-5.4',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      max_completion_tokens: 400
    })
  })
  .then(function (r) {
    if (!r.ok) return r.json().then(function (errBody) { throw new Error((errBody.error && errBody.error.message) || ('HTTP ' + r.status)); });
    return r.json();
  })
  .then(function (data) {
    var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('AIからの応答が空でした');
    var match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AIの応答にJSONが含まれていませんでした');
    try { cb(null, JSON.parse(match[0])); } catch (e) { throw new Error('JSONの解析に失敗しました: ' + e.message); }
  })
  .catch(function (e) { cb(e, null); });
}

function fillFromAi(aiData) {
  // 直接入力タブに切り替え
  switchInputMode('direct');

  // 各フィールドに流し込む
  var set = function (id, val) {
    var el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
  };

  set('watch_di_brand', aiData.brand || '');
  set('watch_di_reference', aiData.reference || '');

  // selectの値は選択肢に一致するものだけセット
  var validMovement = ['Quartz', 'Automatic', 'Manual'];
  if (aiData.movementType && validMovement.indexOf(aiData.movementType) !== -1) {
    set('watch_di_movementType', aiData.movementType);
  }
  var validDisplay = ['Analog', 'Digital', 'Analog-Digital'];
  if (aiData.displayType && validDisplay.indexOf(aiData.displayType) !== -1) {
    set('watch_di_displayType', aiData.displayType);
  }
  var validBand = ['Textile', 'Metal', 'Leather', 'No Band'];
  if (aiData.bandMaterial && validBand.indexOf(aiData.bandMaterial) !== -1) {
    set('watch_di_bandMaterial', aiData.bandMaterial);
  }
  set('watch_di_bandDetail', aiData.bandDetail || '');

  var validCase = ['NOT Gold/Silver Plated', 'Gold/Silver Plated', 'Metal Clad w/Precious Metal', 'Wholly of Precious Metal', 'Other'];
  if (aiData.caseMaterial && validCase.indexOf(aiData.caseMaterial) !== -1) {
    set('watch_di_caseMaterial', aiData.caseMaterial);
  }
  set('watch_di_caseDetail', aiData.caseDetail || '');

  var validBack = ['Other', 'Wholly of Precious Metal'];
  if (aiData.backplateMaterial && validBack.indexOf(aiData.backplateMaterial) !== -1) {
    set('watch_di_backplateMaterial', aiData.backplateMaterial);
  }
  set('watch_di_backplateDetail', aiData.backplateDetail || '');

  // 製造国（一括セット → changeイベントで各パーツに反映）
  var countryEl = document.getElementById('watch_di_countryMain');
  if (countryEl && aiData.country) {
    var countryOptions = Array.from(countryEl.options).map(function (o) { return o.value; });
    if (countryOptions.indexOf(aiData.country) !== -1) {
      countryEl.value = aiData.country;
    } else {
      countryEl.value = 'Other';
    }
    countryEl.dispatchEvent(new Event('change'));
  }

  // ムーブメント変更の副作用を反映
  document.getElementById('watch_di_movementType').dispatchEvent(new Event('change'));

  // HTSUSコード（10桁数字 → ####.##.#### 形式に変換）
  if (aiData.htsus) {
    var digits = String(aiData.htsus).replace(/[^0-9]/g, '');
    if (digits.length === 10) {
      var formatted = digits.slice(0, 4) + '.' + digits.slice(4, 6) + '.' + digits.slice(6, 10);
      set('watch_di_htsCode', formatted);
      validateHtsFormat(formatted);
    }
  }

  // HTSUS候補ヒントも更新
  updateHtsHint();

  // AIバッジ表示
  var badge = document.getElementById('watch_aiResultBadge');
  if (badge) {
    var reasonText = aiData.reason ? '💡 ' + aiData.reason : '';
    badge.innerHTML = '✨ <strong>AI入力補助</strong> — 内容を確認・修正してください。<strong>価格は必ず手入力してください</strong>（申告価格と出品価格が異なる場合があります）。' +
      (reasonText ? '<div class="ai-reason">' + escapeHtml(reasonText) + '</div>' : '');
    badge.style.display = 'block';
  }

  // AI読み取り完了後は「印刷プレビューへ直接進む」ボタンを表示
  var printDirectBtn = document.getElementById('watch_di_printDirectBtn');
  if (printDirectBtn) printDirectBtn.style.display = 'block';
}

// ---------------------------------------------------------
// Watch Worksheet機能: イベント登録
// ---------------------------------------------------------
window.addEventListener('load', function () {
  setupInputSection();
  setupWizardSection();
  setupPrintSection();

  // ホームの緑ボタン「⌚ AIでWatch Worksheetを作成する」
  document.getElementById('watchAiHomeBtn').addEventListener('click', startWatchAiFlowHome);

  // ホームの「⌚ Watch Worksheetを手動で作成」リンク → 入力方式選択（貼り付け/直接入力）へ
  document.getElementById('watchManualLink').addEventListener('click', function () {
    showSection('watch_sectionInput');
  });
});
