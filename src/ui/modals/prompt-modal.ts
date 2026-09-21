/**
 * 通用文本输入弹窗：替代 `window.prompt`，避免在 Obsidian 某些环境（被拦截、
 * 移动端 WebView、禁用系统对话框的插件）下点击无反应。
 */

import { App, Modal, Setting } from "obsidian";

export class PromptModal extends Modal {
	private value: string;

	constructor(
		app: App,
		private readonly titleText: string,
		private readonly placeholder: string,
		initialValue: string,
		private readonly onSubmit: (value: string) => void,
		private readonly okText: string = "确定",
		private readonly cancelText: string = "取消",
	) {
		super(app);
		this.value = initialValue;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pt-prompt-modal");
		contentEl.createEl("h3", { text: this.titleText });

		new Setting(contentEl)
			.setClass("pt-prompt-input")
			.addText((text) => {
				text.setPlaceholder(this.placeholder)
					.setValue(this.value)
					.onChange((v) => {
						this.value = v;
					});
				text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
					if (event.key === "Enter") {
						event.preventDefault();
						this.commit();
					}
				});
			});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText(this.okText).setCta().onClick(() => this.commit()),
			)
			.addButton((btn) => btn.setButtonText(this.cancelText).onClick(() => this.close()));
	}

	private commit(): void {
		const value = this.value.trim();
		this.close();
		if (!value) return;
		this.onSubmit(value);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
