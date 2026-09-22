// content.js - Kindle Viewer 自動制御 & データ抽出 & スキャン領域検知
(() => {
  let overlayElement = null;

  // メッセージ受信用
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    switch (req.action) {
      case 'GET_BOOK_INFO':
        sendResponse(extractBookInfo());
        break;
      case 'CHECK_VIEW_MODE':
        sendResponse(checkSinglePageView());
        break;
      case 'DETECT_CROP_AREA':
        sendResponse(detectBookArea(req.margins));
        break;
      case 'TOGGLE_CROP_OVERLAY':
        toggleCropOverlay(req.show, req.margins);
        sendResponse({ success: true });
        break;
      case 'NEXT_PAGE':
        turnNextPage(req.direction).then(res => sendResponse(res));
        return true;
      case 'PREV_PAGE':
        turnPrevPage(req.direction).then(res => sendResponse(res));
        return true;
      case 'GET_PAGE_STATUS':
        sendResponse(getPageStatus());
        break;
      case 'CHECK_RENDER_COMPLETE':
        checkRenderComplete().then(res => sendResponse(res));
        return true;
      default:
        sendResponse({ error: 'Unknown action' });
    }
  });

  // Escキーによる緊急停止リスナー
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      chrome.runtime.sendMessage({ type: 'EMERGENCY_STOP' });
    }
  });

  // ドキュメント（iframe含む）内の要素を再帰的に検索するヘルパー
  function findElementAcrossFrames(selector) {
    let elem = document.querySelector(selector);
    if (elem) return elem;

    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) {
          elem = doc.querySelector(selector);
          if (elem) return elem;
        }
      } catch (e) {
        // クロスオリジンiframeはスキップ
      }
    }
    return null;
  }

  function detectBookArea(margins = { top: 0, bottom: 0, left: 0, right: 0 }) {
    // Kindle ViewerのメインCanvasまたは描画コンテナを自動検索
    const target = findElementAcrossFrames('canvas#kindleReader_canvas, canvas, #kindleReader_container, .book-page, main');
    let rect = { top: 60, left: 100, width: window.innerWidth - 200, height: window.innerHeight - 120 };

    if (target) {
      let b = target.getBoundingClientRect();
      // iframe内の場合は親ウィンドウのオフセットを加算
      if (target.ownerDocument !== document) {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          if (iframe.contentDocument === target.ownerDocument) {
            const ifr = iframe.getBoundingClientRect();
            b = {
              top: b.top + ifr.top,
              left: b.left + ifr.left,
              width: b.width,
              height: b.height
            };
            break;
          }
        }
      }

      if (b.width > 150 && b.height > 150) {
        rect = {
          top: Math.max(0, b.top),
          left: Math.max(0, b.left),
          width: b.width,
          height: b.height
        };
      }
    }

    // マージン微調整を加味
    const adjusted = {
      top: Math.max(0, rect.top + (margins.top || 0)),
      left: Math.max(0, rect.left + (margins.left || 0)),
      width: Math.max(50, rect.width - (margins.left || 0) - (margins.right || 0)),
      height: Math.max(50, rect.height - (margins.top || 0) - (margins.bottom || 0)),
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    };

    return adjusted;
  }

  function toggleCropOverlay(show, margins) {
    if (!show) {
      if (overlayElement) {
        overlayElement.remove();
        overlayElement = null;
      }
      return;
    }

    const area = detectBookArea(margins);
    if (!overlayElement) {
      overlayElement = document.createElement('div');
      overlayElement.id = 'kindle-epub-crop-overlay';
      overlayElement.style.position = 'fixed';
      overlayElement.style.pointerEvents = 'none';
      overlayElement.style.border = '3px dashed #10b981';
      overlayElement.style.backgroundColor = 'rgba(16, 185, 129, 0.08)';
      overlayElement.style.boxShadow = '0 0 0 9999px rgba(0, 0, 0, 0.35)';
      overlayElement.style.zIndex = '999999';
      overlayElement.style.transition = 'all 0.15s ease-out';
      
      const label = document.createElement('div');
      label.textContent = '【スキャン対象領域（自動検知）】';
      label.style.position = 'absolute';
      label.style.top = '-26px';
      label.style.left = '0';
      label.style.background = '#10b981';
      label.style.color = '#fff';
      label.style.fontSize = '12px';
      label.style.padding = '2px 8px';
      label.style.borderRadius = '4px 4px 0 0';
      label.style.fontWeight = 'bold';
      overlayElement.appendChild(label);

      document.body.appendChild(overlayElement);
    }

    overlayElement.style.top = area.top + 'px';
    overlayElement.style.left = area.left + 'px';
    overlayElement.style.width = area.width + 'px';
    overlayElement.style.height = area.height + 'px';
  }

  function extractBookInfo() {
    let title = document.title.replace(/\s*-?\s*Kindle.*$/i, '').trim();
    let author = '不明な著者';

    const titleElem = findElementAcrossFrames('#header-title, [data-testid="header-title"], .book-title, #title');
    if (titleElem && titleElem.textContent) {
      title = titleElem.textContent.trim();
    }

    const authorElem = findElementAcrossFrames('#header-author, [data-testid="header-author"], .book-author, #author');
    if (authorElem && authorElem.textContent) {
      author = authorElem.textContent.trim();
    }

    return { title: title || 'Kindle_Book', author };
  }

  function checkSinglePageView() {
    const doublePages = document.querySelectorAll('.two-page, [data-display-mode="two-page"], #kindleReader_container_twoPage');
    return {
      isSinglePage: doublePages.length === 0,
      note: '高画質キャプチャのため単一ページ（1ページ）表示を推奨します'
    };
  }

  function getPageStatus() {
    // ページ番号やプログレス情報を取得して最終判定に活用
    let progressPct = 0;
    let isLastPage = false;
    let statusText = '';

    const pageElem = findElementAcrossFrames('#pageText, .progress-text, [aria-label*="進捗"], .footer-progress');
    if (pageElem && pageElem.textContent) {
      statusText = pageElem.textContent.trim();
      const match = statusText.match(/(\d+)%/);
      if (match) progressPct = parseInt(match[1], 10);
      if (progressPct >= 100) isLastPage = true;
      
      const ratioMatch = statusText.match(/(\d+)\s*\/\s*(\d+)/);
      if (ratioMatch) {
        const cur = parseInt(ratioMatch[1], 10);
        const tot = parseInt(ratioMatch[2], 10);
        if (tot > 0 && cur >= tot) isLastPage = true;
      }
    }

    const progressFill = findElementAcrossFrames('#progressFill, .progress-fill, .slider-progress');
    if (progressFill && progressFill.style.width) {
      const w = parseInt(progressFill.style.width, 10);
      if (w >= 100) isLastPage = true;
    }

    return { progressPct, isLastPage, statusText };
  }

  async function turnNextPage(direction = 'rtl') {
    const key = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const keyCode = direction === 'rtl' ? 37 : 39;

    dispatchKeyEventAcrossFrames(key, keyCode);

    // クリック対象があれば併用
    const nextBtnSelectors = direction === 'rtl' 
      ? '#btnLeft, .turn-left, .next-button, #kindleReader_button_next, [aria-label*="次"]'
      : '#btnRight, .turn-right, .next-button, #kindleReader_button_next, [aria-label*="次"]';
    const nextBtn = findElementAcrossFrames(nextBtnSelectors);
    if (nextBtn) {
      try { nextBtn.click(); } catch(e) {}
    }

    return { success: true };
  }

  async function turnPrevPage(direction = 'rtl') {
    const key = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const keyCode = direction === 'rtl' ? 39 : 37;

    dispatchKeyEventAcrossFrames(key, keyCode);

    const prevBtnSelectors = direction === 'rtl'
      ? '#btnRight, .turn-right, .prev-button, #kindleReader_button_prev, [aria-label*="前"]'
      : '#btnLeft, .turn-left, .prev-button, #kindleReader_button_prev, [aria-label*="前"]';
    const prevBtn = findElementAcrossFrames(prevBtnSelectors);
    if (prevBtn) {
      try { prevBtn.click(); } catch(e) {}
    }

    return { success: true };
  }

  function dispatchKeyEventAcrossFrames(key, keyCode) {
    const opts = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true };
    
    // トップウィンドウへ
    window.dispatchEvent(new KeyboardEvent('keydown', opts));
    window.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (document.activeElement) {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', opts));
      document.activeElement.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    // iframe内へも送出
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const win = iframe.contentWindow;
        if (win) {
          win.dispatchEvent(new KeyboardEvent('keydown', opts));
          win.dispatchEvent(new KeyboardEvent('keyup', opts));
        }
      } catch (e) {}
    }
  }

  function checkRenderComplete() {
    return new Promise(resolve => {
      let checks = 0;
      const interval = setInterval(() => {
        checks++;
        const spinner = findElementAcrossFrames('.spinner, .loading, [aria-busy="true"], #loadingSpinner');
        const isSpinnerVisible = spinner && window.getComputedStyle(spinner).display !== 'none';
        if (!isSpinnerVisible || checks >= 10) {
          clearInterval(interval);
          setTimeout(() => resolve({ completed: true }), 250);
        }
      }, 80);
    });
  }
})();
