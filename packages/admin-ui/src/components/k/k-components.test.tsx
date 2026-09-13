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
  // This suite used to assert the opposite: that recency and entity are
  // NOT rendered, on the stated grounds that the server returns three
  // signals. It returns five on /v1/search — recency routinely around
  // .98 — and the assertion was locking in a UI that hid a signal doing
  // real work. Checked against the running deployment.
  it("renders every signal the response carried", () => {
    render(
      <KSignals
        signals={{
          keyword: 0.92,
          vector: 0.84,
          graph: 0.31,
          recency: 0.98,
          entity: 0,
        }}
      />
    );
    for (const k of ["keyword", "vector", "graph", "recency", "entity"]) {
      expect(screen.getByText(k)).toBeInTheDocument();
    }
  });

  it("renders only the signals present, not a fixed set", () => {
    // /v1/neighbors answers with `graph` alone. A bar at zero claims a
    // signal contributed nothing; a missing bar says it was not computed
    // on this route, and those are different claims.
    const { container } = render(<KSignals signals={{ graph: 0.95 }} />);
    expect(screen.getByText("graph")).toBeInTheDocument();
    expect(screen.queryByText("keyword")).not.toBeInTheDocument();
    expect(screen.queryByText("recency")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".bg-subtle-2")).toHaveLength(1);
  });

  it("renders nothing when the response carried no signals", () => {
    // /v1/recent orders rather than ranks. Passing undefined used to
    // throw on `signals[key]`.
    const { container } = render(<KSignals signals={undefined} />);
    expect(container.firstChild).toBeNull();
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
