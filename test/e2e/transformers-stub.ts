/** @xenova/transformers 的 E2E 桩：渲染层不触发 AI 模型，无需真实实现。 */
export const env = { allowLocalModels: false, backends: {} as Record<string, unknown> };
export async function pipeline(): Promise<() => unknown> {
	return () => ({});
}
export class AutoModel {}
export class AutoTokenizer {}
export class AutoProcessor {}
export class AutoConfig {}
