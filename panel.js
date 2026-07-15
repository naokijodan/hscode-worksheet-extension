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

  // TSCA証明書（FedEx）機能（v1.3.0）
  tsca: {
    templateLoaded: false,
    pageCount: null,
    form: null   // 確認画面へ進んだ時点のスナップショット
  },
};

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------
function showSection(id) {
  var sections = ['sectionHome', 'sectionBrowse', 'sectionSettings', 'sectionWizard',
                  'sectionResult', 'sectionConfirm', 'sectionPrint',
                  'sectionCpscWiz', 'sectionCpscResult', 'sectionTsca'];
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

/** ホームの赤ボタン: 開いているページをAIで分析し、TSCA用の英語商品説明を生成してTSCAフォームを開く */
function startTscaAiFlow() {
  var msg = document.getElementById('tscaAiHomeMsg');
  var btn = document.getElementById('tscaAiBtn');

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
      btn.disabled = false;
      msg.style.display = 'none';
      openTscaSection();
      var aiMsg1 = document.getElementById('tscaAiMsg');
      showMessage(aiMsg1, 'error', (errReason || 'ページ情報を取得できませんでした') + '。商品説明は手動で入力してください。');
      return;
    }
    callTscaDescriptionAi(pageInfo, function(err, description) {
      btn.disabled = false;
      msg.style.display = 'none';
      openTscaSection();
      if (err || !description) {
        var aiMsg2 = document.getElementById('tscaAiMsg');
        showMessage(aiMsg2, 'error', 'AI呼び出しに失敗しました: ' + (err ? err.message : '不明なエラー') + '。商品説明は手動で入力してください。');
        return;
      }
      document.getElementById('tscaProductDesc').value = description;
      showTscaAiResultBadge(true);
    });
  });
}

