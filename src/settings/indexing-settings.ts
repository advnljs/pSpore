/**
 * Continuous indexing settings as edited by a client.
 *
 * Kept separate from the LLM settings because it is a different config section
 * with different validation, and mixing them would make one decoder responsible
 * for two unrelated shapes.
 */
export interface IndexingSettings {
  version: 1;
  enabled: boolean;
  directories: string[];
  intervalMinutes: number;
  extensions: string[];
  /** Absolute path of the file these values are stored in, shown to the user. */
  configPath: string;
  /** True when the release shipped an indexer binary the daemon can run. */
  indexerAvailable: boolean;
  /** Absolute path of the indexer, whether or not it is present. */
  indexerPath: string;
}

export interface IndexingSettingsUpdate {
  enabled: boolean;
  directories: string[];
  intervalMinutes: number;
  extensions: string[];
}

export const MAX_INDEX_DIRECTORIES = 64;
export const MAX_INDEX_INTERVAL_MINUTES = 10_080;

export function decodeIndexingSettingsUpdate(
  value: unknown,
  label = "indexing settings",
): IndexingSettingsUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["enabled", "directories", "intervalMinutes", "extensions"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);

  if (typeof input["enabled"] !== "boolean") throw new Error(`${label}.enabled must be boolean`);
  const intervalMinutes = input["intervalMinutes"];
  if (
    !Number.isSafeInteger(intervalMinutes)
    || Number(intervalMinutes) < 1
    || Number(intervalMinutes) > MAX_INDEX_INTERVAL_MINUTES
  ) {
    throw new Error(`${label}.intervalMinutes must be between 1 and ${MAX_INDEX_INTERVAL_MINUTES}`);
  }

  const directories = stringArray(input["directories"], `${label}.directories`, MAX_INDEX_DIRECTORIES);
  for (const [index, directory] of directories.entries()) {
    // Only absolute paths: the daemon resolves nothing on the client's behalf,
    // and a relative path would silently mean a different directory to each.
    if (!directory.startsWith("/")) {
      throw new Error(`${label}.directories[${index}] must be an absolute path`);
    }
  }

  const extensions = stringArray(input["extensions"], `${label}.extensions`, 64);
  if (extensions.length === 0) throw new Error(`${label}.extensions requires at least one extension`);
  const normalized = extensions.map((extension, index) => {
    const value = (extension.startsWith(".") ? extension.slice(1) : extension).toLowerCase();
    if (!/^[a-z0-9]{1,16}$/.test(value)) {
      throw new Error(`${label}.extensions[${index}] must be a short alphanumeric extension`);
    }
    return value;
  });

  return {
    enabled: input["enabled"],
    directories: [...new Set(directories)].sort(),
    intervalMinutes: Number(intervalMinutes),
    extensions: [...new Set(normalized)],
  };
}

function stringArray(value: unknown, path: string, maximum: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  if (value.length > maximum) throw new Error(`${path} cannot contain more than ${maximum} entries`);
  return value.map((item, index) => {
    // Control characters only: real paths routinely contain spaces and hyphens.
    if (typeof item !== "string" || !item.trim() || /[\u0000-\u001f]/.test(item)) {
      throw new Error(`${path}[${index}] must be a non-empty single-line string`);
    }
    return item.trim();
  });
}
