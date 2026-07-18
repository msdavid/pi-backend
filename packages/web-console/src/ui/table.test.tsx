import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { StatusChip } from "./status-chip.js";
import { Table } from "./table.js";
import type { Column } from "./table.js";
import { axe } from "./test-utils.js";

interface Row {
  id: string;
  name: string;
  status: string;
}

const COLUMNS: Array<Column<Row>> = [
  { key: "name", header: "Name", render: (r) => r.name },
  { key: "status", header: "Status", render: (r) => <StatusChip status={r.status} /> },
];

const ROWS: Row[] = [
  { id: "sess_1", name: "review PR 42", status: "running" },
  { id: "sess_2", name: "nightly triage", status: "completed" },
  { id: "sess_3", name: "fix flaky test", status: "failed" },
];

describe("Table", () => {
  it("renders a semantic table with headers, caption, and one row per record", () => {
    render(
      <Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} caption="Sessions" />,
    );

    expect(screen.getByRole("table", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    // 1 header row + 3 data rows
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText("nightly triage")).toBeInTheDocument();
  });

  it("renders the empty slot instead of the table when there are no rows", () => {
    render(
      <Table
        columns={COLUMNS}
        rows={[]}
        rowKey={(r) => r.id}
        caption="Sessions"
        empty={<p>No sessions yet.</p>}
      />,
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
  });

  it("activates a row on click", async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        caption="Sessions"
        onRowActivate={onRowActivate}
      />,
    );

    await user.click(screen.getByText("fix flaky test"));
    expect(onRowActivate).toHaveBeenCalledWith(ROWS[2]);
  });

  it("supports roving focus with arrows and activation with Enter/Space", async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        caption="Sessions"
        onRowActivate={onRowActivate}
      />,
    );

    // First Tab lands on the §10.5 scroll container (keyboard-scrollable
    // group), the second on the one tabbable row.
    await user.tab();
    expect(screen.getByRole("group", { name: "Sessions" })).toHaveFocus();
    await user.tab();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveFocus();

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(rows[2]).toHaveFocus();
    await user.keyboard("{ArrowDown}"); // clamped at the last row
    expect(rows[2]).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onRowActivate).toHaveBeenLastCalledWith(ROWS[2]);

    await user.keyboard("{ArrowUp}");
    expect(rows[1]).toHaveFocus();
    await user.keyboard(" ");
    expect(onRowActivate).toHaveBeenLastCalledWith(ROWS[1]);
  });

  it("does not make rows focusable when not interactive", () => {
    render(
      <Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} caption="Sessions" />,
    );
    for (const row of screen.getAllByRole("row").slice(1)) {
      expect(row).not.toHaveAttribute("tabindex");
    }
  });

  it("has no axe violations (static and interactive)", async () => {
    const { container } = render(
      <div>
        <Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} caption="Static" />
        <Table
          columns={COLUMNS}
          rows={ROWS}
          rowKey={(r) => r.id}
          caption="Interactive"
          onRowActivate={() => {}}
        />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
