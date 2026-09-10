import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const auth = fs.readFileSync(path.join(root, 'includes', 'auth.php'), 'utf8')
const quizAuth = fs.readFileSync(path.join(root, 'api', 'quiz_auth.php'), 'utf8')
const publications = JSON.parse(fs.readFileSync(path.join(root, 'data', 'publications.json'), 'utf8'))

assert.match(auth, /session\.cookie_domain.*\.map\.vnfest\.top/s, 'VNFestmap production sessions must cover both map hostnames')
assert.match(auth, /\['map\.vnfest\.top', 'www\.map\.vnfest\.top'\]/, 'cookie sharing must be limited to the two VNFestmap hosts')
assert.match(quizAuth, /\$origin === 'https:\/\/makoquiz\.vnfest\.top'/, 'quiz auth must keep the production Makoquiz CORS allowlist')
assert.ok(Array.isArray(publications.publications), 'publications.json must expose a publications array')

console.log('Discord/MarkQuiz domain contract passed')
