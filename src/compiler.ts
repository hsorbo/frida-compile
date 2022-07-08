import { Buffer } from "buffer";
import { cjsToEsmTransformer } from "../ext/cjstoesm.js";
import EventEmitter from "events";
import fsPath from "path";
import process from "process";
import { check as checkIdentifier } from "@frida/reserved-words";
import { minify, MinifyOptions, SourceMapOptions } from "terser";
import TypedEmitter from "typed-emitter";
import ts from "../ext/typescript.js";

const isWindows = process.platform === "win32";
const compilerRoot = detectCompilerRoot();

const sourceTransformers: ts.CustomTransformers = {
    after: [
        useStrictRemovalTransformer(),
    ]
};

export async function build(options: Options): Promise<string> {
    const entrypoint = deriveEntrypoint(options);
    const outputOptions = makeOutputOptions(options);
    const { projectRoot, assets, system } = options;

    const compilerOpts = makeCompilerOptions(projectRoot, system, outputOptions);
    const compilerHost = ts.createIncrementalCompilerHost(compilerOpts, system);

    const program = ts.createProgram({
        rootNames: [entrypoint.input],
        options: compilerOpts,
        host: compilerHost
    });

    const bundler = createBundler(entrypoint, projectRoot, assets, system, outputOptions);

    program.emit(undefined, undefined, undefined, undefined, sourceTransformers);

    return await bundler.bundle(program);
}

export function watch(options: Options): TypedEmitter<WatcherEvents> {
    const entrypoint = deriveEntrypoint(options);
    const outputOptions = makeOutputOptions(options);
    const { projectRoot, assets, system } = options;

    const events = new EventEmitter() as TypedEmitter<WatcherEvents>;

    const origCreateProgram: any = ts.createEmitAndSemanticDiagnosticsBuilderProgram;
    const createProgram: ts.CreateProgram<ts.EmitAndSemanticDiagnosticsBuilderProgram> = (...args: any[]): ts.EmitAndSemanticDiagnosticsBuilderProgram => {
        const program: ts.EmitAndSemanticDiagnosticsBuilderProgram = origCreateProgram(...args);

        const origEmit = program.emit;
        program.emit = (targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers) => {
            return origEmit(targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, sourceTransformers);
        };

        return program;
    };

    const compilerOpts = makeCompilerOptions(projectRoot, system, outputOptions);
    const compilerHost = ts.createWatchCompilerHost([entrypoint.input], compilerOpts, system, createProgram);

    let state: "dirty" | "clean" = "dirty";
    let pending: Promise<void> | null = null;
    let timer: NodeJS.Timeout | null = null;

    const bundler = createBundler(entrypoint, projectRoot, assets, system, outputOptions);
    bundler.events.on("externalSourceFileAdded", file => {
        compilerHost.watchFile(file.fileName, () => {
            state = "dirty";
            bundler.invalidate(portablePathToFilePath(file.fileName));
            if (pending !== null || timer !== null) {
                return;
            }
            timer = setTimeout(() => {
                timer = null;
                rebundle();
            }, 250);
        });
    });

    const origPostProgramCreate = compilerHost.afterProgramCreate!;
    compilerHost.afterProgramCreate = async program => {
        origPostProgramCreate(program);
        process.nextTick(rebundle);
    };

    const watchProgram = ts.createWatchProgram(compilerHost);

    function rebundle(): void {
        if (pending === null) {
            state = "clean";
            pending = performBundling();
            pending.then(() => {
                pending = null;
                if (state === "dirty") {
                    rebundle();
                }
            });
        } else {
            state = "dirty";
        }
    }

    async function performBundling(): Promise<void> {
        try {
            const bundle = await bundler.bundle(watchProgram.getProgram().getProgram());
            events.emit("bundleUpdated", bundle);
        } catch (e) {
            console.error("Failed to bundle:", e);
        }
    }

    return events;
}

