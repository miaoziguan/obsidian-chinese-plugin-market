/**
 * 版本号比较（语义化版本的极简实现）。
 *
 * 原为 view-data.ts 内部的私有函数，抽出到 shared 供「依赖状态判定」与
 * 「可更新检测」共用，避免同一份逻辑出现两个实现、两份漂移。
 *
 * 规则：忽略前缀 v；按 `.` 分段逐段数值比较；段数不等时缺位补 0；
 * 非数字段按 0 处理（README / manifest 里的版本号写法很野，不能因为一个
 * 脏字符就让整条依赖判定抛错）。
 *
 * @returns a > b 为 1，a < b 为 -1，相等为 0
 */
export function compareVersion(a: string, b: string): number {
	const pa = a.replace(/^v/i, "").split(".");
	const pb = b.replace(/^v/i, "").split(".");
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		const x = parseInt(pa[i] ?? "0", 10) || 0;
		const y = parseInt(pb[i] ?? "0", 10) || 0;
		if (x !== y) return x > y ? 1 : -1;
	}
	return 0;
}
