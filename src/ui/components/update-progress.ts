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
	const el = document.createElement("div");
	el.className = "pt-updates-progress";
	const text = document.createElement("div");
	text.className = "pt-updates-progress-text";
	el.appendChild(text);
	const track = document.createElement("div");
	track.className = "pt-updates-progress-track";
	el.appendChild(track);
	const fill = document.createElement("div");
	fill.className = "pt-updates-progress-fill";
	track.appendChild(fill);
	const pct = document.createElement("div");
	pct.className = "pt-updates-progress-pct";
	el.appendChild(pct);

	const render = (done: number, total: number, label?: string) => {
		const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
		fill.style.width = `${ratio * 100}%`;
		pct.textContent = `${Math.round(ratio * 100)}%`;
		text.textContent = label ? `${label} · ${done}/${total}` : `更新进度 ${done}/${total}`;
	};
	render(0, 1);

	return {
		el,
		set: (done, total, label) => render(done, total, label),
		finish: () => {
			el.classList.add("pt-updates-progress--done");
			window.setTimeout(() => el.remove(), 600);
		},
	};
}
