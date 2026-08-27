import type { ViewContext } from "@ui/view/view-context";
import type { DrawerHostPlugin } from "@ui/components/detail-drawer";
import type { ChinesePluginMarketSettings } from "@ui/view/translator-view";
import type { Translator } from "@domain/catalog/translator";

/**
 * 测试用 ViewContext 工厂（审计 P1-3：集中收敛 `as ViewContext` 逃逸）。
 *
 * 此前各测试用 `as any` / `as unknown as ViewContext` 伪造上下文，导致类型重构无法
 * 靠编译期发现断裂。改为统一经此工厂：调用点按 `Partial<ViewContext>` 提供所需字段，
 * 类型受校验；唯一的 `as ViewContext` 断言收敛在工厂内部一处，不再散布于各测试。
 *
 * 注意：工厂不做完整 mock，调用方须提供被测函数实际访问到的字段，否则运行期为 undefined。
 */
export function makeMockContext(overrides: Partial<ViewContext> = {}): ViewContext {
	return overrides as ViewContext;
}

/**
 * 测试用 DrawerHostPlugin 工厂（I2：替代 `{ settings, ... } as any` 伪造 plugin）。
 *
 * 集中提供 `DrawerHostPlugin` 最小形状（settings + translator），消除测试里
 * 伪造 plugin 的 `as any` 逃逸，使 plugin 委托字段受编译期校验。
 * settings 用 Partial 放宽，测试只需提供被测路径真正用到的字段；
 * 额外字段（如 saveVectorIndex 等 plugin 委托方法）通过索引签名携带，供断言访问。
 */
export function makeMockPlugin(
	overrides: {
		settings?: Partial<ChinesePluginMarketSettings>;
		translator?: Translator;
		[k: string]: unknown;
	} = {}
): DrawerHostPlugin & { [k: string]: unknown } {
	return {
		settings: (overrides.settings ?? {}) as ChinesePluginMarketSettings,
		translator: overrides.translator ?? ({} as Translator),
		// 默认本地模型下载状态：idle（测试一般不触发真实 worker 下载）
		localModelState: { status: "idle", loaded: 0, total: 0 },
		...overrides,
	} as DrawerHostPlugin & { [k: string]: unknown };
}
