'use strict';
// Compila native/ponte-audio.cpp com o MSVC (Visual Studio 2022 ou Build Tools).
// Uso: npm run native
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') {
  console.log('ponte-audio só existe no Windows; pulando.');
  process.exit(0);
}

const root = path.join(__dirname, '..');
const src = path.join(root, 'native', 'ponte-audio.cpp');
const outDir = path.join(root, 'native', 'bin');
fs.mkdirSync(outDir, { recursive: true });

const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const vs = execFileSync(vswhere, [
  '-latest', '-products', '*',
  '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '-property', 'installationPath',
], { encoding: 'utf8' }).trim();
if (!vs) throw new Error('Não encontrei o compilador C++ do Visual Studio.');
const vcvars = path.join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');

const cmd = [
  `call "${vcvars}" >nul`,
  `cl /nologo /std:c++17 /O2 /EHsc /utf-8 /MT /DUNICODE /D_UNICODE "${src}" /Fe:"${path.join(outDir, 'ponte-audio.exe')}" /Fo:"${outDir}\\\\"`,
].join(' && ');
execFileSync('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { stdio: 'inherit', windowsVerbatimArguments: true });
for (const f of fs.readdirSync(outDir)) if (f.endsWith('.obj')) fs.rmSync(path.join(outDir, f));
console.log('native/bin/ponte-audio.exe pronto');
