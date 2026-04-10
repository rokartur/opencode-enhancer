export interface PluginUpdateOptions {
    dryRun?: boolean;
    includePinned?: boolean;
    exclude?: string[];
}
export declare function runPluginsUpdateCommand(options: PluginUpdateOptions): Promise<void>;
//# sourceMappingURL=plugin-updates.d.ts.map