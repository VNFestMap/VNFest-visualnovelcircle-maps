import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

// exam/ 目录与文件（改名自 trial/）
assert.ok(fs.existsSync(path.join(root, 'exam/index.html')), 'exam/index.html must exist');
assert.ok(fs.existsSync(path.join(root, 'exam/exam.js')), 'exam/exam.js must exist');
assert.ok(fs.existsSync(path.join(root, 'exam/exam.css')), 'exam/exam.css must exist');

const examJs = read('exam/exam.js');
assert.ok(!examJs.includes('#/manage'), 'exam.js must not keep the removed manage route');
assert.ok(!examJs.includes('renderManage'), 'exam.js must not keep the removed manage view renderer');
assert.ok(!examJs.includes('achievements.html'), 'exam.js must point to the user center achievements tab, not the removed page');
assert.ok(examJs.includes('user.html?tab=achievements'), 'exam.js must link the user center achievements tab');
assert.ok(examJs.includes('知识考核'), 'exam.js should use the renamed assessment type label');

// 考核页面接入海报主题与站点主题运行时
const examHtml = read('exam/index.html');
assert.match(examHtml, /js\/theme-runtime\.js/, 'exam page must load the shared theme runtime');
assert.match(examHtml, /css\/galonly-poster-theme\.css/, 'exam page must load the GalOnly poster theme');
assert.match(examHtml, /exam\.css/, 'exam page must keep loading exam.css after the poster theme');

const verifyHtml = read('verify.html');
assert.match(verifyHtml, /js\/theme-runtime\.js/, 'verify page must load the shared theme runtime');
assert.match(verifyHtml, /css\/galonly-poster-theme\.css/, 'verify page must load the GalOnly poster theme');
assert.match(verifyHtml, /exam\/exam\.css/, 'verify page must reuse exam.css');

// 旧路径重定向 stub
const trialStub = read('trial/index.html');
assert.match(trialStub, /exam\/index\.html/, 'trial stub must redirect to exam/index.html');
assert.match(trialStub, /location\.replace|location\.href/, 'trial stub must include a JS redirect fallback');

const achievementsStub = read('achievements.html');
assert.match(achievementsStub, /user\.html\?tab=achievements/, 'achievements stub must redirect to the user center achievements tab');
assert.ok(!fs.existsSync(path.join(root, 'js/achievements.js')), 'legacy js/achievements.js must be removed');

console.log('exam rename contract tests passed');
