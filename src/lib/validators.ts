import { z } from "zod";
import type { AgentMode, MessageRole } from "./types";

// Sanitize HTML entities to prevent XSS
export function sanitize(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Sanitize user chat messages before sending to LLM
// Strips potential prompt injection and normalizes whitespace
export function sanitizeChatMessage(input: string): string {
  return input
    // Strip zero-width characters that can hide injection payloads
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "")
    // Normalize excessive whitespace (but preserve intentional newlines)
    .replace(/[ \t]{3,}/g, "  ")
    // Strip null bytes
    .replace(/\0/g, "")
    .trim();
}

// Detect potential prompt injection patterns in user input
// Returns true if the input looks suspicious (not definitive — use for logging/alerts)
export function detectPromptInjection(input: string): boolean {
  const patterns = [
    /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
    /you\s+are\s+now\s+(a|an)\s+/i,
    /system\s*:\s*/i,
    /<\s*system\s*>/i,
    /\[INST\]/i,
    /<<SYS>>/i,
    /###\s+instruction/i,
    /override\s+(safety|security|instructions?)/i,
  ];
  return patterns.some(p => p.test(input));
}

// Bug Report validation
export const bugReportSchema = z.object({
  title: z.string().min(5, "Title must be at least 5 characters").max(200, "Title must be under 200 characters"),
  description: z.string().min(20, "Description must be at least 20 characters").max(5000, "Description must be under 5000 characters"),
  severity: z.enum(["low", "medium", "high"]),
});

// Inferred type from Zod schema — compile-time safety
export type BugReportInput = z.infer<typeof bugReportSchema>;

// Chat message validation - supports multimodal content (text + images)
// content limit raised to 500K to support full workspace file context injection
// messages limit raised to 100 to support multi-turn tool-calling loops
export const chatMessageSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().max(500000, "Message too long"),
      images: z.array(z.string()).optional(),
    })
  ).min(1, "Messages required").max(100, "Too many messages"),
  conversationId: z.string().nullable().optional(),
  mode: z.enum(["ask", "plan", "code"]).optional().default("ask"),
  // Top-level images — passed by background worker for vision preprocessing
  images: z.array(z.string()).optional(),
});

// Inferred type
export type ChatMessageInput = z.infer<typeof chatMessageSchema>;

// Settings validation
export const settingsSchema = z.object({
  name: z.string().min(1, "Name required").max(100, "Name too long").optional(),
});

// Inferred type
export type SettingsInput = z.infer<typeof settingsSchema>;

// Email validation
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// === Type-safe validation helper ===
// Returns a discriminated union for type narrowing

export type ValidationSuccess<T> = { valid: true; data: T };
export type ValidationFailure = { valid: false; errors: string[] };
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export function validateInput<T>(schema: z.ZodSchema<T>, input: unknown): ValidationResult<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  return {
    valid: false,
    errors: result.error.errors.map(e => `${e.path.join(".")}: ${e.message}`),
  };
}

// Type guard for validation results
export function isValidationSuccess<T>(result: ValidationResult<T>): result is ValidationSuccess<T> {
  return result.valid === true;
}

export function isValidationFailure<T>(result: ValidationResult<T>): result is ValidationFailure {
  return result.valid === false;
}
