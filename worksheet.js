/**
 * worksheet.js
 * Code.gs の純粋JSロジックをそのまま移植したファイル。
 * GAS固有のAPI（SpreadsheetApp, PropertiesService 等）は除去し、
 * 設定値は引数で渡す形に変更（normalizeData の引数に config を追加）。
 * バグも含め元の挙動を一切変えない。
 */

'use strict';

// ===========================================
// オプション／マッピング（Code.gs そのまま）
// ===========================================

function getCurrencySymbol(currency) {
  const symbols = {
    'USD': '$',
    'EUR': '€',
    'JPY': '¥',
    'GBP': '£',
    'CHF': 'CHF'
  };
  return symbols[currency] || '$';
}

function getDropdownOptions() {
  return {
    jewels: [
      '0 to 1 Jewels',
      '2 to 7 Jewels',
      '8 to 17 Jewels',
      'over 17 Jewels'
    ],
    bandMaterial: ['Textile', 'Metal', 'Leather', 'No Band'],
    caseMaterial: [
      'Gold/Silver Plated',
      'NOT Gold/Silver Plated',
      'Metal Clad w/Precious Metal',
      'Wholly of Precious Metal',
      'Other'
    ],
    backplateMaterial: ['Wholly of Precious Metal', 'Other'],
    countries: ['Japan', 'United States', 'Switzerland', 'Germany', 'China', 'Other'],
    primaryFunction: ['Timekeeping', 'GPS', 'Heart Monitor', 'Wi-Fi', 'Pedometer', 'Other']
  };
}

function getValueBreakoutConfig() {
  return {
    quartz: { movement: 0.50, case: 0.30, strap: 0.15, battery: 0.05 },
    mechanical: { movement: 0.55, case: 0.30, strap: 0.15, battery: 0.00 }
  };
}

function mapJewelsToDropdown(jewelCount) {
  if (typeof jewelCount === 'string') {
    const s = jewelCount.toLowerCase();
    if (s.includes('not applicable') || s.includes('quartz')) return '0 to 1 Jewels';
    const m = jewelCount.match(/\d+/);
    if (!m) return '0 to 1 Jewels';
    jewelCount = parseInt(m[0], 10);
  }
  if (jewelCount === 0 || jewelCount === 1) return '0 to 1 Jewels';
  if (jewelCount >= 2 && jewelCount <= 7) return '2 to 7 Jewels';
  if (jewelCount >= 8 && jewelCount <= 17) return '8 to 17 Jewels';
  if (jewelCount > 17) return 'over 17 Jewels';
  return '0 to 1 Jewels';
}

function mapCountryToDropdown(country) {
  if (!country) return '';
  const lower = String(country).toLowerCase();
  const opts = getDropdownOptions().countries;
  for (let o of opts) {
    if (lower.includes(o.toLowerCase())) return o;
  }
  if (lower.includes('switzerland') || lower.includes('swiss')) return 'Switzerland';
  if (lower.includes('usa') || lower.includes('america')) return 'United States';
  if (lower.includes('jp') || lower.includes('jpn')) return 'Japan';
  if (lower.includes('de') || lower.includes('deutsch')) return 'Germany';
  return 'Other';
}

// ===========================================
// ChatGPTデータ解析（Code.gs そのまま）
// ===========================================

/**
 * メインエントリーポイント。
 * @param {string} awbNumber
 * @param {string} chatgptData
 * @param {{companyName:string, nameAndTitle:string, email:string}} config
 * @returns {{success:boolean, message?:string, data?:object}}
 */
function createWatchWorksheetData(awbNumber, chatgptData, config) {
  try {
    const parsed = parseChatGPTData(chatgptData, config);
    if (!parsed.success) return { success: false, message: parsed.message };
    parsed.data.awbNumber = awbNumber || '';
    return { success: true, data: parsed.data };
  } catch (e) {
    return { success: false, message: 'ワークシート作成中にエラーが発生しました: ' + e.message };
  }
}

function parseChatGPTData(rawData, config) {
  try {
    if (!rawData || typeof rawData !== 'string') {
      return { success: false, message: 'データが無効です。ChatGPTからの出力をコピー・ペーストしてください。' };
    }
    const startMarker = '=== WATCH WORKSHEET DATA ===';
    const endMarker = '=== END DATA ===';
    const startIndex = rawData.indexOf(startMarker);
    const endIndex = rawData.indexOf(endMarker);
    if (startIndex === -1 || endIndex === -1) {
      return {
        success: false,
        message: 'データ形式が正しくありません。\n「=== WATCH WORKSHEET DATA ===」から「=== END DATA ===」までの部分が見つかりません。'
      };
    }
    const dataSection = rawData.substring(startIndex + startMarker.length, endIndex).trim();
    const lines = dataSection.split('\n').filter(l => l.trim());
    const parsed = {};
    for (let line of lines) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.substring(0, idx).trim();
      const value = line.substring(idx + 1).trim();
      if (value && value !== '[要確認]' && value !== '[不明]') parsed[key] = value;
    }

    const required = ['Style name/No/Reference', 'Total Watch Value', 'Movement Type'];
    const missing = required.filter(f => !parsed[f]);
    if (missing.length > 0) return { success: false, message: `必須項目が不足しています: ${missing.join(', ')}` };

    const normalized = normalizeData(parsed, config);
    const chk = validateData(normalized);
    if (!chk.isValid) return { success: false, message: '検証エラー: ' + chk.errors.join(' / ') };

    return { success: true, data: normalized };
  } catch (e) {
    return { success: false, message: 'データの解析中にエラーが発生しました: ' + e.message };
  }
}

