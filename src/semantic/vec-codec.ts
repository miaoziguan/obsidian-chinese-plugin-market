/**
 * 向量索引的紧凑二进制编解码（P3：int8 量化 + 二进制存储）。
 *
 * 背景：VectorIndex 原本以 `{ ids: string[], vectors: number[][], ... }` 整体
 * JSON 落盘。float32 向量序列化为 JSON 文本非常膨胀（1 个 1536 维 float 数组的
 * JSON 可达 ~6KB，1000 条即 ~6MB），且 JSON.parse/stringify 大对象又慢又占内存。
 *
 * 本模块把落盘改为：
 *   - int8 量化：把每维 float32 通过「全局 scale + zero-point」映射到 int8[-127,127]，
 *     体积降至 1/4，且保留足够的相对序用于 topK 召回（余弦在量化域误差极小）。
 *   - 紧凑二进制：去掉 JSON 的文本开销（数字逗号/引号/字段名），进一步压缩。
 *
 * 运行时（内存中）仍保留 float32 `number[][]` 向量做余弦，量化只在「落盘边界」
 * 发生，因此数学内核与既有测试完全不受影响。
 *
 * 二进制布局（小端）：
 *   [0]   magic  "PVIX"（4B）
 *   [4]   version   u8 = 1
 *   [5]   dim       u32
 *   [9]   idsCount  u32
 *   [13]  modelLen  u16 + model utf8
 *   [..]  hashLen   u16 + hash utf8
 *   [..]  hasSchema u8（0=无 categorySchemaVersion）
 *         [若 1] schemaLen u16 + schema utf8
 *   [..]  ids（idsCount 个）：idLen u16 + id utf8
 *   [..]  scale f32（全局量化比例）
 *   [..]  zero   f32（全局量化零点）
 *   [..]  quantized int8（idsCount × dim）
 */
import type { VectorIndex } from "@semantic/embedding";

/** 二进制魔法头 */
const MAGIC = "PVIX";
const VERSION = 1;

/** 量化到 int8 的取值范围（对称到 ±127，保留一位符号余量避免 -128 溢出） */
const Q_MAX = 127;

export class VectorCodecError extends Error {
	constructor(msg: string) {
		super(`向量索引编解码失败：${msg}`);
		this.name = "VectorCodecError";
	}
}

/**
 * 单条向量 int8 量化 → BLOB。布局：scale(f32) + zero(f32) + int8[dim]。
 * 供 SQLite 向量库按行存储（每行独立 scale/zero，保留足够相对序用于 topK）。
 */
export function quantizeVec(v: number[] | Float32Array): Uint8Array {
	const dim = v.length;
	let min = Infinity;
	let max = -Infinity;
	for (let i = 0; i < dim; i++) {
		const x = v[i];
		if (x < min) min = x;
		if (x > max) max = x;
	}
	const range = max - min;
	const scale = range === 0 ? 1 : range / (2 * Q_MAX);
	const zero = range === 0 ? 0 : -min / scale - Q_MAX;

	const out = new Uint8Array(8 + dim);
	const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
	dv.setFloat32(0, scale, true);
	dv.setFloat32(4, zero, true);
	for (let i = 0; i < dim; i++) {
		// 用 setInt8 写有符号 int8（Uint8Array 下标赋值会把负值按无符号存成 255+）
		dv.setInt8(8 + i, Math.round(v[i] / scale + zero));
	}
	return out;
}

/** 从 BLOB 反量化回 Float32Array（quantizeVec 的逆操作） */
export function dequantizeVec(blob: Uint8Array): Float32Array {
	if (blob.length < 9) throw new VectorCodecError("向量 BLOB 太短");
	const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	const scale = dv.getFloat32(0, true);
	const zero = dv.getFloat32(4, true);
	const dim = blob.length - 8;
	const out = new Float32Array(dim);
	for (let i = 0; i < dim; i++) {
		out[i] = (dv.getInt8(8 + i) - zero) * scale;
	}
	return out;
}

