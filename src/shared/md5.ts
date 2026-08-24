/**
 * 零依赖 MD5 实现（同步、纯 JS，不依赖 node:crypto / Web Crypto）。
 *
 * 选型背景：百度通用翻译 API 的签名算法固定为 MD5(appid + q + salt + key)，
 * 而 Web Crypto（crypto.subtle）并不提供 MD5，node:crypto 在浏览器打包环境
 * （E2E / Playwright）又无法解析。为避免环境差异，这里用一份与 Node 实现字节级
 * 一致的纯函数实现，Obsidian（Electron）、浏览器、Node 测试三处通用。
 *
 * 实现参考 RFC 1321，采用社区广泛验证的位运算写法（与 blueimp/JavaScript-MD5 一致）。
 */

function rotateLeft(lValue: number, iShiftBits: number): number {
	return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
}

function addUnsigned(lX: number, lY: number): number {
	const lX4 = lX & 0x40000000;
	const lY4 = lY & 0x40000000;
	const lX8 = lX & 0x80000000;
	const lY8 = lY & 0x80000000;
	const lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
	if (lX4 & lY4) return (lResult ^ 0x80000000 ^ lX8 ^ lY8) >>> 0;
	if (lX4 | lY4) {
		if (lResult & 0x40000000) return (lResult ^ 0xc0000000 ^ lX8 ^ lY8) >>> 0;
		else return (lResult ^ 0x40000000 ^ lX8 ^ lY8) >>> 0;
	}
	return (lResult ^ lX8 ^ lY8) >>> 0;
}

function F(x: number, y: number, z: number): number {
	return (x & y) | (~x & z);
}
function G(x: number, y: number, z: number): number {
	return (x & z) | (y & ~z);
}
function H(x: number, y: number, z: number): number {
	return x ^ y ^ z;
}
function I(x: number, y: number, z: number): number {
	return y ^ (x | ~z);
}

function FF(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
	a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
	return addUnsigned(rotateLeft(a, s), b);
}
function GG(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
	a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
	return addUnsigned(rotateLeft(a, s), b);
}
function HH(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
	a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
	return addUnsigned(rotateLeft(a, s), b);
}
function II(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
	a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
	return addUnsigned(rotateLeft(a, s), b);
}

function utf8Encode(str: string): number[] {
	const bytes: number[] = [];
	for (let i = 0; i < str.length; i++) {
		let code = str.charCodeAt(i);
		if (code < 0x80) {
			bytes.push(code);
		} else if (code < 0x800) {
			bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const hi = code;
			const lo = str.charCodeAt(++i);
			code = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
			bytes.push(
				0xf0 | (code >> 18),
				0x80 | ((code >> 12) & 0x3f),
				0x80 | ((code >> 6) & 0x3f),
				0x80 | (code & 0x3f)
			);
		} else {
			bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		}
	}
	return bytes;
}

function convertToWordArrayFromBytes(bytes: number[]): number[] {
	const messageLength = bytes.length;
	const numberOfWords = (((messageLength + 8) >> 6) + 1) * 16;
	const words: number[] = Array.from({ length: numberOfWords }, () => 0);
	let j = 0;
	for (let i = 0; i < messageLength; i++) {
		words[j >>> 2] |= bytes[i] << ((j % 4) * 8);
		j++;
	}
	words[j >>> 2] |= 0x80 << ((j % 4) * 8);
	words[numberOfWords - 2] = (messageLength << 3) & 0xffffffff;
	words[numberOfWords - 1] = (messageLength >>> 29) & 0xffffffff;
	return words;
}

function wordToHex(lValue: number): string {
	let word = "";
	for (let i = 0; i <= 3; i++) {
		let byte = (lValue >>> (i * 8)) & 255;
		word += ("0" + byte.toString(16)).slice(-2);
	}
	return word;
}

const S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = [
	0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8,
	0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
	0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87,
	0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
	0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039,
	0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
	0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
	0xeb86d391,
];

