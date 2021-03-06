/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/debugViewlet';
import * as nls from 'vs/nls';
import { IAction, IActionViewItem } from 'vs/base/common/actions';
import { IDebugService, VIEWLET_ID, State, BREAKPOINTS_VIEW_ID, CONTEXT_DEBUG_UX, CONTEXT_DEBUG_UX_KEY, REPL_VIEW_ID, CONTEXT_DEBUG_STATE, ILaunch } from 'vs/workbench/contrib/debug/common/debug';
import { StartAction } from 'vs/workbench/contrib/debug/browser/debugActions';
import { StartDebugActionViewItem, FocusSessionActionViewItem } from 'vs/workbench/contrib/debug/browser/debugActionViewItems';
import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IProgressService } from 'vs/platform/progress/common/progress';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IContextMenuService, IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IWorkbenchLayoutService } from 'vs/workbench/services/layout/browser/layoutService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ViewPaneContainer } from 'vs/workbench/browser/parts/views/viewPaneContainer';
import { ViewPane } from 'vs/workbench/browser/parts/views/viewPane';
import { MenuId, MenuItemAction, SubmenuItemAction, registerAction2, Action2, MenuRegistry } from 'vs/platform/actions/common/actions';
import { IContextKeyService, ContextKeyEqualsExpr, ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { MenuEntryActionViewItem, SubmenuEntryActionViewItem } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { IViewDescriptorService, IViewsService } from 'vs/workbench/common/views';
import { WelcomeView } from 'vs/workbench/contrib/debug/browser/welcomeView';
import { ShowViewletAction } from 'vs/workbench/browser/viewlet';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { debugConfigure, debugConsole } from 'vs/workbench/contrib/debug/browser/debugIcons';
import { WorkbenchStateContext } from 'vs/workbench/browser/contextkeys';
import { IQuickInputService } from 'vs/platform/quickinput/common/quickInput';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { ToggleViewAction } from 'vs/workbench/browser/actions/layoutActions';
import { FOCUS_SESSION_ID, SELECT_AND_START_ID } from 'vs/workbench/contrib/debug/browser/debugCommands';

export class DebugViewPaneContainer extends ViewPaneContainer {

	private startDebugActionViewItem: StartDebugActionViewItem | undefined;
	private progressResolve: (() => void) | undefined;
	private breakpointView: ViewPane | undefined;
	private paneListeners = new Map<string, IDisposable>();

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IProgressService private readonly progressService: IProgressService,
		@IDebugService private readonly debugService: IDebugService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IExtensionService extensionService: IExtensionService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService
	) {
		super(VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }, instantiationService, configurationService, layoutService, contextMenuService, telemetryService, extensionService, themeService, storageService, contextService, viewDescriptorService);

		// When there are potential updates to the docked debug toolbar we need to update it
		this._register(this.debugService.onDidChangeState(state => this.onDebugServiceStateChange(state)));

		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set([CONTEXT_DEBUG_UX_KEY]))) {
				this.updateTitleArea();
			}
		}));

		this._register(this.contextService.onDidChangeWorkbenchState(() => this.updateTitleArea()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('debug.toolBarLocation')) {
				this.updateTitleArea();
			}
		}));
	}

	create(parent: HTMLElement): void {
		super.create(parent);
		parent.classList.add('debug-viewlet');
	}

	focus(): void {
		super.focus();

		if (this.startDebugActionViewItem) {
			this.startDebugActionViewItem.focus();
		} else {
			this.focusView(WelcomeView.ID);
		}
	}

	getActionViewItem(action: IAction): IActionViewItem | undefined {
		if (action.id === 'debug.start') {
			this.startDebugActionViewItem = this.instantiationService.createInstance(StartDebugActionViewItem, null, action);
			return this.startDebugActionViewItem;
		}
		if (action.id === FOCUS_SESSION_ID) {
			return new FocusSessionActionViewItem(action, undefined, this.debugService, this.themeService, this.contextViewService, this.configurationService);
		}
		if (action instanceof MenuItemAction) {
			return this.instantiationService.createInstance(MenuEntryActionViewItem, action);
		} else if (action instanceof SubmenuItemAction) {
			return this.instantiationService.createInstance(SubmenuEntryActionViewItem, action);
		}

		return undefined;
	}

	focusView(id: string): void {
		const view = this.getView(id);
		if (view) {
			view.focus();
		}
	}

	private onDebugServiceStateChange(state: State): void {
		if (this.progressResolve) {
			this.progressResolve();
			this.progressResolve = undefined;
		}

		if (state === State.Initializing) {
			this.progressService.withProgress({ location: VIEWLET_ID, }, _progress => {
				return new Promise<void>(resolve => this.progressResolve = resolve);
			});
		}
	}

	addPanes(panes: { pane: ViewPane, size: number, index?: number }[]): void {
		super.addPanes(panes);

		for (const { pane: pane } of panes) {
			// attach event listener to
			if (pane.id === BREAKPOINTS_VIEW_ID) {
				this.breakpointView = pane;
				this.updateBreakpointsMaxSize();
			} else {
				this.paneListeners.set(pane.id, pane.onDidChange(() => this.updateBreakpointsMaxSize()));
			}
		}
	}

	removePanes(panes: ViewPane[]): void {
		super.removePanes(panes);
		for (const pane of panes) {
			dispose(this.paneListeners.get(pane.id));
			this.paneListeners.delete(pane.id);
		}
	}

	private updateBreakpointsMaxSize(): void {
		if (this.breakpointView) {
			// We need to update the breakpoints view since all other views are collapsed #25384
			const allOtherCollapsed = this.panes.every(view => !view.isExpanded() || view === this.breakpointView);
			this.breakpointView.maximumBodySize = allOtherCollapsed ? Number.POSITIVE_INFINITY : this.breakpointView.minimumBodySize;
		}
	}
}

