import type { Request, Response, NextFunction } from "express";

/**
 * Express error-handling middleware.
 * Catches all errors thrown by route handlers and returns a JSON response
 * with the error message and an appropriate HTTP status code.
 */
export function errorHandler(
  err: Error & { status?: number; statusCode?: number },
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const status = err.status ?? err.statusCode ?? 500;
  const message =
    status >= 500 ? "Internal server error" : err.message;

  if (status >= 500) {
    console.error("[error-handler]", err);
  }

  res.status(status).json({ error: message });
}
