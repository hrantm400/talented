import type { Request, Response, NextFunction } from "express";

type Bucket = { tokens: number; lastRefill: number };

/**
 * Simple in-memory token-bucket rate limiter, keyed per user (or IP fallback).
 * Tokens regenerate linearly: `capacity` tokens per `windowMs`.
 *
 * This intentionally lives in-process — fine for a single-node deployment.
 * For multi-node, swap the Map for Redis.
 */
export function rateLimit(opts: {
  windowMs: number;
  capacity: number;
  name: string;
}) {
  const { windowMs, capacity, name } = opts;
  const buckets = new Map<string, Bucket>();
  const refillPerMs = capacity / windowMs;

  return (req: Request, res: Response, next: NextFunction) => {
    const key =
      req.user?.id != null
        ? `u:${req.user.id}`
        : `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;

    const now = Date.now();
    const existing = buckets.get(key);
    const bucket: Bucket =
      existing ?? { tokens: capacity, lastRefill: now };

    if (existing) {
      const elapsed = now - bucket.lastRefill;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.lastRefill = now;
    }

    if (bucket.tokens < 1) {
      const retryMs = Math.ceil((1 - bucket.tokens) / refillPerMs);
      res.setHeader("Retry-After", Math.ceil(retryMs / 1000).toString());
      return res.status(429).json({
        error: `Rate limit exceeded for ${name}. Retry in ~${Math.ceil(retryMs / 1000)}s.`,
      });
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return next();
  };
}
