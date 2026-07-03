'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const dest = path.join(__dirname, '..', 'app');

const files = ['index.html', 'app.js', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png'];
const dirs = ['vendor'];

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(dest, file));
}
for (const dir of dirs) {
  fs.cpSync(path.join(root, dir), path.join(dest, dir), { recursive: true });
}

console.log(`Copiados ${files.length} archivos y ${dirs.length} carpeta(s) a ${dest}`);
