/**
 * SQLite 向量库（真 SQLite，sql.js / WASM）。
 *
 * 借鉴 vault-curate 的 SQLiteStore 门面模式：
 *   - 所有 SQL 封装在本模块，消费方不触碰 raw db.exec；
 *   - PersistAdapter 注入（read/write/exists），不直接依赖 Obsidian adapter，方便测试；
 *   - 持久化防抖：每 100 次变更或 30s 空闲才整库导出写盘（sql.js 无增量写）。
 *
 * 表结构：
 *   plugins(id TEXT PRIMARY KEY, vec BLOB, category TEXT, tags TEXT)
 *     - vec 为 int8 量化 BLOB（scale+zero+int8[]，见 vec-codec.quantizeVec）
 *   meta(key TEXT PRIMARY KEY, value TEXT) —— 存 model / hash / schema 版本
 *
 * 定位：替代原先「整个 VectorIndex 存一份 JSON/二进制文件」的旧方式。
 * 对插件市场这种「写入低频（索引重建时）、读取频繁（搜索时）」的模式很合适。
 */
import type { Database, SqlJsStatic } from "sql.js";
import { quantizeVec, dequantizeVec, VectorCodecError } from "./vec-codec";

/** 持久化适配器（由调用方注入，通常是 Obsidian vault.adapter） */
export interface PersistAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<Uint8Array>;
	write(path: string, bytes: Uint8Array): Promise<void>;
}

/** 写入的插件向量行 */
export interface VecRow {
	id: string;
	vec: number[] | Float32Array;
	category?: string | null;
	tags?: string[] | null;
}

const MUTATION_THRESHOLD = 100;
const IDLE_FLUSH_MS = 30_000;

/** 用 sql.js 运行时初始化（wasmBinary 由调用方用 Obsidian requestUrl/adapter 读入，绕开 CORS） */
export async function initSqlJsStatic(
	wasmBinary: Uint8Array,
	sqlJsModule: typeof import("sql.js"),
): Promise<SqlJsStatic> {
	const ab = new ArrayBuffer(wasmBinary.byteLength);
	new Uint8Array(ab).set(wasmBinary);
	return await sqlJsModule.default({ wasmBinary: ab });
}

export class SqliteVectorStore {
	private db!: Database;
	private mutationCount = 0;
	private idleTimer: number | null = null;
	private flushInFlight: Promise<void> | null = null;
	private disposed = false;
	/** 内容版本号，任何变更自增（供上层判断是否需要重建下游结构） */
	private revision = 0;

	private constructor(
		private readonly adapter: PersistAdapter,
		private readonly dbPath: string,
	) {}

	static async open(
		adapter: PersistAdapter,
		dbPath: string,
		sql: SqlJsStatic,
	): Promise<SqliteVectorStore> {
		const store = new SqliteVectorStore(adapter, dbPath);
		const bytes = (await adapter.exists(dbPath)) ? await adapter.read(dbPath) : null;
		store.db = bytes && bytes.length > 0 ? new sql.Database(bytes) : new sql.Database();
		store.applySchema();
		return store;
	}

