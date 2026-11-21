/**
 * Fails loudly when a GradReach entry point is started on a runtime it cannot serve, instead of
 * surfacing a syntax or "unknown file extension" error far from the cause.
 *
 * Two runtime shapes are recognised from the executing module URL:
 * - a TypeScript source file (`*.ts`), which needs Node's type stripping;
 * - a compiled file under `dist/`, which needs only a supported Node version.
 * Anything else (for example a Next.js server bundle) is left alone, so importing this module
 * from a bundled web route cannot change website behaviour.
 */

export type RuntimeFailureCode = 'node_version_unsupported' | 'typescript_runtime_unavailable';

export class RuntimeSupportError extends Error {
  readonly code: RuntimeFailureCode;

  constructor(code: RuntimeFailureCode, message: string) {
    super(message);
    this.name = 'RuntimeSupportError';
    this.code = code;
  }
}

export const MINIMUM_NODE_MAJOR = 22;

const SOURCE_MODULE = /\.(?:ts|tsx)(?:$|[?#])/u;
const BUILT_MODULE = /[\\/]dist[\\/]/u;
const TYPE_STRIPPING_FLAG = '--experimental-strip-types';

export interface RuntimeSupportInput {
  nodeVersion?: string | undefined;
  typeScriptFeature?: string | false | undefined;
  execArgv?: readonly string[] | undefined;
  nodeOptions?: string | undefined;
  moduleUrl?: string | undefined;
}

function typeScriptFeature(): string | false | undefined {
  return (process.features as { typescript?: string | false }).typescript;
}

function nodeMajor(nodeVersion: string): number | undefined {
  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  return Number.isSafeInteger(major) && major > 0 ? major : undefined;
}

function flagEnabled(input: RuntimeSupportInput): boolean {
  if (input.execArgv?.includes(TYPE_STRIPPING_FLAG)) return true;
  return input.nodeOptions?.split(/\s+/u).includes(TYPE_STRIPPING_FLAG) ?? false;
}

/** Returns the blocking runtime problem for this process, or `undefined` when it can run. */
export function unsupportedRuntime(input: RuntimeSupportInput = {}): RuntimeSupportError | undefined {
  const moduleUrl = input.moduleUrl ?? import.meta.url;
  const source = SOURCE_MODULE.test(moduleUrl);
  const built = !source && BUILT_MODULE.test(moduleUrl);
  if (!source && !built) return undefined;

  const nodeVersion = input.nodeVersion ?? process.versions.node;
  const major = nodeMajor(nodeVersion);
  if (major === undefined || major < MINIMUM_NODE_MAJOR) {
    return new RuntimeSupportError(
      'node_version_unsupported',
      `GradReach requires Node.js ${MINIMUM_NODE_MAJOR} or newer, but this process is running Node.js ${nodeVersion}. Install a supported Node.js release and run the command again.`,
    );
  }

  if (source) {
    const feature = input.typeScriptFeature ?? typeScriptFeature();
    const stripping = feature === 'strip' || feature === 'transform';
    if (!stripping && !flagEnabled(input)) {
      return new RuntimeSupportError(
        'typescript_runtime_unavailable',
        `This command starts from TypeScript source, which Node.js ${nodeVersion} cannot load without type stripping. Use Node.js 22.18 or newer, or run the compiled build with the matching ops script (its start-up builds dist/ first).`,
      );
    }
  }

  return undefined;
}

/** Throws {@link RuntimeSupportError} when the current process cannot run this entry point. */
export function assertSupportedRuntime(input: RuntimeSupportInput = {}): void {
  const problem = unsupportedRuntime(input);
  if (problem) throw problem;
}
