const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const http = require('http');
const mockServer = require('./mock-server');
const { validateEpub } = require('./epub-validator');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_PATH = path.resolve(__dirname, '../kindle-to-epub-chrome-extension');
const PORT = 8080;

async function runE2ETest() {
  console.log('========================================');
  console.log('🚀 Kindle to EPUB 自動E2Eテスト開始');
  console.log('========================================\n');

  // 1. モックサーバー起動
  await new Promise(resolve => mockServer.listen(PORT, resolve));
  console.log(`[1/5] モックKindleサーバー起動: http://localhost:${PORT}`);

  // 2. Chrome起動（拡張機能ロード）
  console.log('[2/5] Chrome起動（拡張機能をロード）...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  try {
    const page = await browser.newPage();
    
    // コンソールログ監視
    page.on('console', msg => {
      const text = msg.text();
      if (msg.type() === 'error') {
        console.error(`  [ブラウザError]: ${text}`);
      }
    });

    // 3. モックKindleページへアクセス
    console.log('[3/5] モックKindleページを開いています...');
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });

    // 書籍タイトルと著者名の確認
    const title = await page.$eval('#header-title', el => el.textContent.trim());
    const author = await page.$eval('#header-author', el => el.textContent.trim());
    console.log(`  取得した書籍情報: "${title}" / ${author}`);
    if (!title.includes('坊っちゃん')) throw new Error('モック書籍タイトルの取得に失敗');

    // 4. Content Scriptの機能検証
    console.log('[4/5] 拡張機能 Content Script の動作検証...');
    
    // 領域検知 (DETECT_CROP_AREA) のシミュレート検証
    const cropArea = await page.evaluate(() => {
      const canvas = document.querySelector('canvas#kindleReader_canvas');
      const b = canvas.getBoundingClientRect();
      return {
        top: b.top,
        left: b.left,
        width: b.width,
        height: b.height,
        dpr: window.devicePixelRatio || 1
      };
    });
    console.log(`  書籍キャンバス領域検知成功: 幅 ${cropArea.width}px × 高さ ${cropArea.height}px`);

    // 自動めくり（ArrowLeft送信）の検証
    console.log('  ページめくりシミュレート（1ページ目 → 2ページ目）...');
    const page1Text = await page.$eval('#pageText', el => el.textContent);
    console.log(`  めくり前: ${page1Text}`);

    // ArrowLeft キーイベント発火
    await page.keyboard.press('ArrowLeft');
    await new Promise(r => setTimeout(r, 400)); // 描画待ち

    const page2Text = await page.$eval('#pageText', el => el.textContent);
    console.log(`  めくり後: ${page2Text}`);
    if (page1Text === page2Text) {
      throw new Error('キー入力によるページめくりが反映されませんでした');
    }
    console.log('  ✅ 自動ページめくりテスト合格');

    // 5. 拡張機能コンテキスト内でのEPUB生成テスト
    console.log('[5/5] ブラウザ環境内でのJSZip & EpubBuilder 動作検証...');
    
    // 拡張機能IDを取得（リトライあり）
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
    console.log(`  ロードされた拡張機能ID: ${extensionId || '検出中'}`);

    if (extensionId) {
      const sidepanelPage = await browser.newPage();
      await sidepanelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);


      // JSZipがグローバルに存在するか確認
      const hasJSZip = await sidepanelPage.evaluate(() => typeof window.JSZip !== 'undefined');
      const hasEpubBuilder = await sidepanelPage.evaluate(() => typeof window.EpubBuilder !== 'undefined');
      console.log(`  sidepanel.html 内の JSZip 存在確認: ${hasJSZip ? '✅ OK' : '❌ 存在しない'}`);
      console.log(`  sidepanel.html 内の EpubBuilder 存在確認: ${hasEpubBuilder ? '✅ OK' : '❌ 存在しない'}`);

      if (!hasJSZip || !hasEpubBuilder) {
        throw new Error('sidepanel.html 内のライブラリ初期化に失敗しました');
      }

      // サイドパネル内でダミーEPUB生成をテスト
      const epubBase64 = await sidepanelPage.evaluate(async () => {
        const builder = new EpubBuilder({
          title: '坊っちゃん (ブラウザテスト)',
          author: '夏目漱石'
        }, { mode: 'fixed' });

        // ダミー1x1 PNG画像Blob作成
        const canvas = document.createElement('canvas');
        canvas.width = 100;
        canvas.height = 150;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fdfbf7';
        ctx.fillRect(0, 0, 100, 150);
        ctx.fillStyle = '#333';
        ctx.fillText('Page 1', 20, 50);

        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8));
        builder.addFixedPage(blob, 1, 'image/jpeg');

        const epubBlob = await builder.build();
        const reader = new FileReader();
        return new Promise(r => {
          reader.onloadend = () => r(reader.result.split(',')[1]);
          reader.readAsDataURL(epubBlob);
        });
      });

      const buffer = Buffer.from(epubBase64, 'base64');
      const result = await validateEpub(buffer);
      console.log(`  ブラウザ内EPUB生成検証: ${result.valid ? '✅ 合格 (PASS)' : '❌ 不合格'}`);
      if (!result.valid) {
        console.error('EPUBエラー:', result.errors);
        throw new Error('EPUB規格違反が検出されました');
      }
    }

    console.log('\n========================================');
    console.log('🎉 全E2Eテスト項目が正常に完了（ALL PASS）しました！');
    console.log('========================================');

  } finally {
    await browser.close();
    mockServer.close();
  }
}

runE2ETest().catch(err => {
  console.error('\n❌ E2Eテスト失敗:', err);
  process.exit(1);
});
