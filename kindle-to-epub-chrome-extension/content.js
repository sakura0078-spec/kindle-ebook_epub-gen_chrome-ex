// content.js - Kindle Viewer 自動制御 & データ抽出 & スキャン領域検知
(() => {
  let overlayElement = null;
  let coverOverlayElement = null;

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
        sendResponse(getActualCropArea(req.config, req.isCapture));
        break;
      case 'HIDE_OVERLAY_FOR_CAPTURE':
        if (overlayElement) {
          overlayElement.style.visibility = 'hidden';
        }
        sendResponse({ success: true });
        break;
      case 'RESTORE_OVERLAY':
        if (overlayElement) {
          overlayElement.style.visibility = 'visible';
        }
        sendResponse({ success: true });
        break;
      case 'TOGGLE_CROP_OVERLAY':
        if (window === window.top) {
          toggleCropOverlay(req.show, req.config);
        }
        sendResponse({ success: true });
        break;
      case 'TOGGLE_COVER_OVERLAY':
        if (window === window.top) {
          toggleCoverOverlay(req.show);
        }
        sendResponse({ success: true });
        break;
      case 'DETECT_COVER_CROP_AREA':
        sendResponse(getActualCoverCropArea(req.isCapture));
        break;
      case 'HIDE_COVER_OVERLAY_FOR_CAPTURE':
        if (coverOverlayElement) {
          coverOverlayElement.style.visibility = 'hidden';
        }
        sendResponse({ success: true });
        break;
      case 'RESTORE_COVER_OVERLAY':
        if (coverOverlayElement) {
          coverOverlayElement.style.visibility = 'visible';
        }
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

  // 機種別比率キャプチャ枠の状態管理
  let currentFrameConfig = {
    preset: '20:9',
    scale: 85,
    centerOffset: { x: 0, y: 0 },
    freeRect: null // 自由変形モード用の矩形 { top, left, width, height }
  };

  function parseRatio(preset) {
    if (preset === '19.5:9') return 19.5 / 9; // 約 2.1667
    if (preset === '16:9') return 16 / 9;     // 約 1.7778
    return 20 / 9; // A302ZT / 20:9 (約 2.2222)
  }

  function calculateRatioFrame(config, isCapture = false) {
    const cfg = config || currentFrameConfig;

    // 自由変形モード（雑誌・固定レイアウト用）
    if (cfg.preset === 'free') {
      let top, left, width, height;
      if (cfg.freeRect) {
        top = cfg.freeRect.top;
        left = cfg.freeRect.left;
        width = cfg.freeRect.width;
        height = cfg.freeRect.height;
      } else {
        const defHeight = Math.min(window.innerHeight - 60, Math.round(window.innerHeight * 0.85));
        const defWidth = Math.min(window.innerWidth - 60, Math.round(defHeight * 0.7));
        top = Math.round((window.innerHeight - defHeight) / 2);
        left = Math.round((window.innerWidth - defWidth) / 2);
        width = defWidth;
        height = defHeight;
        cfg.freeRect = { top, left, width, height };
      }

      if (isCapture) {
        const inset = 3;
        top += inset;
        left += inset;
        width = Math.max(10, width - inset * 2);
        height = Math.max(10, height - inset * 2);
      }

      return {
        top: Math.round(top),
        left: Math.round(left),
        width: Math.round(width),
        height: Math.round(height),
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1
      };
    }

    const ratioHtoW = parseRatio(cfg.preset); // height / width
    const scale = (cfg.scale || 85) / 100;

    // 基本高さをウィンドウ高（マージン最小限）とし、scale(30%〜150%)を適用
    const baseHeight = Math.max(200, window.innerHeight - 40);
    const targetHeight = Math.max(100, Math.round(baseHeight * scale));
    const targetWidth = Math.max(50, Math.round(targetHeight / ratioHtoW));

    const baseTop = (window.innerHeight - targetHeight) / 2;
    const baseLeft = (window.innerWidth - targetWidth) / 2;

    let top = baseTop + (cfg.centerOffset?.y || 0);
    let left = baseLeft + (cfg.centerOffset?.x || 0);
    let width = targetWidth;
    let height = targetHeight;

    // キャプチャ時：枠線（3px）の内側を切り抜く安全インセット
    if (isCapture) {
      const inset = 3;
      top += inset;
      left += inset;
      width = Math.max(10, width - inset * 2);
      height = Math.max(10, height - inset * 2);
    }

    return {
      top: Math.round(top),
      left: Math.round(left),
      width: Math.round(width),
      height: Math.round(height),
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    };
  }

  // 画面上に表示されているプレビュー枠(overlayElement)の実測座標を直接取得する関数
  function getActualCropArea(config, isCapture = false) {
    if (overlayElement && document.body.contains(overlayElement)) {
      const rect = overlayElement.getBoundingClientRect();
      let top = rect.top;
      let left = rect.left;
      let width = rect.width;
      let height = rect.height;

      // キャプチャ時：枠線（3px）の内側を切り抜く安全インセット
      if (isCapture) {
        const inset = 3;
        top += inset;
        left += inset;
        width = Math.max(10, width - inset * 2);
        height = Math.max(10, height - inset * 2);
      }

      return {
        top: Math.round(top),
        left: Math.round(left),
        width: Math.round(width),
        height: Math.round(height),
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1
      };
    }
    // 枠が非表示または未生成の場合は、設定から直接算出
    return calculateRatioFrame(config, isCapture);
  }

  function toggleCropOverlay(show, config) {
    if (config) {
      if (config.preset) currentFrameConfig.preset = config.preset;
      if (typeof config.scale === 'number') currentFrameConfig.scale = config.scale;
      if (config.resetPosition) {
        currentFrameConfig.centerOffset = { x: 0, y: 0 };
        currentFrameConfig.freeRect = null;
      }
    }

    if (!show) {
      if (overlayElement) {
        overlayElement.remove();
        overlayElement = null;
      }
      return;
    }

    const area = calculateRatioFrame(currentFrameConfig);
    if (!overlayElement) {
      overlayElement = document.createElement('div');
      overlayElement.id = 'kindle-epub-crop-overlay';
      overlayElement.style.position = 'fixed';
      overlayElement.style.pointerEvents = 'auto';
      overlayElement.style.cursor = 'move';
      overlayElement.style.border = '3px solid #10b981';
      overlayElement.style.backgroundColor = 'rgba(16, 185, 129, 0.04)';
      overlayElement.style.boxShadow = '0 0 0 9999px rgba(0, 0, 0, 0.45)';
      overlayElement.style.zIndex = '999999';
      overlayElement.style.userSelect = 'none';
      overlayElement.style.boxSizing = 'border-box';
      overlayElement.style.transition = 'box-shadow 0.2s ease';

      // 枠ラベル
      const label = document.createElement('div');
      label.id = 'crop-overlay-label';
      label.style.position = 'absolute';
      label.style.top = '-26px';
      label.style.left = '0';
      label.style.background = '#10b981';
      label.style.color = '#fff';
      label.style.fontSize = '12px';
      label.style.padding = '2px 10px';
      label.style.borderRadius = '4px 4px 0 0';
      label.style.fontWeight = 'bold';
      label.style.pointerEvents = 'none';
      overlayElement.appendChild(label);

      // 4隅のリサイズハンドルを作成
      const handles = ['nw', 'ne', 'se', 'sw'];
      handles.forEach(pos => {
        const handle = document.createElement('div');
        handle.className = `crop-resize-handle crop-handle-${pos}`;
        handle.dataset.handle = pos;
        handle.style.position = 'absolute';
        handle.style.width = '14px';
        handle.style.height = '14px';
        handle.style.background = '#10b981';
        handle.style.border = '2px solid #ffffff';
        handle.style.borderRadius = '50%';
        handle.style.zIndex = '1000000';
        handle.style.boxShadow = '0 1px 4px rgba(0,0,0,0.3)';

        if (pos.includes('n')) handle.style.top = '-7px';
        if (pos.includes('s')) handle.style.bottom = '-7px';
        if (pos.includes('w')) handle.style.left = '-7px';
        if (pos.includes('e')) handle.style.right = '-7px';

        handle.style.cursor = (pos === 'nw' || pos === 'se') ? 'nwse-resize' : 'nesw-resize';
        overlayElement.appendChild(handle);
      });

      // 操作管理 (ドラッグ移動 / リサイズ)
      let actionMode = null; // 'move' または 'resize'
      let activeHandle = null;
      let startX = 0, startY = 0;
      let initOffsetX = 0, initOffsetY = 0;
      let initScale = 85;
      let initRect = null;

      overlayElement.addEventListener('mousedown', (e) => {
        const handleTarget = e.target.closest('.crop-resize-handle');
        initRect = overlayElement.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;

        if (handleTarget) {
          actionMode = 'resize';
          activeHandle = handleTarget.dataset.handle;
          initScale = currentFrameConfig.scale || 85;
          e.stopPropagation();
          e.preventDefault();
        } else {
          actionMode = 'move';
          initOffsetX = currentFrameConfig.centerOffset.x;
          initOffsetY = currentFrameConfig.centerOffset.y;
          overlayElement.style.borderColor = '#059669';
          e.preventDefault();
        }
      });

      window.addEventListener('mousemove', (e) => {
        if (!actionMode || !overlayElement || !initRect) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        // 自由変形モード（比率固定なし）の場合
        if (currentFrameConfig.preset === 'free') {
          if (actionMode === 'move') {
            const newLeft = Math.round(initRect.left + dx);
            const newTop = Math.round(initRect.top + dy);
            overlayElement.style.left = `${newLeft}px`;
            overlayElement.style.top = `${newTop}px`;
            currentFrameConfig.freeRect = {
              left: newLeft,
              top: newTop,
              width: Math.round(initRect.width),
              height: Math.round(initRect.height)
            };
          } else if (actionMode === 'resize') {
            let newLeft = initRect.left;
            let newTop = initRect.top;
            let newWidth = initRect.width;
            let newHeight = initRect.height;

            if (activeHandle.includes('e')) {
              newWidth = Math.max(50, initRect.width + dx);
            }
            if (activeHandle.includes('w')) {
              const w = initRect.width - dx;
              if (w >= 50) {
                newLeft = initRect.left + dx;
                newWidth = w;
              }
            }
            if (activeHandle.includes('s')) {
              newHeight = Math.max(50, initRect.height + dy);
            }
            if (activeHandle.includes('n')) {
              const h = initRect.height - dy;
              if (h >= 50) {
                newTop = initRect.top + dy;
                newHeight = h;
              }
            }

            overlayElement.style.left = `${Math.round(newLeft)}px`;
            overlayElement.style.top = `${Math.round(newTop)}px`;
            overlayElement.style.width = `${Math.round(newWidth)}px`;
            overlayElement.style.height = `${Math.round(newHeight)}px`;

            currentFrameConfig.freeRect = {
              left: Math.round(newLeft),
              top: Math.round(newTop),
              width: Math.round(newWidth),
              height: Math.round(newHeight)
            };
          }
          return;
        }

        // 比率固定モードの場合
        if (actionMode === 'move') {
          currentFrameConfig.centerOffset.x = initOffsetX + dx;
          currentFrameConfig.centerOffset.y = initOffsetY + dy;

          const updatedArea = calculateRatioFrame(currentFrameConfig);
          overlayElement.style.top = updatedArea.top + 'px';
          overlayElement.style.left = updatedArea.left + 'px';
        } else if (actionMode === 'resize') {
          const factor = activeHandle.includes('s') ? dy : -dy;
          const deltaScale = (factor / (window.innerHeight * 0.9)) * 100 * 1.5;
          const newScale = Math.max(30, Math.min(150, Math.round(initScale + deltaScale)));

          if (newScale !== currentFrameConfig.scale) {
            currentFrameConfig.scale = newScale;
            const updatedArea = calculateRatioFrame(currentFrameConfig);
            overlayElement.style.top = updatedArea.top + 'px';
            overlayElement.style.left = updatedArea.left + 'px';
            overlayElement.style.width = updatedArea.width + 'px';
            overlayElement.style.height = updatedArea.height + 'px';

            chrome.runtime.sendMessage({
              type: 'FRAME_SCALE_CHANGED',
              scale: newScale
            }).catch(() => {});
          }
        }
      });

      window.addEventListener('mouseup', () => {
        if (actionMode && overlayElement) {
          actionMode = null;
          activeHandle = null;
          initRect = null;
          overlayElement.style.borderColor = '#10b981';
        }
      });

      document.body.appendChild(overlayElement);
    }

    const labelElem = overlayElement.querySelector('#crop-overlay-label');
    if (labelElem) {
      if (currentFrameConfig.preset === 'free') {
        labelElem.textContent = '【本文枠: 自由変形】※四隅で自由リサイズ・面で位置移動';
      } else {
        const presetName = currentFrameConfig.preset === '20:9' ? 'A302ZT (20:9)' : currentFrameConfig.preset;
        labelElem.textContent = `【本文枠: ${presetName} (${currentFrameConfig.scale}%)】※四隅でサイズ伸縮・面で位置移動`;
      }
    }

    overlayElement.style.top = area.top + 'px';
    overlayElement.style.left = area.left + 'px';
    overlayElement.style.width = area.width + 'px';
    overlayElement.style.height = area.height + 'px';
  }

  // 表紙専用枠（自由ドラッグ・比率固定なし）の実測座標取得
  function getActualCoverCropArea(isCapture = false) {
    if (coverOverlayElement && document.body.contains(coverOverlayElement)) {
      const rect = coverOverlayElement.getBoundingClientRect();
      let top = rect.top;
      let left = rect.left;
      let width = rect.width;
      let height = rect.height;

      if (isCapture) {
        const inset = 3;
        top += inset;
        left += inset;
        width = Math.max(10, width - inset * 2);
        height = Math.max(10, height - inset * 2);
      }

      return {
        top: Math.round(top),
        left: Math.round(left),
        width: Math.round(width),
        height: Math.round(height),
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1
      };
    }
    // 表紙枠が存在しない場合のデフォルト中央領域
    const defHeight = Math.round(window.innerHeight * 0.8);
    const defWidth = Math.round(defHeight * 0.7);
    return {
      top: Math.round((window.innerHeight - defHeight) / 2),
      left: Math.round((window.innerWidth - defWidth) / 2),
      width: defWidth,
      height: defHeight,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    };
  }

  // 表紙専用枠の表示/非表示（自由変形・ドラッグ）
  function toggleCoverOverlay(show) {
    if (!show) {
      if (coverOverlayElement) {
        coverOverlayElement.remove();
        coverOverlayElement = null;
      }
      return;
    }

    if (!coverOverlayElement) {
      coverOverlayElement = document.createElement('div');
      coverOverlayElement.id = 'kindle-epub-cover-overlay';
      coverOverlayElement.style.position = 'fixed';
      coverOverlayElement.style.pointerEvents = 'auto';
      coverOverlayElement.style.cursor = 'move';
      coverOverlayElement.style.border = '3px solid #2563eb';
      coverOverlayElement.style.backgroundColor = 'rgba(37, 99, 235, 0.05)';
      coverOverlayElement.style.boxShadow = '0 0 0 9999px rgba(0, 0, 0, 0.5)';
      coverOverlayElement.style.zIndex = '999999';
      coverOverlayElement.style.userSelect = 'none';
      coverOverlayElement.style.boxSizing = 'border-box';

      // 表紙枠ラベル
      const label = document.createElement('div');
      label.id = 'cover-overlay-label';
      label.style.position = 'absolute';
      label.style.top = '-26px';
      label.style.left = '0';
      label.style.background = '#2563eb';
      label.style.color = '#fff';
      label.style.fontSize = '12px';
      label.style.padding = '2px 10px';
      label.style.borderRadius = '4px 4px 0 0';
      label.style.fontWeight = 'bold';
      label.style.pointerEvents = 'none';
      label.textContent = '【表紙専用枠（自由変形）】四隅で自由リサイズ・面で位置移動';
      coverOverlayElement.appendChild(label);

      // 4隅の自由リサイズハンドル
      const handles = ['nw', 'ne', 'se', 'sw'];
      handles.forEach(pos => {
        const handle = document.createElement('div');
        handle.className = `cover-resize-handle cover-handle-${pos}`;
        handle.dataset.handle = pos;
        handle.style.position = 'absolute';
        handle.style.width = '14px';
        handle.style.height = '14px';
        handle.style.background = '#2563eb';
        handle.style.border = '2px solid #ffffff';
        handle.style.borderRadius = '50%';
        handle.style.zIndex = '1000000';
        handle.style.boxShadow = '0 1px 4px rgba(0,0,0,0.3)';

        if (pos.includes('n')) handle.style.top = '-7px';
        if (pos.includes('s')) handle.style.bottom = '-7px';
        if (pos.includes('w')) handle.style.left = '-7px';
        if (pos.includes('e')) handle.style.right = '-7px';

        handle.style.cursor = (pos === 'nw' || pos === 'se') ? 'nwse-resize' : 'nesw-resize';
        coverOverlayElement.appendChild(handle);
      });

      // 操作管理 (自由リサイズ & 移動)
      let actionMode = null;
      let activeHandle = null;
      let startX = 0, startY = 0;
      let initRect = null;

      coverOverlayElement.addEventListener('mousedown', (e) => {
        const handleTarget = e.target.closest('.cover-resize-handle');
        initRect = coverOverlayElement.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;

        if (handleTarget) {
          actionMode = 'resize';
          activeHandle = handleTarget.dataset.handle;
          e.stopPropagation();
          e.preventDefault();
        } else {
          actionMode = 'move';
          coverOverlayElement.style.borderColor = '#1d4ed8';
          e.preventDefault();
        }
      });

      window.addEventListener('mousemove', (e) => {
        if (!actionMode || !coverOverlayElement || !initRect) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (actionMode === 'move') {
          coverOverlayElement.style.left = `${Math.round(initRect.left + dx)}px`;
          coverOverlayElement.style.top = `${Math.round(initRect.top + dy)}px`;
        } else if (actionMode === 'resize') {
          let newLeft = initRect.left;
          let newTop = initRect.top;
          let newWidth = initRect.width;
          let newHeight = initRect.height;

          if (activeHandle.includes('e')) {
            newWidth = Math.max(50, initRect.width + dx);
          }
          if (activeHandle.includes('w')) {
            const w = initRect.width - dx;
            if (w >= 50) {
              newLeft = initRect.left + dx;
              newWidth = w;
            }
          }
          if (activeHandle.includes('s')) {
            newHeight = Math.max(50, initRect.height + dy);
          }
          if (activeHandle.includes('n')) {
            const h = initRect.height - dy;
            if (h >= 50) {
              newTop = initRect.top + dy;
              newHeight = h;
            }
          }

          coverOverlayElement.style.left = `${Math.round(newLeft)}px`;
          coverOverlayElement.style.top = `${Math.round(newTop)}px`;
          coverOverlayElement.style.width = `${Math.round(newWidth)}px`;
          coverOverlayElement.style.height = `${Math.round(newHeight)}px`;
        }
      });

      window.addEventListener('mouseup', () => {
        if (actionMode && coverOverlayElement) {
          actionMode = null;
          activeHandle = null;
          initRect = null;
          coverOverlayElement.style.borderColor = '#2563eb';
        }
      });

      // 初期サイズ・初期位置の配置
      const defHeight = Math.min(window.innerHeight - 80, Math.round(window.innerHeight * 0.8));
      const defWidth = Math.min(window.innerWidth - 80, Math.round(defHeight * 0.7));
      const defTop = Math.round((window.innerHeight - defHeight) / 2);
      const defLeft = Math.round((window.innerWidth - defWidth) / 2);

      coverOverlayElement.style.top = `${defTop}px`;
      coverOverlayElement.style.left = `${defLeft}px`;
      coverOverlayElement.style.width = `${defWidth}px`;
      coverOverlayElement.style.height = `${defHeight}px`;

      document.body.appendChild(coverOverlayElement);
    }
  }

  function extractBookInfo() {
    let title = '';
    let author = '';

    // 1. 実機Kindle Cloud Readerヘッダー要素から探索（最優先）
    const titleSelectors = [
      'ion-title.top-chrome__book-title',
      'ion-title.top-chrome__book-title span',
      '.top-chrome__book-title',
      'ion-title',
      '[class*="book-title"]',
      '#header-title',
      '[data-testid="header-title"]',
      '#title'
    ];
    for (const sel of titleSelectors) {
      const elem = findElementAcrossFrames(sel);
      if (elem && elem.textContent) {
        const text = elem.textContent.trim();
        if (text && !/^kindle$/i.test(text)) {
          title = text;
          break;
        }
      }
    }

    // 2. ページ内スクリプトタグ (JSON / kfw / window変数) からの探索
    if (!title || !author) {
      try {
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const content = script.textContent || '';
          if (content.includes('title') && (content.includes('asin') || content.includes('author') || content.includes('book'))) {
            // "title":"..." パターン
            if (!title) {
              const tm = content.match(/["']title["']\s*:\s*["']([^"']+)["']/i);
              if (tm && tm[1] && !/^kindle$/i.test(tm[1])) {
                title = tm[1];
              }
            }
            if (!author) {
              const am = content.match(/["'](?:author|authors|creator)["']\s*:\s*["']([^"']+)["']/i);
              if (am && am[1]) {
                author = am[1];
              }
            }
          }
        }
      } catch (e) {}
    }

    // 3. 著者名DOM要素の探索
    if (!author) {
      const authorSelectors = [
        'ion-title.top-chrome__book-author',
        '.top-chrome__book-author',
        '[class*="book-author"]',
        '[class*="author-name"]',
        '#header-author',
        '[data-testid="header-author"]',
        '#author'
      ];
      for (const sel of authorSelectors) {
        const elem = findElementAcrossFrames(sel);
        if (elem && elem.textContent) {
          const text = elem.textContent.trim();
          if (text) {
            author = text;
            break;
          }
        }
      }
    }

    // 4. document.title から探索（単なる "Kindle" 以外の場合）
    if (!title && document.title) {
      const docTitle = document.title.replace(/\s*-?\s*Kindle.*$/i, '').trim();
      if (docTitle && !/^kindle$/i.test(docTitle)) {
        title = docTitle;
      }
    }

    // 5. URLパラメータ (asin) からフォールバック
    if (!title) {
      const urlParams = new URLSearchParams(window.location.search);
      const asin = urlParams.get('asin');
      if (asin) {
        title = `Kindle_Book_${asin}`;
      }
    }

    return {
      title: title || 'Kindle_Book',
      author: author || '不明な著者',
      isDefaultTitle: !title || title === 'Kindle_Book'
    };
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
    // 縦書き(RTL): キー操作は ArrowLeft、横書き(LTR): ArrowRight
    const key = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const keyCode = direction === 'rtl' ? 37 : 39;

    dispatchKeyEventAcrossFrames(key, keyCode);

    // Amazon Kindle Web Reader では、ボタン「次のページ」は常に button#kr-chevron-right (aria-label="次のページ")
    const nextBtn = findElementAcrossFrames('button#kr-chevron-right, button[aria-label="次のページ"]');
    if (nextBtn) {
      try { nextBtn.click(); } catch(e) {}
    }

    // 意図せずサイドバーやダイアログが開いていないかチェックし、開いている場合は閉じる
    dismissOverlays();

    return { success: true };
  }

  async function turnPrevPage(direction = 'rtl') {
    const key = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const keyCode = direction === 'rtl' ? 39 : 37;

    dispatchKeyEventAcrossFrames(key, keyCode);

    // Amazon Kindle Web Reader では、ボタン「前のページ」は常に button#kr-chevron-left (aria-label="前のページ")
    const prevBtn = findElementAcrossFrames('button#kr-chevron-left, button[aria-label="前のページ"]');
    if (prevBtn) {
      try { prevBtn.click(); } catch(e) {}
    }

    dismissOverlays();

    return { success: true };
  }

  function dismissOverlays() {
    // 目次サイドバー（ion-menu等）やダイアログ、オーバーレイが開いている場合は閉じる
    const sideMenu = findElementAcrossFrames('ion-menu.show-menu, .side-menu--open, .side-navigation--open, [role="navigation"][aria-hidden="false"], ion-backdrop');
    if (sideMenu) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      // 画面中央をクリックしてメニューを閉じるフォールバック
      const centerBackdrop = findElementAcrossFrames('ion-backdrop, .backdrop');
      if (centerBackdrop) {
        try { centerBackdrop.click(); } catch(e) {}
      }
    }
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