	private applySchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS plugins (
				id TEXT PRIMARY KEY,
				vec BLOB NOT NULL,
				category TEXT,
				tags TEXT
			);
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT
			);
		`);
	}

	// ── Meta ─────────────────────────────────────────────────────────────

	getMeta(key: string): string | null {
		const res = this.db.exec("SELECT value FROM meta WHERE key = ?", [key]);
		if (res.length === 0 || res[0].values.length === 0) return null;
		return res[0].values[0][0] as string;
	}

	setMeta(key: string, value: string): void {
		if (this.disposed) return;
		this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value]);
		this.touch();
	}

	// ── 向量写入 / 读取 ──────────────────────────────────────────────────

	/** 全量重建：清空 plugins 并插入所有行（索引重建用）。 */
	replaceAll(rows: VecRow[]): void {
		if (this.disposed) return;
		this.db.exec("DELETE FROM plugins");
		if (rows.length === 0) {
			this.touch();
			return;
		}
		const stmt = this.db.prepare(
			"INSERT INTO plugins (id, vec, category, tags) VALUES (?, ?, ?, ?)"
		);
		try {
			for (const r of rows) {
				stmt.run([
					r.id,
					quantizeVec(r.vec),
					r.category ?? null,
					r.tags && r.tags.length ? JSON.stringify(r.tags) : null,
				]);
			}
		} finally {
			stmt.free();
		}
		this.touch();
	}

	/**
	 * 增量写入：仅插入/更新给定行（按 id 主键 INSERT OR REPLACE），不动其余行。
	 * 用于「插件列表变动」场景——只写新增/内容指纹变化的 id，避免全表 DELETE+重插。
	 * 复用现有 touch() 防抖落盘，不破坏 replaceAll 的整库重建语义。
	 */
	upsertMany(rows: VecRow[]): void {
		if (this.disposed || rows.length === 0) return;
		const stmt = this.db.prepare(
			"INSERT OR REPLACE INTO plugins (id, vec, category, tags) VALUES (?, ?, ?, ?)"
		);
		try {
			for (const r of rows) {
				stmt.run([
					r.id,
					quantizeVec(r.vec),
					r.category ?? null,
					r.tags && r.tags.length ? JSON.stringify(r.tags) : null,
				]);
			}
		} finally {
			stmt.free();
		}
		this.touch();
	}

	/**
	 * 删除给定 id 的行（插件被移除时增量清理）。不存在的 id 忽略。
	 */
	deleteMany(ids: string[]): void {
		if (this.disposed || ids.length === 0) return;
		const stmt = this.db.prepare("DELETE FROM plugins WHERE id = ?");
		try {
			for (const id of ids) stmt.run([id]);
		} finally {
			stmt.free();
		}
		this.touch();
	}

	/** 读取全部插件向量，返回 Map<id, Float32Array>（反量化）。空库返回空 Map。 */
	getAllVecs(): Map<string, Float32Array> {
		const out = new Map<string, Float32Array>();
		const tSql = Date.now();
		const res = this.db.exec("SELECT id, vec FROM plugins");
		const sqlMs = Date.now() - tSql;
		if (res.length === 0) {
			console.debug(`[Chinese Plugin Market] 探针：getAllVecs SQL 查询 ${sqlMs}ms（空库）`);
			return out;
		}
		const tDeq = Date.now();
		for (const row of res[0].values) {
			out.set(row[0] as string, dequantizeVec(row[1] as Uint8Array));
		}
		console.debug(`[Chinese Plugin Market] 探针：getAllVecs SQL=${sqlMs}ms · 反量化 ${out.size} 条=${Date.now() - tDeq}ms`);
		return out;
	}

	getAllRows(): { id: string; category: string | null; tags: string[] }[] {
		const res = this.db.exec("SELECT id, category, tags FROM plugins");
		if (res.length === 0) return [];
		return res[0].values.map((row) => ({
			id: row[0] as string,
			category: (row[1] as string) ?? null,
			tags: row[2] ? JSON.parse(row[2] as string) : [],
		}));
	}

	count(): number {
		const res = this.db.exec("SELECT COUNT(*) FROM plugins");
		if (res.length === 0 || res[0].values.length === 0) return 0;
		return res[0].values[0][0] as number;
	}

	// ── 持久化（防抖） ───────────────────────────────────────────────────

	/** 内容版本号：任何变更自增 */
	getRevision(): number {
		return this.revision;
	}

	private touch(force = false): void {
		this.revision++;
		this.mutationCount++;
		if (this.idleTimer) {
			window.clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (force || this.mutationCount >= MUTATION_THRESHOLD) {
			void this.flush();
		} else {
			this.idleTimer = window.setTimeout(() => void this.flush(), IDLE_FLUSH_MS);
		}
	}

	/** 强制写盘（整库导出）。返回写入完成。 */
	async flush(): Promise<void> {
		if (this.disposed) return;
		if (this.flushInFlight) return this.flushInFlight;
		this.flushInFlight = (async () => {
			try {
				if (this.idleTimer) {
					window.clearTimeout(this.idleTimer);
					this.idleTimer = null;
				}
				const bytes = this.db.export();
				await this.adapter.write(this.dbPath, bytes);
				this.mutationCount = 0;
			} finally {
				this.flushInFlight = null;
			}
		})();
		return this.flushInFlight;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.idleTimer) {
			window.clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (this.mutationCount > 0) await this.flush();
		try {
			this.db.close();
		} catch {
			/* already closed */
		}
	}
}

// 兼容导出（避免未使用告警）
export { VectorCodecError };
