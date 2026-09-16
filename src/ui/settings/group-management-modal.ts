/**
 * 分组管理模态框：对齐参考插件 albus-plugins-and-styles-manager 的交互。
 *
 * 在原生设置页筛选栏点「管理分组」直接弹出本框，无需离开当前页：
 * - 顶部输入分组名 + 「添加分组」（Enter 亦可）
 * - 每个自定义分组一行：名称（点击铅笔内联重命名）、配色、重置颜色、
 *   用量计数、删除（成员自动归位「其他」）
 * 任何改动即时落盘并刷新当前增强页行。
 */

import {
	Modal,
	TextComponent,
	ButtonComponent,
	ColorComponent,
	ExtraButtonComponent,
	Notice,
	type App,
} from "obsidian";
import { pickLang } from "@shared/i18n";
import {
	listGroups,
	isBuiltinGroup,
	addGroup,
	renameGroup,
	removeGroup,
	countMembersByGroup,
	reassignMetaGroup,
	getGroupColor,
} from "@domain/manage/group";
import { GROUP_OTHER } from "@domain/manage/types";
import type { GroupManageStore } from "./group-manage-store";

const DEFAULT_COLOR = "#7f6df2";

export class GroupManagementModal extends Modal {
	private listEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly store: GroupManageStore,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.innerHTML = "";
		const title =
			this.store.type === "css"
				? pickLang("manage.groups.css.title")
				: pickLang("manage.groups.plugin.title");
		contentEl.appendChild(createEl("h3", { text: title }));

		this.renderComposer(contentEl);
		const listEl = createDiv({ cls: "cpm-group-modal-list" });
		this.listEl = listEl;
		contentEl.appendChild(listEl);
		this.renderList();
	}

	onClose(): void {
		this.contentEl.innerHTML = "";
	}

	// ── 顶部添加分组 ──

	private renderComposer(parent: HTMLElement): void {
		const composer = createDiv({ cls: "cpm-group-composer" });
		parent.appendChild(composer);
		const input = new TextComponent(composer);
		input.setPlaceholder(pickLang("settings.manage.group.name.ph"));
		input.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				this.addGroup(input);
			}
		});
		new ButtonComponent(composer)
			.setButtonText(pickLang("settings.manage.group.add"))
			.setCta()
			.onClick(() => this.addGroup(input));
	}

	private addGroup(input: TextComponent): void {
		const value = input.getValue().trim();
		if (!value) {
			new Notice(pickLang("settings.manage.group.nameRequired"));
			return;
		}
		const result = addGroup(this.store.getGroups(), value);
		if (!result) {
			new Notice(pickLang("settings.manage.group.exists", { name: value }));
			return;
		}
		this.store.saveGroups(result.groups, this.store.getGroupColors());
		new Notice(pickLang("manage.group.added", { name: value }));
		input.setValue("");
		this.renderList();
	}

	// ── 分组列表 ──

	private renderList(): void {
		if (!this.listEl) return;
		this.listEl.innerHTML = "";

		const groups = listGroups(this.store.getGroups());
		const custom = groups.filter((g) => !isBuiltinGroup(g.key));
		if (custom.length === 0) {
			this.listEl.appendChild(
				createDiv({ cls: "cpm-group-empty", text: pickLang("manage.group.listEmpty") }),
			);
			return;
		}

		this.listEl.appendChild(
			createDiv({
				cls: "cpm-group-count-hint",
				text: pickLang("manage.group.total", { count: String(custom.length) }),
			}),
		);

		const counts = countMembersByGroup(this.store.getMeta());
		for (const { key, name } of custom) {
			this.renderRow(key, name, counts[key] ?? 0);
		}
	}

	private renderRow(key: string, name: string, count: number): void {
		if (!this.listEl) return;
		const row = createDiv({ cls: "cpm-group-row setting-item" });
		this.listEl.appendChild(row);

		const infoEl = createDiv({ cls: "setting-item-info" });
		row.appendChild(infoEl);
		const nameEl = createDiv({ cls: "setting-item-name" });
		infoEl.appendChild(nameEl);
		nameEl.appendChild(createSpan({ text: name }));

		const controlEl = createDiv({ cls: "setting-item-control" });
		row.appendChild(controlEl);

		// 配色：无自定义色时回落默认色
		const color = getGroupColor(this.store.getGroupColors(), key);
		const colorC = new ColorComponent(controlEl);
		colorC.setValue(color || DEFAULT_COLOR);
		colorC.onChange((value) => {
			const colors = { ...this.store.getGroupColors(), [key]: value };
			this.store.saveGroups(this.store.getGroups(), colors);
			this.renderList();
		});

		// 仅当有自定义色时显示「重置颜色」
		if (color) {
			new ExtraButtonComponent(controlEl)
				.setIcon("rotate-ccw")
				.setTooltip(pickLang("settings.manage.group.resetColor"))
				.onClick(() => {
					const colors = { ...this.store.getGroupColors() };
					delete colors[key];
					this.store.saveGroups(this.store.getGroups(), colors);
					this.renderList();
				});
		}

		// 用量计数（X 个插件 / X 个样式）
		controlEl.appendChild(
			createSpan({
				cls: "cpm-group-usage",
				text: pickLang(
					this.store.type === "css"
						? "manage.group.count.css"
						: "manage.group.count.plugin",
					{ count: String(count) },
				),
			}),
		);

		// 重命名（内联编辑）
		new ExtraButtonComponent(controlEl)
			.setIcon("pencil")
			.setTooltip(pickLang("settings.manage.group.rename"))
			.onClick(() => this.beginRename(row, key, name));

		// 删除（成员归位「其他」）
		new ExtraButtonComponent(controlEl)
			.setIcon("trash")
			.setTooltip(pickLang("settings.manage.group.delete"))
			.onClick(() => this.deleteGroup(key, name));
	}

	// ── 内联重命名 ──

	private beginRename(row: HTMLElement, key: string, currentName: string): void {
		if (!this.listEl) return;
		row.innerHTML = "";
		const infoEl = createDiv({ cls: "setting-item-info" });
		row.appendChild(infoEl);
		const input = new TextComponent(infoEl);
		input.setValue(currentName);
		input.inputEl.focus();

		const commit = (): void => {
			const next = input.getValue().trim();
			if (!next || next === currentName) {
				this.renderList();
				return;
			}
			const result = renameGroup(this.store.getGroups(), key, next);
			if (!result) {
				new Notice(pickLang("settings.manage.group.exists", { name: next }));
				this.renderList();
				return;
			}
			this.store.saveGroups(result, this.store.getGroupColors());
			new Notice(pickLang("manage.group.renamed", { name: next }));
			this.renderList();
		};

		input.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				commit();
			} else if (event.key === "Escape") {
				event.preventDefault();
				this.renderList();
			}
		});
		input.inputEl.addEventListener("blur", commit);
	}

	// ── 删除 ──

	private deleteGroup(key: string, name: string): void {
		const nextGroups = removeGroup(this.store.getGroups(), key);
		if (!nextGroups) return;
		const colors = { ...this.store.getGroupColors() };
		delete colors[key];
		this.store.saveGroups(nextGroups, colors);
		const meta = reassignMetaGroup(this.store.getMeta(), key, GROUP_OTHER);
		this.store.replaceMeta(meta);
		new Notice(pickLang("settings.manage.group.deleted", { name }));
		this.renderList();
	}
}
