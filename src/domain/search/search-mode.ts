import type { ViewContext } from "@ui/view/view-context";

/**
 * searchMode 协调器（审计 P1-5）。
 *
 * 视图层原本散落大量 `ctx.searchMode === "ai"` / `=== "keyword"` 字面量比较，
 * 模式语义（"什么是 AI 模式"）被硬编码在渲染逻辑里。此处集中为单一判定入口，
 * 后续若新增模式或调整模式语义，只需改这两个函数。
 */
export function isAIMode(ctx: ViewContext): boolean {
	return ctx.searchMode === "ai";
}

export function isKeywordMode(ctx: ViewContext): boolean {
	return ctx.searchMode === "keyword";
}

export function isLocalMode(ctx: ViewContext): boolean {
	return ctx.searchMode === "local";
}
