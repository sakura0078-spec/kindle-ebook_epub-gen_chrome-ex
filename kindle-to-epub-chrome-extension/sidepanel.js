// sidepanel.js - サイドパネル制御 & スキャン制御
(() => {
  let isScanning = false;
  let isPaused = false;
  let currentPage = 0;
  let maxPages = null; // null = 自動検知で最終ページまで
  let startTime = null;
  let scanTimer = null;
  let timeoutTimer = null;
  let lastCapturedSample = null;
  let duplicateCount = 0;

  // DOM要素
  const metaTitle = document.getElementById('metaTitle');
  const metaAuthor = document.getElementById('metaAuthor');
  const settingMode = document.getElementById('settingMode');
  const settingFormat = document.getElementById('settingFormat');
  const settingQuality = document.getElementById('settingQuality');
  const qualityVal = document.getElementById('qualityVal');
  const settingDirection = document.getElementById('settingDirection');
  const settingMaxPages = document.getElementById('settingMaxPages');
  const autoInterval = document.getElementById('autoInterval');
  const manualIntervalWrap = document.getElementById('manualIntervalWrap');
  const fixedInterval = document.getElementById('fixedInterval');
  const progressBar = document.getElementById('progressBar');
  const pageCount = document.getElementById('pageCount');
  const timeRemaining = document.getElementById('timeRemaining');
  const thumbBox = document.getElementById('thumbBox');
  const statusMessage = document.getElementById('statusMessage');
  const warningAlert = document.getElementById('warningAlert');
  const btnStart = document.getElementById('btnStart');
  const btnPause = document.getElementById('btnPause');
  const btnResume = document.getElementById('btnResume');
  const btnRetryPage = document.getElementById('btnRetryPage');
  const btnAbort = document.getElementById('btnAbort');
  const btnCompleteNow = document.getElementById('btnCompleteNow');
  const subActions = document.getElementById('subActions');
  const chkShowOverlay = document.getElementById('chkShowOverlay');
  const settingRatioPreset = document.getElementById('settingRatioPreset');
  const frameScale = document.getElementById('frameScale');
  const frameScaleVal = document.getElementById('frameScaleVal');
  const btnResetFrame = document.getElementById('btnResetFrame');

  // IndexedDB初期化 (メモリクラッシュ防止)
  let db = null;
  const dbReq = indexedDB.open('KindleEpubDB', 1);
  dbReq.onupgradeneeded = (e) => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains('pages')) {
      d.createObjectStore('pages', { keyPath: 'pageNum' });
    }
  };
  dbReq.onsuccess = (e) => { db = e.target.result; };

  // イベントリスナー
  settingQuality.addEventListener('input', (e) => {
    qualityVal.textContent = e.target.value + '%';
  });

  autoInterval.addEventListener('change', (e) => {
    manualIntervalWrap.classList.toggle('hidden', e.target.checked);
  });

  frameScale.addEventListener('input', (e) => {
    frameScaleVal.textContent = e.target.value + '%';
    updateCropOverlay(false);
  });

  settingRatioPreset.addEventListener('change', () => {
    updateCropOverlay(true);
  });

  chkShowOverlay.addEventListener('change', () => {
    updateCropOverlay(false);
  });

  btnResetFrame.addEventListener('click', () => {
    updateCropOverlay(true);
  });

  function getFrameConfig(resetPosition = false) {
    return {
      preset: settingRatioPreset.value || '20:9',
      scale: parseInt(frameScale.value, 10) || 85,
      resetPosition
    };
  }

  function updateCropOverlay(resetPosition = false) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'TOGGLE_CROP_OVERLAY',
          show: chkShowOverlay.checked,
          config: getFrameConfig(resetPosition)
        }, () => { if (chrome.runtime.lastError) {} });
      }
    });
  }

  btnStart.addEventListener('click', startScan);
  btnPause.addEventListener('click', pauseScan);
  btnResume.addEventListener('click', resumeScan);
  btnAbort.addEventListener('click', abortScan);
  btnRetryPage.addEventListener('click', retryCurrentPage);
  btnCompleteNow.addEventListener('click', () => {
    if (currentPage > 0) completeScan();
  });

  // 初期メタデータ自動取得
  async function initBookMetadata() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { action: 'GET_BOOK_INFO' }, (res) => {
          if (!chrome.runtime.lastError && res && res.title) {
            metaTitle.value = res.title;
            metaAuthor.value = res.author || '';
          }
        });
      }
    } catch (e) {}
  }
  initBookMetadata();

  async function startScan() {
    // スキャン開始時にもメタデータを再確認（ページ遷移完了後に取得できる場合があるため）
    if (!metaTitle.value || metaTitle.value === 'Kindle_Book') {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
          const res = await new Promise(r => chrome.tabs.sendMessage(tab.id, { action: 'GET_BOOK_INFO' }, r));
          if (res && res.title) {
            metaTitle.value = res.title;
            if (res.author) metaAuthor.value = res.author;
          }
        }
      } catch(e) {}
    }

    isScanning = true;
    isPaused = false;
    currentPage = 0;
    duplicateCount = 0;
    lastCapturedSample = null;
    startTime = Date.now();

    const maxVal = parseInt(settingMaxPages.value, 10);
    maxPages = (!isNaN(maxVal) && maxVal > 0) ? maxVal : null;

    btnStart.classList.add('hidden');
    btnPause.classList.remove('hidden');
    subActions.classList.remove('hidden');
    statusMessage.textContent = 'スキャン開始中...';

    // 以前の一時データをクリア
    clearDB();

    loopNextStep();
  }

  async function loopNextStep() {
    if (!isScanning || isPaused) return;

    currentPage++;
    updateProgressUI();

    // タイムアウト監視 (12秒無反応で一時停止)
    clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => {
      pauseScan();
      warningAlert.textContent = 'ページの読み込みがタイムアウトしました。Kindle画面を確認し、再開ボタンを押してください。';
      warningAlert.classList.remove('hidden');
    }, 12000);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      pauseScan();
      statusMessage.textContent = 'Kindleタブが見つかりません';
      return;
    }

    const mode = settingMode.value;
    if (mode === 'fixed') {
      // 画面キャプチャ実行
      chrome.runtime.sendMessage({
        type: 'CAPTURE_VISIBLE_TAB',
        format: settingFormat.value === 'image/png' ? 'png' : 'jpeg',
        quality: parseInt(settingQuality.value, 10),
        windowId: tab.windowId
      }, async (res) => {
        if (!res || !res.success || !res.dataUrl) {
          console.error("[Sidepanel] Capture failed:", res?.error);
          pauseScan();
          warningAlert.textContent = '画面キャプチャに失敗しました: ' + (res?.error || '不明なエラー');
          warningAlert.classList.remove('hidden');
          return;
        }

        clearTimeout(timeoutTimer);
        warningAlert.classList.add('hidden');

        // 指定機種比率のキャプチャ枠に合わせてクロップ
        chrome.tabs.sendMessage(tab.id, { action: 'DETECT_CROP_AREA', config: getFrameConfig(false) }, async (cropArea) => {
          const finalDataUrl = await cropImage(res.dataUrl, cropArea, settingFormat.value, parseInt(settingQuality.value, 10));

          // 画面変化の重複検知（めくっても変化しない = 最終ページ到達の判定）
          const sample = finalDataUrl.substring(finalDataUrl.length - 200);
          if (lastCapturedSample && sample === lastCapturedSample) {
            duplicateCount++;
            if (duplicateCount >= 2) {
              statusMessage.textContent = '最終ページを検知しました。EPUB生成を開始します...';
              completeScan();
              return;
            }
          } else {
            duplicateCount = 0;
            lastCapturedSample = sample;
          }

          // サムネイル更新
          thumbBox.innerHTML = `<img src="${finalDataUrl}" alt="P${currentPage}"/>`;

          // IndexedDBへ一時保存
          savePageToDB(currentPage, finalDataUrl);

          // Kindle側の進捗ステータス確認
          chrome.tabs.sendMessage(tab.id, { action: 'GET_PAGE_STATUS' }, (status) => {
            const isLast = status && status.isLastPage;

            // 最大ページ数到達チェック
            if (maxPages && currentPage >= maxPages) {
              completeScan();
              return;
            }

            if (isLast) {
              statusMessage.textContent = '書籍の末尾に到達しました。EPUBを作成します...';
              completeScan();
              return;
            }

            // 次ページへめくり
            advancePage(tab.id);
          });
        });
      });
    }
  }

  function cropImage(dataUrl, cropArea, format, quality) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = img.naturalWidth / ((cropArea && cropArea.windowWidth) || window.innerWidth);

        const sx = cropArea ? cropArea.left * scale : 0;
        const sy = cropArea ? cropArea.top * scale : 0;
        const sWidth = cropArea ? cropArea.width * scale : img.naturalWidth;
        const sHeight = cropArea ? cropArea.height * scale : img.naturalHeight;

        canvas.width = Math.max(10, sWidth);
        canvas.height = Math.max(10, sHeight);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);

        resolve(canvas.toDataURL(format, quality / 100));
      };
      img.src = dataUrl;
    });
  }

  function advancePage(tabId) {
    chrome.tabs.sendMessage(tabId, { action: 'NEXT_PAGE', direction: settingDirection.value }, (res) => {
      // 描画待機＆ロードインジケーター確認
      chrome.tabs.sendMessage(tabId, { action: 'CHECK_RENDER_COMPLETE' }, () => {
        const waitTime = autoInterval.checked ? 900 : parseInt(fixedInterval.value, 10);
        scanTimer = setTimeout(() => {
          loopNextStep();
        }, waitTime);
      });
    });
  }

  function pauseScan() {
    isPaused = true;
    clearTimeout(scanTimer);
    clearTimeout(timeoutTimer);
    btnPause.classList.add('hidden');
    btnResume.classList.remove('hidden');
    statusMessage.textContent = '一時停止中';
  }

  function resumeScan() {
    isPaused = false;
    btnResume.classList.add('hidden');
    btnPause.classList.remove('hidden');
    statusMessage.textContent = 'スキャン中...';
    warningAlert.classList.add('hidden');
    loopNextStep();
  }

  function abortScan() {
    isScanning = false;
    isPaused = false;
    clearTimeout(scanTimer);
    clearTimeout(timeoutTimer);
    clearDB();
    resetUI();
    statusMessage.textContent = 'スキャンを中止しました';
  }

  function retryCurrentPage() {
    if (currentPage > 0) currentPage--;
    loopNextStep();
  }

  async function completeScan() {
    isScanning = false;
    isPaused = false;
    clearTimeout(scanTimer);
    clearTimeout(timeoutTimer);
    statusMessage.textContent = `全 ${currentPage} ページのEPUBファイルを構築中...`;
    progressBar.style.width = '100%';

    try {
      const builder = new EpubBuilder({
        title: metaTitle.value || 'Kindle_Book',
        author: metaAuthor.value || '不明な著者',
        direction: settingDirection.value === 'ltr' ? 'ltr' : 'rtl'
      }, {
        mode: settingMode.value,
        ratioPreset: settingRatioPreset.value || '20:9'
      });

      // IndexedDBから全ページを順次読み込み
      const pages = await getAllPagesFromDB();
      if (pages.length === 0) {
        statusMessage.textContent = '保存対象のページがありません';
        resetUI();
        return;
      }

      for (const p of pages) {
        const blob = await (await fetch(p.dataUrl)).blob();
        builder.addFixedPage(blob, p.pageNum, settingFormat.value);
      }

      const epubBlob = await builder.build();
      const blobUrl = URL.createObjectURL(epubBlob);
      const safeTitle = (metaTitle.value || 'Kindle_Book').replace(/[/\\?%*:|"<>]/g, '_');
      const filename = `${safeTitle}.epub`;

      chrome.runtime.sendMessage({
        type: 'SAVE_EPUB_FILE',
        subfolder: 'KindleBooks',
        filename,
        blobUrl
      }, (res) => {
        chrome.runtime.sendMessage({
          type: 'SHOW_NOTIFICATION',
          title: 'Kindle to EPUB 完了',
          message: `${filename} (${pages.length}ページ) を保存しました。`
        });

        statusMessage.textContent = `完了！ ${filename} (${pages.length}ページ) を保存しました`;
        resetUI();
        btnStart.classList.remove('hidden');
        btnPause.classList.add('hidden');
        subActions.classList.add('hidden');
      });
    } catch (err) {
      console.error(err);
      statusMessage.textContent = 'EPUB生成エラー: ' + err.message;
      resetUI();
    }
  }

  function updateProgressUI() {
    if (maxPages) {
      const pct = Math.min(100, Math.round((currentPage / maxPages) * 100));
      progressBar.style.width = pct + '%';
      pageCount.textContent = `${currentPage} / ${maxPages} ページ`;
    } else {
      pageCount.textContent = `${currentPage} ページスキャン済み`;
      progressBar.style.width = `${Math.min(95, currentPage * 2)}%`;
    }

    if (startTime && maxPages) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = Math.floor((elapsed / (currentPage || 1)) * (maxPages - currentPage));
      timeRemaining.textContent = `残り: 約${Math.floor(remaining / 60)}分${remaining % 60}秒`;
    } else {
      timeRemaining.textContent = '自動終了までスキャン';
    }
  }

  function resetUI() {
    btnStart.classList.remove('hidden');
    btnPause.classList.add('hidden');
    btnResume.classList.add('hidden');
    subActions.classList.add('hidden');
    progressBar.style.width = '0%';
    pageCount.textContent = '0 ページスキャン済み';
    timeRemaining.textContent = '残り: --:--';
  }

  function savePageToDB(pageNum, dataUrl) {
    if (!db) return;
    const tx = db.transaction('pages', 'readwrite');
    tx.objectStore('pages').put({ pageNum, dataUrl });
  }

  function clearDB() {
    if (!db) return;
    const tx = db.transaction('pages', 'readwrite');
    tx.objectStore('pages').clear();
  }

  function getAllPagesFromDB() {
    return new Promise(resolve => {
      if (!db) return resolve([]);
      const tx = db.transaction('pages', 'readonly');
      const req = tx.objectStore('pages').getAll();
      req.onsuccess = () => resolve(req.result || []);
    });
  }
})();
