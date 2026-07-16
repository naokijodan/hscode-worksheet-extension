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
    const loadingMsg  = document.getElementById('loadingMsg');
    const screenHeader = document.getElementById('screenHeader');
    const tableEl     = document.getElementById('worksheetTable');
    const printBtn    = document.getElementById('printBtn');

    if (!stored._watchPrintPayload) {
      loadingMsg.textContent = 'データが見つかりません。サイドパネルから「印刷/PDFとして保存」を押してください。';
      return;
    }

    let col;
    try {
      col = JSON.parse(stored._watchPrintPayload);
    } catch (e) {
      loadingMsg.textContent = 'データの解析に失敗しました: ' + e.message;
      return;
    }

    // キーを数値に変換
    const colNum = {};
    Object.keys(col).forEach(function (k) {
      colNum[parseInt(k, 10)] = col[k];
    });

    renderTable(tableEl, colNum);

    loadingMsg.style.display   = 'none';
    screenHeader.style.display = '';
    tableEl.style.display      = '';

    printBtn.addEventListener('click', function () {
      window.print();
    });

    // 読み込み後、一時データを削除する（オプション：セキュリティ上の好習慣）
    chrome.storage.local.remove('_watchPrintPayload');
  });
});
