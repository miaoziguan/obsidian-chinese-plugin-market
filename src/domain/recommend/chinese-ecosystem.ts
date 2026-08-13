/**
 * 中文生态判定（产品想法：筛选「中文生态」插件，对齐中文市场定位）。
 *
 * 定义：C 方案——「中文生态」而非「中国籍开发者」：
 *   中文作者名 / 描述含中文 / 作者名命中常见中文拼音 / 人工清单。
 * 算法是「先粗后精」的粗层：启发式兜底 + 人工清单精修。
 * 纯函数，零网络依赖，可单测。
 */

/** 常见中文姓氏拼音（非完整名单，覆盖高频即可；海外华人/越南名可能误判，靠清单精修） */
const CHINESE_SURNAME_PINYIN = new Set([
	"li", "wang", "zhang", "chen", "liu", "yang", "zhao", "huang", "wu", "zhou",
	"xu", "sun", "ma", "zhu", "hu", "guo", "lin", "he", "gao", "luo", "zheng",
	"liang", "xie", "song", "tang", "han", "deng", "feng", "ceng", "peng", "cao",
	"yuan", "ding", "pan", "jiang", "du", "ye", "su", "wei", "cheng", "lu", "ren",
	"cui", "shen", "fan", "fang", "shi", "yao", "tan", "liao", "zou", "xiong", "jin",
	"qin", "hao", "ran", "fu", "bai", "xiao", "qiu", "chao", "neng", "jiao", "yu",
]);

/** 判定插件是否属「中文生态」。信号：author/name 含汉字，或 description 含中文，或 author 命中常见中文拼音 */
export function isChineseEcosystem(plugin: {
	name: string;
	author: string;
	description?: string;
}): boolean {
	if (containsHan(plugin.author) || containsHan(plugin.name)) return true;
	if (plugin.description && containsHan(plugin.description)) return true;
	return isPinyinSurname(plugin.author);
}

/** 是否含 CJK 统一表意文字（汉字） */
export function containsHan(text: string): boolean {
	return /[\u4e00-\u9fff]/.test(text);
}

/** 作者名是否以常见中文姓氏拼音开头（按空格/连字符/下划线分段取首 token） */
export function isPinyinSurname(author: string): boolean {
	const first = author.split(/[\s\-_]+/)[0]?.toLowerCase();
	if (!first) return false;
	return CHINESE_SURNAME_PINYIN.has(first);
}
