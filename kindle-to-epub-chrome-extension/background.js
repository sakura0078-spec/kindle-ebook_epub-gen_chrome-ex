// background.js - Service Worker for Kindle to EPUB
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// サイドパネルやコンテンツスクリプトからのメッセージハンドラ
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_VISIBLE_TAB') {
    chrome.tabs.captureVisibleTab(message.windowId || null, { format: message.format || 'png', quality: message.quality || 90 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, dataUrl });
      }
    });
    return true; // 非同期レスポンス
  }

  if (message.type === 'SHOW_NOTIFICATION') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: message.title || 'Kindle to EPUB',
      message: message.message || '処理が完了しました',
      priority: 2
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SAVE_EPUB_FILE') {
    const filename = (message.subfolder ? message.subfolder.replace(/\/$/, '') + '/' : '') + message.filename;
    chrome.downloads.download({
      url: message.blobUrl,
      filename: filename,
      saveAs: false // プリセットフォルダへ自動保存（ダイアログなし）
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    return true;
  }
});
