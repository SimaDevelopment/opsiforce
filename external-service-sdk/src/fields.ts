import { z } from 'zod';

export const fieldKeySchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, 'must start with a letter and use only letters, digits and _ (at most 64)');

export const handlerNameSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, 'must name a handler: a letter, then letters, digits or _ (at most 64)');

const scalar = z.union([z.string().max(200), z.number(), z.boolean()]);

export const visibleWhenSchema = z.union([
  z.strictObject({ field: fieldKeySchema, equals: scalar }),
  z.strictObject({ field: fieldKeySchema, in: z.array(scalar).min(1).max(100) }),
  z.strictObject({ field: fieldKeySchema, truthy: z.literal(true) }),
]);

export const textFormats = ['email', 'emailOrDomain', 'url', 'hostname', 'e164', 'ipOrCidr'] as const;

export const generatedAlphabets = ['base32lower', 'alphanumeric', 'lowercaseAlphanumeric', 'digits', 'hex'] as const;

const textValidate = z.strictObject({
  minLength: z.int().min(0).max(100_000).optional(),
  maxLength: z.int().min(1).max(100_000).optional(),
  format: z.enum(textFormats).optional(),
  allowHttp: z.boolean().optional(),
});

const generatedBytes = { bytes: z.int().min(16).max(64) };

const generatedCharacters = { length: z.int().min(8).max(64), alphabet: z.enum(generatedAlphabets) };

export const generateSchema = z.union([
  z.strictObject({ ...generatedBytes, unique: z.boolean().optional() }),
  z.strictObject({ ...generatedCharacters, unique: z.boolean().optional() }),
]);

const secretGenerateError = (issue: z.core.$ZodRawIssue) =>
  issue.code === 'unrecognized_keys' && issue.keys.includes('unique')
    ? 'unique applies only to a text field: a generated secret never collides, and a sealed value cannot be compared'
    : undefined;

const secretGenerateSchema = z.union([
  z.strictObject(generatedBytes, { error: secretGenerateError }),
  z.strictObject(generatedCharacters, { error: secretGenerateError }),
]);

const optionValue = z.string().min(1).max(200);

export const staticOptionsSchema = z
  .array(
    z.strictObject({
      value: optionValue,
      label: z.string().min(1).max(200),
      description: z.string().max(500).optional(),
    })
  )
  .min(1)
  .max(500);

export const callOptionsSchema = z.strictObject({
  call: handlerNameSchema,
  searchable: z.boolean().optional(),
  dependsOn: z.array(fieldKeySchema).min(1).max(10).optional(),
});

export const serviceConfigurationOptionsSchema = z.strictObject({
  serviceConfiguration: fieldKeySchema,
  labelKey: fieldKeySchema,
});

export const optionsSourceSchema = z
  .union([staticOptionsSchema, callOptionsSchema, serviceConfigurationOptionsSchema])
  .meta({ id: 'OptionsSource' });

const shared = {
  key: fieldKeySchema,
  label: z.string().min(1).max(120).optional(),
  help: z.string().max(1000).optional(),
  visibleWhen: visibleWhenSchema.optional(),
  was: fieldKeySchema.optional(),
};

const valueShared = {
  ...shared,
  required: z.boolean().optional(),
  placeholder: z.string().max(200).optional(),
};

const fieldTypeError = (issue: z.core.$ZodRawIssue) =>
  issue.code === 'unrecognized_keys' ? `not a property of this field type: ${issue.keys.join(', ')}` : undefined;

const textField = z
  .strictObject(
    {
      ...valueShared,
      type: z.literal('text'),
      default: z.string().max(10_000).optional(),
      validate: textValidate.optional(),
      generate: generateSchema.optional(),
    },
    { error: fieldTypeError }
  )
  .meta({ id: 'TextField' });

const textareaField = z
  .strictObject(
    {
      ...valueShared,
      type: z.literal('textarea'),
      default: z.string().max(100_000).optional(),
      validate: textValidate.optional(),
    },
    { error: fieldTypeError }
  )
  .meta({ id: 'TextareaField' });

const numberField = z
  .strictObject(
    {
      ...valueShared,
      type: z.literal('number'),
      default: z.number().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      integer: z.boolean().optional(),
      step: z.number().positive().optional(),
    },
    { error: fieldTypeError }
  )
  .meta({ id: 'NumberField' });

const toggleField = z
  .strictObject({ ...shared, type: z.literal('toggle'), default: z.boolean().optional() }, { error: fieldTypeError })
  .meta({ id: 'ToggleField' });

