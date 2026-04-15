import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { requireAuth, requireAdmin, requireFeature } from "./auth.ts";
import type { Request, Response, NextFunction } from "express";

describe("Auth Middlewares", () => {
  const mockResponse = () => {
    const res: any = {};
    res.status = mock.fn((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json = mock.fn((data: any) => {
      res.body = data;
      return res;
    });
    res.send = mock.fn((data: any) => {
        res.body = data;
        return res;
    });
    return res;
  };

  describe("requireAuth", () => {
    it("should call next() if user is authenticated (req.user exists)", () => {
      const req: any = { user: { id: 1 }, isAuthenticated: mock.fn(() => true) };
      const res = mockResponse();
      const next = mock.fn();

      requireAuth(req as Request, res as Response, next as NextFunction);

      assert.strictEqual(next.mock.callCount(), 1);
      assert.strictEqual(res.status.mock.callCount(), 0);
    });

    it("should return 401 if user is not authenticated (req.user missing)", () => {
      const req: any = { isAuthenticated: mock.fn(() => false) };
      const res = mockResponse();
      const next = mock.fn();

      requireAuth(req as Request, res as Response, next as NextFunction);

      assert.strictEqual(next.mock.callCount(), 0);
      assert.strictEqual(res.statusCode, 401);
      assert.deepStrictEqual(res.body, { error: "Authentication required" });
    });
  });

  describe("requireAdmin", () => {
    it("should call next() if user is admin", () => {
      const req: any = { user: { id: 1, role: "admin" } };
      const res = mockResponse();
      const next = mock.fn();

      requireAdmin(req as Request, res as Response, next as NextFunction);

      assert.strictEqual(next.mock.callCount(), 1);
    });

    it("should return 403 if user is not admin", () => {
      const req: any = { user: { id: 1, role: "user" } };
      const res = mockResponse();
      const next = mock.fn();

      requireAdmin(req as Request, res as Response, next as NextFunction);

      assert.strictEqual(next.mock.callCount(), 0);
      assert.strictEqual(res.statusCode, 403);
      assert.deepStrictEqual(res.body, { error: "Admin access required" });
    });

    it("should return 403 if user is missing", () => {
      const req: any = {};
      const res = mockResponse();
      const next = mock.fn();

      requireAdmin(req as Request, res as Response, next as NextFunction);

      assert.strictEqual(next.mock.callCount(), 0);
      assert.strictEqual(res.statusCode, 403);
    });
  });

  describe("requireFeature", () => {
    it("should call next() if user has the required feature", () => {
      const req: any = { user: { id: 1, role: "user", permissions: ["feature1"] } };
      const res = mockResponse();
      const next = mock.fn();

      requireFeature("feature1")(req as Request, res as Response, next as NextFunction);

      assert.strictEqual(next.mock.callCount(), 1);
    });

    it("should call next() if user is admin regardless of features", () => {
      const req: any = { user: { id: 1, role: "admin", permissions: [] } };
      const res = mockResponse();
      const next = mock.fn();

      requireFeature("feature1")(req as Request, res as Response, next as NextFunction);

      assert.strictEqual(next.mock.callCount(), 1);
    });

    it("should return 401 if user is missing", () => {
      const req: any = {};
      const res = mockResponse();
      const next = mock.fn();

      requireFeature("feature1")(req as Request, res as Response, next as NextFunction);

      assert.strictEqual(next.mock.callCount(), 0);
      assert.strictEqual(res.statusCode, 401);
    });

    it("should return 403 if user lacks the feature and is not admin", () => {
      const req: any = { user: { id: 1, role: "user", permissions: ["other"] } };
      const res = mockResponse();
      const next = mock.fn();

      requireFeature("feature1")(req as Request, res as Response, next as NextFunction);

      assert.strictEqual(next.mock.callCount(), 0);
      assert.strictEqual(res.statusCode, 403);
      assert.deepStrictEqual(res.body, { error: "No access to feature: feature1" });
    });
  });
});
