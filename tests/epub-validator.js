const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

/**
 * EPUB 3 規格および内容の整合性を自動検証する
 * @param {string|Buffer} epubPathOrBuffer 
 * @returns {Promise<{ valid: boolean, errors: string[], warnings: string[], info: any }>}
 */
async function validateEpub(epubPathOrBuffer) {
  const errors = [];
  const warnings = [];
  const info = {};

  let buffer;
  if (typeof epubPathOrBuffer === 'string') {
    if (!fs.existsSync(epubPathOrBuffer)) {
      return { valid: false, errors: [`ファイルが存在しません: ${epubPathOrBuffer}`], warnings, info };
    }
    buffer = fs.readFileSync(epubPathOrBuffer);
  } else {
    buffer = epubPathOrBuffer;
  }

  // 1. mimetype のチェック (ZIPバイナリの先頭部分)
  // EPUB仕様: 先頭4バイト PK\x03\x04、30バイト目から "mimetype"、その後非圧縮 "application/epub+zip"
  const magic = buffer.subarray(0, 4).toString('ascii');
  if (magic !== 'PK\x03\x04') {
    errors.push('無効なZIPファイルです（マジックナンバー不一致）');
    return { valid: false, errors, warnings, info };
  }

  const zip = await JSZip.loadAsync(buffer);

  // 2. mimetype ファイルの存在と中身
  const mimetypeFile = zip.file('mimetype');
  if (!mimetypeFile) {
    errors.push('必須ファイル "mimetype" が存在しません');
  } else {
    const mimetypeContent = (await mimetypeFile.async('string')).trim();
    if (mimetypeContent !== 'application/epub+zip') {
      errors.push(`mimetype の内容が不正です: "${mimetypeContent}" (期待値: "application/epub+zip")`);
    }
  }

  // 3. META-INF/container.xml のチェック
  const containerFile = zip.file('META-INF/container.xml');
  let opfPath = '';
  if (!containerFile) {
    errors.push('必須ファイル "META-INF/container.xml" が存在しません');
  } else {
    const containerXml = await containerFile.async('string');
    const match = containerXml.match(/full-path="([^"]+)"/);
    if (!match) {
      errors.push('container.xml 内に package.opf への full-path が見つかりません');
    } else {
      opfPath = match[1];
    }
  }

  // 4. package.opf のチェック
  if (opfPath) {
    const opfFile = zip.file(opfPath);
    if (!opfFile) {
      errors.push(`OPFファイルが存在しません: ${opfPath}`);
    } else {
      const opfXml = await opfFile.async('string');
      
      // メタデータ検証
      if (!opfXml.includes('<dc:title>')) errors.push('OPFメタデータに <dc:title> がありません');
      if (!opfXml.includes('<dc:identifier')) errors.push('OPFメタデータに <dc:identifier> がありません');
      if (!opfXml.includes('<dc:language>')) errors.push('OPFメタデータに <dc:language> がありません');
      
      // 固定レイアウト (Fixed-layout) プロパティ
      if (opfXml.includes('pre-paginated')) {
        info.layout = 'fixed';
      } else {
        info.layout = 'reflow';
      }

      // マニフェスト抽出
      const manifestRegex = /<item\s+[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*media-type="([^"]+)"/g;
      let m;
      const manifestItems = new Map();
      while ((m = manifestRegex.exec(opfXml)) !== null) {
        manifestItems.set(m[1], { href: m[2], mediaType: m[3] });
      }

      const opfDir = path.dirname(opfPath);
      let validImagesCount = 0;
      let zeroByteFiles = 0;

      // マニフェスト全アイテムの実体チェック
      for (const [id, item] of manifestItems.entries()) {
        const itemFullPath = opfDir === '.' ? item.href : `${opfDir}/${item.href}`;
        const f = zip.file(itemFullPath);
        if (!f) {
          errors.push(`マニフェストに定義されたファイルがZIP内に存在しません: ${itemFullPath} (id: ${id})`);
        } else {
          const itemBuffer = await f.async('nodebuffer');
          if (itemBuffer.length === 0) {
            errors.push(`ファイルサイズが0バイトです: ${itemFullPath}`);
            zeroByteFiles++;
          }
          if (item.mediaType.startsWith('image/')) {
            validImagesCount++;
          }
        }
      }

      info.totalManifestItems = manifestItems.size;
      info.imageCount = validImagesCount;

      if (validImagesCount === 0 && info.layout === 'fixed') {
        errors.push('固定レイアウトEPUBに画像ファイルが1枚も含まれていません');
      }

      // 表紙画像 (Cover) の検証
      const hasCoverProperty = opfXml.includes('properties="cover-image"');
      const hasCoverMeta = opfXml.includes('<meta name="cover"');
      info.hasCoverImage = hasCoverProperty && hasCoverMeta;

      // spine の検証
      if (!opfXml.includes('<spine')) {
        errors.push('OPF内に <spine> が存在しません');
      }
    }
  }

  // 5. ナビゲーション (nav.xhtml) チェック
  const navMatches = zip.file(/nav\.xhtml$/);
  if (navMatches.length === 0) {
    warnings.push('nav.xhtml が見つかりません（EPUB 3推奨）');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info
  };
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.log('Usage: node epub-validator.js <path-to-epub>');
    process.exit(1);
  }
  validateEpub(target).then(res => {
    console.log('--- EPUB Validation Result ---');
    console.log(`Valid: ${res.valid ? '✅ PASS' : '❌ FAIL'}`);
    console.log('Info:', JSON.stringify(res.info, null, 2));
    if (res.warnings.length > 0) console.log('Warnings:', res.warnings);
    if (res.errors.length > 0) {
      console.log('Errors:', res.errors);
      process.exit(1);
    }
  });
}

module.exports = { validateEpub };
