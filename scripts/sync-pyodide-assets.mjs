import { mkdir, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const srcDir = path.join(repoRoot, 'node_modules', 'pyodide');
const destDir = path.join(repoRoot, 'static', 'pyodide', 'v0.29.3');

const filesToCopy = [
	'pyodide.mjs',
	'pyodide.asm.js',
	'pyodide.asm.wasm',
	'python_stdlib.zip',
	'pyodide-lock.json',
	'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl',
	'mpmath-1.3.0-py3-none-any.whl',
	'sympy-1.13.3-py3-none-any.whl'
];

async function ensureReadable(filePath) {
	try {
		await access(filePath);
	} catch {
		throw new Error(`Missing required Pyodide asset: ${filePath}`);
	}
}

async function run() {
	await mkdir(destDir, { recursive: true });

	for (const fileName of filesToCopy) {
		const srcPath = path.join(srcDir, fileName);
		const destPath = path.join(destDir, fileName);
		await ensureReadable(srcPath);
		await copyFile(srcPath, destPath);
	}

	console.log(`[sync-pyodide-assets] copied ${filesToCopy.length} files to ${destDir}`);
}

run().catch((error) => {
	console.error('[sync-pyodide-assets] failed:', error);
	process.exitCode = 1;
});
