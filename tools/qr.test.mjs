import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const root = new URL('../', import.meta.url);

async function readProjectFile(path) {
	return readFile(new URL(path, root), 'utf8');
}

async function evaluateQr(source, expression, text) {
	const executable = source.replace(/export\s+/g, '') + `\nresult = ${expression};`;
	const context = { TextEncoder, Uint8Array, text, result: null };
	runInNewContext(executable, context);
	return context.result;
}

test('dependency-free QR encoder emits a square matrix for the complete share URL', async () => {
	const source = await readProjectFile('public/qr.js');
	const shareUrl = 'https://private-notes.example.workers.dev/share?t='
		+ `${'a'.repeat(43)}.${'b'.repeat(43)}.${'c'.repeat(43)}`
		+ `#v1.${'d'.repeat(43)}`;
	const matrix = await evaluateQr(source, 'createQrMatrix(text)', shareUrl);

	assert.ok(Array.isArray(matrix));
	assert.ok(matrix.length >= 21 && matrix.length <= 177);
	assert.equal(matrix.length % 4, 1);
	assert.ok(matrix.every((row) => Array.isArray(row) && row.length === matrix.length));
	assert.ok(matrix.every((row) => row.every((cell) => typeof cell === 'boolean')));
});

test('QR SVG contains only locally generated modules, not the secret URL text', async () => {
	const source = await readProjectFile('public/qr.js');
	const secretUrl = 'https://example.test/share?t=secret-token#v1.secret-fragment-key';
	const svg = await evaluateQr(source, 'createQrSvg(text)', secretUrl);

	assert.match(svg, /^<svg\b/);
	assert.match(svg, /role="img"/);
	assert.match(svg, /<title id="qrSvgTitle">二维码分享链接<\/title>/);
	assert.match(svg, /<path\b[^>]*d="M/);
	assert.doesNotMatch(svg, /secret-token|secret-fragment-key/);
});