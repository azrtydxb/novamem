import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KBtn } from "./KBtn";
import { KCard } from "./KCard";
import { KEmpty } from "./KEmpty";
import { KPill } from "./KPill";
import { KSignals } from "./KSignals";
import { KSpark } from "./KSpark";
import { KStat } from "./KStat";

describe("KSignals", () => {
  // The decision this component encodes: the prototype draws five bars,
  // the server returns three. A zero-height bar for a signal nobody
  // computes reads as "contributed nothing", which is a different and
  // false claim.
  it("renders one bar per signal the server actually returns", () => {
    const { container } = render(
      <KSignals signals={{ keyword: 0.92, vector: 0.84, graph: 0.31 }} />
    );
    expect(screen.getByText("keyword")).toBeInTheDocument();
    expect(screen.getByText("vector")).toBeInTheDocument();
    expect(screen.getByText("graph")).toBeInTheDocument();
    expect(screen.queryByText("recency")).not.toBeInTheDocument();
    expect(screen.queryByText("entity")).not.toBeInTheDocument();
    // three labels + three values, and no fourth track
    expect(container.querySelectorAll(".bg-subtle-2")).toHaveLength(3);
  });

  it("drops the leading zero so values align under narrow labels", () => {
    render(<KSignals signals={{ keyword: 0.92, vector: 0.5, graph: 0 }} />);
    expect(screen.getByText(".92")).toBeInTheDocument();
    expect(screen.getByText(".50")).toBeInTheDocument();
    expect(screen.getByText(".00")).toBeInTheDocument();
  });

  it("clamps a bar to the track rather than overflowing it", () => {
    const { container } = render(
      // Scores are 0..1 by contract; a server bug should not paint
      // outside the card.
      <KSignals signals={{ keyword: 1.8, vector: -0.3, graph: 0.5 }} />
    );
    const widths = [...container.querySelectorAll<HTMLElement>("[style]")].map(
      (el) => el.style.width
    );
    expect(widths).toContain("100%");
    expect(widths).toContain("0%");
  });
});

describe("KSpark", () => {
  it("renders nothing plottable under two points", () => {
    const { container } = render(<KSpark data={[1]} />);
    expect(container.querySelector("path")).toBeNull();
  });

  it("plots a path through every point", () => {
    const { container } = render(<KSpark data={[1, 4, 2, 8]} />);
    const d = container.querySelector("path")?.getAttribute("d") ?? "";
    expect(d.startsWith("M")).toBe(true);
    expect(d.match(/L/g)).toHaveLength(3);
  });

  it("survives a flat series without dividing by zero", () => {
    const { container } = render(<KSpark data={[3, 3, 3]} />);
    const d = container.querySelector("path")?.getAttribute("d") ?? "";
    expect(d).not.toContain("NaN");
  });
});

describe("KPill", () => {
  it("maps a tone to its token pair", () => {
    const { container } = render(<KPill tone="graph">ok</KPill>);
    expect(container.firstElementChild?.className).toContain("text-graph");
    expect(container.firstElementChild?.className).toContain("bg-graph-soft");
  });

  it("pulses the dot only when asked", () => {
    const { container, rerender } = render(
      <KPill tone="graph" dot>
        live
      </KPill>
    );
    expect(container.querySelector(".animate-pulse-soft")).toBeNull();
    rerender(
      <KPill tone="graph" dot pulse>
        live
      </KPill>
    );
    expect(container.querySelector(".animate-pulse-soft")).not.toBeNull();
  });
});

describe("KBtn", () => {
  it("disables itself while loading, so a click cannot fire twice", () => {
    render(<KBtn loading>save</KBtn>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("uses the accent-ink token rather than a literal white", () => {
    // The accent differs between themes and so does its readable
    // foreground; a hard-coded #fff is unreadable in one of them.
    render(<KBtn variant="primary">go</KBtn>);
    expect(screen.getByRole("button").className).toContain("text-accent-ink");
  });
});

describe("KCard / KStat / KEmpty", () => {
  it("omits the title strip when there is no title", () => {
    const { container } = render(<KCard>body</KCard>);
    expect(container.querySelector(".border-b")).toBeNull();
  });

  it("renders the title strip and its right-hand adornment", () => {
    render(<KCard title="stores" right={<span>legend</span>} />);
    expect(screen.getByText("stores")).toBeInTheDocument();
    expect(screen.getByText("legend")).toBeInTheDocument();
  });

  it("renders a stat without a sparkline when the series is too short", () => {
    const { container } = render(
      <KStat label="queries" value="0" spark={[1]} />
    );
    expect(container.querySelector("svg")).toBeNull();
  });

  it("shows the empty-state action when one is given", () => {
    render(<KEmpty title="nothing here" action={<KBtn>remember</KBtn>} />);
    expect(
      screen.getByRole("button", { name: "remember" })
    ).toBeInTheDocument();
  });
});