export interface Options {
    projectRoot: string;
    entrypoint: string;
    assets: Assets;
    system: ts.System;
    sourceMaps?: SourceMaps;
    compression?: Compression;
}

export type SourceMaps = "included" | "omitted";
export type Compression = "none" | "terser";

export interface Assets {
    projectNodeModulesDir: string;
    compilerNodeModulesDir: string;
    shimDir: string;
    shims: Map<string, string>;
}

export type WatcherEvents = {
    bundleUpdated: (bundle: string) => void,
};

interface EntrypointName {
    input: string;
    output: string;
}

interface OutputOptions {
    sourceMaps: SourceMaps;
    compression: Compression;
}

type ModuleType = "cjs" | "esm";

interface JSModule {
    type: ModuleType;
    path: string;
    file: ts.SourceFile;
}

function deriveEntrypoint(options: Options): EntrypointName {
    const { projectRoot, entrypoint } = options;

    const input = fsPath.isAbsolute(entrypoint) ? entrypoint : fsPath.join(projectRoot, entrypoint);
    if (!input.startsWith(projectRoot)) {
        throw new Error("Entrypoint must be inside the project root");
    }

    let output = input.substring(projectRoot.length);
    if (output.endsWith(".ts")) {
        output = output.substring(0, output.length - 2) + "js";
    }

    return { input, output };
}

function makeOutputOptions(options: Options): OutputOptions {
    const {
        sourceMaps = "included",
        compression = "none",
    } = options;

    return { sourceMaps, compression };
}

export function queryDefaultAssets(projectRoot: string, sys: ts.System): Assets {
    const projectNodeModulesDir = fsPath.join(projectRoot, "node_modules");
    const compilerNodeModulesDir = fsPath.join(compilerRoot, "node_modules");
    const shimDir = sys.directoryExists(compilerNodeModulesDir) ? compilerNodeModulesDir : projectNodeModulesDir;

    const shims = new Map([
        ["assert", fsPath.join(shimDir, "@frida", "assert")],
        ["base64-js", fsPath.join(shimDir, "@frida", "base64-js")],
        ["buffer", fsPath.join(shimDir, "@frida", "buffer")],
        ["diagnostics_channel", fsPath.join(shimDir, "@frida", "diagnostics_channel")],
        ["events", fsPath.join(shimDir, "@frida", "events")],
        ["fs", fsPath.join(shimDir, "frida-fs")],
        ["http", fsPath.join(shimDir, "@frida", "http")],
        ["https", fsPath.join(shimDir, "@frida", "https")],
        ["http-parser-js", fsPath.join(shimDir, "@frida", "http-parser-js")],
        ["ieee754", fsPath.join(shimDir, "@frida", "ieee754")],
        ["net", fsPath.join(shimDir, "@frida", "net")],
        ["os", fsPath.join(shimDir, "@frida", "os")],
        ["path", fsPath.join(shimDir, "@frida", "path")],
        ["process", fsPath.join(shimDir, "@frida", "process")],
        ["punycode", fsPath.join(shimDir, "@frida", "punycode")],
        ["querystring", fsPath.join(shimDir, "@frida", "querystring")],
        ["readable-stream", fsPath.join(shimDir, "@frida", "readable-stream")],
        ["stream", fsPath.join(shimDir, "@frida", "stream")],
        ["string_decoder", fsPath.join(shimDir, "@frida", "string_decoder")],
        ["timers", fsPath.join(shimDir, "@frida", "timers")],
        ["tty", fsPath.join(shimDir, "@frida", "tty")],
        ["url", fsPath.join(shimDir, "@frida", "url")],
        ["util", fsPath.join(shimDir, "@frida", "util")],
        ["vm", fsPath.join(shimDir, "@frida", "vm")],
    ]);

    return {
        projectNodeModulesDir,
        compilerNodeModulesDir,
        shimDir,
        shims,
    };
}

