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
  const settingInterval = document.getElementById('settingInterval');
  const intervalVal = document.getElementById('intervalVal');
  const btnSelectFolder = document.getElementById('btnSelectFolder');
  const folderPathDisplay = document.getElementById('folderPathDisplay');
  const btnResetFolder = document.getElementById('btnResetFolder');
  let customDirHandle = null; // FileSystemDirectoryHandle (任意フォルダ直接出力用)
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
  const scaleAdjustBox = document.getElementById('scaleAdjustBox');
  const freeAdjustBox = document.getElementById('freeAdjustBox');
  const btnResetFrame = document.getElementById('btnResetFrame');
  const btnReloadMetadata = document.getElementById('btnReloadMetadata');
  const btnToggleCoverFrame = document.getElementById('btnToggleCoverFrame');
  const btnCaptureCover = document.getElementById('btnCaptureCover');
  const coverPreviewContainer = document.getElementById('coverPreviewContainer');
  const coverThumbnail = document.getElementById('coverThumbnail');
  const coverSizeInfo = document.getElementById('coverSizeInfo');
  const btnClearCover = document.getElementById('btnClearCover');
  let isCoverOverlayVisible = false;
  let customCoverData = null; // { blob, mimeType, dataUrl, width, height }

  // IndexedDB初期化 (メモリクラッシュ防止 + ディレクトリハンドル保存)
  let db = null;
  const dbReq = indexedDB.open('KindleEpubDB', 2);
  dbReq.onupgradeneeded = (e) => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains('pages')) {
      d.createObjectStore('pages', { keyPath: 'pageNum' });
    }
    if (!d.objectStoreNames.contains('config')) {
      d.createObjectStore('config', { keyPath: 'key' });
    }
  };
  dbReq.onsuccess = (e) => {
    db = e.target.result;
    loadSavedDirectoryHandle();
  };

  // コンテントスクリプトからのリアルタイム連動（画面枠直接ドラッグリサイズ時）
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'FRAME_SCALE_CHANGED' && typeof msg.scale === 'number') {
      frameScale.value = msg.scale;
      frameScaleVal.textContent = msg.scale + '%';
    }
  });

  // イベントリスナー
  settingQuality.addEventListener('input', (e) => {
    qualityVal.textContent = e.target.value + '%';
  });

  // 所要時間スライダーの更新
  settingInterval.addEventListener('input', (e) => {
    const s = (parseInt(e.target.value, 10) / 1000).toFixed(1);
    intervalVal.textContent = s + ' 秒';
  });

  // フォルダピッカー (File System Access API) による保存先フォルダ選択
  btnSelectFolder.addEventListener('click', async () => {
    try {
      if (typeof window.showDirectoryPicker !== 'function') {
        alert('お使いの環境ではフォルダ選択APIがサポートされていません。既定のダウンロードフォルダが使用されます。');
        return;
      }
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (dirHandle) {
        customDirHandle = dirHandle;
        saveDirectoryHandle(dirHandle);
        folderPathDisplay.textContent = `📁 ${dirHandle.name}`;
        folderPathDisplay.title = dirHandle.name;
        btnResetFolder.classList.remove('hidden');
        statusMessage.textContent = `保存先フォルダを「${dirHandle.name}」に設定しました`;
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Folder picker error:', err);
      }
    }
  });

  btnResetFolder.addEventListener('click', () => {
    customDirHandle = null;
    clearSavedDirectoryHandle();
    folderPathDisplay.textContent = '未設定（ブラウザのダウンロード/KindleBooks）';
    folderPathDisplay.title = '';
    btnResetFolder.classList.add('hidden');
    statusMessage.textContent = '保存先を既定のダウンロードフォルダに戻しました';
  });

  function saveDirectoryHandle(handle) {
    if (!db) return;
    try {
      const tx = db.transaction('config', 'readwrite');
      tx.objectStore('config').put({ key: 'outputDirHandle', handle, name: handle.name });
    } catch (e) {
      console.warn('Failed to save directory handle:', e);
    }
  }

  function clearSavedDirectoryHandle() {
    if (!db) return;
    try {
      const tx = db.transaction('config', 'readwrite');
      tx.objectStore('config').delete('outputDirHandle');
    } catch (e) {}
  }

  async function loadSavedDirectoryHandle() {
    if (!db) return;
    try {
      const tx = db.transaction('config', 'readonly');
      const req = tx.objectStore('config').get('outputDirHandle');
      req.onsuccess = async () => {
        const res = req.result;
        if (res && res.handle) {
          customDirHandle = res.handle;
          folderPathDisplay.textContent = `📁 ${res.name || res.handle.name || '選択済みフォルダ'}`;
          folderPathDisplay.title = res.name || res.handle.name;
          btnResetFolder.classList.remove('hidden');
        }
      };
    } catch (e) {
      console.warn('Failed to load saved directory handle:', e);
    }
  }

  frameScale.addEventListener('input', (e) => {
    frameScaleVal.textContent = e.target.value + '%';
    updateCropOverlay(false);
  });

  function updatePresetUI() {
    const isFree = settingRatioPreset.value === 'free';
    if (isFree) {
      scaleAdjustBox.classList.add('hidden');
      freeAdjustBox.classList.remove('hidden');
    } else {
      scaleAdjustBox.classList.remove('hidden');
      freeAdjustBox.classList.add('hidden');
    }
  }

  settingRatioPreset.addEventListener('change', () => {
    updatePresetUI();
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

  async function getTargetKindleTab() {
    // 1. まず現在のアクティブタブを確認
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url && activeTab.url.includes('read.amazon')) {
      return activeTab;
    }
    // 2. 開いているすべてのKindleタブから探索
    const kindleTabs = await chrome.tabs.query({ url: '*://read.amazon.*/*' });
    if (kindleTabs && kindleTabs.length > 0) {
      return kindleTabs[0];
    }
    return activeTab || null;
  }

  async function updateCropOverlay(resetPosition = false) {
    const tab = await getTargetKindleTab();
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'TOGGLE_CROP_OVERLAY',
        show: chkShowOverlay.checked,
        config: getFrameConfig(resetPosition)
      }, () => { if (chrome.runtime.lastError) {} });
    }
  }

  btnStart.addEventListener('click', startScan);
  btnPause.addEventListener('click', pauseScan);
  btnResume.addEventListener('click', resumeScan);
  btnAbort.addEventListener('click', abortScan);
  btnRetryPage.addEventListener('click', retryCurrentPage);
  btnCompleteNow.addEventListener('click', () => {
    if (currentPage > 0) completeScan();
  });

  // 表紙枠の表示/非表示トグル
  btnToggleCoverFrame.addEventListener('click', async () => {
    isCoverOverlayVisible = !isCoverOverlayVisible;
    await updateCoverOverlay(isCoverOverlayVisible);
  });

  async function updateCoverOverlay(show) {
    const tab = await getTargetKindleTab();
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'TOGGLE_COVER_OVERLAY',
        show: show
      }, () => { if (chrome.runtime.lastError) {} });
    }
    if (show) {
      btnToggleCoverFrame.textContent = '📐 表紙枠を非表示';
      btnToggleCoverFrame.style.background = '#dbeafe';
      btnToggleCoverFrame.style.borderColor = '#3b82f6';
      btnToggleCoverFrame.style.color = '#1d4ed8';
      btnCaptureCover.removeAttribute('disabled');
      statusMessage.textContent = 'Kindle画面の青い枠を表紙に合わせて「表紙を撮影」を押してください';
    } else {
      btnToggleCoverFrame.textContent = '📐 表紙枠を表示';
      btnToggleCoverFrame.style.background = '';
      btnToggleCoverFrame.style.borderColor = '';
      btnToggleCoverFrame.style.color = '';
      btnCaptureCover.setAttribute('disabled', 'true');
    }
  }

  // 表紙撮影ボタン（自由枠内をキャプチャして登録）
  btnCaptureCover.addEventListener('click', async () => {
    try {
      const tab = await getTargetKindleTab();
      if (!tab || !tab.id) {
        statusMessage.textContent = 'Kindleタブが見つかりません';
        return;
      }

      statusMessage.textContent = '表紙を撮影中...';

      // 1. 枠線の映り込み防止のため一時非表示
      await new Promise(r => chrome.tabs.sendMessage(tab.id, { action: 'HIDE_COVER_OVERLAY_FOR_CAPTURE' }, r));

      // 2. キャプチャ実行
      const res = await new Promise(r => {
        chrome.runtime.sendMessage({
          type: 'CAPTURE_VISIBLE_TAB',
          format: settingFormat.value === 'image/png' ? 'png' : 'jpeg',
          quality: parseInt(settingQuality.value, 10),
          windowId: tab.windowId
        }, r);
      });

      // 3. 枠線の復元
      chrome.tabs.sendMessage(tab.id, { action: 'RESTORE_COVER_OVERLAY' }, () => {});

      if (!res || !res.success || !res.dataUrl) {
        statusMessage.textContent = '表紙キャプチャに失敗しました: ' + (res?.error || '不明なエラー');
        return;
      }

      // 4. 表紙枠の実測座標取得（インセット適用）
      const cropArea = await new Promise(r => {
        chrome.tabs.sendMessage(tab.id, { action: 'DETECT_COVER_CROP_AREA', isCapture: true }, r);
      });

      // 5. クロップ実行
      const coverDataUrl = await cropImage(res.dataUrl, cropArea, settingFormat.value, parseInt(settingQuality.value, 10));
      const coverBlob = await (await fetch(coverDataUrl)).blob();

      customCoverData = {
        blob: coverBlob,
        mimeType: settingFormat.value,
        dataUrl: coverDataUrl,
        width: cropArea ? cropArea.width : 0,
        height: cropArea ? cropArea.height : 0
      };

      // 6. UI更新 & 表紙枠を非表示にして終了
      coverThumbnail.src = coverDataUrl;
      coverSizeInfo.textContent = `${customCoverData.width} × ${customCoverData.height} px`;
      coverPreviewContainer.classList.remove('hidden');

      isCoverOverlayVisible = false;
      await updateCoverOverlay(false);

      statusMessage.textContent = '表紙画像を正常に撮影・登録しました！';
    } catch (err) {
      console.error('Cover capture error:', err);
      statusMessage.textContent = '表紙撮影エラー: ' + err.message;
    }
  });

  // 表紙画像解除
  btnClearCover.addEventListener('click', () => {
    customCoverData = null;
    coverThumbnail.src = '';
    coverSizeInfo.textContent = '';
    coverPreviewContainer.classList.add('hidden');
    statusMessage.textContent = '設定済み表紙画像を解除しました';
  });

  // メタデータ手動再取得ボタン
  btnReloadMetadata.addEventListener('click', async () => {
    statusMessage.textContent = 'メタデータを再取得中...';
    await initBookMetadata(true);
    statusMessage.textContent = metaTitle.value ? `書籍メタデータを反映しました: "${metaTitle.value}"` : 'メタデータの取得に失敗しました';
  });

  // 初期メタデータ自動取得（非同期リトライ対応）
  async function initBookMetadata(force = false) {
    for (let retry = 0; retry < (force ? 3 : 5); retry++) {
      try {
        const tab = await getTargetKindleTab();
        if (tab && tab.id) {
          const res = await new Promise(r => chrome.tabs.sendMessage(tab.id, { action: 'GET_BOOK_INFO' }, r));
          if (!chrome.runtime.lastError && res && res.title && !res.isDefaultTitle) {
            metaTitle.value = res.title;
            if (res.author) metaAuthor.value = res.author;
            return;
          }
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  initBookMetadata();
  // 起動時は枠をオフのまま待機（ユーザーがチェックを入れた時のみ表示）

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
      // 枠線の映り込み防止: 撮影の瞬間だけ画面上の枠を非表示にする
      await new Promise(r => chrome.tabs.sendMessage(tab.id, { action: 'HIDE_OVERLAY_FOR_CAPTURE' }, r));

      const res = await new Promise(r => {
        chrome.runtime.sendMessage({
          type: 'CAPTURE_VISIBLE_TAB',
          format: settingFormat.value === 'image/png' ? 'png' : 'jpeg',
          quality: parseInt(settingQuality.value, 10),
          windowId: tab.windowId
        }, r);
      });

      // 撮影完了後、直ちに枠の表示状態を元に戻す
      chrome.tabs.sendMessage(tab.id, { action: 'RESTORE_OVERLAY' }, () => {});

      if (!res || !res.success || !res.dataUrl) {
        console.error("[Sidepanel] Capture failed:", res?.error);
        pauseScan();
        warningAlert.textContent = '画面キャプチャに失敗しました: ' + (res?.error || '不明なエラー');
        warningAlert.classList.remove('hidden');
        return;
      }

      clearTimeout(timeoutTimer);
      warningAlert.classList.add('hidden');

      // 指定機種比率のキャプチャ枠に合わせてクロップ（isCapture: true で枠線インセット適用）
      const cropArea = await new Promise(r => {
        chrome.tabs.sendMessage(tab.id, { action: 'DETECT_CROP_AREA', config: getFrameConfig(false), isCapture: true }, r);
      });

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
      const status = await new Promise(r => chrome.tabs.sendMessage(tab.id, { action: 'GET_PAGE_STATUS' }, r));
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
        const waitTime = parseInt(settingInterval.value, 10) || 900;
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

      // 表紙画像（Kindle本棚対応）の設定（専用枠で撮影された表紙画像を反映）
      if (customCoverData && customCoverData.blob) {
        builder.setCoverImage(customCoverData.blob, customCoverData.mimeType);
      }

      for (const p of pages) {
        const blob = await (await fetch(p.dataUrl)).blob();
        builder.addFixedPage(blob, p.pageNum, settingFormat.value);
      }

      const epubBlob = await builder.build();
      // ファイル名は純粋な書籍名のみ（著者名は含めない、Windows禁止文字を置換）
      let rawTitle = metaTitle.value ? metaTitle.value.trim() : 'Kindle_Book';
      const safeTitle = rawTitle.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'Kindle_Book';
      const filename = `${safeTitle}.epub`;

      // 1. ユーザーが指定した保存先フォルダ (File System Access API) が存在する場合
      if (customDirHandle) {
        try {
          // 権限確認（未許可の場合はリクエスト）
          let hasPermission = false;
          try {
            if ((await customDirHandle.queryPermission({ mode: 'readwrite' })) === 'granted') {
              hasPermission = true;
            } else if ((await customDirHandle.requestPermission({ mode: 'readwrite' })) === 'granted') {
              hasPermission = true;
            }
          } catch(e) {
            hasPermission = true;
          }

          if (hasPermission) {
            const fileHandle = await customDirHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(epubBlob);
            await writable.close();

            chrome.runtime.sendMessage({
              type: 'SHOW_NOTIFICATION',
              title: 'Kindle to EPUB 完了',
              message: `${filename} (${pages.length}ページ) を保存しました。`
            });

            statusMessage.textContent = `完了！ フォルダ「${customDirHandle.name}」へ ${filename} (${pages.length}ページ) を保存しました`;
            resetUI();
            btnStart.classList.remove('hidden');
            btnPause.classList.add('hidden');
            subActions.classList.add('hidden');
            return;
          }
        } catch (dirErr) {
          console.warn('Custom directory write failed, falling back to downloads API:', dirErr);
        }
      }

      // 2. フォルダー未指定またはアクセス失敗時のフォールバック (既定のDownloads/KindleBooksへ保存)
      const blobUrl = URL.createObjectURL(epubBlob);
      const subfolder = 'KindleBooks';

      chrome.runtime.sendMessage({
        type: 'SAVE_EPUB_FILE',
        subfolder,
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
