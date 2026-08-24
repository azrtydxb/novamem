import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

describe("api()", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed body on 2xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, n: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const r = await api<{ ok: boolean; n: number }>("GET", "/v1/me/metrics");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, n: 7 });
  });

  it("throws ApiError on non-2xx with structured {error, code}", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "metadata too large",
          code: "METADATA_OVERSIZE",
        }),
        {
          status: 413,
          headers: { "content-type": "application/json" },
        }
      )
    );
    await expect(api("POST", "/v1/remember", {})).rejects.toMatchObject({
      name: "ApiError",
      message: "metadata too large",
      status: 413,
      code: "METADATA_OVERSIZE",
    });
  });

  it("throws ApiError with HTTP <status> when body has no error field", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    try {
      await api("GET", "/health");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
      expect((err as ApiError).message).toBe("HTTP 500");
      expect((err as ApiError).code).toBeUndefined();
    }
  });

  it("returns status:0 + error on network failure (no throw)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const r = await api("GET", "/health");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toBe("Failed to fetch");
    expect(r.body).toBeNull();
  });

  it("omits content-type when no body (avoids Fastify 400 on empty POST)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api("DELETE", "/v1/me/tokens/abc");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).not.toHaveProperty("content-type");
    expect(init.body).toBeUndefined();
  });

  it("ApiError instances satisfy `instanceof Error` and `instanceof ApiError`", () => {
    const e = new ApiError("boom", 418, "TEAPOT");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.name).toBe("ApiError");
  });
});
