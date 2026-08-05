/**
 * 测试用 mock：esbuild 在构建时注入真实的 worker bundle 源码字符串。
 * vitest 无法解析 @inline-worker（只有 esbuild 的 inlineWorkerSourcePlugin 认识它），
 * 这里给一个空串即可——单测不真正实例化 worker，而是注入 FakeBackend。
 */
const workerSource = "";
export default workerSource;
