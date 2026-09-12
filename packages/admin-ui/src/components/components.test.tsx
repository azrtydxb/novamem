import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";
import { Button } from "./Button";

/** `Pill` and `Sparkline` used to be covered here. They were superseded
 *  by `k/KPill` and `k/KSpark` — which carry the equivalent tests in
 *  k-components.test.tsx, including cases these never had (clamping an
 *  out-of-range signal, a flat series) — and deleted once the last page
 *  moved off them. */

describe("<Badge>", () => {
  it("renders children", () => {
    render(<Badge tone="success">ok</Badge>);
    expect(screen.getByText("ok")).toBeInTheDocument();
  });

  it("maps a tone to its token pair", () => {
    const { container } = render(<Badge tone="danger">gone</Badge>);
    expect(container.firstElementChild?.className).toContain("text-err");
    expect(container.firstElementChild?.className).toContain("bg-err-soft");
  });
});

describe("<Button>", () => {
  it("disables itself while loading, so a click cannot fire twice", () => {
    render(<Button loading>save</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("uses the accent-ink token rather than a literal white", () => {
    // The accent differs between themes and so does its readable
    // foreground; a hard-coded #fff is unreadable in one of them.
    render(<Button variant="primary">go</Button>);
    expect(screen.getByRole("button").className).toContain("text-accent-ink");
  });
});