export class OpenDebugViewletAction extends ShowViewletAction {
	public static readonly ID = VIEWLET_ID;
	public static readonly LABEL = nls.localize('toggleDebugViewlet', "Show Run and Debug");

	constructor(
		id: string,
		label: string,
		@IViewletService viewletService: IViewletService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService
	) {
		super(id, label, VIEWLET_ID, viewletService, editorGroupService, layoutService);
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'debug.start',
			title: StartAction.LABEL,
			f1: false,
			precondition: ContextKeyExpr.and(CONTEXT_DEBUG_STATE.notEqualsTo('initializing'), CONTEXT_DEBUG_UX.notEqualsTo('simple')),
			menu: {
				id: MenuId.ViewContainerTitle,
				group: 'navigation',
				order: 10,
				when: ContextKeyExpr.and(ContextKeyEqualsExpr.create('viewContainer', VIEWLET_ID), CONTEXT_DEBUG_UX.notEqualsTo('simple'), WorkbenchStateContext.notEqualsTo('empty'),
					ContextKeyExpr.or(CONTEXT_DEBUG_STATE.isEqualTo('inactive'), ContextKeyExpr.notEquals('config.debug.toolBarLocation', 'docked')))
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		const startAction = instantiationService.createInstance(StartAction, StartAction.ID, StartAction.LABEL);
		await startAction.run();
	}
});

