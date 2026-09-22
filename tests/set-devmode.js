const fs = require('fs');
const path = require('path');
const prefPath = path.resolve(__dirname, '../test-chrome-profile/Default/Preferences');
const prefs = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
if (!prefs.extensions) prefs.extensions = {};
if (!prefs.extensions.ui) prefs.extensions.ui = {};
prefs.extensions.ui.developer_mode = true;
fs.writeFileSync(prefPath, JSON.stringify(prefs, null, 2), 'utf8');
console.log('developer_mode set to true');
