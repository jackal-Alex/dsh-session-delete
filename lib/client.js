/**
 * dsh-session-delete — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step). It adds two entries
 * to the Session row's "..." menu that the WorkspaceBrowser declares:
 *
 *   sidebar.workspaces.session.menu.item
 *     - "删除会话"        → move the session directory into ~/.dsh/session-trash
 *     - "彻底删除会话"    → same move, then delete it from the trash
 *
 * The row menu passes the row's Session identity and nothing else, so this
 * half never needs a Session binding: it hands the id to the host routes and
 * reloads the page afterwards so the sidebar re-reads the session list.
 *
 * Rows are plain `role="menuitem"` buttons styled by one injected stylesheet
 * that mirrors the shipped menu cell (`font-size: 13px; line-height: 20px;
 * min-height: 34px; padding: 6px 8px`) instead of the shared `MenuItemButton`
 * primitive: the menu's own font does not cross into a slot occupant, and an
 * inline `font: inherit` would pick up the page's 16px rather than the cell's.
 */
window.__ModuleLoader__.load({
	id: "@jackal-alex/dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;

		/** Host route that performs the deletion. */
		const ENDPOINT = "/api/session-delete/delete";

		/** Marker on the injected stylesheet, so a reload never doubles it. */
		const STYLE_ID = "dsh-session-delete-styles";

		/**
		 * Copy of the shipped menu cell metrics (`.item` / `.danger` in
		 * dsh-client-ui-primitives). Kept in one place so the two rows cannot
		 * drift from the menu they live in.
		 */
		const CSS = [
			".dsh-session-delete-row{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;margin:0;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-family:inherit;font-size:13px;font-weight:inherit;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}",
			".dsh-session-delete-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-session-delete-row:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}",
			".dsh-session-delete-row--danger{color:var(--dsw-alias-state-error-primary)}",
			".dsh-session-delete-row--danger:hover:not(:disabled),.dsh-session-delete-row--danger:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}",
			".dsh-session-delete-separator{margin-top:3px;padding-top:3px;border-top:0.5px solid var(--dsw-alias-border-l2)}",
		].join("");

		/**
		 * Install the stylesheet once per page.
		 * @returns {void}
		 */
		function ensureStyles() {
			if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			(document.head || document.documentElement).appendChild(style);
		}

		/**
		 * Ensure the browser-only API surface we rely on exists before acting.
		 * @returns {boolean} true when the page can talk to the host routes.
		 */
		function canReachHost() {
			return typeof fetch === "function" && typeof window !== "undefined";
		}

		/**
		 * Ask the host to delete one session.
		 * @param {string} sessionId - the row's Session id.
		 * @param {"trash"|"purge"} mode - reversible move, or move + purge.
		 * @returns {Promise<{ok: boolean, error?: string, code?: string}>} the receipt.
		 */
		async function requestDelete(sessionId, mode) {
			const response = await fetch(ENDPOINT, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-dsh-session-delete": "1",
				},
				body: JSON.stringify({ sessionId, mode }),
			});
			let body = {};
			try {
				body = await response.json();
			} catch {
				body = { ok: false, error: "宿主返回了非 JSON 响应（HTTP " + response.status + "）" };
			}
			return body;
		}

		/**
		 * One Session-row menu entry.
		 * @param {{sessionId: string, displayTitle?: string, useMenuOpenState?: Function, mode: "trash"|"purge", label: string, hint: string, separator?: boolean}} props - slot props plus the injected face.
		 * @returns {any} menu item.
		 */
		function SessionDeleteItem(props) {
			const sessionId = props.sessionId;
			const title = props.displayTitle || sessionId;
			const closeMenu = props.useMenuOpenState ? props.useMenuOpenState()[1] : () => {};
			const danger = props.mode === "purge";

			const click = async (event) => {
				event.preventDefault();
				event.stopPropagation();
				closeMenu(false);
				if (!canReachHost()) {
					window.alert("当前页面没有 fetch，无法调用宿主接口");
					return;
				}
				const prompt = danger
					? "彻底删除会话「" + title + "」？\n\n这次删除不可恢复。"
					: "删除会话「" + title + "」？\n\n会移到 ~/.dsh/session-trash（可恢复），不会立刻彻底删除。";
				if (!window.confirm(prompt)) return;

				let receipt;
				try {
					receipt = await requestDelete(sessionId, props.mode);
				} catch (error) {
					window.alert("请求宿主失败：" + (error && error.message ? error.message : String(error)));
					return;
				}
				if (!receipt || receipt.ok !== true) {
					const code = receipt && receipt.code ? " [" + receipt.code + "]" : "";
					window.alert("删除失败" + code + "：" + ((receipt && receipt.error) || "未知错误"));
					return;
				}
				window.alert(danger ? "已彻底删除，刷新后列表不再显示该会话。" : "已移入回收站，刷新后列表不再显示该会话。");
				window.location.reload();
			};

			const button = h(
				"button",
				{
					type: "button",
					role: "menuitem",
					className: "dsh-session-delete-row" + (danger ? " dsh-session-delete-row--danger" : ""),
					"data-dsh-session-delete": props.mode,
					title: props.hint,
					onClick: click,
				},
				props.label,
			);

			if (!props.separator) return button;
			return h(
				"div",
				null,
				h("div", { className: "dsh-session-delete-separator", role: "separator" }),
				button,
			);
		}

		/** Services required by the browser half. */
		const inject = ["slots"];

		/**
		 * Register both menu entries.
		 * @param {any} ctx - client plugin host context.
		 * @returns {void}
		 */
		function apply(ctx) {
			ensureStyles();

			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "session-delete.trash",
				order: 600,
				inject: () => ({ mode: "trash", label: "删除会话", hint: "移入回收站，可恢复", separator: true }),
			}, SessionDeleteItem));

			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "session-delete.purge",
				order: 601,
				inject: () => ({ mode: "purge", label: "彻底删除会话", hint: "移入回收站后立刻清除，不可恢复" }),
			}, SessionDeleteItem));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.SessionDeleteItem = SessionDeleteItem;

		//#endregion

		return module.exports;
	},
});
