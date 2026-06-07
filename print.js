'use strict';

/**
 * print.js — 印刷専用
 * chrome.storage.local から _hsPrintPayload を読み出しワークシートを描画。
 */

/** Strip all dots, hyphens, and spaces from a code for display. */
function stripDots(s) {
  return (s == null ? '' : String(s)).replace(/[.\-\s]/g, '');
}

function renderWorksheet(tableEl, p) {
  tableEl.innerHTML = '';

  function addRow(labelText, valueText, labelClass, trClass) {
    var tr = document.createElement('tr');
    if (trClass) tr.className = trClass;

    var tdL = document.createElement('td');
    tdL.textContent = labelText;
    tdL.className = labelClass || 'ws-label';

    var tdV = document.createElement('td');
    tdV.textContent = valueText || '';
    tdV.className = 'ws-data';

    tr.appendChild(tdL);
    tr.appendChild(tdV);
    tableEl.appendChild(tr);
  }

  function addTitleRow(text, cls) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 2;
    td.textContent = text;
    td.className = cls || 'ws-title';
    tr.appendChild(td);
    tableEl.appendChild(tr);
  }

  // タイトル
  addTitleRow('HS Code Worksheet / 通関用HSコードワークシート', 'ws-title');

  // HTSコード
  addTitleRow('HTS / HS Code', 'ws-header');
  addRow('HTSUS Code (10-digit)',   stripDots(p.htsus   || ''), 'ws-label', 'ws-section-hts');
  addRow('HS Code (6-digit)',       stripDots(p.hs6     || ''), 'ws-label', 'ws-section-hts');
  addRow('Official Description',   p.desc    || '', 'ws-label', 'ws-section-hts');
  addRow('Duty Rate (General)',     p.duty    || '', 'ws-label', 'ws-section-hts');

  // 商品情報
  addTitleRow('Product Information / 商品情報', 'ws-header');
  addRow('Customs Title (English)',  p.title   || '', 'ws-label', 'ws-section-goods');
  addRow('Brand / Manufacturer',    p.brand   || '', 'ws-label', 'ws-section-goods');
  addRow('Model / Reference',       p.model   || '', 'ws-label', 'ws-section-goods');
  addRow('Country of Origin',       p.country || '', 'ws-label', 'ws-section-goods');

  // 価格
  addTitleRow('Value / 申告価格', 'ws-header');
  addRow('Quantity',         String(p.qty || 1),
                             'ws-label', 'ws-section-value');
  addRow('Declared Value',   p.value ? (p.value + ' ' + (p.currency || 'USD')) : '',
                             'ws-label', 'ws-section-value');

  // 輸出者情報
  addTitleRow('Shipper Information / 輸出者情報', 'ws-header');
  addRow('Company Name',   p.company   || '', 'ws-label', 'ws-section-company');
  addRow('Name and Title', p.nameTitle || '', 'ws-label', 'ws-section-company');
  addRow('E-mail',         p.email     || '', 'ws-label', 'ws-section-company');
  addRow('AWB Number',     p.awb       || '', 'ws-label', 'ws-section-company');

  // 免責
  var tr = document.createElement('tr');
  tr.className = 'ws-disclaimer';
  var td = document.createElement('td');
  td.colSpan = 2;
  td.className = 'ws-disclaimer';
  td.textContent =
    '【免責】このワークシートのHSコードはガイドウィザードによる候補です。' +
    '最終的な分類・申告責任は輸出者にあります。不明な場合は通関士にご相談ください。' +
    '  Generated: ' + (p.generatedAt || '');
  tr.appendChild(td);
  tableEl.appendChild(tr);
}

window.addEventListener('load', function() {
  var loadingMsg   = document.getElementById('loadingMsg');
  var screenHeader = document.getElementById('screenHeader');
  var tableEl      = document.getElementById('worksheetTable');
  var printBtn     = document.getElementById('printBtn');
  var closeBtn     = document.getElementById('closeBtn');

  chrome.storage.local.get(['_hsPrintPayload'], function(stored) {
    if (!stored._hsPrintPayload) {
      loadingMsg.textContent =
        'データが見つかりません。サイドパネルから「印刷/PDFとして保存」を押してください。';
      return;
    }

    var payload;
    try {
      payload = JSON.parse(stored._hsPrintPayload);
    } catch(e) {
      loadingMsg.textContent = 'データの解析に失敗しました: ' + e.message;
      return;
    }

    renderWorksheet(tableEl, payload);

    loadingMsg.style.display    = 'none';
    screenHeader.style.display  = '';
    tableEl.style.display       = '';

    printBtn.addEventListener('click', function() { window.print(); });
    closeBtn.addEventListener('click', function() { window.close(); });

    // 読み込み後に一時データを削除
    chrome.storage.local.remove('_hsPrintPayload');
  });
});
