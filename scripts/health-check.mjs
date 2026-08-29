import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { extname, join, relative } from 'path';
import vm from 'vm';

const ROOT = join(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['.git', '_local', 'node_modules', 'dist', 'www', 'android']);

const files = [];
const failures = [];

function walk(dir) {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}

function runCheck(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    failures.push({
      label,
      output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
    });
  }
}

function checkInlineScripts(file) {
  const html = readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];

  scripts.forEach((match, index) => {
    const attributes = match[1] || '';
    const source = match[2] || '';
    const typeMatch = attributes.match(/\btype\s*=\s*(['"]?)([^'">\s]+)\1/i);
    const scriptType = (typeMatch?.[2] || '').toLowerCase();
    const isModule = scriptType === 'module';
    if (scriptType === 'importmap' || scriptType.includes('json')) {
      try {
        JSON.parse(source);
      } catch (error) {
        failures.push({
          label: `html inline json: ${relative(ROOT, file)}#${index + 1}`,
          output: error.stack || String(error),
        });
      }
      return;
    }
    if (scriptType && !isModule && scriptType !== 'text/javascript' && scriptType !== 'application/javascript') {
      return;
    }
    if (isModule) {
      const result = spawnSync('node', ['--input-type=module', '--check', '-'], {
        cwd: ROOT,
        encoding: 'utf8',
        input: source,
      });
      if (result.status !== 0) {
        failures.push({
          label: `html inline module: ${relative(ROOT, file)}#${index + 1}`,
          output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
        });
      }
      return;
    }
    try {
      new vm.Script(source, {
        filename: `${relative(ROOT, file)}#script${index + 1}`,
      });
    } catch (error) {
      failures.push({
        label: `html inline script: ${relative(ROOT, file)}#${index + 1}`,
        output: error.stack || String(error),
      });
    }
  });

  return scripts.length;
}

walk(ROOT);

let phpCount = 0;
let jsCount = 0;
let htmlCount = 0;
let inlineScriptCount = 0;

for (const file of files) {
  const ext = extname(file);
  if (ext === '.php') {
    phpCount++;
    runCheck(`php lint: ${relative(ROOT, file)}`, 'php', ['-l', file]);
  } else if (ext === '.js' || ext === '.mjs') {
    jsCount++;
    runCheck(`node syntax: ${relative(ROOT, file)}`, 'node', ['--check', file]);
  } else if (ext === '.html') {
    htmlCount++;
    inlineScriptCount += checkInlineScripts(file);
  }
}

if (failures.length > 0) {
  console.error('\nHealth check failed:\n');
  for (const failure of failures) {
    console.error(`- ${failure.label}`);
    if (failure.output) {
      console.error(failure.output);
    }
    console.error('');
  }
  process.exit(1);
}

console.log('Health check passed.');
console.log(`PHP files: ${phpCount}`);
console.log(`JS/MJS files: ${jsCount}`);
console.log(`HTML files: ${htmlCount}`);
console.log(`Inline scripts: ${inlineScriptCount}`);
