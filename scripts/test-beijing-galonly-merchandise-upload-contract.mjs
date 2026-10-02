import fs from 'node:fs';
import assert from 'node:assert/strict';

const pagePath = 'Galgame_events/Beijing_Galonly_merchandise.html';
const html = fs.readFileSync(pagePath, 'utf8');

function expect(pattern, message) {
  assert.match(html, pattern, message);
}

// The upload page must handle transient client/proxy failures without
// duplicating uploads after a successful response.
expect(/function\s+uploadRetryableStatus\s*\(/, 'upload retry status helper is missing');
expect(/function\s+uploadImage\s*\(file,\s*fileName,\s*attempt\)/, 'uploadImage must expose an attempt counter');
expect(/\b499\b/, 'client-disconnect status 499 must be treated as retryable');
expect(/attempt\s*<\s*2/, 'upload retries must be bounded');
expect(/(?:parseError|responseError)\.status\s*=\s*response\.status/, 'HTTP status must survive JSON response parsing');
expect(/uploadError\.status\s*=\s*200/, 'HTTP 200 business failures must not be retried');

// Returned paths may be local relative paths or absolute/object-storage URLs.
// All preview and canvas code must use one normalization helper.
expect(/function\s+resolveUploadImageUrl\s*\(/, 'upload image URL normalization helper is missing');
expect(/image\.src\s*=\s*resolveUploadImageUrl\(uploadedDisplayImagePath\)/, 'display preview bypasses upload URL normalization');
expect(/var\s+original\s*=\s*resolveUploadImageUrl\(path\)/, 'item preview bypasses upload URL normalization');
expect(/decodeImageForCanvas\(resolveUploadImageUrl\(firstImage\)\)/, 'auto display image bypasses upload URL normalization');

assert.doesNotMatch(
  html,
  /image\.src\s*=\s*'\.\/'\s*\+\s*uploadedDisplayImagePath/,
  'display preview must not blindly prefix an already absolute upload URL'
);
assert.doesNotMatch(
  html,
  /decodeImageForCanvas\('\.\/'\s*\+\s*firstImage\)/,
  'auto display image must not blindly prefix an already absolute upload URL'
);

console.log('Beijing GalOnly merchandise upload contract passed.');