/** 把 VectorIndex 编码为紧凑二进制（int8 量化 + 紧凑布局） */
export function encodeVectorIndex(index: VectorIndex): ArrayBuffer {
	const dim = index.vectors.length > 0 ? index.vectors[0].length : 0;
	const ids = index.ids;
	const count = ids.length;

	// 计算全局 scale / zero-point（基于所有向量所有维度）
	let min = Infinity;
	let max = -Infinity;
	for (const v of index.vectors) {
		for (const x of v) {
			if (x < min) min = x;
			if (x > max) max = x;
		}
	}
	const range = max - min;
	const scale = range === 0 ? 1 : range / (2 * Q_MAX);
	// q = round(x/scale + zero)，把 [min,max] 映射到 [-127,127]：
	// x=min → round(-Q_MAX)，x=max → round(Q_MAX)
	const zero = range === 0 ? 0 : -min / scale - Q_MAX;

	const head = Buffer.alloc(4 + 1 + 4 + 4);
	head.write(MAGIC, 0, "ascii");
	head[4] = VERSION;
	head.writeUInt32LE(dim, 5);
	head.writeUInt32LE(count, 9);

	const parts: Buffer[] = [head];

	const str = (s: string) => {
		const b = Buffer.from(s, "utf-8");
		const len = Buffer.alloc(2);
		len.writeUInt16LE(b.length);
		return [len, b];
	};

	// model
	parts.push(...str(index.model || ""));
	// hash
	parts.push(...str(index.hash || ""));
	// categorySchemaVersion（可选）
	if (index.categorySchemaVersion) {
		const schema = Buffer.from(index.categorySchemaVersion, "utf-8");
		const hasSchema = Buffer.alloc(1);
		hasSchema[0] = 1;
		const len = Buffer.alloc(2);
		len.writeUInt16LE(schema.length);
		parts.push(hasSchema, len, schema);
	} else {
		const noSchema = Buffer.alloc(1);
		noSchema[0] = 0;
		parts.push(noSchema);
	}

	// ids
	for (const id of ids) parts.push(...str(id || ""));

	// scale + zero
	const sz = Buffer.alloc(8);
	sz.writeFloatLE(scale, 0);
	sz.writeFloatLE(zero, 4);
	parts.push(sz);

	// 量化向量：全部 int8，行优先
	const quant = Buffer.alloc(count * dim);
	let qi = 0;
	for (const v of index.vectors) {
		for (const x of v) {
			quant.writeInt8(Math.round(x / scale + zero), qi++);
		}
	}
	parts.push(quant);

	const out = Buffer.concat(parts);
	// 返回精确大小的 ArrayBuffer（兼容 Buffer 带 byteOffset 的情况）
	return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

/** 解码：把二进制还原为 VectorIndex（向量还原为 float32 number[][]） */
export function decodeVectorIndex(buf: ArrayBuffer): VectorIndex {
	const b = Buffer.from(buf);
	let off = 0;
	const read = (n: number): Buffer => {
		if (off + n > b.length) throw new VectorCodecError("数据不完整");
		const out = b.subarray(off, off + n);
		off += n;
		return out;
	};
	const readStr = (): string => {
		const len = read(2).readUInt16LE(0);
		return read(len).toString("utf-8");
	};

	if (read(4).toString("ascii") !== MAGIC) throw new VectorCodecError("魔法头不匹配（可能非二进制文件）");
	const version = read(1)[0];
	if (version !== VERSION) throw new VectorCodecError(`不支持版本 ${version}`);

	const dim = read(4).readUInt32LE(0);
	const count = read(4).readUInt32LE(0);
	const model = readStr();
	const hash = readStr();
	const hasSchema = read(1)[0];
	const categorySchemaVersion = hasSchema === 1 ? readStr() : undefined;

	const ids: string[] = [];
	for (let i = 0; i < count; i++) ids.push(readStr());

	const scale = read(4).readFloatLE(0);
	const zero = read(4).readFloatLE(0);

	// 反量化
	const vectors: number[][] = [];
	const byteLen = count * dim;
	const quant = read(byteLen);
	for (let r = 0; r < count; r++) {
		const row: number[] = [];
		for (let c = 0; c < dim; c++) {
			const q = quant.readInt8(r * dim + c);
			row.push((q - zero) * scale);
		}
		vectors.push(row);
	}

	return { ids, vectors, hash, model, categorySchemaVersion };
}
