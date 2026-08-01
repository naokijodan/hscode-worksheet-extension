'use strict';

/**
 * print-watch.js
 * chrome.storage.local から _watchPrintPayload を読み出し、
 * Watch Worksheet テーブルを描画して window.print() を実行する。
 *
 * このファイルは print-watch.html 専用。worksheet.js には依存しない
 * （描画ロジックはここで自己完結させる）。
 * WatchWorksheet_Extension/print.js の移植（ストレージキーのみ
 * _printPayload → _watchPrintPayload に変更、他は挙動を変えない）。
 */

// ラベル定義（panel.js の watch 用 ROW_LABELS と同一）
const ROW_LABELS = [
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

const VALUE_BREAKOUT_ROWS = new Set([29,30,31,32,33,34]);
const COMPANY_ROWS        = new Set([36,37,38,39]);

// ===========================================
// 複数時計（2〜5本）用の定数・ヘルパー
// ===========================================
const BODY_ROW_START   = 3;
const BODY_ROW_END     = 35; // 本文（39行レイアウトのうちフッター4行を除く分）
const FOOTER_ROWS      = [36, 37, 38, 39];
const FOOTER_LABELS    = {
  36: 'Company Name',
  37: 'Name and Title',
  38: 'E-mail',
  39: 'AWB Number'
};
const MAX_COLS_PER_PAGE = 3;

/** ペイロードのキー（文字列）を数値キーに変換したコピーを返す */
function normalizeColKeys(col) {
  const out = {};
  Object.keys(col || {}).forEach(function (k) {
    out[parseInt(k, 10)] = col[k];
  });
  return out;
}

/**
 * 複数時計ページ用の本文テーブル（行3〜35 + ラベル列 + 時計N列）を1つ作る。
 * watchGroup: このページに載せる col オブジェクトの配列（最大3件）
 * startIndex: このページの先頭の時計が全体の何番目か（0始まり。ヘッダーの "Watch n" 表示用）
 */
function buildMultiPageTable(watchGroup, startIndex) {
  const table = document.createElement('table');
  table.className = 'worksheet-table watch-multi-table';

  const trTitle = document.createElement('tr');
  const tdTitle = document.createElement('td');
  tdTitle.colSpan = 1 + watchGroup.length;
  tdTitle.textContent = 'Watch Worksheet';
  tdTitle.className = 'ws-title';
  trTitle.appendChild(tdTitle);
  table.appendChild(trTitle);

  const trHeader = document.createElement('tr');
  const tdHL = document.createElement('td');
  tdHL.textContent = '';
  tdHL.className = 'ws-header';
  trHeader.appendChild(tdHL);
  watchGroup.forEach(function (col, i) {
    const tdHV = document.createElement('td');
    tdHV.textContent = 'Watch ' + (startIndex + i + 1);
    tdHV.className = 'ws-header';
    trHeader.appendChild(tdHV);
  });
  table.appendChild(trHeader);

  for (let rowNum = BODY_ROW_START; rowNum <= BODY_ROW_END; rowNum++) {
    const label = ROW_LABELS[rowNum - 3];
    const isSub = label.indexOf('  ') === 0;
    const isVB  = VALUE_BREAKOUT_ROWS.has(rowNum);

    const tr = document.createElement('tr');
    if (isVB) tr.classList.add('ws-value-breakout');

    const tdLabel = document.createElement('td');
    tdLabel.textContent = label;
    tdLabel.className = isSub ? 'ws-label-sub' : 'ws-label';
    tr.appendChild(tdLabel);

    watchGroup.forEach(function (col) {
      const tdValue = document.createElement('td');
      tdValue.textContent = col[rowNum] || '';
      tdValue.className = 'ws-data';
      tr.appendChild(tdValue);
    });

    table.appendChild(tr);
  }

  return table;
}

/** フッター（Company Name / Name and Title / E-mail / AWB Number）は常に Watch 1 の値を使う */
function buildFooterTable(firstWatchCol) {
  const table = document.createElement('table');
  table.className = 'worksheet-table watch-footer-table';

  FOOTER_ROWS.forEach(function (rowNum) {
    const tr = document.createElement('tr');
    tr.classList.add('ws-company');

    const tdLabel = document.createElement('td');
    tdLabel.textContent = FOOTER_LABELS[rowNum];
    tdLabel.className = 'ws-label';
    tr.appendChild(tdLabel);

    const tdValue = document.createElement('td');
    tdValue.textContent = (firstWatchCol && firstWatchCol[rowNum]) || '';
    tdValue.className = 'ws-data';
    tr.appendChild(tdValue);

    table.appendChild(tr);
  });

  return table;
}

/**
 * 2〜5本の時計を、1ページ最大3列のFedEx様式（列形式）で描画する。
 * 4〜5本の場合は2ページ目へ続き、各ページでラベル列・行ラベルを繰り返す。
 * フッター（会社情報等）は各ページに1回ずつ、常に Watch 1 の値で表示する。
 * A4横向きにするため、印刷専用の @page 上書きスタイルを動的に追加する。
 */
function renderMultiPages(container, watches) {
  container.innerHTML = '';

  const pages = [];
  for (let i = 0; i < watches.length; i += MAX_COLS_PER_PAGE) {
    pages.push(watches.slice(i, i + MAX_COLS_PER_PAGE));
  }

  pages.forEach(function (group, pageIdx) {
    const startIndex = pageIdx * MAX_COLS_PER_PAGE;

    const pageDiv = document.createElement('div');
    pageDiv.className = 'watch-multi-page';
    if (pageIdx < pages.length - 1) pageDiv.classList.add('watch-page-break');

    pageDiv.appendChild(buildMultiPageTable(group, startIndex));

    const footerWrap = document.createElement('div');
    footerWrap.className = 'watch-footer-wrap';
    footerWrap.appendChild(buildFooterTable(watches[0]));
    pageDiv.appendChild(footerWrap);

    container.appendChild(pageDiv);
  });

  // 複数時計ページはA4横向きで印刷する（1本のみの場合はこの関数自体が呼ばれないため無関係）。
  // @page はセレクタでスコープできないため、後勝ちになるよう <style> を追加で差し込む。
  const styleEl = document.createElement('style');
  styleEl.textContent = '@media print { @page { size: A4 landscape; margin: 12mm 10mm; } }';
  document.head.appendChild(styleEl);
}

function renderTable(tableEl, col) {
  tableEl.innerHTML = '';

  // row 1: タイトル
  const trTitle = document.createElement('tr');
  const tdTitle = document.createElement('td');
  tdTitle.colSpan = 2;
  tdTitle.textContent = 'Watch Worksheet';
  tdTitle.className = 'ws-title';
  trTitle.appendChild(tdTitle);
  tableEl.appendChild(trTitle);

  // row 2: ヘッダー
  const trHeader = document.createElement('tr');
  const tdHL = document.createElement('td');
  tdHL.textContent = '';
  tdHL.className = 'ws-header';
  const tdHV = document.createElement('td');
  tdHV.textContent = 'Watch 1';
  tdHV.className = 'ws-header';
  trHeader.appendChild(tdHL);
  trHeader.appendChild(tdHV);
  tableEl.appendChild(trHeader);

  // row 3～39
  ROW_LABELS.forEach(function (label, idx) {
    const rowNum = idx + 3;
    const isSub = label.startsWith('  ');
    const isVB  = VALUE_BREAKOUT_ROWS.has(rowNum);
    const isCo  = COMPANY_ROWS.has(rowNum);

    const tr = document.createElement('tr');
    if (isVB) tr.classList.add('ws-value-breakout');
    if (isCo) tr.classList.add('ws-company');

    const tdLabel = document.createElement('td');
    tdLabel.textContent = label;
    tdLabel.className   = isSub ? 'ws-label-sub' : 'ws-label';

    const tdValue = document.createElement('td');
    tdValue.textContent = col[rowNum] || '';
    tdValue.className   = 'ws-data';

    tr.appendChild(tdLabel);
    tr.appendChild(tdValue);
    tableEl.appendChild(tr);
  });
}

window.addEventListener('load', function () {
  chrome.storage.local.get(['_watchPrintPayload'], function (stored) {
    const loadingMsg   = document.getElementById('loadingMsg');
    const screenHeader = document.getElementById('screenHeader');
    const printRoot    = document.getElementById('printRoot');
    const printBtn     = document.getElementById('printBtn');

    if (!stored._watchPrintPayload) {
      loadingMsg.textContent = 'データが見つかりません。サイドパネルから「印刷/PDFとして保存」を押してください。';
      return;
    }

    let raw;
    try {
      raw = JSON.parse(stored._watchPrintPayload);
    } catch (e) {
      loadingMsg.textContent = 'データの解析に失敗しました: ' + e.message;
      return;
    }

    // ペイロード形状の判定:
    //   従来どおりのフラットな col オブジェクト（1本）→ そのまま
    //   { multi: true, watches: [...] }（2〜5本）→ 配列を取り出す
    let watches;
    if (raw && raw.multi === true && Array.isArray(raw.watches)) {
      watches = raw.watches.map(normalizeColKeys);
    } else {
      watches = [normalizeColKeys(raw)];
    }

    if (watches.length <= 1) {
      // 1本のみ：従来と完全に同じ #worksheetTable を描画する（見た目・挙動は不変）。
      const tableEl = document.createElement('table');
      tableEl.className = 'worksheet-table';
      tableEl.id = 'worksheetTable';
      printRoot.appendChild(tableEl);
      renderTable(tableEl, watches[0] || {});
    } else {
      // 2〜5本：FedEx様式（列形式・A4横向き・最大3列/ページ）で描画する。
      renderMultiPages(printRoot, watches);
    }

    loadingMsg.style.display   = 'none';
    screenHeader.style.display = '';
    printRoot.style.display    = '';

    printBtn.addEventListener('click', function () {
      window.print();
    });

    // 読み込み後、一時データを削除する（オプション：セキュリティ上の好習慣）
    chrome.storage.local.remove('_watchPrintPayload');
  });
});
