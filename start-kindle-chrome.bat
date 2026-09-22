@echo off
chcp 65001 > nul
echo ===================================================
echo Kindle to EPUB: テスト専用Chromeを起動しています...
echo ===================================================

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%~dp0test-chrome-profile" --disable-extensions-except="%~dp0kindle-to-epub-chrome-extension" --load-extension="%~dp0kindle-to-epub-chrome-extension" "https://read.amazon.co.jp"

exit
