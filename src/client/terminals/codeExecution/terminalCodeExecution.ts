// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable } from 'inversify';
import * as path from 'path';
import { Disposable, Uri } from 'vscode';
import { IWorkspaceService } from '../../common/application/types';
import '../../common/extensions';
import { IPlatformService } from '../../common/platform/types';
import { ITerminalService, ITerminalServiceFactory } from '../../common/terminal/types';
import { IConfigurationService, IDisposableRegistry } from '../../common/types';
import { IInterpreterService } from '../../interpreter/contracts';
import { buildPythonExecInfo, PythonExecInfo } from '../../pythonEnvironments/exec';
import { ICodeExecutionService } from '../../terminals/types';

@injectable()
export class TerminalCodeExecutionProvider implements ICodeExecutionService {
    private hasRanOutsideCurrentDrive = false;
    protected terminalTitle!: string;
    private replActive = new Map<string, Promise<boolean>>();
    constructor(
        @inject(ITerminalServiceFactory) protected readonly terminalServiceFactory: ITerminalServiceFactory,
        @inject(IConfigurationService) protected readonly configurationService: IConfigurationService,
        @inject(IWorkspaceService) protected readonly workspace: IWorkspaceService,
        @inject(IDisposableRegistry) protected readonly disposables: Disposable[],
        @inject(IPlatformService) protected readonly platformService: IPlatformService,
        @inject(IInterpreterService) protected readonly interpreterService: IInterpreterService,
    ) {}

    public async executeFile(file: Uri) {
        await this.setCwdForFileExecution(file);
        const { command, args } = await this.getExecuteFileArgs(file, [
            file.fsPath.fileToCommandArgumentForPythonExt(),
        ]);

        await this.getTerminalService(file).sendCommand(command, args);
    }

    public async execute(code: string, resource?: Uri): Promise<void> {
        if (!code || code.trim().length === 0) {
            return;
        }

        await this.initializeRepl();
        await this.getTerminalService(resource).sendText(code);
    }
    public async initializeRepl(resource?: Uri) {
        const terminalService = this.getTerminalService(resource);
        let replActive = this.replActive.get(resource?.fsPath || '');
        if (replActive && (await replActive)) {
            await terminalService.show();
            return;
        }
        replActive = new Promise<boolean>(async (resolve) => {
            const replCommandArgs = await this.getExecutableInfo(resource);
            terminalService.sendCommand(replCommandArgs.command, replCommandArgs.args);

            // Give python repl time to start before we start sending text.
            setTimeout(() => resolve(true), 1000);
        });
        this.replActive.set(resource?.fsPath || '', replActive);
        this.disposables.push(
            terminalService.onDidCloseTerminal(() => {
                this.replActive.delete(resource?.fsPath || '');
            }),
        );

        await replActive;
    }

    public async getExecutableInfo(resource?: Uri, args: string[] = []): Promise<PythonExecInfo> {
        const pythonSettings = this.configurationService.getSettings(resource);
        const interpreter = await this.interpreterService.getActiveInterpreter(resource);
        const interpreterPath = interpreter?.path ?? pythonSettings.pythonPath;
        const command = this.platformService.isWindows ? interpreterPath.replace(/\\/g, '/') : interpreterPath;
        const launchArgs = pythonSettings.terminal.launchArgs;
        return buildPythonExecInfo(command, [...launchArgs, ...args]);
    }

    // Overridden in subclasses, see djangoShellCodeExecution.ts
    public async getExecuteFileArgs(resource?: Uri, executeArgs: string[] = []): Promise<PythonExecInfo> {
        return this.getExecutableInfo(resource, executeArgs);
    }
    private getTerminalService(resource?: Uri): ITerminalService {
        return this.terminalServiceFactory.getTerminalService({
            resource,
            title: this.terminalTitle,
        });
    }
    private async setCwdForFileExecution(file: Uri) {
        const pythonSettings = this.configurationService.getSettings(file);
        if (!pythonSettings.terminal.executeInFileDir) {
            return;
        }
        const fileDirPath = path.dirname(file.fsPath);
        if (fileDirPath.length > 0) {
            if (this.platformService.isWindows && /[a-z]\:/i.test(fileDirPath)) {
                const currentDrive =
                    typeof this.workspace.rootPath === 'string'
                        ? this.workspace.rootPath.replace(/\:.*/g, '')
                        : undefined;
                const fileDrive = fileDirPath.replace(/\:.*/g, '');
                if (fileDrive !== currentDrive || this.hasRanOutsideCurrentDrive) {
                    this.hasRanOutsideCurrentDrive = true;
                    await this.getTerminalService(file).sendText(`${fileDrive}:`);
                }
            }
            await this.getTerminalService(file).sendText(`cd ${fileDirPath.fileToCommandArgumentForPythonExt()}`);
        }
    }
}
