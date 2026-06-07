'use strict';

/**
 * background.js (service worker)
 * ツールバーアイコンをクリックしたときサイドパネルを開く。
 */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(function (e) {
    console.error('sidePanel.setPanelBehavior error:', e);
  });
