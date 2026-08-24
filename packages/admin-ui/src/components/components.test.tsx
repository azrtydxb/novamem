import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Pill } from "./Pill";
import { Sparkline } from "./Sparkline";
import { Badge } from "./Badge";

describe("<Pill>", () => {
  it("renders children with the default neutral tone class", () => {
    render(<Pill>idle</Pill>);
    const el = screen.getByText("idle");
    expect(el).toBeInTheDocument();
    expect(el.className).toContain("text-dim");
  });

  it("adds a status dot when `dot` is set", () => {
    const { container } = render(
      <Pill tone="accent" dot pulse>
        live
      </Pill>
    );
    const dot = container.querySelector("span > span");
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain("bg-accent");
    expect(dot?.className).toContain("animate-pulse-soft");
  });
});

describe("<Sparkline>", () => {
  it("renders an empty SVG when data has fewer than 2 points", () => {
    const { container } = render(<Sparkline data={[]} color="#fff" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.querySelector("polyline")).toBeNull();
  });

  it("plots a polyline through every data point", () => {
    const { container } = render(
      <Sparkline data={[0, 5, 10, 5, 0]} color="#0f0" width={100} />
    );
    const poly = container.querySelector("polyline");
    expect(poly).not.toBeNull();
    expect(poly?.getAttribute("stroke")).toBe("#0f0");
    const pts = poly!.getAttribute("points")!.split(" ");
    expect(pts).toHaveLength(5);
  });

  it("does not crash on a flat-line series (range collapse)", () => {
    const { container } = render(<Sparkline data={[3, 3, 3]} color="#fff" />);
    expect(container.querySelector("polyline")).not.toBeNull();
  });
});

describe("<Badge>", () => {
  it("renders children", () => {
    render(<Badge tone="success">ok</Badge>);
    expect(screen.getByText("ok")).toBeInTheDocument();
  });
});
