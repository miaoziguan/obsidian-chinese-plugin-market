/** 由 esbuild 在构建时解析（inlineWorkerSourcePlugin）：返回 worker bundle 的源码字符串。 */
declare module "@inline-worker" {
	const workerSource: string;
	export default workerSource;
}
