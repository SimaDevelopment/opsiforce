import { randomBytes, randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { generatedAlphabets, ValueField } from '@opsiforce/external-service-sdk/platform';

export type GenerateSpec = NonNullable<Extract<ValueField, { type: 'text' | 'secret' }>['generate']>;

type GeneratedAlphabet = (typeof generatedAlphabets)[number];

const alphabetCharacters: Record<GeneratedAlphabet, string> = {
  base32lower: 'abcdefghijklmnopqrstuvwxyz234567',
  alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  lowercaseAlphanumeric: 'abcdefghijklmnopqrstuvwxyz0123456789',
  digits: '0123456789',
  hex: '0123456789abcdef',
};

export interface GeneratedValue {
  path: string;
  value: string;
  secret: boolean;
}

export interface RevealedSecret {
  path: string;
  value: string;
}

export interface SaveOptions {
  rotate?: string;
  keepSwitches?: boolean;
  keepRenamedKeys?: boolean;
}

export function revealedSecrets(generated: readonly GeneratedValue[]): RevealedSecret[] {
  return generated.filter((value) => value.secret).map(({ path, value }) => ({ path, value }));
}

export type GeneratedField = Extract<ValueField, { type: 'text' | 'secret' }> & { generate: GenerateSpec };

export function isGeneratedField(field: ValueField): field is GeneratedField {
  return (field.type === 'text' || field.type === 'secret') && field.generate !== undefined;
}

export type UniqueField = Extract<GeneratedField, { type: 'text' }>;

export function isUniqueField(field: ValueField): field is UniqueField {
  return field.type === 'text' && field.generate?.unique === true;
}

@Injectable()
export class GeneratedValueSource {
  next(spec: GenerateSpec): string {
    if ('bytes' in spec) return randomBytes(spec.bytes).toString('base64url');
    const characters = alphabetCharacters[spec.alphabet];
    return Array.from({ length: spec.length }, () => characters[randomInt(characters.length)]).join('');
  }
}
