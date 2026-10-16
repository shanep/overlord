// The parts of the OTLP/HTTP JSON encoding we read. Envelopes are zod schemas
// with loose objects; AnyValue is converted by hand because it is recursive.
// In OTLP JSON, 64-bit integers (intValue, *UnixNano) may arrive as strings.

import { z } from 'zod';

export type AttributeValue =
  | string
  | number
  | boolean
  | null
  | readonly AttributeValue[]
  | { readonly [key: string]: AttributeValue };

export type Attributes = Readonly<Record<string, AttributeValue>>;

const numeric = z.union([z.number(), z.string()]);
const keyValues = z.array(z.looseObject({ key: z.string(), value: z.unknown() })).optional();
const resource = z.looseObject({ attributes: keyValues }).nullish();

const numberPoint = z.looseObject({
  attributes: keyValues,
  timeUnixNano: numeric.optional(),
  startTimeUnixNano: numeric.optional(),
  asDouble: numeric.optional(),
  asInt: numeric.optional(),
});

const histogramPoint = z.looseObject({
  attributes: keyValues,
  timeUnixNano: numeric.optional(),
  startTimeUnixNano: numeric.optional(),
  sum: numeric.optional(),
});

const metricSchema = z.looseObject({
  name: z.string(),
  unit: z.string().optional(),
  sum: z.looseObject({ dataPoints: z.array(numberPoint).optional() }).optional(),
  gauge: z.looseObject({ dataPoints: z.array(numberPoint).optional() }).optional(),
  histogram: z.looseObject({ dataPoints: z.array(histogramPoint).optional() }).optional(),
});

export const metricsRequestSchema = z.looseObject({
  resourceMetrics: z
    .array(
      z.looseObject({
        resource,
        scopeMetrics: z
          .array(z.looseObject({ metrics: z.array(metricSchema).optional() }))
          .optional(),
      }),
    )
    .optional(),
});

const logRecordSchema = z.looseObject({
  timeUnixNano: numeric.optional(),
  observedTimeUnixNano: numeric.optional(),
  body: z.unknown(),
  attributes: keyValues,
});

export const logsRequestSchema = z.looseObject({
  resourceLogs: z
    .array(
      z.looseObject({
        resource,
        scopeLogs: z
          .array(z.looseObject({ logRecords: z.array(logRecordSchema).optional() }))
          .optional(),
      }),
    )
    .optional(),
});

const spanSchema = z.looseObject({
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  startTimeUnixNano: numeric.optional(),
  endTimeUnixNano: numeric.optional(),
  attributes: keyValues,
});

export const tracesRequestSchema = z.looseObject({
  resourceSpans: z
    .array(
      z.looseObject({
        resource,
        scopeSpans: z.array(z.looseObject({ spans: z.array(spanSchema).optional() })).optional(),
      }),
    )
    .optional(),
});

export type OtlpMetric = z.infer<typeof metricSchema>;
export type OtlpLogRecord = z.infer<typeof logRecordSchema>;
export type OtlpSpan = z.infer<typeof spanSchema>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number from a JSON number or numeric string. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const DIGITS = /^\d+$/u;

/** Epoch milliseconds from OTLP nanoseconds. Zero means unset in OTLP. */
export function nanosToMs(value: unknown): number | null {
  // Integer strings go through BigInt because nanosecond epochs do not fit a double exactly.
  if (typeof value === 'string' && DIGITS.test(value)) {
    const nanos = BigInt(value);
    return nanos === 0n ? null : Number(nanos / 1_000_000n);
  }
  const nanos = toNumber(value);
  return nanos === null || nanos <= 0 ? null : Math.floor(nanos / 1e6);
}

function arrayValues(value: unknown): readonly unknown[] {
  return isRecord(value) && Array.isArray(value['values']) ? value['values'] : [];
}

function keyValuesToRecord(
  list: readonly unknown[],
  convert: (value: unknown) => AttributeValue,
): Attributes {
  const result: Record<string, AttributeValue> = {};
  for (const item of list) {
    if (isRecord(item) && typeof item['key'] === 'string') {
      result[item['key']] = convert(item['value']);
    }
  }
  return result;
}

// AnyValue is a tagged union, so its JS value is too.
// eslint-disable-next-line sonarjs/function-return-type
export function anyValue(value: unknown): AttributeValue {
  if (!isRecord(value)) {
    return null;
  }
  const text = value['stringValue'] ?? value['bytesValue'];
  if (typeof text === 'string') {
    return text;
  }
  if (typeof value['boolValue'] === 'boolean') {
    return value['boolValue'];
  }
  const number = value['intValue'] ?? value['doubleValue'];
  if (number !== undefined) {
    return toNumber(number);
  }
  if ('arrayValue' in value) {
    return arrayValues(value['arrayValue']).map((item) => anyValue(item));
  }
  if ('kvlistValue' in value) {
    return keyValuesToRecord(arrayValues(value['kvlistValue']), anyValue);
  }
  return null;
}

export function attributesOf(list: readonly unknown[] | undefined): Attributes {
  return keyValuesToRecord(list ?? [], anyValue);
}

export function readString(attributes: Attributes, key: string): string | null {
  const value = attributes[key];
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' ? String(value) : null;
}

export function readNumber(attributes: Attributes, key: string): number | null {
  return toNumber(attributes[key]);
}

export function readBool(attributes: Attributes, key: string): boolean | null {
  const value = attributes[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  return null;
}
