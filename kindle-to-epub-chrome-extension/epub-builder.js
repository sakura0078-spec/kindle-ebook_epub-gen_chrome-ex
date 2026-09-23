const _JSZip = (typeof JSZip !== 'undefined') ? JSZip : (typeof require !== 'undefined' ? require('jszip') : null);

class EpubBuilder {
  constructor(metadata, options = {}) {
    this.metadata = {
      title: metadata.title || 'Untitled Book',
      author: metadata.author || 'Unknown Author',
      identifier: 'urn:uuid:' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2)),
      language: 'ja',
      direction: options.direction || 'rtl',
      ...metadata
    };
    let vpWidth = 1080;
    let vpHeight = 2400; // デフォルト A302ZT (20:9)
    if (options.ratioPreset === '19.5:9') {
      vpWidth = 1080;
      vpHeight = 2340;
    } else if (options.ratioPreset === '16:9') {
      vpWidth = 1080;
      vpHeight = 1920;
    }

    this.options = {
      mode: options.mode || 'fixed', // 'fixed' または 'reflow'
      writingMode: options.writingMode || 'vertical-rl', // 'vertical-rl' または 'horizontal-tb'
      viewportWidth: options.viewportWidth || vpWidth,
      viewportHeight: options.viewportHeight || vpHeight,
      ...options
    };
    this.coverImage = options.coverImage || null; // { blob, mimeType }
    this.pages = []; // 画像BlobまたはHTML文字列
    this.images = []; // 挿絵
    this.zip = new _JSZip();
  }

  setCoverImage(imageBlob, mimeType = 'image/jpeg', dimensions = null) {
    this.coverImage = {
      blob: imageBlob,
      mimeType,
      width: dimensions ? dimensions.width : null,
      height: dimensions ? dimensions.height : null
    };
  }

  addFixedPage(imageBlob, pageNum, mimeType = 'image/jpeg', dimensions = null) {
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    this.pages.push({
      type: 'image',
      pageNum,
      blob: imageBlob,
      filename: `page_${String(pageNum).padStart(4, '0')}.${ext}`,
      mimeType,
      width: dimensions ? dimensions.width : null,
      height: dimensions ? dimensions.height : null
    });
  }

  async getImageDimensions(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(blob);
        const dim = { width: bmp.width, height: bmp.height };
        bmp.close();
        return dim;
      } catch (e) {}
    }
    if (typeof Image !== 'undefined') {
      return new Promise(resolve => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          resolve(null);
        };
        img.src = url;
      });
    }
    return null;
  }

  addReflowPage(htmlContent, pageNum, images = []) {
    this.pages.push({
      type: 'html',
      pageNum,
      content: htmlContent,
      filename: `section_${String(pageNum).padStart(4, '0')}.xhtml`,
      images
    });
  }

  async build() {
    // 1. mimetype (先頭・非圧縮必須)
    this.zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

    // 2. META-INF/container.xml
    this.zip.folder('META-INF').file(
      'container.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
    );

    const oebps = this.zip.folder('OEBPS');

    // 3. CSSスタイルシート (縦書き・固定レイアウト用)
    const cssContent = this.options.mode === 'fixed'
      ? `@page { margin: 0; padding: 0; }
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
}
div.svg-wrapper {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
}
svg {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  display: block;
}`
      : `body {
  writing-mode: ${this.options.writingMode};
  -webkit-writing-mode: ${this.options.writingMode};
  margin: 5%;
  line-height: 1.8;
  font-family: sans-serif;
}
ruby { ruby-align: center; }
rt { font-size: 0.5em; }`;
    oebps.file('style.css', cssContent);

    // 4. コンテンツ配置
    const manifestItems = [];
    const spineItems = [];

    manifestItems.push('<item id="style" href="style.css" media-type="text/css"/>');
    manifestItems.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');

    // 表紙画像（Kindle本棚・Send to Kindle対応）の処理
    let coverMetaTag = '';
    let coverSpineItem = '';
    if (this.coverImage && this.coverImage.blob) {
      const cExt = this.coverImage.mimeType.includes('png') ? 'png' : this.coverImage.mimeType.includes('webp') ? 'webp' : 'jpg';
      const coverFilename = `cover.${cExt}`;
      oebps.file(`images/${coverFilename}`, this.coverImage.blob);

      // EPUB 3 cover-image プロパティ
      manifestItems.push(`<item id="cover-image" href="images/${coverFilename}" media-type="${this.coverImage.mimeType}" properties="cover-image"/>`);
      // Kindle / EPUB 2 互換メタデータ
      coverMetaTag = '<meta name="cover" content="cover-image"/>';

      let coverWidth = this.coverImage.width;
      let coverHeight = this.coverImage.height;
      if (!coverWidth || !coverHeight) {
        const dims = await this.getImageDimensions(this.coverImage.blob);
        if (dims) {
          coverWidth = dims.width;
          coverHeight = dims.height;
        } else {
          coverWidth = this.options.viewportWidth;
          coverHeight = this.options.viewportHeight;
        }
      }

      // 表紙XHTMLページ (cover.xhtml: Kindle標準SVGラッパー方式)
      const coverXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja">
<head>
  <meta charset="UTF-8"/>
  <title>Cover</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
  <meta name="viewport" content="width=${coverWidth}, height=${coverHeight}"/>
</head>
<body epub:type="cover" style="margin: 0; padding: 0;">
  <div class="svg-wrapper" style="width: 100%; height: 100%;">
    <svg xmlns="http://www.w3.org/2000/svg" version="1.1" xmlns:xlink="http://www.w3.org/1999/xlink"
         width="100%" height="100%" viewBox="0 0 ${coverWidth} ${coverHeight}">
      <image width="${coverWidth}" height="${coverHeight}" xlink:href="images/${coverFilename}"/>
    </svg>
  </div>
</body>
</html>`;
      oebps.file('cover.xhtml', coverXhtml);
      manifestItems.push('<item id="cover_page" href="cover.xhtml" media-type="application/xhtml+xml"/>');
      coverSpineItem = '<itemref idref="cover_page" linear="yes"/>';
    }

    if (this.options.mode === 'fixed') {
      for (let i = 0; i < this.pages.length; i++) {
        const p = this.pages[i];
        oebps.file(`images/${p.filename}`, p.blob);
        manifestItems.push(`<item id="img_${i}" href="images/${p.filename}" media-type="${p.mimeType}"/>`);

        let pageWidth = p.width;
        let pageHeight = p.height;
        if (!pageWidth || !pageHeight) {
          const dims = await this.getImageDimensions(p.blob);
          if (dims) {
            pageWidth = dims.width;
            pageHeight = dims.height;
          } else {
            pageWidth = this.options.viewportWidth;
            pageHeight = this.options.viewportHeight;
          }
        }

        // 画像を表示するXHTML (Kindle Publishing Guidelines標準: SVGラッパー方式)
        const xhtmlFilename = `p_${String(i + 1).padStart(4, '0')}.xhtml`;
        const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja">
<head>
  <meta charset="UTF-8"/>
  <title>${this.metadata.title} - Page ${i + 1}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
  <meta name="viewport" content="width=${pageWidth}, height=${pageHeight}"/>
</head>
<body style="margin: 0; padding: 0;">
  <div class="svg-wrapper" style="width: 100%; height: 100%;">
    <svg xmlns="http://www.w3.org/2000/svg" version="1.1" xmlns:xlink="http://www.w3.org/1999/xlink"
         width="100%" height="100%" viewBox="0 0 ${pageWidth} ${pageHeight}">
      <image width="${pageWidth}" height="${pageHeight}" xlink:href="images/${p.filename}"/>
    </svg>
  </div>
</body>
</html>`;
        oebps.file(xhtmlFilename, xhtml);
        manifestItems.push(`<item id="page_${i}" href="${xhtmlFilename}" media-type="application/xhtml+xml"/>`);
        spineItems.push(`<itemref idref="page_${i}"/>`);
      }
    } else {
      // リフローモード
      for (let i = 0; i < this.pages.length; i++) {
        const p = this.pages[i];
        const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja">
<head>
  <meta charset="UTF-8"/>
  <title>${this.metadata.title} - Section ${i + 1}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  ${p.content}
</body>
</html>`;
        oebps.file(p.filename, xhtml);
        manifestItems.push(`<item id="sec_${i}" href="${p.filename}" media-type="application/xhtml+xml"/>`);
        spineItems.push(`<itemref idref="sec_${i}"/>`);
      }
    }

    // 5. 目次 (nav.xhtml)
    const navItemsList = [];
    if (this.coverImage && this.coverImage.blob) {
      navItemsList.push('<li><a href="cover.xhtml">表紙</a></li>');
    }
    spineItems.forEach((_, idx) => {
      navItemsList.push(`<li><a href="${this.options.mode === 'fixed' ? 'p_' + String(idx + 1).padStart(4, '0') + '.xhtml' : this.pages[idx].filename}">ページ ${idx + 1}</a></li>`);
    });

    const navContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja">
<head>
  <meta charset="UTF-8"/>
  <title>目次</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目次</h1>
    <ol>
      ${navItemsList.join('\n      ')}
    </ol>
  </nav>
  ${this.coverImage && this.coverImage.blob ? `<nav epub:type="landmarks" hidden="">
    <h2>Landmarks</h2>
    <ol>
      <li><a epub:type="cover" href="cover.xhtml">表紙</a></li>
    </ol>
  </nav>` : ''}
</body>
</html>`;
    oebps.file('nav.xhtml', navContent);

    // 6. package.opf
    const allSpineItems = coverSpineItem ? [coverSpineItem, ...spineItems] : spineItems;
    const opfContent = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${this.metadata.identifier}</dc:identifier>
    <dc:title>${this.metadata.title}</dc:title>
    <dc:creator>${this.metadata.author}</dc:creator>
    <dc:language>ja</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.[0-9]+Z$/, 'Z')}</meta>
    <meta property="rendition:layout">${this.options.mode === 'fixed' ? 'pre-paginated' : 'reflowable'}</meta>
    <meta property="rendition:orientation">auto</meta>
    <meta property="rendition:spread">auto</meta>
    ${coverMetaTag}
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine page-progression-direction="${this.metadata.direction}">
    ${allSpineItems.join('\n    ')}
  </spine>
</package>`;
    oebps.file('package.opf', opfContent);

    // ZIP生成
    if (typeof window !== 'undefined' || typeof Blob !== 'undefined') {
      return await this.zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
    } else {
      return await this.zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' });
    }
  }
}

// 環境に応じたエクスポート (ブラウザ window / Node.js module)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EpubBuilder;
}
if (typeof window !== 'undefined') {
  window.EpubBuilder = EpubBuilder;
}

