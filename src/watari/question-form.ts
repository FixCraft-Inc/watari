import { z } from "zod";

import type { QuestionField } from "./questions.ts";

const ChoiceSchema = z.strictObject({ const: z.string().min(1).max(512), title: z.string().max(512).optional(), description: z.string().max(2_000).optional() });
const PropertySchema = z.strictObject({
  type: z.enum(["string", "number", "integer", "boolean", "array"]),
  title: z.string().max(256).optional(), description: z.string().max(2_000).optional(),
  enum: z.array(z.string().min(1).max(512)).min(1).max(16).optional(),
  enumNames: z.array(z.string().max(512)).max(16).optional(),
  oneOf: z.array(ChoiceSchema).min(1).max(16).optional(),
  items: z.strictObject({
    type: z.literal("string").optional(),
    enum: z.array(z.string().min(1).max(512)).min(1).max(16).optional(),
    anyOf: z.array(ChoiceSchema).min(1).max(16).optional(),
  }).optional(),
  minimum: z.number().optional(), maximum: z.number().optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(),
  minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(),
  uniqueItems: z.boolean().optional(),
  default: z.unknown().optional(),
  // These forms require richer/secure controls; never pretend a text box supports them.
  format: z.string().optional(), pattern: z.never().optional(), writeOnly: z.literal(false).optional(),
});
const FormSchema = z.strictObject({
  type: z.literal("object"),
  properties: z.record(z.string().min(1).max(256), PropertySchema),
  required: z.array(z.string().max(256)).max(8).optional(),
  title: z.string().max(256).optional(), description: z.string().max(2_000).optional(),
  $schema: z.string().max(1_000).optional(), additionalProperties: z.boolean().optional(),
});

/** Compile the credential-free, flat subset used by ACP/MCP question tools. */
export function compileQuestionForm(input: unknown, message: string) {
  const encoded = JSON.stringify(input);
  if (!encoded || encoded.length > 32_000) throw new Error("input form is missing or too large");
  const form = FormSchema.parse(input);
  const entries = Object.entries(form.properties);
  if (!entries.length || entries.length > 8 || form.required?.some((key) => !Object.hasOwn(form.properties, key))) throw new Error("unsupported input form");
  const fields: QuestionField[] = entries.map(([id, property]) => {
    if (/password|passphrase|secret|token|api[_ -]?key|credential|private[_ -]?key/i.test(`${id} ${property.title ?? ""} ${property.description ?? ""}`) || property.format) throw new Error("secure input requires the provider surface");
    const choices = property.oneOf ?? property.items?.anyOf;
    const values = property.enum ?? property.items?.enum;
    if (property.type === "array" && !property.items) throw new Error("array form needs string items");
    const options = choices?.map((choice) => ({ label: choice.const, description: [choice.title, choice.description].filter(Boolean).join(" · ") })) ??
      values?.map((value, index) => ({ label: value, description: property.enumNames?.[index] ?? "" })) ??
      (property.type === "boolean" ? [{ label: "true", description: "Yes" }, { label: "false", description: "No" }] : []);
    return {
      id, header: property.title ?? id,
      question: [message, property.title ?? id, property.description].filter(Boolean).join("\n"),
      options, multiSelect: property.type === "array", allowOther: options.length === 0,
      required: form.required?.includes(id) ?? false,
    };
  });
  return {
    fields,
    decode(answers: Record<string, string[]>): Record<string, string | number | boolean | string[]> {
      return Object.fromEntries(entries.flatMap(([key, property]) => {
        const values = answers[key] ?? [];
        if (!values.length && !form.required?.includes(key)) return [];
        let value: string | number | boolean | string[] = values[0] ?? "";
        if (property.type === "boolean") value = z.enum(["true", "false"]).parse(value) === "true";
        else if (property.type === "number" || property.type === "integer") {
          value = z.number().finite().parse(Number(value));
          if ((property.type === "integer" && !Number.isInteger(value)) || (property.minimum !== undefined && value < property.minimum) || (property.maximum !== undefined && value > property.maximum)) throw new Error("number outside form bounds");
        } else if (property.type === "array") {
          if ((property.minItems !== undefined && values.length < property.minItems) || (property.maxItems !== undefined && values.length > property.maxItems)) throw new Error("selection outside form bounds");
          value = values;
        } else if ((property.minLength !== undefined && value.length < property.minLength) || (property.maxLength !== undefined && value.length > property.maxLength)) throw new Error("text outside form bounds");
        return [[key, value]];
      }));
    },
  };
}
