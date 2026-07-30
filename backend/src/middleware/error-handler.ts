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

  // A streaming response (SSE) has already sent its headers and possibly part
  // of the body — writing a status or a JSON envelope now would throw
  // ERR_HTTP_HEADERS_SENT. Report the failure in-band and close the stream.
  if (res.headersSent) {
    if (!res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
      } catch {
        // Socket already gone — nothing left to do.
      }
      res.end();
    }
    return;
  }

  res.status(status).json({ error: message });
}
