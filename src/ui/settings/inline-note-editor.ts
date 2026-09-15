/**
 * 内联备注编辑器：点击即编辑，Enter 保存、Shift+Enter 换行、Esc 取消、失焦保存。
 *
 * 元素创建统一用 Obsidian 的全局 createEl / createSpan（而非 document.createElement），
 * 既符合插件规范，也在测试环境由 test/setup.ts 补齐，可直接单测。
 */

export interface InlineNoteOptions {
	value: string;
	/** 编辑态占位符 */
	placeholder: string;
	/** 空值时的展示文案 */
	emptyText: string;
	/** 值变化后回调（调用方负责持久化） */
	onSave: (value: string) => void;
}

/**
 * 在 host 内渲染备注编辑器。host 应由调用方创建并标记归属，
 * 便于整块移除（页面重绘时不会残留监听器）。
 */
export function renderInlineNoteEditor(
	host: HTMLElement,
	options: InlineNoteOptions,
): void {
	host.textContent = "";
	host.classList.add("cpm-note");
	let value = options.value ?? "";
	let editing = false;

	const paint = (): void => {
		host.textContent = "";
		if (editing) {
			const input = createEl("textarea", { cls: "cpm-note-input" });
			input.value = value;
			input.placeholder = options.placeholder;
			input.rows = 1;
			host.appendChild(input);
			input.focus();

			let closed = false;
			const commit = (save: boolean): void => {
				if (closed) return;
				closed = true;
				if (save && input.value !== value) {
					value = input.value;
					options.onSave(value);
				}
				editing = false;
				paint();
			};
			input.addEventListener("keydown", (event: KeyboardEvent) => {
				if (event.key === "Enter" && !event.shiftKey) {
					event.preventDefault();
					commit(true);
				} else if (event.key === "Escape") {
					event.preventDefault();
					commit(false);
				}
			});
			input.addEventListener("blur", () => commit(true));
			return;
		}

		const span = createSpan({
			cls: value ? "cpm-note-text" : "cpm-note-empty",
			text: value || options.emptyText,
		});
		host.appendChild(span);
	};

	host.addEventListener("click", () => {
		if (editing) return;
		editing = true;
		paint();
	});
	paint();
}