const radioField = z
  .strictObject(
    { ...valueShared, type: z.literal('radio'), options: optionsSourceSchema, default: optionValue.optional() },
    { error: fieldTypeError }
  )
  .meta({ id: 'RadioField' });

const selectField = z
  .strictObject(
    { ...valueShared, type: z.literal('select'), options: optionsSourceSchema, default: optionValue.optional() },
    { error: fieldTypeError }
  )
  .meta({ id: 'SelectField' });

const multiselectField = z
  .strictObject(
    {
      ...valueShared,
      type: z.literal('multiselect'),
      options: optionsSourceSchema,
      default: z.array(optionValue).max(500).optional(),
      minItems: z.int().min(0).max(500).optional(),
      maxItems: z.int().min(1).max(500).optional(),
    },
    { error: fieldTypeError }
  )
  .meta({ id: 'MultiselectField' });

const secretField = z
  .strictObject(
    {
      ...valueShared,
      type: z.literal('secret'),
      multiline: z.boolean().optional(),
      generate: secretGenerateSchema.optional(),
    },
    { error: fieldTypeError }
  )
  .meta({ id: 'SecretField' });

const keyValueField = z
  .strictObject(
    {
      ...valueShared,
      type: z.literal('keyValue'),
      default: z.record(z.string().min(1).max(200), z.string().max(10_000)).optional(),
    },
    { error: fieldTypeError }
  )
  .meta({ id: 'KeyValueField' });

const infoField = z
  .strictObject(
    {
      ...shared,
      type: z.literal('info'),
      text: z.string().min(1).max(2000).optional(),
      template: z.string().min(1).max(2000).optional(),
      call: handlerNameSchema.optional(),
    },
    { error: fieldTypeError }
  )
  .meta({ id: 'InfoField' });

const buttonField = z
  .strictObject(
    {
      ...shared,
      type: z.literal('button'),
      label: z.string().min(1).max(120),
      call: handlerNameSchema,
      confirm: z.union([z.string().min(1).max(500), z.boolean()]).optional(),
    },
    { error: fieldTypeError }
  )
  .meta({ id: 'ButtonField' });

const leafFields = [
  textField,
  textareaField,
  numberField,
  toggleField,
  radioField,
  selectField,
  multiselectField,
  secretField,
  keyValueField,
  infoField,
  buttonField,
] as const;

type FieldMember = z.ZodObject<{ type: z.ZodLiteral<string> }, z.core.$strict>;

const fieldUnion = <const Members extends readonly [FieldMember, ...FieldMember[]]>(
  members: Members,
  where: string
) => {
  const types = members.map((member) => member.shape.type.value);
  return z.discriminatedUnion('type', members, {
    error: (issue) =>
      issue.code === 'invalid_union' ? `${where} takes a field of type ${types.join(', ')}` : undefined,
  });
};

const sectionShape = <Fields extends z.ZodType>(fields: Fields) =>
  z.strictObject(
    {
      type: z.literal('section'),
      title: z.string().min(1).max(120),
      description: z.string().max(1000).optional(),
      collapsed: z.boolean().optional(),
      visibleWhen: visibleWhenSchema.optional(),
      fields: z.array(fields).min(1).max(100),
    },
    { error: fieldTypeError }
  );

const itemSectionField = sectionShape(fieldUnion(leafFields, 'a section inside a list item')).meta({
  id: 'ListItemSectionField',
});

const listField = z
  .strictObject(
    {
      ...valueShared,
      type: z.literal('list'),
      maxItems: z.int().min(1).max(1000).optional(),
      item: z
        .array(fieldUnion([...leafFields, itemSectionField], 'a list item (one level, no list inside)'))
        .min(1)
        .max(50),
    },
    { error: fieldTypeError }
  )
  .meta({ id: 'ListField' });

const sectionField = sectionShape(fieldUnion([...leafFields, listField], 'a section (sections do not nest)')).meta({
  id: 'SectionField',
});

export const fieldTypes = [
  'text',
  'textarea',
  'number',
  'toggle',
  'radio',
  'select',
  'multiselect',
  'secret',
  'list',
  'keyValue',
  'section',
  'info',
  'button',
] as const;

export const fieldSchema = fieldUnion([...leafFields, listField, sectionField], 'a form').meta({ id: 'Field' });

export const formSchema = z.array(fieldSchema).max(100);

export type Field = z.infer<typeof fieldSchema>;
export type FieldType = Field['type'];
export type Form = Field[];
export type OptionsSource = z.infer<typeof optionsSourceSchema>;
export type VisibleWhen = z.infer<typeof visibleWhenSchema>;
