// scripts/test_deixis.js — run: node scripts/test_deixis.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'deixis.js'), 'utf8');
eval(src); // file defines plain globals, browser-style

// 1) candidate detection
assert.strictEqual(detectDeixisCandidates('이 식을 여기에 대입하면 됩니다'), true);
assert.strictEqual(detectDeixisCandidates('아까 그 정리를 다시 봅시다'), true);
assert.strictEqual(detectDeixisCandidates('오일러 공식은 중요합니다'), false);

// 2) parse + validate: keeps only high-conf, unique-quote, existing-slide items
const rec = '[00:01:00] 발화자 1: 이 식을 여기 대입하면 값이 나옵니다.\n\n[00:02:00] 발화자 1: 그 정리는 다음 시간에 봅니다.';
const ppt = '[슬라이드 8]\n제목: 오일러 공식\n내용: e^{iθ}=cosθ+i·sinθ';
const raw = '설명입니다.\n[' + JSON.stringify({q:'이 식을 여기 대입하면', ref:'오일러 공식 e^{iθ}=cosθ+i·sinθ', slide:8, conf:'high'})
  + ',' + JSON.stringify({q:'그 정리는', ref:'뭔가 정리', slide:8, conf:'medium'})            // dropped: not high
  + ',' + JSON.stringify({q:'없는 인용문', ref:'XX테스트', slide:8, conf:'high'})                    // dropped: quote absent
  + ',' + JSON.stringify({q:'값이 나옵니다', ref:'XX테스트', slide:99, conf:'high'})                 // dropped: slide 99 not in deck
  + ']';
const anns = parseDeixisAnnotations(raw, rec, ppt);
assert.strictEqual(anns.length, 1);
assert.strictEqual(anns[0].q, '이 식을 여기 대입하면');

// 2b) robustness: trailing prose after JSON array doesn't corrupt parsing
assert.strictEqual(parseDeixisAnnotations(raw + '\n참고: 교재 [3장] 관련', rec, ppt).length, 1);

// 2c) $-pattern safety: function replacer prevents $& expansion when ref contains $-patterns
const dollarAnns = [{q:'값이 나옵니다', ref:'가격 $$100 및 $& 검증', slide:8, conf:'high'}];
const dHtml = injectDeixisChips(rec.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'), dollarAnns);
assert.ok(dHtml.includes('가격 $$100 및 $&amp; 검증'));

// 3) parse failure / garbage → []
assert.deepStrictEqual(parseDeixisAnnotations('no json here', rec, ppt), []);

// 4) section building
const section = buildDeixisSection(anns);
assert.ok(section.includes('지시어 해석 주석'));
assert.ok(section.includes('슬라이드 8'));
assert.strictEqual(buildDeixisSection([]), '');

// 5) per-record assignment: quote must appear exactly once in that record's raw text
assert.strictEqual(assignAnnotationsToRecordText(anns, rec).length, 1);
assert.strictEqual(assignAnnotationsToRecordText(anns, '전혀 다른 텍스트').length, 0);

// 6) chip injection into escaped HTML (no double-annotation, chip is a span)
const esc = rec.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const html = injectDeixisChips(esc, anns);
assert.ok(html.includes('deixis-chip'));
assert.ok(html.includes('오일러 공식'));
assert.strictEqual((html.match(/deixis-chip/g) || []).length, 1);

console.log('test_deixis: ALL PASS');
