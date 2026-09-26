const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ACCOUNT_DIR = path.join(ROOT, 'data', 'accounts');
const LEGACY_AUTH_FILE = path.join(ROOT, 'deepseek-auth.json');

function accountFiles(dir = ACCOUNT_DIR) {
    try {
        return fs.readdirSync(dir)
            .filter(f => f.endsWith('.json'))
            .sort()
            .map(f => path.join(dir, f));
    } catch (e) {
        return [];
    }
}

function hasAccountFiles(dir = ACCOUNT_DIR) {
    return accountFiles(dir).length > 0;
}

// Where a new/refreshed account should be written. Once the account pool exists
// the scripts must target it too, otherwise `npm run auth` would produce a file
// the server never loads.
function defaultAuthPath() {
    return hasAccountFiles() ? path.join(ACCOUNT_DIR, 'main.json') : LEGACY_AUTH_FILE;
}

function defaultAuthLabel() {
    return hasAccountFiles() ? path.join('data', 'accounts', 'main.json') : 'deepseek-auth.json';
}

module.exports = {
    ROOT,
    ACCOUNT_DIR,
    LEGACY_AUTH_FILE,
    accountFiles,
    hasAccountFiles,
    defaultAuthPath,
    defaultAuthLabel,
};