/**
 * @param {object} raw
 * @param {{companyName:string, nameAndTitle:string, email:string}} config
 */
function normalizeData(raw, config) {
  const n = {};
  n.styleRef = raw['Style name/No/Reference'] || '';

  // 通貨単位を抽出して保存
  const totalValueStr = String(raw['Total Watch Value'] || '').trim();
  n.totalValue = parseFloat(totalValueStr.replace(/[^0-9.]/g, '')) || 0;

  // 通貨単位を抽出（JPY, USD, EUR等）
  const currencyMatch = totalValueStr.match(/[A-Z]{3}$/);
  n.currency = currencyMatch ? currencyMatch[0] : 'USD';

  n.movementType = raw['Movement Type'] || 'Quartz';
  n.displayType = raw['Display Type'] || 'Analog';
  n.htsCode = cleanHTSCode(raw['HTS US Code']) || '';
  n.jewels = mapJewelsToDropdown(raw['Number of Jewels in Movement']);
  // 元のJewel数値を保持（新フォーマットの数値直接入力用）
  const rawJewels = raw['Number of Jewels in Movement'];
  if (typeof rawJewels === 'string') {
    const m = rawJewels.match(/\d+/);
    n.jewelCount = m ? parseInt(m[0], 10) : 0;
  } else {
    n.jewelCount = parseInt(rawJewels || '0', 10);
  }
  n.quantity = parseInt(raw['Quantity'] || '1', 10);

  n.bandMaterial = raw['Material of Band'] || 'Leather';
  n.bandDetail = raw['Band Detail'] || '';
  n.caseMaterial = raw['Material of Case'] || 'Other';
  n.caseDetail = raw['Case Detail'] || '';
  n.backplateMaterial = raw['Material of Backplate'] || 'Other';
  n.backplateDetail = raw['Backplate Detail'] || '';

  n.movementCountry = mapCountryToDropdown(raw['Country of Origin of Movement']);
  n.bandCountry = mapCountryToDropdown(raw['Country of Origin of Band']);
  n.caseCountry = mapCountryToDropdown(raw['Country of Origin of Case']);
  n.batteryCountry = mapCountryToDropdown(raw['Country of Origin of Battery'] || 'Japan');

  n.primaryFunction = raw['Primary Function'] || 'Timekeeping';
  n.otherMaterials = raw['Other materials'] || '';

  const b = calculateValueBreakout(n.totalValue, n.movementType);
  n.movementValue = b.movement;
  n.caseValue = b.case;
  n.strapValue = b.strap;
  n.batteryValue = b.battery;

  // GASのgetCompanyConfig()の代わりに引数のconfigを使う
  const cfg = config || { companyName: '', nameAndTitle: '', email: '' };
  n.companyName = cfg.companyName || '';
  n.nameAndTitle = cfg.nameAndTitle || '';
  n.email = cfg.email || '';
  n.awbNumber = '';

  return n;
}

function cleanHTSCode(htsText) {
  if (!htsText) return '';
  let cleaned = String(htsText).replace(/\s*\([^)]*\)/g, '');
  const m = cleaned.match(/\d+(\.\d+)*/);
  if (m) return m[0];
  return cleaned.trim().split(/\s+/)[0];
}

function calculateValueBreakout(totalValue, movementType) {
  const cfg = getValueBreakoutConfig();
  const r = (String(movementType).toLowerCase().includes('quartz')) ? cfg.quartz : cfg.mechanical;
  const round2 = (x) => Math.round(x * 100) / 100;
  return {
    movement: round2(totalValue * r.movement),
    case: round2(totalValue * r.case),
    strap: round2(totalValue * r.strap),
    battery: round2(totalValue * r.battery)
  };
}

function validateData(data) {
  const errors = [];
  if (!data.styleRef) errors.push('Style name/No/Reference は必須です');
  if (!data.totalValue || data.totalValue <= 0) errors.push('Total Watch Value は正の数値である必要があります');
  if (!data.movementType) errors.push('Movement Type は必須です');
  return { isValid: errors.length === 0, errors };
}

// ===========================================
// DHL用ヘルパー（Code.gs そのまま。第1段階では直接呼び出さないが移植対象に含む）
// ===========================================

/** 連続アンダースコアを作る（等幅フォント前提） */
function _us(n) { return new Array(Math.max(0, n)).fill('_').join(''); }

/** 下線の中に値を"載せる"テキストを作る */
function _inlineOnLine(valueStr, totalLen, leftPad) {
  const v = String(valueStr || '').trim();
  const lp = Math.max(0, leftPad || 0);
  const usable = Math.max(0, totalLen - lp);
  if (!v) return _us(totalLen);
  const vv = v.length > usable ? v.substring(0, usable) : v;
  const right = Math.max(0, totalLen - lp - vv.length);
  return _us(lp) + vv + _us(right);
}

/** Name & Title の分離（簡易） */
function _splitNameAndTitle(nameAndTitle) {
  const s = String(nameAndTitle || '').trim();
  if (!s) return { name: '', title: '' };
  const parts = s.split(/\s+/);
  if (parts.length >= 3) {
    return { name: parts.slice(0, -1).join(' '), title: parts[parts.length - 1] };
  }
  if (parts.length === 2) {
    return { name: s, title: '' };
  }
  return { name: s, title: '' };
}
