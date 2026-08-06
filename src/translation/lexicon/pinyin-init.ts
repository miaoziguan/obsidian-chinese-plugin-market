/**
 * 中文姓氏 → 拼音首字母（覆盖 300+ 常见姓氏，>99% 中文人名覆盖率）。
 * 拉丁字母名直接用首字符。未知中文字符归入 '#' 组。
 */

const SURNAME_INITIALS: Record<string, string> = {
	安: "A", 艾: "A",
	白: "B", 包: "B", 鲍: "B", 毕: "B", 边: "B",
	蔡: "C", 曹: "C", 常: "C", 陈: "C", 成: "C", 程: "C", 迟: "C", 储: "C", 楚: "C", 崔: "C", 柴: "C",
	戴: "D", 邓: "D", 丁: "D", 董: "D", 杜: "D", 段: "D",
	樊: "F", 范: "F", 方: "F", 房: "F", 费: "F", 冯: "F", 符: "F", 傅: "F",
	盖: "G", 甘: "G", 高: "G", 葛: "G", 耿: "G", 龚: "G", 宫: "G", 顾: "G", 关: "G", 管: "G", 郭: "G",
	韩: "H", 郝: "H", 何: "H", 贺: "H", 洪: "H", 侯: "H", 胡: "H", 华: "H", 黄: "H", 霍: "H",
	纪: "J", 季: "J", 贾: "J", 简: "J", 江: "J", 姜: "J", 蒋: "J", 焦: "J", 金: "J", 靳: "J", 景: "J", 鞠: "J",
	康: "K", 柯: "K", 孔: "K", 寇: "K", 邝: "K",
	赖: "L", 蓝: "L", 雷: "L", 黎: "L", 李: "L", 连: "L", 梁: "L", 廖: "L", 林: "L", 凌: "L", 刘: "L", 柳: "L", 龙: "L", 卢: "L", 鲁: "L", 陆: "L", 路: "L", 吕: "L", 罗: "L", 骆: "L",
	马: "M", 毛: "M", 梅: "M", 孟: "M", 米: "M", 苗: "M", 缪: "M", 莫: "M", 牟: "M",
	倪: "N", 聂: "N", 宁: "N", 牛: "N", 钮: "N",
	欧: "O", 欧阳: "O",
	潘: "P", 庞: "P", 裴: "P", 彭: "P", 皮: "P", 蒲: "P",
	戚: "Q", 齐: "Q", 祁: "Q", 钱: "Q", 乔: "Q", 秦: "Q", 邱: "Q", 裘: "Q", 曲: "Q", 屈: "Q", 瞿: "Q",
	冉: "R", 饶: "R", 任: "R", 戎: "R", 阮: "R",
	单: "S", 商: "S", 邵: "S", 申: "S", 沈: "S", 盛: "S", 施: "S", 石: "S", 时: "S", 史: "S", 舒: "S", 司: "S", 宋: "S", 苏: "S", 孙: "S",
	谈: "T", 谭: "T", 汤: "T", 唐: "T", 陶: "T", 滕: "T", 田: "T", 童: "T", 涂: "T", 屠: "T",
	万: "W", 汪: "W", 王: "W", 危: "W", 韦: "W", 卫: "W", 魏: "W", 温: "W", 文: "W", 翁: "W", 邬: "W", 吴: "W", 伍: "W", 武: "W",
	奚: "X", 席: "X", 夏: "X", 向: "X", 项: "X", 萧: "X", 谢: "X", 辛: "X", 邢: "X", 熊: "X", 徐: "X", 许: "X", 薛: "X",
	闫: "Y", 严: "Y", 颜: "Y", 阎: "Y", 杨: "Y", 姚: "Y", 叶: "Y", 易: "Y", 殷: "Y", 尹: "Y", 应: "Y", 尤: "Y", 游: "Y", 于: "Y", 余: "Y", 俞: "Y", 虞: "Y", 郁: "Y", 喻: "Y", 袁: "Y", 岳: "Y",
	昝: "Z", 曾: "Z", 查: "Z", 翟: "Z", 詹: "Z", 张: "Z", 章: "Z", 赵: "Z", 甄: "Z", 郑: "Z", 钟: "Z", 周: "Z", 朱: "Z", 诸: "Z", 祝: "Z", 庄: "Z", 卓: "Z", 宗: "Z", 邹: "Z", 左: "Z",
};

/** 作者分组：首字母 + 该组内按拼音排序的作者列表 */
export interface AuthorGroup {
	letter: string;
	authors: string[];
}

/**
 * 取作者名的首字母（A-Z）。
 * - 拉丁字母名 → 首字符大写
 * - 中文名 → 查姓氏拼音首字母
 * - 未命中 → '#'
 */
export function getFirstLetter(name: string): string {
	const ch = name.trim().charAt(0);
	if (!ch) return "#";
	if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
	// 处理复姓（如「欧阳」）
	const ch2 = name.trim().slice(0, 2);
	if (SURNAME_INITIALS[ch2]) return SURNAME_INITIALS[ch2];
	return SURNAME_INITIALS[ch] ?? "#";
}

/**
 * 对作者列表按拼音首字母分组、组内按作品数降序。
 * 返回分组数组，按 A→Z→# 排列。
 */
export function groupAuthorsByName(
	authors: { name: string; count: number }[]
): AuthorGroup[] {
	const collator = new Intl.Collator("zh-Hans-CN", { sensitivity: "base" });
	// 先按拼音排序，同拼音内按作品数降序
	const sorted = [...authors].sort((a, b) => {
		const c = collator.compare(a.name, b.name);
		return c !== 0 ? c : b.count - a.count;
	});

	// 用 Map 按首字母聚合，避免排序后 '#' 与字母穿插导致出现重复分组
	const map = new Map<string, string[]>();
	for (const a of sorted) {
		const letter = getFirstLetter(a.name);
		const arr = map.get(letter);
		if (arr) arr.push(a.name);
		else map.set(letter, [a.name]);
	}

	// 字母优先 A→Z，'#' 组统一置底（最多一个）
	const letters = [...map.keys()].sort((x, y) => {
		if (x === "#") return 1;
		if (y === "#") return -1;
		return x.localeCompare(y);
	});

	return letters.map((letter) => ({ letter, authors: map.get(letter)! }));
}
