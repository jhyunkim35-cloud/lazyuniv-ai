#!/usr/bin/env node
// Auto cache-bumper.
// Use `npm run deploy` instead of `git push origin main`.
// On every run: rewrites ?v=... in public/index.html with a fresh
// timestamp-based version, commits the change, then pushes.

const fs = require('fs');
const { execSync } = require('child_process');

const version = Date.now().toString(36);
const indexPath = 'public/index.html';
const html = fs.readFileSync(indexPath, 'utf8');
const re = /(src="\/js\/[^"]+\.js)\?v=[^"]*(")/g;
const updated = html.replace(re, '$1?v=' + version + '$2');

if (updated !== html) {
  fs.writeFileSync(indexPath, updated);
  console.log('[deploy] cache version -> ' + version);
  execSync('git add public/index.html', { stdio: 'inherit' });
  try {
    execSync('git commit -m "chore: cache bump ' + version + '"', { stdio: 'inherit' });
  } catch (e) {
    console.log('[deploy] nothing to commit (already current)');
  }
} else {
  console.log('[deploy] no ?v= tags found in index.html — run setup first');
}

execSync('git push origin main', { stdio: 'inherit' });
console.log('[deploy] pushed.');