function makeCompilerOptions(projectRoot: string, system: ts.System, options: OutputOptions): ts.CompilerOptions {
    const defaultTsOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2020,
        lib: ["lib.es2020.d.ts"],
        module: ts.ModuleKind.ES2020,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        resolveJsonModule: true,
        allowJs: true,
        strict: true
    };

    const configFileHost = new FridaConfigFileHost(projectRoot, system);

    const opts = ts.getParsedCommandLineOfConfigFile(fsPath.join(projectRoot, "tsconfig.json"), defaultTsOptions, configFileHost)?.options ?? defaultTsOptions;
    delete opts.noEmit;
    opts.rootDir = projectRoot;
    opts.outDir = "/";
    if (options.sourceMaps === "included") {
        opts.sourceRoot = projectRoot;
        opts.sourceMap = true;
        opts.inlineSourceMap = false;
    }
    return opts;
}

function createBundler(entrypoint: EntrypointName, projectRoot: string, assets: Assets, system: ts.System, options: OutputOptions): Bundler {
    const {
        sourceMaps,
        compression,
    } = options;

    const events = new EventEmitter() as TypedEmitter<BundlerEvents>;

    const output = new Map<string, string>();
    const origins = new Map<string, string>();
    const aliases = new Map<string, string>();
    const pendingModules = new Map<string, JSModule>();
    const processedModules = new Set<string>();
    const jsonFilePaths = new Set<string>();
    const modules = new Map<string, JSModule>();
    const externalSources = new Map<string, ts.SourceFile>();

    system.writeFile = (path, data, writeByteOrderMark) => {
        output.set(path, data);
    };

    function getExternalSourceFile(path: string): ts.SourceFile {
        let file = externalSources.get(path);
        if (file !== undefined) {
            return file;
        }

        const sourceText = system.readFile(path, "utf-8");
        if (sourceText === undefined) {
            throw new Error(`Unable to open ${path}`);
        }

        file = ts.createSourceFile(path, sourceText, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
        externalSources.set(path, file);

        events.emit("externalSourceFileAdded", file);

        return file;
    }

    function assetNameFromFilePath(path: string): string {
        if (path.startsWith(compilerRoot)) {
            return portablePathFromFilePath(path.substring(compilerRoot.length));
        }

        if (path.startsWith(projectRoot)) {
            return portablePathFromFilePath(path.substring(projectRoot.length));
        }

        throw new Error(`Unexpected file path: ${path}`);
    }

    return {
        events,
        async bundle(program: ts.Program): Promise<string> {
            for (const sf of program.getSourceFiles()) {
                if (!sf.isDeclarationFile) {
                    const fileName = portablePathToFilePath(sf.fileName);
                    const bareName = fileName.substring(0, fileName.lastIndexOf("."));
                    const outName = bareName + ".js";
                    origins.set(assetNameFromFilePath(outName), outName);
                    processedModules.add(bareName);
                    processedModules.add(outName);
                }
            }

            for (const sf of program.getSourceFiles()) {
                if (!sf.isDeclarationFile) {
                    const { fileName } = sf;
                    const mod: JSModule = {
                        type: "esm",
                        path: portablePathToFilePath(fileName),
                        file: sf
                    };
                    processJSModule(mod, processedModules, pendingModules, jsonFilePaths);
                }
            }

            const linkedCompilerRoot = fsPath.join(assets.projectNodeModulesDir, "frida-compile");

            const missing: string[] = [];
            while (pendingModules.size > 0) {
                const entry: string = pendingModules.keys().next().value;
                const requesterPath = pendingModules.get(entry)!.path;
                pendingModules.delete(entry);
                processedModules.add(entry);

                let modPath: string;
                let needsAlias = false;
                if (fsPath.isAbsolute(entry)) {
                    modPath = entry;
                } else {
                    const tokens = entry.split("/");

                    let pkgName: string;
                    let subPath: string[];
                    if (tokens[0].startsWith("@")) {
                        pkgName = tokens[0] + "/" + tokens[1];
                        subPath = tokens.slice(2);
                    } else {
                        pkgName = tokens[0];
                        subPath = tokens.slice(1);
                    }

                    const shimPath = assets.shims.get(pkgName);
                    if (shimPath !== undefined) {
                        if (shimPath.endsWith(".js")) {
                            modPath = shimPath;
                        } else {
                            modPath = fsPath.join(shimPath, ...subPath);
                        }
                        needsAlias = true;
                    } else {
                        if (requesterPath.startsWith(compilerRoot) || requesterPath.startsWith(linkedCompilerRoot)) {
                            modPath = fsPath.join(assets.compilerNodeModulesDir, ...tokens);
                        } else {
                            modPath = fsPath.join(assets.projectNodeModulesDir, ...tokens);
                        }
                        needsAlias = subPath.length > 0;
                    }
                }

                if (system.directoryExists(modPath)) {
                    const rawPkgMeta = system.readFile(fsPath.join(modPath, "package.json"));
                    if (rawPkgMeta !== undefined) {
                        const pkgMeta = JSON.parse(rawPkgMeta);
                        const pkgMain = pkgMeta.module ?? pkgMeta.main ?? "index.js";
                        let pkgEntrypoint = fsPath.join(modPath, pkgMain);
                        if (system.directoryExists(pkgEntrypoint)) {
                            pkgEntrypoint = fsPath.join(pkgEntrypoint, "index.js");
                        }

                        modPath = pkgEntrypoint;
                        needsAlias = true;
                    } else {
                        modPath = fsPath.join(modPath, "index.js");
                    }
                }

                if (!system.fileExists(modPath)) {
                    modPath += ".js";
                    if (!system.fileExists(modPath)) {
                        missing.push(entry);
                        continue;
                    }
                }

                if (needsAlias) {
                    let assetSubPath: string;
                    if (modPath.startsWith(assets.projectNodeModulesDir)) {
                        assetSubPath = modPath.substring(projectRoot.length + 1);
                    } else {
                        assetSubPath = modPath.substring(compilerRoot.length + 1);
                    }
                    aliases.set("/" + portablePathFromFilePath(assetSubPath), entry);
                }

                const sourceFile = getExternalSourceFile(modPath);

                const mod: JSModule = {
                    type: detectModuleType(modPath, system),
                    path: modPath,
                    file: sourceFile
                };
                modules.set(modPath, mod);

                processJSModule(mod, processedModules, pendingModules, jsonFilePaths);
            }
            if (missing.length > 0) {
                throw new Error(`unable to resolve: ${missing.join(", ")}`);
            }

            const legacyModules = Array.from(modules.values()).filter(m => m.type === "cjs");
            if (legacyModules.length > 0) {
                const opts = makeCompilerOptions(projectRoot, system, options);
                const host = ts.createIncrementalCompilerHost(opts, system);
                const p = ts.createProgram({
                    rootNames: legacyModules.map(m => m.path),
                    options: { ...opts, allowJs: true },
                    host
                });
                p.emit(undefined, undefined, undefined, undefined, {
                    before: [
                        cjsToEsmTransformer()
                    ],
                    after: [
                        useStrictRemovalTransformer()
                    ]
                });
            }

            for (const [path, mod] of modules) {
                const assetName = assetNameFromFilePath(path);
                if (!output.has(assetName)) {
                    output.set(assetName, mod.file.text);
                    origins.set(assetName, path);
                }
            }

            for (const path of jsonFilePaths) {
                const assetName = assetNameFromFilePath(path);
                if (!output.has(assetName)) {
                    output.set(assetName, system.readFile(path)!);
                }
            }

            for (const [name, data] of output) {
                if (name.endsWith(".js")) {
                    let code = data;

                    const lines = code.split("\n");
                    const n = lines.length;
                    const lastLine = lines[n - 1];
                    if (lastLine.startsWith("//# sourceMappingURL=")) {
                        const precedingLines = lines.slice(0, n - 1);
                        code = precedingLines.join("\n");
                    }

                    if (compression === "terser") {
                        const originPath = origins.get(name)!;
                        const originFilename = fsPath.basename(originPath);

                        const minifySources: { [name: string]: string } = {};
                        minifySources[originFilename] = code;

                        const minifyOpts: MinifyOptions = {
                            ecma: 2020,
                            compress: {
                                module: true,
                                global_defs: {
                                    "process.env.FRIDA_COMPILE": true
                                },
                            },
                            mangle: {
                                module: true,
                            },
                        };

                        const mapName = name + ".map";

                        if (sourceMaps === "included") {
                            const mapOpts: SourceMapOptions = {
                                asObject: true,
                                root: portablePathFromFilePath(fsPath.dirname(originPath)) + "/",
                                filename: name.substring(name.lastIndexOf("/") + 1),
                            } as SourceMapOptions;

                            const inputMap = output.get(mapName);
                            if (inputMap !== undefined) {
                                mapOpts.content = inputMap;
                            }

                            minifyOpts.sourceMap = mapOpts;
                        }

                        const result = await minify(minifySources, minifyOpts);
                        code = result.code!;

                        if (sourceMaps === "included") {
                            const map = result.map as { [key: string]: any };
                            const prefixLength: number = map.sourceRoot.length;
                            map.sources = map.sources.map((s: string) => s.substring(prefixLength));
                            output.set(mapName, JSON.stringify(map));
                        }
                    }

                    output.set(name, code);
                } else if (name.endsWith(".json")) {
                    output.set(name, jsonToModule(data));
                }
            }

            const names: string[] = [];

            const orderedNames = Array.from(output.keys());
            orderedNames.sort();

            const maps = new Set(orderedNames.filter(name => name.endsWith(".map")));
            for (const name of orderedNames.filter(name => !name.endsWith(".map"))) {
                let index = (name === entrypoint.output) ? 0 : names.length;

                const mapName = name + ".map";
                if (maps.has(mapName)) {
                    names.splice(index, 0, mapName);
                    index++;
                }

                names.splice(index, 0, name);
            }

            const chunks: string[] = [];
            chunks.push("📦\n")
            for (const name of names) {
                const rawData = Buffer.from(output.get(name)!);
                chunks.push(`${rawData.length} ${name}\n`);
                const alias = aliases.get(name);
                if (alias !== undefined) {
                    chunks.push(`↻ ${alias}\n`)
                }
            }
            chunks.push("✄\n");
            let i = 0;
            for (const name of names) {
                if (i !== 0) {
                    chunks.push("\n✄\n");
                }
                const data = output.get(name)!;
                chunks.push(data);
                i++;
            }

            return chunks.join("");
        },
        invalidate(path: string): void {
            output.delete(assetNameFromFilePath(path));
            processedModules.clear();
            externalSources.delete(path);
        }
    };
}

interface Bundler {
    events: TypedEmitter<BundlerEvents>;

    bundle(program: ts.Program): Promise<string>;
    invalidate(path: string): void;
}

type BundlerEvents = {
    externalSourceFileAdded: (file: ts.SourceFile) => void,
};

function detectModuleType(modPath: string, sys: ts.System): ModuleType {
    let curDir = fsPath.dirname(modPath);
    while (true) {
        const rawPkgMeta = sys.readFile(fsPath.join(curDir, "package.json"));
        if (rawPkgMeta !== undefined) {
            const pkgMeta = JSON.parse(rawPkgMeta);
            if (pkgMeta.type === "module") {
                return "esm";
            }
            break;
        }

        const nextDir = fsPath.dirname(curDir);
        if (nextDir === curDir) {
            break;
        }
        curDir = nextDir;
    }

    return "cjs";
}

function processJSModule(mod: JSModule, processedModules: Set<string>, pendingModules: Map<string, JSModule>, jsonFilePaths: Set<string>): void {
    const moduleDir = fsPath.dirname(mod.path);
    ts.forEachChild(mod.file, visit);

    function visit(node: ts.Node) {
        if (ts.isImportDeclaration(node)) {
            visitImportDeclaration(node);
        } else if (ts.isExportDeclaration(node)) {
            visitExportDeclaration(node);
        } else {
            ts.forEachChild(node, visit);
        }
    }

    function visitImportDeclaration(imp: ts.ImportDeclaration) {
        const depName = (imp.moduleSpecifier as ts.StringLiteral).text;
        maybeAddModuleToPending(depName);
    }

    function visitExportDeclaration(exp: ts.ExportDeclaration) {
        const specifier = exp.moduleSpecifier;
        if (specifier === undefined) {
            return;
        }

        const depName = (specifier as ts.StringLiteral).text;
        maybeAddModuleToPending(depName);
    }

    function maybeAddModuleToPending(name: string) {
        const path = resolveAssetReference(name);

        if (name.endsWith(".json")) {
            jsonFilePaths.add(path)
        } else {
            if (!processedModules.has(path)) {
                pendingModules.set(path, mod);
            }
        }
    }

    function resolveAssetReference(name: string): string {
        if (name.startsWith(".")) {
            return fsPath.join(moduleDir, name);
        } else {
            return name;
        }
    }
}

function useStrictRemovalTransformer(): ts.TransformerFactory<ts.SourceFile> {
    return context => {
        return sourceFile => {
            const visitor = (node: ts.Node): ts.VisitResult<ts.Node> => {
                if (ts.isExpressionStatement(node)) {
                    const { expression } = node;
                    if (ts.isStringLiteral(expression) && expression.text === "use strict") {
                        return [];
                    }
                }

                return ts.visitEachChild(node, visitor, context);
            };

            return ts.visitNode(sourceFile, visitor);
        };
    };
}

function jsonToModule(json: string): string {
    const result: string[] = [];

    const data = JSON.parse(json);
    if (typeof data === "object" && data !== null) {
        const obj: [string, any] = data;

        let identifier = "d";
        let candidate = identifier;
        let serial = 1;
        while (obj.hasOwnProperty(candidate)) {
            candidate = identifier + serial;
            serial++;
        }
        identifier = candidate;

        result.push(`const ${identifier} = ${json.trim()};`);

        result.push(`export default ${identifier};`);

        for (const member of Object.keys(data).filter(identifier => !checkIdentifier(identifier, "es2015", true))) {
            result.push(`export const ${member} = ${identifier}.${member};`);
        }
    } else {
        result.push(`export default ${json.trim()};`);
    }

    return result.join("\n");
}

class FridaConfigFileHost implements ts.ParseConfigFileHost {
    useCaseSensitiveFileNames = true;

    constructor(
        private projectRoot: string,
        private sys: ts.System,
    ) {
    }

    readDirectory(rootDir: string, extensions: readonly string[], excludes: readonly string[] | undefined, includes: readonly string[], depth?: number): readonly string[] {
        return this.sys.readDirectory(rootDir, extensions, excludes, includes, depth);
    }

    fileExists(path: string): boolean {
        return this.sys.fileExists(path);
    }

    readFile(path: string): string | undefined {
        return this.sys.readFile(path);
    }

    trace?(s: string): void {
        console.log(s);
    }

    getCurrentDirectory(): string {
        return this.projectRoot;
    }

    onUnRecoverableConfigFileDiagnostic(diagnostic: ts.Diagnostic) {
    }
}

function detectCompilerRoot(): string {
    if (process.env.FRIDA_COMPILE !== undefined) {
        return fsPath.sep + "frida-compile";
    } else {
        const jsPath = import.meta.url.substring(isWindows ? 8 : 7);
        const rootPath = fsPath.dirname(fsPath.dirname(jsPath));
        return portablePathToFilePath(rootPath);
    }
}

function portablePathFromFilePath(path: string): string {
    return isWindows ? path.replace(/\\/g, "/") : path;
}

function portablePathToFilePath(path: string): string {
    return isWindows ? path.replace(/\//g, "\\") : path;
}
