/**
 * Skills (WP-C3.6; console-spec §9.5 remainder): list with `?type=` filter,
 * per-skill detail with the version history (`GET /v1/skills/:id/versions`),
 * and the API's one cheap mutation — hard delete. Uploads are multipart and
 * deliberately NOT in the console (`src/api/files-skills.ts` header); the
 * empty state teaches the API path (DP-5). Like files, skills have no
 * detail route — activating a row opens the panel below (DP-2). There is no
 * content endpoint for skills, so detail is metadata + versions ("per API",
 * §9.5).
 */
import { createLazyRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import type { Skill, SkillType } from "@pi-managed/contracts";

import {
  useDeleteSkill,
  useSkill,
  useSkills,
  useSkillVersions,
} from "../../api/files-skills.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { CopyableId } from "../../ui/copyable-id.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Select } from "../../ui/select.js";
import { Table, type Column } from "../../ui/table.js";
import { TypedConfirmDialog } from "../../ui/typed-confirm-dialog.js";
import { useToast } from "../../ui/toast.js";
import { formatTimestamp } from "../sessions/format.js";
import styles from "./files-skills.module.css";

export const Route = createLazyRoute("/resources/skills")({
  component: SkillsPage,
});

const UPLOAD_CURL = `curl -X POST $PI_BACKEND_URL/v1/skills -H "Authorization: Bearer $PI_API_KEY" -H "Idempotency-Key: $(uuidgen)" -F file=@skill.zip`;

const COLUMNS: Array<Column<Skill>> = [
  { key: "title", header: "Title", render: (skill) => skill.displayTitle },
  {
    key: "id",
    header: "ID",
    render: (skill) => <CopyableId id={skill.id} maxLength={22} />,
  },
  { key: "type", header: "Type", render: (skill) => skill.type },
  {
    key: "versions",
    header: "Versions",
    render: (skill) => String(skill.versions.length),
  },
  {
    key: "created",
    header: "Created",
    render: (skill) => formatTimestamp(skill.createdAt),
  },
];

function SkillsPage() {
  const [type, setType] = useState<SkillType | "">("");
  const skills = useSkills(type === "" ? {} : { type });
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = skills.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section>
      <p className={styles.back}>
        <Link to="/resources" className={styles.backLink}>
          ← Resources
        </Link>
      </p>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Skills</h1>
          {/* DP-6: one line — Pi's native skills system (Agent Skills
              standard); the console browses versions and deletes. */}
          <p className={styles.microcopy}>
            Skill bundles agents load at runtime — pre-built ones ship with
            Pi, custom ones are uploaded through the API (multipart). Each
            re-upload of the same title adds a version.
          </p>
        </div>
        <span className={styles.headActions}>
          <Select
            label="Type"
            value={type}
            onChange={(e) => setType(e.target.value as SkillType | "")}
          >
            <option value="">All</option>
            <option value="prebuilt">prebuilt</option>
            <option value="custom">custom</option>
          </Select>
          <Button
            onClick={() => void skills.refetch()}
            disabled={skills.isRefetching}
          >
            Refresh
          </Button>
        </span>
      </header>

      {skills.isError ? (
        <ErrorAlert label="skills" error={skills.error} />
      ) : skills.isPending ? (
        <p role="status">Loading skills…</p>
      ) : (
        <>
          <Table
            columns={COLUMNS}
            rows={rows}
            rowKey={(skill) => skill.id}
            caption="Skills"
            onRowActivate={(skill) =>
              setOpenId((current) => (current === skill.id ? null : skill.id))
            }
            empty={
              <EmptyState
                title="No skills here yet"
                description="A skill is a SKILL.md (plus supporting files) an agent can load on demand — upload a zip or individual files."
                cliCommand={UPLOAD_CURL}
              />
            }
          />
          {skills.hasNextPage ? (
            <div className={styles.more}>
              <Button
                onClick={() => void skills.fetchNextPage()}
                disabled={skills.isFetchingNextPage}
              >
                {skills.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
          {openId !== null ? (
            <SkillDetail id={openId} onDeleted={() => setOpenId(null)} />
          ) : null}
        </>
      )}
    </section>
  );
}

/** Per-skill panel: facts + version history, fetched on open (DP-2). */
function SkillDetail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const skill = useSkill(id);
  const versions = useSkillVersions(id);
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const del = useDeleteSkill();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);

  if (skill.isError) {
    return (
      <section aria-label={`Skill ${id}`} className={styles.panel}>
        <ErrorAlert label="skill" error={skill.error} />
      </section>
    );
  }
  if (skill.isPending) {
    return (
      <section aria-label={`Skill ${id}`} className={styles.panel}>
        <p role="status">Loading skill…</p>
      </section>
    );
  }

  return (
    <section aria-label={`Skill ${id}`} className={styles.panel}>
      <h2 className={styles.panelTitle}>{skill.data.displayTitle}</h2>
      <dl className={styles.meta}>
        <div className={styles.metaRow}>
          <dt className={styles.metaLabel}>ID</dt>
          <dd className={styles.metaValue}>
            <CopyableId id={skill.data.id} maxLength={30} />
          </dd>
        </div>
        <div className={styles.metaRow}>
          <dt className={styles.metaLabel}>Type</dt>
          <dd className={styles.metaValue}>{skill.data.type}</dd>
        </div>
        <div className={styles.metaRow}>
          <dt className={styles.metaLabel}>Created</dt>
          <dd className={styles.metaValue}>
            {formatTimestamp(skill.data.createdAt)}
          </dd>
        </div>
      </dl>

      <h3 className={styles.subheading}>Version history</h3>
      {versions.isError ? (
        <ErrorAlert label="skill versions" error={versions.error} />
      ) : versions.isPending ? (
        <p role="status">Loading versions…</p>
      ) : (
        <Table
          columns={VERSION_COLUMNS}
          rows={versions.data.data}
          rowKey={(version) => String(version.version)}
          caption="Skill versions"
          empty={<p>No versions recorded.</p>}
        />
      )}

      <div className={styles.actions}>
        <Button
          variant="destructive"
          onClick={() => setConfirming(true)}
          disabled={!writable || del.isPending}
          aria-describedby={writable ? undefined : "skill-delete-note"}
        >
          Delete
        </Button>
        {!writable ? (
          <span id="skill-delete-note" className={styles.scopeNote}>
            requires the write scope
          </span>
        ) : null}
      </div>
      {del.isError ? <ErrorAlert label="delete skill" error={del.error} /> : null}
      <TypedConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete skill"
        resourceName={skill.data.displayTitle}
        consequence={`This permanently deletes "${skill.data.displayTitle}" and all ${skill.data.versions.length} uploaded version(s) from storage. Hard delete — sessions can no longer load it, and there is no undo.`}
        confirmLabel="Delete skill"
        onConfirm={() => {
          setConfirming(false);
          del.mutate(id, {
            onSuccess: () => {
              toast({ message: "Skill deleted", tone: "success" });
              onDeleted();
            },
          });
        }}
      />
    </section>
  );
}

const VERSION_COLUMNS: Array<
  Column<{ version: number; createdAt: string }>
> = [
  {
    key: "version",
    header: "Version",
    render: (version) => `v${version.version}`,
  },
  {
    key: "created",
    header: "Uploaded",
    render: (version) => formatTimestamp(version.createdAt),
  },
];
