import type { ScopeFile } from '../../bridge/types.ts';

export interface SchemaProperty {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface SettingsSchema {
  properties: Record<string, SchemaProperty>;
}

export type Control = 'boolean' | 'enum' | 'string' | 'number' | 'json';

export interface SettingKey {
  key: string;
  description: string;
  control: Control;
  options: string[];
  inSchema: boolean;
  deprecated: boolean;
}

export function controlFor(property: SchemaProperty | undefined): Control {
  if (!property) {
    return 'json';
  }
  if (Array.isArray(property.enum) && property.enum.every((option) => typeof option === 'string')) {
    return 'enum';
  }
  switch (property.type) {
    case 'boolean':
      return 'boolean';
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    default:
      return 'json';
  }
}

/** Every key the schema documents, plus any key found in a file that the schema does not know. */
export function listKeys(schema: SettingsSchema, files: ScopeFile[]): SettingKey[] {
  const names = new Set(Object.keys(schema.properties));
  for (const file of files) {
    for (const key of Object.keys(file.value)) {
      names.add(key);
    }
  }
  names.delete('$schema');
  return [...names].sort((left, right) => left.localeCompare(right)).map((key) => {
    const property = schema.properties[key];
    const description = property?.description ?? 'Not in the published settings schema.';
    return {
      key,
      description,
      control: controlFor(property),
      options: controlFor(property) === 'enum' ? (property?.enum as string[]) : [],
      inSchema: property !== undefined,
      deprecated: /^deprecated/i.test(description),
    };
  });
}

export function toInput(control: Control, value: unknown): string {
  if (value === undefined) {
    return '';
  }
  return control === 'json' ? JSON.stringify(value, null, 2) : String(value);
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

export function parseInput(setting: Pick<SettingKey, 'control' | 'options'>, text: string, property?: SchemaProperty): Parsed {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Enter a value, or use "Remove from this scope".' };
  }
  switch (setting.control) {
    case 'boolean':
      return trimmed === 'true' || trimmed === 'false' ? { ok: true, value: trimmed === 'true' } : { ok: false, error: 'Choose true or false.' };
    case 'enum':
      return setting.options.includes(trimmed) ? { ok: true, value: trimmed } : { ok: false, error: `Must be one of: ${setting.options.join(', ')}.` };
    case 'string':
      return { ok: true, value: text };
    case 'number': {
      const number = Number(trimmed);
      if (!Number.isFinite(number)) {
        return { ok: false, error: 'Enter a number.' };
      }
      if (property?.type === 'integer' && !Number.isInteger(number)) {
        return { ok: false, error: 'Enter a whole number.' };
      }
      if (property?.minimum !== undefined && number < property.minimum) {
        return { ok: false, error: `Minimum is ${property.minimum}.` };
      }
      if (property?.maximum !== undefined && number > property.maximum) {
        return { ok: false, error: `Maximum is ${property.maximum}.` };
      }
      return { ok: true, value: number };
    }
    case 'json':
      try {
        return { ok: true, value: JSON.parse(trimmed) as unknown };
      } catch (error) {
        return { ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
      }
  }
}

export function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
