/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { tmpdir } from 'os';
import { join } from 'path';
import { mapValues } from '../common/objUtils';
import { ISourceMapMetadata } from '../common/sourceMaps/sourceMap';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { toolPath } from '../diagnosticTool/tool';
import { FS, FsPromises } from '../ioc-extras';
import { ITarget } from '../targets/targets';
import { BreakpointManager } from './breakpoints';
import { CdpReferenceState } from './breakpoints/breakpointBase';
import { IUiLocation, SourceContainer, SourceFromMap } from './sources';

export interface IDiagnosticSource {
  url: string;
  sourceReference: number;
  absolutePath: string;
  actualAbsolutePath: string | undefined;
  scriptIds: string[];
  prettyName: string;
  compiledSourceRefToUrl?: [number, string][];
  sourceMap?: {
    url: string;
    metadata: ISourceMapMetadata;
    sources: { [url: string]: number };
  };
}

export interface IDiagnosticBreakpoint {
  source: Dap.Source;
  params: Dap.SourceBreakpoint;
  cdp: object[];
}

export interface IDiagnosticDump {
  sources: IDiagnosticSource[];
  breakpoints: IDiagnosticBreakpoint[];
  config: AnyLaunchConfiguration;
}

@injectable()
export class Diagnostics {
  constructor(
    @inject(FS) private readonly fs: FsPromises,
    @inject(SourceContainer) private readonly sources: SourceContainer,
    @inject(BreakpointManager) private readonly breakpoints: BreakpointManager,
    @inject(ITarget) private readonly target: ITarget,
  ) {}

  /**
   * Generates the a object containing information
   * about sources, config, and breakpoints.
   */
  public async generateObject() {
    const [sources] = await Promise.all([this.dumpSources()]);

    return {
      breakpoints: this.dumpBreakpoints(),
      sources,
      config: this.target.launchConfig,
    };
  }

  /**
   * Generates an HTML diagnostic report.
   */
  public async generateHtml(file = join(tmpdir(), 'js-debug-diagnostics.html')) {
    await this.fs.writeFile(
      file,
      `<body>
        <script>window.DUMP=${JSON.stringify(await this.generateObject())}
        <script>${await this.fs.readFile(toolPath, 'utf-8')}</script>
      </body>`,
    );

    return file;
  }

  private dumpBreakpoints() {
    const output: IDiagnosticBreakpoint[] = [];
    for (const list of [this.breakpoints.appliedByPath, this.breakpoints.appliedByRef]) {
      for (const breakpoints of list.values()) {
        for (const breakpoint of breakpoints) {
          const dump = breakpoint.diagnosticDump();
          output.push({
            source: dump.source,
            params: dump.params,
            cdp: dump.cdp.map(bp =>
              bp.state === CdpReferenceState.Applied
                ? { ...bp, uiLocations: bp.uiLocations.map(l => this.dumpUiLocation(l)) }
                : { ...bp, done: undefined },
            ),
          });
        }
      }
    }

    return output;
  }

  private dumpSources() {
    const output: Promise<IDiagnosticSource>[] = [];
    for (const source of this.sources.sources) {
      output.push(
        (async () => ({
          url: source.url,
          sourceReference: source.sourceReference,
          absolutePath: source.absolutePath,
          actualAbsolutePath: await source.existingAbsolutePath(),
          scriptIds: source.scriptIds(),
          prettyName: await source.prettyName(),
          compiledSourceRefToUrl:
            source instanceof SourceFromMap
              ? [...source.compiledToSourceUrl.entries()].map(
                  ([k, v]) => [k.sourceReference, v] as [number, string],
                )
              : [],
          sourceMap: source.sourceMap && {
            url: source.sourceMap.url,
            metadata: source.sourceMap.metadata,
            sources: mapValues(
              Object.fromEntries(source.sourceMap.sourceByUrl),
              v => v.sourceReference,
            ),
          },
        }))(),
      );
    }

    return Promise.all(output);
  }

  private dumpUiLocation(location: IUiLocation) {
    return {
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber,
      sourceReference: location.source.sourceReference,
    };
  }
}
