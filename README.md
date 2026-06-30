# HSコードワークシート作成君

**HS Code / HTSUS Code Worksheet Generator — Chrome Extension (Manifest V3)**

## 概要

eBay輸出者向けのChrome拡張機能です。サイドパネルを使い、商品カテゴリ別のガイドウィザードでHSコード（6桁）および米国HTSUS番号（10桁）の候補を特定し、通関ワークシートをA4でPDF出力できます。

**完全オフライン動作・AIなし・外部API不要**

---

## 免責事項（重要）

このツールが提示するコードはガイドウィザードによる**候補**です。  
最終的な分類・申告の責任は**輸出者ご本人**にあります。  
不明な場合は通関士または米国税関（CBP）にご確認ください。

---

## 対応カテゴリ（ガイドウィザード）

| カテゴリ | 主なHSチャプター |
|---------|----------------|
| おもちゃ・フィギュア・ぬいぐるみ | Ch.95 |
| カード類（トレカ・プレイングカード） | Ch.49, Ch.95 |
| テレビゲーム・ゲーム機・アクセサリー | Ch.95, Ch.85 |
| 衣類（上着・ズボン・Tシャツ等） | Ch.61, Ch.62 |
| 靴・スニーカー・サンダル | Ch.64 |
| バッグ・財布・革小物 | Ch.42 |
| 時計（腕時計・懐中時計） | Ch.91 |
| ジュエリー・アクセサリー | Ch.71 |
| 書籍・印刷物・ポスター | Ch.49 |
| 陶磁器・食器 | Ch.69 |
| 家電・電子部品 | Ch.85, Ch.84 |
| プラスチック製品 | Ch.39 |

---

## Chromeへのロード手順（開発者モード）

1. Chromeブラウザで `chrome://extensions/` を開く
2. 右上の「デベロッパーモード」をオンにする
3. 「パッケージ化されていない拡張機能を読み込む」をクリック
4. `HSCodeWorksheet_Extension` フォルダを選択
5. ツールバーのアイコンをクリックするとサイドパネルが開きます

---

## HTSデータの更新方法

### 現在のデータについて
- ファイル: `data/hts_full.json`
- 収録チャプター: Ch.39, Ch.42, Ch.49, Ch.61, Ch.62, Ch.64, Ch.69, Ch.71, Ch.84, Ch.85, Ch.91, Ch.95
- レコード数: 約10,000件
- データソース: USITC HTSUS API (https://hts.usitc.gov/)
- 取得日: 2026-06-06

### 更新コマンド（Bash）

```bash
# 特定チャプターを再取得（例：Ch.95）
curl -s "https://hts.usitc.gov/reststop/exportList?from=9500&to=9599&format=JSON&styles=true" \
  > data/hts_ch95_new.json

# または全チャプターを一括取得してmerge
# (check.js などで結合スクリプトを作成してください)
```

### フォールバック
`data/hts_full.json` が見つからない場合、`data/hts_seed.json` を使用します（現在は未作成。hts_full.jsonで代替）。

---

## ファイル構成

```
HSCodeWorksheet_Extension/
├── manifest.json          # MV3マニフェスト
├── background.js          # サービスワーカー（サイドパネル起動）
├── panel.html             # メインUI
├── panel.css              # スタイル
├── panel.js               # ウィザード・検索・確認ロジック
├── print.html             # 印刷専用ページ
├── print.js               # 印刷描画ロジック
├── data/
│   ├── flows.json         # 分類ウィザードツリー（データ駆動）
│   └── hts_full.json      # USITC HTSUSデータ（~10,000レコード）
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## flows.json の仕様

カテゴリ追加はJSONのみ編集すればOKです（JS不要）。

```json
{
  "categories": [ { "id": "...", "label": "...", "chapter": "95", "start": "node_id" } ],
  "nodes": {
    "node_id": { "question": "質問文", "answers": [ {"label": "選択肢", "next": "次ノード"} ] },
    "leaf_node": { "question": "...", "answers": [ {"label": "...", "leaf": "葉キー"} ] }
  },
  "leaves": {
    "9503000090": { "htsus": "9503.00.00.90", "hs6": "950300", "desc": "...", "duty": "Free", "title_template": "..." }
  }
}
```

---

---

## CPSC eFiling 対応機能（v1.1.0）

CPSC（米国消費者製品安全委員会）の電子申告（eFiling）対象品かどうかを、HTSUSコード確定後に自動でチェックする機能です。

### 機能A: 600コードリスト照合アラート
分類結果画面で CPSC eFiling 対象リスト（590コード／23カテゴリ）と照合し、3段階でアラートを表示します。
- **赤**: 対象リストのコードに完全一致（CPC/GCC が必要）
- **黄**: コードは不一致だが同じHTS章に対象品あり（要確認）
- **灰**: リストに一致しなかった（リストは全網羅ではないため念のため確認）

### 機能B: CPSC判定サブウィザード
「CPSCの対象か詳しく調べる ▶」ボタンで起動。対象年齢・衣類か・商品の特徴を聞き、CPC（児童製品証明書）またはGCC（一般適合証明書）の必要性と参考規制を表示します。

### 機能C: Regulatory Robotガイド
CPSC公式ツール（[Regulatory Robot](https://business.cpsc.gov/robot/)）での最終確認方法を案内します。ウィザードの回答をプリフィルして手順をガイドします。

### 設計原則
- **オフライン維持**: 外部通信ゼロ。`manifest.json` の permissions に host_permissions を追加していません
- **AIなし・APIキーなし**: 全判定はローカルデータ（`data/cpsc_efiling_hts.json`）で完結
- **断定しない**: 判定は「対象 / 対象の可能性あり / 要確認」のみ。「対象外」「安全」等の断定表現は使用しません
- データソース: CPSC Guidance and HTS List V5（2026年4月）、590コード収録

---

## 動作要件

- Google Chrome（Manifest V3対応バージョン）
- インターネット不要（完全オフライン動作）
- AIなし・外部APIなし