/** 计算 UTF-8 字符串的 MD5，返回 32 位小写十六进制串（与 node:crypto 的 md5 字节级一致）。 */
export function md5Hex(input: string): string {
	// 百度服务端按 UTF-8 字节计算签名：先转 UTF-8 字节再喂给算法，
	// 确保与 node:crypto update(str,'utf8') 在任意字符下都一致。
	const bytes = utf8Encode(input);
	const x = convertToWordArrayFromBytes(bytes);
	let a = 0x67452301;
	let b = 0xefcdab89;
	let c = 0x98badcfe;
	let d = 0x10325476;

	for (let k = 0; k < x.length; k += 16) {
		const AA = a;
		const BB = b;
		const CC = c;
		const DD = d;

		a = FF(a, b, c, d, x[k], S[0], K[0]);
		d = FF(d, a, b, c, x[k + 1], S[1], K[1]);
		c = FF(c, d, a, b, x[k + 2], S[2], K[2]);
		b = FF(b, c, d, a, x[k + 3], S[3], K[3]);
		a = FF(a, b, c, d, x[k + 4], S[4], K[4]);
		d = FF(d, a, b, c, x[k + 5], S[5], K[5]);
		c = FF(c, d, a, b, x[k + 6], S[6], K[6]);
		b = FF(b, c, d, a, x[k + 7], S[7], K[7]);
		a = FF(a, b, c, d, x[k + 8], S[8], K[8]);
		d = FF(d, a, b, c, x[k + 9], S[9], K[9]);
		c = FF(c, d, a, b, x[k + 10], S[10], K[10]);
		b = FF(b, c, d, a, x[k + 11], S[11], K[11]);
		a = FF(a, b, c, d, x[k + 12], S[12], K[12]);
		d = FF(d, a, b, c, x[k + 13], S[13], K[13]);
		c = FF(c, d, a, b, x[k + 14], S[14], K[14]);
		b = FF(b, c, d, a, x[k + 15], S[15], K[15]);

		a = GG(a, b, c, d, x[k + 1], S[16], K[16]);
		d = GG(d, a, b, c, x[k + 6], S[17], K[17]);
		c = GG(c, d, a, b, x[k + 11], S[18], K[18]);
		b = GG(b, c, d, a, x[k], S[19], K[19]);
		a = GG(a, b, c, d, x[k + 5], S[20], K[20]);
		d = GG(d, a, b, c, x[k + 10], S[21], K[21]);
		c = GG(c, d, a, b, x[k + 15], S[22], K[22]);
		b = GG(b, c, d, a, x[k + 4], S[23], K[23]);
		a = GG(a, b, c, d, x[k + 9], S[24], K[24]);
		d = GG(d, a, b, c, x[k + 14], S[25], K[25]);
		c = GG(c, d, a, b, x[k + 3], S[26], K[26]);
		b = GG(b, c, d, a, x[k + 8], S[27], K[27]);
		a = GG(a, b, c, d, x[k + 13], S[28], K[28]);
		d = GG(d, a, b, c, x[k + 2], S[29], K[29]);
		c = GG(c, d, a, b, x[k + 7], S[30], K[30]);
		b = GG(b, c, d, a, x[k + 12], S[31], K[31]);

		a = HH(a, b, c, d, x[k + 5], S[32], K[32]);
		d = HH(d, a, b, c, x[k + 8], S[33], K[33]);
		c = HH(c, d, a, b, x[k + 11], S[34], K[34]);
		b = HH(b, c, d, a, x[k + 14], S[35], K[35]);
		a = HH(a, b, c, d, x[k + 1], S[36], K[36]);
		d = HH(d, a, b, c, x[k + 4], S[37], K[37]);
		c = HH(c, d, a, b, x[k + 7], S[38], K[38]);
		b = HH(b, c, d, a, x[k + 10], S[39], K[39]);
		a = HH(a, b, c, d, x[k + 13], S[40], K[40]);
		d = HH(d, a, b, c, x[k], S[41], K[41]);
		c = HH(c, d, a, b, x[k + 3], S[42], K[42]);
		b = HH(b, c, d, a, x[k + 6], S[43], K[43]);
		a = HH(a, b, c, d, x[k + 9], S[44], K[44]);
		d = HH(d, a, b, c, x[k + 12], S[45], K[45]);
		c = HH(c, d, a, b, x[k + 15], S[46], K[46]);
		b = HH(b, c, d, a, x[k + 2], S[47], K[47]);

		a = II(a, b, c, d, x[k], S[48], K[48]);
		d = II(d, a, b, c, x[k + 7], S[49], K[49]);
		c = II(c, d, a, b, x[k + 14], S[50], K[50]);
		b = II(b, c, d, a, x[k + 5], S[51], K[51]);
		a = II(a, b, c, d, x[k + 12], S[52], K[52]);
		d = II(d, a, b, c, x[k + 3], S[53], K[53]);
		c = II(c, d, a, b, x[k + 10], S[54], K[54]);
		b = II(b, c, d, a, x[k + 1], S[55], K[55]);
		a = II(a, b, c, d, x[k + 8], S[56], K[56]);
		d = II(d, a, b, c, x[k + 15], S[57], K[57]);
		c = II(c, d, a, b, x[k + 6], S[58], K[58]);
		b = II(b, c, d, a, x[k + 13], S[59], K[59]);
		a = II(a, b, c, d, x[k + 4], S[60], K[60]);
		d = II(d, a, b, c, x[k + 11], S[61], K[61]);
		c = II(c, d, a, b, x[k + 2], S[62], K[62]);
		b = II(b, c, d, a, x[k + 9], S[63], K[63]);

		a = addUnsigned(a, AA);
		b = addUnsigned(b, BB);
		c = addUnsigned(c, CC);
		d = addUnsigned(d, DD);
	}

	return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
}
