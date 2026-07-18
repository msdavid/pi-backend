/**
 * Create-environment dialog (WP-C3.2; console-spec §9.2). Name + type, and
 * for `cloud` the optional image and network policy — each mode explained in
 * one line of DP-6 microcopy at decision time. `self_hosted` teaches the T5
 * worker model instead; the worker-key mint lives on the detail page.
 */
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import type { EnvironmentCreate, EnvironmentType } from "@pi-managed/contracts";

import { useCreateEnvironment } from "../../api/environments.js";
import { Button } from "../../ui/button.js";
import { Dialog } from "../../ui/dialog.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import { Select } from "../../ui/select.js";
import { useToast } from "../../ui/toast.js";
import {
  NETWORK_POLICY_EXPLANATIONS,
  SELF_HOSTED_EXPLAINER,
} from "./environment-copy.js";
import styles from "./environments.module.css";

/** The network-policy choice in the form; "" = provisioner default. */
type PolicyChoice = "" | "unrestricted" | "limited";

export function EnvironmentCreateDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const create = useCreateEnvironment();
  const [name, setName] = useState("");
  const [type, setType] = useState<EnvironmentType>("cloud");
  const [image, setImage] = useState("");
  const [policy, setPolicy] = useState<PolicyChoice>("");
  const [allowedHosts, setAllowedHosts] = useState("");

  function close() {
    create.reset();
    onClose();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const body: EnvironmentCreate = { name: name.trim(), type };
    if (type === "cloud") {
      if (image.trim()) body.image = image.trim();
      if (policy === "unrestricted") body.networking = { mode: "unrestricted" };
      if (policy === "limited") {
        body.networking = {
          mode: "limited",
          allowedHosts: allowedHosts
            .split(",")
            .map((host) => host.trim())
            .filter(Boolean),
        };
      }
    }
    create.mutate(body, {
      onSuccess: (env) => {
        toast({ message: `Environment ${env.name} created`, tone: "success" });
        close();
        void navigate({
          to: "/resources/environments/$environmentId",
          params: { environmentId: env.id },
        });
      },
    });
  }

  return (
    <Dialog open={open} onClose={close} title="Create environment">
      <form onSubmit={submit} className={styles.form}>
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          spellCheck={false}
          placeholder="python-env"
        />
        <Select
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as EnvironmentType)}
          hint={
            type === "cloud"
              ? "A managed sandbox: image, resources, and network policy below."
              : SELF_HOSTED_EXPLAINER
          }
        >
          <option value="cloud">cloud</option>
          <option value="self_hosted">self_hosted</option>
        </Select>
        {type === "cloud" ? (
          <>
            <Input
              label="Image (optional)"
              value={image}
              onChange={(e) => setImage(e.target.value)}
              spellCheck={false}
              placeholder="ubuntu:22.04"
              hint="OCI image the sandbox boots from; leave empty for the default."
            />
            <Select
              label="Network policy"
              value={policy}
              onChange={(e) => setPolicy(e.target.value as PolicyChoice)}
              hint={
                policy === ""
                  ? "Leave unset for the provisioner default."
                  : NETWORK_POLICY_EXPLANATIONS[policy]
              }
            >
              <option value="">default</option>
              <option value="unrestricted">unrestricted</option>
              <option value="limited">limited</option>
            </Select>
            {policy === "limited" ? (
              <Input
                label="Allowed hosts"
                value={allowedHosts}
                onChange={(e) => setAllowedHosts(e.target.value)}
                spellCheck={false}
                placeholder="api.github.com, pypi.org"
                hint="Comma-separated hosts sessions may reach; everything else is denied."
              />
            ) : null}
          </>
        ) : null}
        {create.isError ? (
          <ErrorAlert label="create environment" error={create.error} />
        ) : null}
        <div className={styles.formActions}>
          <Button onClick={close}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || name.trim() === ""}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
