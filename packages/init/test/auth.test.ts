import { describe, it, expect } from "vitest";
import {
  extractSessionCookie,
  probeHealth,
  signIn,
  mintToken,
  AuthError,
} from "../src/auth.js";

function fakeFetch(
  handler: (req: {
    url: string;
    init?: RequestInit;
  }) => Response | Promise<Response>
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    return handler({ url, init });
  }) as typeof fetch;
}

describe("extractSessionCookie", () => {
  it("returns the session cookie pair from a Set-Cookie response", () => {
    const r = new Response("", {
      headers: {
        "set-cookie": "nm.session_token=abc123; Path=/; HttpOnly; SameSite=Lax",
      },
    });
    expect(extractSessionCookie(r)).toBe("nm.session_token=abc123");
  });
  it("matches the generic session_token name as a fallback", () => {
    const r = new Response("", {
      headers: { "set-cookie": "session_token=xyz; Path=/" },
    });
    expect(extractSessionCookie(r)).toBe("session_token=xyz");
  });
  it("returns null when no session cookie is present", () => {
    const r = new Response("", { headers: { "set-cookie": "csrf=v; Path=/" } });
    expect(extractSessionCookie(r)).toBe(null);
  });
});

describe("probeHealth", () => {
  it("succeeds on 200", async () => {
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    await expect(
      probeHealth("http://localhost:7778", f)
    ).resolves.toBeUndefined();
  });
  it("throws AuthError on non-2xx", async () => {
    const f = fakeFetch(() => new Response("nope", { status: 500 }));
    await expect(
      probeHealth("http://localhost:7778", f)
    ).rejects.toBeInstanceOf(AuthError);
  });
  it("wraps network errors", async () => {
    const f = fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(probeHealth("http://localhost:7778", f)).rejects.toMatchObject(
      { status: 0 }
    );
  });
});

describe("signIn", () => {
  it("returns the session cookie pair on 200", async () => {
    const f = fakeFetch(({ url }) => {
      expect(url).toBe("http://localhost:7778/api/auth/sign-in/email");
      return new Response("{}", {
        status: 200,
        headers: {
          "set-cookie": "nm.session_token=cookieval; Path=/; HttpOnly",
        },
      });
    });
    const cookie = await signIn({
      baseUrl: "http://localhost:7778",
      email: "a@b.com",
      password: "x",
      fetchImpl: f,
    });
    expect(cookie).toBe("nm.session_token=cookieval");
  });
  it("throws AuthError with the response body on 401", async () => {
    const f = fakeFetch(() => new Response("invalid", { status: 401 }));
    await expect(
      signIn({
        baseUrl: "http://localhost:7778",
        email: "a@b.com",
        password: "x",
        fetchImpl: f,
      })
    ).rejects.toMatchObject({ status: 401 });
  });
  it("throws when no session cookie is returned", async () => {
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    await expect(
      signIn({
        baseUrl: "http://localhost:7778",
        email: "a@b.com",
        password: "x",
        fetchImpl: f,
      })
    ).rejects.toThrow(/no session cookie/);
  });
});

describe("mintToken", () => {
  it("returns the plaintext token from { token } payload", async () => {
    const f = fakeFetch(({ url, init }) => {
      expect(url).toBe("http://localhost:7778/v1/me/tokens");
      expect((init?.headers as Record<string, string>).cookie).toBe(
        "nm.session_token=cookieval"
      );
      return new Response(
        JSON.stringify({
          token: "nm_abc",
          userId: "u_1",
          createdAt: new Date().toISOString(),
        }),
        {
          status: 201,
        }
      );
    });
    const t = await mintToken({
      baseUrl: "http://localhost:7778",
      sessionCookie: "nm.session_token=cookieval",
      fetchImpl: f,
    });
    expect(t).toBe("nm_abc");
  });
  it("throws AuthError on 401", async () => {
    const f = fakeFetch(() => new Response("nope", { status: 401 }));
    await expect(
      mintToken({
        baseUrl: "http://localhost:7778",
        sessionCookie: "nm.session_token=cookieval",
        fetchImpl: f,
      })
    ).rejects.toMatchObject({ status: 401 });
  });
});