/** 開いているページの情報からTSCA用の英語商品説明（1〜2文・誇張なし・最大350文字）を生成する */
function callTscaDescriptionAi(pageInfo, cb) {
  var lines = [
    'Product URL: ' + pageInfo.url,
    'Product name: ' + (pageInfo.productName || '')
  ];
  if (pageInfo.brand)       lines.push('Brand: ' + pageInfo.brand);
  if (pageInfo.condition)   lines.push('Condition: ' + pageInfo.condition);
  if (pageInfo.category)    lines.push('Category on site: ' + pageInfo.category);
  if (pageInfo.description) lines.push('Description: ' + pageInfo.description);

  var userContent = lines.join('\n');

  var systemPrompt = [
    'You are helping prepare a US customs document (FedEx TSCA certification) for a shipment',
    'of a used/secondhand consumer good exported from Japan to the US.',
    'Given the product page information below, write a concise English product description',
    'for the "Product description" field of the customs form.',
    'Factual, no exaggeration, no marketing or promotional language. Maximum 350 characters total.',
    'ALWAYS include the material composition of the product as a bullet list, because FedEx may ask about materials.',
    'Output format (use explicit line breaks exactly like this, nothing else):',
    '<one factual sentence: item type, product name in quotes, brand, and condition (new/used)>',
    'Materials:',
    '- <material name (full chemical name in parentheses if applicable)>: approx. <percent>%',
    '- <material name>: approx. <percent>%',
    'Material rules:',
    '- If the page information states materials (素材, 材質, "Material", etc.), use them, translated into standard English material names. This takes priority.',
    '- Otherwise use the industry-standard composition for the product category (e.g. painted finished figures = PVC approx. 90% / ABS approx. 10%; trading cards and board games = paper and cardboard; plush toys = polyester fabric and stuffing).',
    '- Give each material an approximate percentage prefixed with "approx.", adding up to roughly 100%.',
    '- Write a percentage WITHOUT "approx." only when that exact figure is explicitly stated in the page information.',
    '- List at most 4 materials (the form has only 7 writing lines in total).',
    'Example output:',
    'Painted finished figure set "Gundam RX-78-2" by Bandai, used.',
    'Materials:',
    '- PVC (polyvinyl chloride): approx. 90%',
    '- ABS (acrylonitrile butadiene styrene): approx. 10%',
    'Return ONLY the description text. No quotes around the whole text, no markdown, no explanation.'
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
      max_completion_tokens: 250
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
    content = content.trim().replace(/^["']|["']$/g, '');
    cb(null, content);
  })
  .catch(function(e) {
    cb(e, null);
  });
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
var TSCA_DESC_MAX_WIDTH = 280; // 商品説明欄の実用幅(pt)

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

/** 記入フォーム表示。既定値・会社情報設定からのプリフィルを行う。 */
function tscaEnterForm() {
  tscaUpdateTemplateStatus();
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
  document.getElementById('tscaProductDesc').value    = '';

  var aiMsg = document.getElementById('tscaAiMsg');
  if (aiMsg) aiMsg.style.display = 'none';
  showTscaAiResultBadge(false);

  // 設定にCertifier情報が何も保存されていなければ、設定画面への案内を表示
  var hintEl = document.getElementById('tscaSettingsHint');
  if (hintEl) {
    var hasCertifierInfo = !!(state.company.certifierName || state.company.phone || state.company.email);
    hintEl.style.display = hasCertifierInfo ? 'none' : '';
  }

  showTscaSub('tscaSubForm');
}

/** AIで英語の商品説明を生成（既存のOpenAI利用パターンを踏襲） */
function tscaGenerateDescription() {
  var msgEl = document.getElementById('tscaAiMsg');
  var btn = document.getElementById('tscaAiDescBtn');
  var textEl = document.getElementById('tscaProductDesc');

  if (!state.openaiKey) {
    showMessage(msgEl, 'error', 'APIキーが未設定です。設定画面で OpenAI APIキーを入力してください。');
    return;
  }
  var source = textEl.value.trim();
  if (!source) {
    showMessage(msgEl, 'error', '商品名など、元になる情報を先に入力してください（日本語可）。');
    return;
  }

  btn.disabled = true;
  showMessage(msgEl, 'info', '生成中…');

  var systemPrompt = [
    'You are helping prepare a FedEx TSCA (Toxic Substances Control Act) certification form',
    'for a shipment of used/secondhand consumer goods exported from Japan to the US.',
    'Given a short Japanese or English product name/description, write ONE concise English',
    'product description suitable for the "Product description" field of the form.',
    'Keep it factual and short. No marketing language. Maximum 350 characters total.',
    'Mention the item type and condition (e.g. "Used") when relevant.',
    'ALWAYS include the material composition of the product as a bullet list, because FedEx may ask about materials.',
    'Output format (use explicit line breaks exactly like this, nothing else):',
    '<one factual sentence: item type, product name in quotes, brand, and condition (new/used)>',
    'Materials:',
    '- <material name (full chemical name in parentheses if applicable)>: approx. <percent>%',
    '- <material name>: approx. <percent>%',
    'Material rules:',
    '- If the given text states materials (素材, 材質, "Material", etc.), use them, translated into standard English material names. This takes priority.',
    '- Otherwise use the industry-standard composition for the product category (e.g. painted finished figures = PVC approx. 90% / ABS approx. 10%; trading cards and board games = paper and cardboard; plush toys = polyester fabric and stuffing).',
    '- Give each material an approximate percentage prefixed with "approx.", adding up to roughly 100%.',
    '- Write a percentage WITHOUT "approx." only when that exact figure is explicitly stated in the given text.',
    '- List at most 4 materials (the form has only 7 writing lines in total).',
    'Example output:',
    'Painted finished figure set "Gundam RX-78-2" by Bandai, used.',
    'Materials:',
    '- PVC (polyvinyl chloride): approx. 90%',
    '- ABS (acrylonitrile butadiene styrene): approx. 10%',
    'Return ONLY the description text. No quotes around the whole text, no markdown, no explanation.'
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
        { role: 'user', content: source }
      ],
      max_completion_tokens: 250
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
    content = content.trim().replace(/^["']|["']$/g, '');
    textEl.value = content;
    msgEl.style.display = 'none';
  })
  .catch(function(e) {
    showMessage(msgEl, 'error', 'AI呼び出しに失敗しました: ' + e.message);
  })
  .finally(function() {
    btn.disabled = false;
  });
}

/** 記入フォーム → 確認画面（商品説明が7行に収まるかを確認してから進む） */
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
    // 明示的な改行（Materials:箇条書き等）は保持し、行内の連続空白のみ正規化する
    productDesc:     document.getElementById('tscaProductDesc').value
                       .split(/\r?\n/)
                       .map(function(s) { return s.replace(/\s+/g, ' ').trim(); })
                       .filter(function(s) { return s; })
                       .join('\n'),
    companyName:     document.getElementById('tscaCompanyName').value.trim(),
    companyAddress:  document.getElementById('tscaCompanyAddress').value.trim(),
    certifierTitle:  document.getElementById('tscaCertifierTitle').value.trim()
  };

  if (!f.certifierName) {
    alert('Certifier name を入力してください。');
    return;
  }
  if (!f.productDesc) {
    alert('商品説明を入力してください。');
    return;
  }
  if (typeof PDFLib === 'undefined') {
    alert('PDF処理ライブラリの読み込みに失敗しました。拡張機能を再読み込みしてください。');
    return;
  }

  PDFLib.PDFDocument.create().then(function(tmpDoc) {
    return tmpDoc.embedFont(PDFLib.StandardFonts.Helvetica);
  }).then(function(helv) {
    var wrap = tscaWrapDescription(helv, f.productDesc, TSCA_DESC_MAX_WIDTH, TSCA_COORD.descRows.length);
    if (wrap.overflow) {
      alert('商品説明が長すぎます。' + TSCA_COORD.descRows.length + '行に収まるよう短くしてください（現在' + wrap.lineCount + '行相当）。');
      return;
    }
    tscaProceedToConfirm(f);
  }).catch(function(err) {
    console.error('TSCA description wrap check error', err);
    alert('商品説明のチェックに失敗しました: ' + (err && err.message ? err.message : String(err)));
  });
}

