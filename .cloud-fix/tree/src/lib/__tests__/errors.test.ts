import { AppError, ValidationError, NotFoundError, UnauthorizedError, ForbiddenError, RateLimitError, successResponse, errorResponse } from "../errors";

describe("AppError", () => {
  it("creates error with status code", () => {
    const err = new AppError("test error", 500);
    expect(err.message).toBe("test error");
    expect(err.statusCode).toBe(500);
    expect(err.isOperational).toBe(true);
  });

  it("defaults to 500", () => {
    const err = new AppError("test");
    expect(err.statusCode).toBe(500);
  });
});

describe("ValidationError", () => {
  it("creates 400 error with field errors", () => {
    const err = new ValidationError("invalid", [{ field: "email", message: "required" }]);
    expect(err.statusCode).toBe(400);
    expect(err.errors).toHaveLength(1);
    expect(err.errors[0].field).toBe("email");
  });
});

describe("NotFoundError", () => {
  it("creates 404 error", () => {
    const err = new NotFoundError();
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Resource not found");
  });
});

describe("RateLimitError", () => {
  it("creates 429 error with retry", () => {
    const err = new RateLimitError("too many", 30);
    expect(err.statusCode).toBe(429);
    expect(err.retryIn).toBe(30);
  });
});

describe("Error class hierarchy", () => {
  it("all extend AppError", () => {
    expect(new ValidationError("test")).toBeInstanceOf(AppError);
    expect(new NotFoundError()).toBeInstanceOf(AppError);
    expect(new UnauthorizedError()).toBeInstanceOf(AppError);
    expect(new ForbiddenError()).toBeInstanceOf(AppError);
    expect(new RateLimitError()).toBeInstanceOf(AppError);
  });
});