export const DEBUG_CONFIGURE_COMMAND_ID = 'workbench.action.debug.configure';
export const DEBUG_CONFIGURE_LABEL = nls.localize('openLaunchJson', "Open {0}", 'launch.json');
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: DEBUG_CONFIGURE_COMMAND_ID,
			title: DEBUG_CONFIGURE_LABEL,
			f1: true,
			icon: debugConfigure,
			precondition: CONTEXT_DEBUG_UX.notEqualsTo('simple'),
			menu: [{
				id: MenuId.ViewContainerTitle,
				group: 'navigation',
				order: 20,
				when: ContextKeyExpr.and(ContextKeyEqualsExpr.create('viewContainer', VIEWLET_ID), CONTEXT_DEBUG_UX.notEqualsTo('simple'), WorkbenchStateContext.notEqualsTo('empty'),
					ContextKeyExpr.or(CONTEXT_DEBUG_STATE.isEqualTo('inactive'), ContextKeyExpr.notEquals('config.debug.toolBarLocation', 'docked')))
			}, {
				id: MenuId.ViewContainerTitle,
				order: 20,
				// Show in debug viewlet secondary actions when debugging and debug toolbar is docked
				when: ContextKeyExpr.and(ContextKeyEqualsExpr.create('viewContainer', VIEWLET_ID), CONTEXT_DEBUG_STATE.notEqualsTo('inactive'), ContextKeyExpr.equals('config.debug.toolBarLocation', 'docked'))
			}]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const debugService = accessor.get(IDebugService);
		const quickInputService = accessor.get(IQuickInputService);
		const configurationManager = debugService.getConfigurationManager();
		let launch: ILaunch | undefined;
		if (configurationManager.selectedConfiguration.name) {
			launch = configurationManager.selectedConfiguration.launch;
		} else {
			const launches = configurationManager.getLaunches().filter(l => !l.hidden);
			if (launches.length === 1) {
				launch = launches[0];
			} else {
				const picks = launches.map(l => ({ label: l.name, launch: l }));
				const picked = await quickInputService.pick<{ label: string, launch: ILaunch }>(picks, {
					activeItem: picks[0],
					placeHolder: nls.localize({ key: 'selectWorkspaceFolder', comment: ['User picks a workspace folder or a workspace configuration file here. Workspace configuration files can contain settings and thus a launch.json configuration can be written into one.'] }, "Select a workspace folder to create a launch.json file in or add it to the workspace config file")
				});
				if (picked) {
					launch = picked.launch;
				}
			}
		}

		if (launch) {
			await launch.openConfigFile(false);
		}
	}
});

export const OPEN_REPL_COMMAND_ID = 'workbench.debug.action.toggleRepl';
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_REPL_COMMAND_ID,
			title: nls.localize('toggleDebugPanel', "Debug Console"),
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KEY_Y,
				weight: KeybindingWeight.WorkbenchContrib
			},
			icon: debugConsole,
			precondition: CONTEXT_DEBUG_UX.notEqualsTo('simple'),
			menu: [{
				id: MenuId.ViewContainerTitle,
				group: 'navigation',
				order: 30,
				when: ContextKeyExpr.and(ContextKeyEqualsExpr.create('viewContainer', VIEWLET_ID), CONTEXT_DEBUG_UX.notEqualsTo('simple'), WorkbenchStateContext.notEqualsTo('empty'),
					ContextKeyExpr.or(CONTEXT_DEBUG_STATE.isEqualTo('inactive'), ContextKeyExpr.notEquals('config.debug.toolBarLocation', 'docked')))
			}, {
				id: MenuId.ViewContainerTitle,
				order: 30,
				// Show in debug viewlet secondary actions when debugging and debug toolbar is docked
				when: ContextKeyExpr.and(ContextKeyEqualsExpr.create('viewContainer', VIEWLET_ID), CONTEXT_DEBUG_STATE.notEqualsTo('inactive'), ContextKeyExpr.equals('config.debug.toolBarLocation', 'docked'))
			}]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const viewDescriptorService = accessor.get(IViewDescriptorService);
		const contextKeyService = accessor.get(IContextKeyService);
		const layoutService = accessor.get(IWorkbenchLayoutService);
		return new class extends ToggleViewAction {
			constructor() {
				super(OPEN_REPL_COMMAND_ID, 'Debug Console', REPL_VIEW_ID, viewsService, viewDescriptorService, contextKeyService, layoutService);
			}
		}().run();
	}
});

MenuRegistry.appendMenuItem(MenuId.ViewContainerTitle, {
	when: ContextKeyExpr.and(ContextKeyEqualsExpr.create('viewContainer', VIEWLET_ID), CONTEXT_DEBUG_STATE.notEqualsTo('inactive'), ContextKeyExpr.equals('config.debug.toolBarLocation', 'docked')),
	order: 10,
	command: {
		id: SELECT_AND_START_ID,
		title: nls.localize('startAdditionalSession', "Start Additional Session"),
	}
});
