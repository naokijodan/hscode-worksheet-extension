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
  company: { name: '', nameTitle: '', email: '' },

  // ブラウズ
  browseChapter: null,     // 現在開いている章 { chapter, title, count }
  browseChapterData: null  // その章のデータ配列（lazy-loaded）
};

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------
function showSection(id) {
  var sections = ['sectionHome', 'sectionBrowse', 'sectionSettings', 'sectionWizard',
                  'sectionResult', 'sectionConfirm', 'sectionPrint'];
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
  chrome.storage.local.get(['_hsCompany'], function(stored) {
    if (stored._hsCompany) {
      try {
        state.company = JSON.parse(stored._hsCompany);
        document.getElementById('companyName').value  = state.company.name || '';
        document.getElementById('nameAndTitle').value = state.company.nameTitle || '';
        document.getElementById('email').value        = state.company.email || '';
      } catch(e) {}
    }
  });
}

function saveSettings(e) {
  e.preventDefault();
  state.company.name      = document.getElementById('companyName').value.trim();
  state.company.nameTitle = document.getElementById('nameAndTitle').value.trim();
  state.company.email     = document.getElementById('email').value.trim();
  chrome.storage.local.set({ _hsCompany: JSON.stringify(state.company) }, function() {
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

  // 初期表示
  showSection('sectionHome');
});
