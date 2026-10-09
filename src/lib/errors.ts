// errors.ts — Custom error hierarchy for consistent API responses
// Pattern: AppError base → specific subclasses → global error handler
// Uses branded types and discriminated unions

import type { ApiResponse, ApiSuccessResponse, ApiErrorResponse } from "./types";

// === Error Classes ===

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number = 500, isOperational: boolean = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  public readonly errors: { field: string; message: string }[];

  constructor(message: string, errors: { field: string; message: string }[] = []) {
    super(message, 400);
    this.errors = errors;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = "Resource not found") {
    super(message, 404);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = "Unauthorized") {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = "Forbidden") {
    super(message, 403);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
  }
}

export class RateLimitError extends AppError {
  public readonly retryIn: number;

  constructor(message: string = "Rate limit exceeded", retryIn: number = 60) {
    super(message, 429);
    this.retryIn = retryIn;
  }
}

// === API Response Helpers ===
// Uses the branded ApiResponse type from types.ts

export function successResponse<T>(data: T, status: number = 200): Response {
  const body: ApiSuccessResponse<T> = { success: true, data };
  return Response.json(body, { status });
}

export function errorResponse(message: string, status: number = 500, details?: unknown): Response {
  const body: ApiErrorResponse = {
    success: false,
    error: { message, ...(details ? { details } : {}) },
  };
  return Response.json(body, { status });
}

// === Error Handler (for use in route handlers) ===

/**
 * Client-safe message for an UNEXPECTED error.
 *
 * Raw `error.message` leaks internals (Prisma clauses, absolute paths, SQL) to
 * callers, so routes return a fixed fallback instead — but the real error is
 * logged server-side, and deliberately-thrown operational errors (AppError)
 * keep their user-facing message.
 */
export function publicErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AppError && error.isOperational) return error.message;
  console.error("[API Error]", error);
  return fallback;
}

export function handleError(error: unknown): Response {
  if (error instanceof AppError) {
    return errorResponse(
      error.message,
      error.statusCode,
      error instanceof ValidationError ? error.errors : undefined
    );
  }

  console.error("[API Error]", error);
  return errorResponse("Internal server error", 500);
}
