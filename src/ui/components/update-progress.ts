import { createDiv } from "obsidian";

export interface UpdateProgressHandle {
	/** 进度条根元素（由调用方挂载到合适位置，避免被列表重渲染清空） */
	el: HTMLElement;
	/** 更新进度：done 已完成数，total 总数；label 可选（如「正在更新 X」本地化文本） */
	set(done: number, total: number, label?: string): void;
	/** 完成后淡出并移除 DOM */
	finish(): void;
}

/**
 * 创建一个**游离**的批量更新进度条层（不自动挂载，由调用方挂到合适位置，
 * 例如工具条之后，确保不被列表重渲染清空）。
 * 返回控制器：el 为根元素，set 实时更新填充宽度 + 百分比 + 文本，finish 淡出移除。
 */
export function createUpdateProgressLayer(): UpdateProgressHandle {
	const el = createDiv({ cls: "pt-updates-progress" });
	const text = el.createDiv({ cls: "pt-updates-progress-text" });
	const track = el.createDiv({ cls: "pt-updates-progress-track" });
	const fill = track.createDiv({ cls: "pt-updates-progress-fill" });
	const pct = el.createDiv({ cls: "pt-updates-progress-pct" });

	const render = (done: number, total: number, label?: string) => {
		const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
		fill.setCssStyles({ width: `${ratio * 100}%` });
		pct.setText(`${Math.round(ratio * 100)}%`);
		text.setText(label ? `${label} · ${done}/${total}` : `更新进度 ${done}/${total}`);
	};
	render(0, 1);

	return {
		el,
		set: (done, total, label) => render(done, total, label),
		finish: () => {
			el.addClass("pt-updates-progress--done");
			window.setTimeout(() => el.remove(), 600);
		},
	};
}
