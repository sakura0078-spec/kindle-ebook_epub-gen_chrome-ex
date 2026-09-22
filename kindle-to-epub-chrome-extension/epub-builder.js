// epub-builder.js - クライアントサイドEPUB3ジェネレーター
// JSZipライブラリを利用してEPUB構造を構築
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
    this.options = {
      mode: options.mode || 'fixed', // 'fixed' または 'reflow'
      writingMode: options.writingMode || 'vertical-rl', // 'vertical-rl' または 'horizontal-tb'
      ...options
    };
    this.pages = []; // 画像BlobまたはHTML文字列
    this.images = []; // 挿絵
    this.zip = new JSZip();
  }

  addFixedPage(imageBlob, pageNum, mimeType = 'image/jpeg') {
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    this.pages.push({
      type: 'image',
      pageNum,
      blob: imageBlob,
      filename: `page_${String(pageNum).padStart(4, '0')}.${ext}`,
      mimeType
    });
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
body { margin: 0; padding: 0; text-align: center; }
img { max-width: 100%; max-height: 100%; height: 100vh; object-fit: contain; }`
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

    if (this.options.mode === 'fixed') {
      for (let i = 0; i < this.pages.length; i++) {
        const p = this.pages[i];
        oebps.file(`images/${p.filename}`, p.blob);
        manifestItems.push(`<item id="img_${i}" href="images/${p.filename}" media-type="${p.mimeType}"/>`);

        // 画像を表示するXHTML
        const xhtmlFilename = `p_${String(i + 1).padStart(4, '0')}.xhtml`;
        const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja">
<head>
  <meta charset="UTF-8"/>
  <title>${this.metadata.title} - Page ${i + 1}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
  <meta name="viewport" content="width=1200, height=1920"/>
</head>
<body>
  <div>
    <img src="images/${p.filename}" alt="Page ${i + 1}"/>
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
      ${spineItems.map((_, idx) => `<li><a href="${this.options.mode === 'fixed' ? 'p_' + String(idx + 1).padStart(4, '0') + '.xhtml' : this.pages[idx].filename}">ページ ${idx + 1}</a></li>`).join('\n      ')}
    </ol>
  </nav>
</body>
</html>`;
    oebps.file('nav.xhtml', navContent);

    // 6. package.opf
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
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine page-progression-direction="${this.metadata.direction}">
    ${spineItems.join('\n    ')}
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

