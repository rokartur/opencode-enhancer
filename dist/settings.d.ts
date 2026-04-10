import { type RotationSettings, type WeightPreset, type SettingsValidationError } from './types.js';
export interface SettingsResult {
    settings: RotationSettings;
    source: 'default' | 'persisted' | 'runtime' | 'env';
    errors?: SettingsValidationError[];
}
export declare function getSettings(): SettingsResult;
export declare function getRuntimeSettings(): SettingsResult;
export declare function updateSettings(updates: Partial<RotationSettings>, actor?: string): {
    success: boolean;
    settings?: RotationSettings;
    errors?: SettingsValidationError[];
};
export declare function resetSettings(actor?: string): RotationSettings;
export declare function applyPreset(preset: WeightPreset, actor?: string): {
    success: boolean;
    settings?: RotationSettings;
    errors?: SettingsValidationError[];
};
export declare function calculateWeightedSelection(aliases: string[], weights: Record<string, number>): string | null;
export declare function getSettingsWithInfo(): {
    settings: RotationSettings;
    source: string;
    preset?: WeightPreset;
    canReset: boolean;
};
export declare function isFeatureEnabled(flag: keyof NonNullable<RotationSettings['featureFlags']>): boolean;
//# sourceMappingURL=settings.d.ts.map