/** 商品説明の行数チェック通過後、確認画面を構築して表示する */
function tscaProceedToConfirm(f) {
  state.tsca.form = f;

  var rows = [
    ['Date', f.date || '(未入力)'],
    ['Waybill番号', f.waybill || '（未入力・後で手書き）'],
    ['証明区分', f.certType === 'positive' ? 'Positive Certification' : 'Negative Certification'],
    ['Certifier name', f.certifierName],
    ['Certifier phone', f.certifierPhone || '(未入力)'],
    ['Certifier email', f.certifierEmail || '(未入力)'],
    ['商品説明', f.productDesc],
    ['Company name', f.companyName || '(未入力・任意)'],
    ['Company address', f.companyAddress || '(未入力・任意)'],
    ['Certifier title', f.certifierTitle || '(未入力・任意)']
  ];
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
            outDoc.embedFont(PDFLib.StandardFonts.HelveticaOblique)
          ]).then(function(fonts) {
            var helv = fonts[0];
            var helvOblique = fonts[1];
            var page = outDoc.getPage(0);
            var black = PDFLib.rgb(0, 0, 0);

            function draw(text, coord, font) {
              if (!text) return;
              page.drawText(text, { x: coord.x, y: coord.y, size: TSCA_FONT_SIZE, font: font || helv, color: black });
            }

            draw(f.date, TSCA_COORD.date);
            draw(f.waybill, TSCA_COORD.waybill);
            draw(f.companyName, TSCA_COORD.companyName);
            draw(f.companyAddress, TSCA_COORD.companyAddress);
            draw(f.certifierName, TSCA_COORD.certifierName);
            draw(f.certifierTitle, TSCA_COORD.certifierTitle);
            draw(f.certifierPhone, TSCA_COORD.certifierPhone);
            draw(f.certifierEmail, TSCA_COORD.certifierEmail);
            draw(f.certifierName, TSCA_COORD.signature, helvOblique);

            var wrap = tscaWrapDescription(helv, f.productDesc, TSCA_DESC_MAX_WIDTH, TSCA_COORD.descRows.length);
            if (wrap.overflow) {
              throw new Error('商品説明が' + TSCA_COORD.descRows.length + '行に収まりません（現在' + wrap.lineCount + '行相当）。フォームに戻って短くしてください。');
            }
            wrap.lines.forEach(function(line, i) {
              if (TSCA_COORD.descRows[i]) draw(line, TSCA_COORD.descRows[i]);
            });

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
  showSection('sectionHome');
}

// -------------------------------------------------------
// TSCA証明書機能: イベント登録
// -------------------------------------------------------
window.addEventListener('load', function() {
  document.getElementById('tscaManualLink').addEventListener('click', openTscaSection);
  document.getElementById('backFromTsca').addEventListener('click', function() {
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
  document.getElementById('tscaGoToConfirmBtn').addEventListener('click', tscaGoToConfirm);

  document.getElementById('tscaConfirmCheck').addEventListener('change', function() {
    document.getElementById('tscaGenerateBtn').disabled = !this.checked;
  });
  document.getElementById('tscaGenerateBtn').addEventListener('click', tscaGeneratePdf);
  document.getElementById('tscaBackToFormBtn').addEventListener('click', function() {
    showTscaSub('tscaSubForm');
  });

  document.getElementById('tscaStartOverBtn').addEventListener('click', tscaStartOver);
});
