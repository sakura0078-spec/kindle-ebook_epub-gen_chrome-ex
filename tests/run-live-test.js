const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CFT_PATH = 'C:\\Users\\sakur\\.cache\\puppeteer\\chrome\\win64-147.0.7727.56\\chrome-win64\\chrome.exe';
const CHROME_PATH = fs.existsSync(CFT_PATH) ? CFT_PATH : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA_DIR = path.resolve(__dirname, '../test-chrome-profile');
const EXT_PATH = path.resolve(__dirname, '../kindle-to-epub-chrome-extension');
const DEFAULT_ASIN = 'B0DK8MNJDY'; // 検出された書籍ASIN
const KNOWN_EXT_ID = 'hnlpagpolhlbbjnnoijbhbnnlmklobnd';

async function runLiveTest(options = { maxPages: 5, asin: DEFAULT_ASIN }) {
  console.log('====================================================');
  console.log('🚀 [方式C] 実機Kindle Cloud Reader 完全自律テスト走行');
  console.log('====================================================\n');

  console.log(`[1/5] GUI表示でChromeを起動中... (Binary: ${CHROME_PATH})`);
  console.log('※ 画面上にChromeウィンドウが表示され、直接書籍リーダーを開きます。');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: USER_DATA_DIR,
    headless: false, // 目視できるGUIウィンドウで表示
    defaultViewport: null,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  try {
    // 拡張機能IDの取得
    console.log('[2/5] 拡張機能のロードを確認中...');
    let extensionId = '';
    for (let i = 0; i < 10; i++) {
      const targets = await browser.targets();
      const extTarget = targets.find(t => t.url().startsWith('chrome-extension://'));
      if (extTarget) {
        extensionId = extTarget.url().split('/')[2];
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    if (!extensionId) {
      extensionId = KNOWN_EXT_ID;
    }
    console.log(`  拡張機能ID: ${extensionId}`);

    // 直接書籍URLを開く
    const targetAsin = options.asin || DEFAULT_ASIN;
    const targetUrl = `https://read.amazon.co.jp/?asin=${targetAsin}`;
    console.log(`[3/5] 対象書籍リーダーを直接開いています (${targetUrl})...`);

    const pages = await browser.pages();
    const kindlePage = pages[0] || await browser.newPage();
    
    kindlePage.on('console', msg => {
      const t = msg.text();
      if (t.includes('[Kindle to EPUB]') || msg.type() === 'error') {
        console.log(`  [KindlePage ${msg.type()}]: ${t}`);
      }
    });

    await kindlePage.goto(targetUrl, { waitUntil: 'networkidle2' });

    // 読書画面の読み込み待機（8秒）
    console.log('  読書画面レンダリング待機中...');
    await new Promise(r => setTimeout(r, 8000));

    const bookInfo = await kindlePage.evaluate(() => {
      return { title: document.title, url: location.href };
    });
    console.log(`  ✅ 読書画面オープン完了！ タイトル: "${bookInfo.title}"`);

    // 4. 拡張機能サイドパネルの起動と操作
    console.log('[4/5] 拡張機能サイドパネルを起動してスキャンを開始します...');
    const sidepanelPage = await browser.newPage();
    
    sidepanelPage.on('console', msg => {
      const t = msg.text();
      console.log(`  [Sidepanel ${msg.type()}]: ${t}`);
    });

    await sidepanelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'networkidle0' });

    // 最大ページ数を入力
    if (options.maxPages) {
      await sidepanelPage.$eval('#settingMaxPages', (el, val) => el.value = val, options.maxPages);
      console.log(`  スキャン上限ページ数設定: ${options.maxPages} ページ`);
    }

    await new Promise(r => setTimeout(r, 1500));

    // Kindle読書画面タブを最前面にしてスキャン開始
    await kindlePage.bringToFront();
    await new Promise(r => setTimeout(r, 1000));
    console.log('  ▶ サイドパネルから「スキャン開始」を実行します...');
    
    await sidepanelPage.evaluate(() => {
      const btn = document.getElementById('btnStart');
      if (btn) btn.click();
    });

    // 5. スキャン進行監視ループ（リアルタイムめくり監視）
    console.log('[5/5] スキャン進行を監視中（リアルタイムめくり連動）...');
    let completed = false;
    let lastProgress = '';
    const startTime = Date.now();
    const maxWaitTime = 1000 * 60 * 5; // 最大5分

    while (Date.now() - startTime < maxWaitTime) {
      await new Promise(r => setTimeout(r, 2000));

      const scanStatus = await sidepanelPage.evaluate(() => {
        const statusMsg = document.getElementById('statusMessage')?.textContent || '';
        const pageCnt = document.getElementById('pageCount')?.textContent || '';
        const isStartHidden = document.getElementById('btnStart')?.classList.contains('hidden');
        const isPauseHidden = document.getElementById('btnPause')?.classList.contains('hidden');
        return { statusMsg, pageCnt, isScanning: isStartHidden && !isPauseHidden };
      }).catch(() => null);

      if (scanStatus) {
        if (scanStatus.pageCnt !== lastProgress) {
          console.log(`  進行状況: ${scanStatus.pageCnt} - ステータス: ${scanStatus.statusMsg}`);
          lastProgress = scanStatus.pageCnt;
        }

        if (scanStatus.statusMsg.includes('完了') || scanStatus.statusMsg.includes('保存しました')) {
          console.log(`\n🎉 スキャン＆EPUB保存完了を検知！: ${scanStatus.statusMsg}`);
          completed = true;
          break;
        }
      }
    }

    if (!completed) {
      console.log('  上限到達またはタイムアウトのため「ここで完了＆EPUB作成」を実行します...');
      await sidepanelPage.evaluate(() => {
        document.getElementById('btnCompleteNow')?.click();
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 8000));
    }

    // 保存されたEPUB確認
    const downloadDir = path.join(process.env.USERPROFILE, 'Downloads', 'KindleBooks');
    console.log(`  ダウンロードフォルダ確認: ${downloadDir}`);
    let epubFiles = [];
    if (fs.existsSync(downloadDir)) {
      epubFiles = fs.readdirSync(downloadDir).filter(f => f.endsWith('.epub'));
    }

    console.log('\n====================================================');
    console.log('✅ 実機テスト走行完了レポート');
    console.log(`  対象書籍URL: ${targetUrl}`);
    console.log(`  スキャン完了ステータス: ${completed ? 'SUCCESS' : 'PARTIAL'}`);
    console.log(`  保存されたEPUBファイル数: ${epubFiles.length}`);
    if (epubFiles.length > 0) {
      console.log(`  最新ファイル: ${epubFiles[epubFiles.length - 1]}`);
    }
    console.log('====================================================');

    return {
      success: completed || epubFiles.length > 0,
      bookTitle: bookInfo.title,
      downloadDir,
      epubFiles
    };

  } finally {
    console.log('※ 5秒後にブラウザを正常終了します...');
    await new Promise(r => setTimeout(r, 5000));
    await browser.close();
  }
}

if (require.main === module) {
  const maxPages = parseInt(process.argv[2], 10) || 5;
  const asin = process.argv[3] || DEFAULT_ASIN;
  runLiveTest({ maxPages, asin }).then(res => {
    console.log('テスト結果:', res);
  }).catch(err => {
    console.error('実機テスト例外:', err);
    process.exit(1);
  });
}

module.exports = { runLiveTest };
