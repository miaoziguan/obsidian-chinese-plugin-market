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
import { logger } from "@shared/logger";
import { quantizeVec, dequantizeVec, VectorCodecError } from "@semantic/vec-codec";

/** 持久化适配器（由调用方注入，通常是 Obsidian vault.adapter） */
export interface PersistAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<Uint8Array>;
	write(path: string, bytes: Uint8Array): Promise<void>;
	/** 删除文件（可选；盘上库损坏自愈需要）。不提供时不执行自愈。 */
	delete?(path: string): Promise<void>;
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
		try {
			// 注意：sql.js 构造 DB 对象时惰性解析，损坏常在执行首条 SQL（applySchema）时
			// 才暴露（如 "file is not a database" / "database disk image is malformed"），
			// 故需把 applySchema 一并纳入 try。
			store.db = bytes && bytes.length > 0 ? new sql.Database(bytes) : new sql.Database();
			store.applySchema();
		} catch (e: unknown) {
			const msg = (e as Error)?.message || String(e);
			// 盘上文件损坏：删除后以空库重建，当次会话的索引重建会经 saveVectorIndex
			// 重新落盘，而非永久降级内存索引。
			if (bytes && bytes.length > 0 && adapter.delete &&
				/malformed|not a database|disk image/i.test(msg)) {
				logger.warn(`[Chinese Plugin Market] 向量库文件损坏，删除后重建空库: ${dbPath}`);
				try { await adapter.delete(dbPath); } catch { /* 删除失败则保留原错误 */ }
				// 覆盖引用前先关闭上一个实例：applySchema() 抛错时 store.db 已是一个
				// 完整 Database，直接覆盖会让它的 WASM 堆内存永不回收。
				try { store.db?.close(); } catch { /* 关闭失败不影响重建 */ }
				store.db = new sql.Database();
				store.applySchema();
			} else {
				throw e;
			}
		}
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

	/** 全量重建：清空 plugins 并插入所有行（索引重建用）。包事务提速（PERF-13）。 */
	replaceAll(rows: VecRow[]): void {
		if (this.disposed) return;
		// PERF-13：批量写入包事务，避免 sql.js 每条语句自动提交的开销（全量重建数千行提速约 2-5 倍）
		this.db.exec("BEGIN");
		try {
			this.db.exec("DELETE FROM plugins");
			if (rows.length > 0) {
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
			}
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
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
		// PERF-13：批量增量写入同样包事务，避免逐条自动提交
		this.db.exec("BEGIN");
		try {
			for (const r of rows) {
				stmt.run([
					r.id,
					quantizeVec(r.vec),
					r.category ?? null,
					r.tags && r.tags.length ? JSON.stringify(r.tags) : null,
				]);
			}
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
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
		this.db.exec("BEGIN");
		try {
			for (const id of ids) stmt.run([id]);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
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
			logger.debug(`[Chinese Plugin Market] 探针：getAllVecs SQL 查询 ${sqlMs}ms（空库）`);
			return out;
		}
		const tDeq = Date.now();
		for (const row of res[0].values) {
			// 反量化原样返回（存储层保持通用契约：调用方决定是否需要归一化，
			// 见 plugin.ts loadVectorIndex 加载索引时对召回向量做归一化，#28）
			out.set(row[0] as string, dequantizeVec(row[1] as Uint8Array));
		}
		logger.debug(`[Chinese Plugin Market] 探针：getAllVecs SQL=${sqlMs}ms · 反量化 ${out.size} 条=${Date.now() - tDeq}ms`);
		return out;
	}

	getAllRows(): { id: string; category: string | null; tags: string[] }[] {
		const res = this.db.exec("SELECT id, category, tags FROM plugins");
		if (res.length === 0) return [];
		return res[0].values.map((row) => ({
			id: row[0] as string,
			category: (row[1] as string) ?? null,
			tags: row[2] ? (JSON.parse(row[2] as string) as string[]) : [],
		}));
	}

	count(): number {
		const res = this.db.exec("SELECT COUNT(*) FROM plugins");
		if (res.length === 0 || res[0].values.length === 0) return 0;
		return res[0].values[0][0] as number;
	}

	// ── 持久化（防抖） ───────────────────────────────────────────────────

	/**
	 * 触发一次写盘并吞掉失败（仅记日志）。
	 * 直接用 `void this.flush()` 会在 adapter.write 失败（磁盘满/vault 锁定/移动端权限）
	 * 时产生未处理的 Promise 拒绝；写盘失败不丢数据（mutationCount 未清零，
	 * finally 会重新挂 idleTimer 重试），但必须避免 unhandledrejection 噪声。
	 */
	private flushQuietly(): void {
		void this.flush().catch((e: unknown) => {
			logger.warn("[Chinese Plugin Market] 向量库写盘失败：", e);
		});
	}

	private touch(force = false): void {
		this.mutationCount++;
		if (this.idleTimer) {
			window.clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (force || this.mutationCount >= MUTATION_THRESHOLD) {
			this.flushQuietly();
		} else {
			this.idleTimer = window.setTimeout(() => this.flushQuietly(), IDLE_FLUSH_MS);
		}
	}

	/** 强制写盘（整库导出）。返回写入完成。 */
	async flush(): Promise<void> {
		if (this.disposed) return;
		if (this.flushInFlight) return this.flushInFlight;
		await this.flushNow();
	}

	/**
	 * 真正执行一次导出写盘（private，不做 disposed 短路，供 dispose() 收尾调用）。
	 *
	 * 为什么不能直接在 dispose 里 await flush()：dispose 若先把 disposed 置 true，
	 * flush 首行的 `if (this.disposed) return;` 会让它空转，本应冲刷的增量全部丢失。
	 */
	private async flushNow(): Promise<void> {
		if (this.flushInFlight) return this.flushInFlight;
		this.flushInFlight = (async () => {
			// 记录本轮起点，用于「导出期间新到的变更」计数结转。
			// 反例：直接 `this.mutationCount = 0` 会把 await adapter.write 期间发生的
			// insert/update 计数一并抹掉 —— 这部分行不在本次导出的 bytes 里，却再也
			// 没有任何写盘触发器（idleTimer 已清、未达阈值）→ 数据静默丢。
			const mark = this.mutationCount;
			try {
				if (this.idleTimer) {
					window.clearTimeout(this.idleTimer);
					this.idleTimer = null;
				}
				const bytes = this.db.export();
				await this.adapter.write(this.dbPath, bytes);
				this.mutationCount = Math.max(0, this.mutationCount - mark);
			} finally {
				this.flushInFlight = null;
				// touch() 在 adapter.write 的 await 窗口内可能已经累积了新变更。
				// 若当时达到阈值，touch() 只能看到 in-flight 而复用旧 Promise，不能
				// 自动开启下一轮；这里在本轮结束后补上阈值 flush 或空闲定时器。
				if (!this.disposed && this.mutationCount > 0) {
					if (this.idleTimer) {
						window.clearTimeout(this.idleTimer);
						this.idleTimer = null;
					}
					if (this.mutationCount >= MUTATION_THRESHOLD) {
						this.flushQuietly();
					} else {
						this.idleTimer = window.setTimeout(() => this.flushQuietly(), IDLE_FLUSH_MS);
					}
				}
			}
		})();
		return this.flushInFlight;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		// 顺序铁律：先冲刷未落盘的变更，再置 disposed。
		// 反例：先置 disposed 会让 flush() 被自身的 `if (this.disposed) return` 短路 →
		// 未达 100 次阈值（或尚未到 30s 空闲）的增量在插件卸载时被静默丢弃。
		try {
			if (this.mutationCount > 0) await this.flushNow();
			// 写盘期间可能又累积了新变更（await 窗口）→ 再冲一轮，确保干净退出
			if (this.mutationCount > 0) await this.flushNow();
		} catch (e) {
			logger.warn("[Chinese Plugin Market] 向量库关闭前冲刷失败：", e);
		}
		this.disposed = true;
		if (this.idleTimer) {
			window.clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		try {
			this.db.close();
		} catch {
			/* already closed */
		}
	}
}

// 兼容导出（避免未使用告警）
export { VectorCodecError };
