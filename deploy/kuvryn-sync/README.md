# Novamem on kw with Kuvryn Sync

This follows Scout's deployment flow: CI builds and publishes an immutable
`sha-<commit>` image, verifies that the registry serves both architectures,
commits that image to Git with `[skip ci]`, and Kuvryn Sync reconciles `main`
every minute. Older builds cannot overwrite a newer recorded image. Sync
needs only read access and uses the existing Scout credential, provisioned
out of band as `novamem/novamem-git` (keys `username` and `token`, labelled
`sync.kuvryn.io/git-credentials: "true"`). CI uses that same authorized credential
through the repository Actions secret `KW_GITOPS_TOKEN` to record deployment
commits. There is no ImagePolicy; the cluster controller does not write to Git.

Scout renders Helm; Novamem retains its existing Kustomize manifests through
`deploy/overlays/kw`. The overlay preserves three app replicas, PostgreSQL 16,
Qdrant 1.12.4, Longhorn claims (20 GiB and 10 GiB), and the live inference
settings. It adds HTTPS at `https://novamem.kw.watteel.lab`, an explicit
Certificate issued by `cluster-ca` (as Scout uses), rolling updates with zero
unavailable app replicas, node spreading, and a PodDisruptionBudget keeping
two replicas during voluntary disruptions. The existing Stakater Reloader
restarts the app when its ConfigMap or Secret changes.

## One-time handover

1. Merge the deployment files, image-recording script, and CI changes into
   `main`. Provision `KW_GITOPS_TOKEN` and the `novamem-git` Kubernetes Secret
   before activation. The CI credential needs permission to push its deployment
   commit to `main`. CI updates the image only after
   tests, scans, and publication of the multi-architecture image succeed.
2. Preserve the existing `novamem` namespace and `novamem-secrets` Secret.
   Neither is rendered or overwritten. Take current PostgreSQL and Qdrant
   backups before upgrading the app. Restore the PostgreSQL archive into a
   disposable database and compare counts; verify the Qdrant snapshot checksum
   and archive contents. Automatic image rollback cannot undo a forward-only
   schema migration.
3. Clients must trust the cluster CA and use
   `https://novamem.kw.watteel.lab/mcp`. HTTP redirects are not a substitute
   for changing an MCP POST endpoint.
4. Review the rendered changes against kw:

   ```sh
   kubectl kustomize deploy/overlays/kw > /tmp/novamem-kw.yaml
   kubectl --context kw diff --server-side --field-manager=kuvryn-sync \
     --force-conflicts -f /tmp/novamem-kw.yaml
   kubectl --context kw apply --server-side --field-manager=kuvryn-sync \
     --force-conflicts --dry-run=server -f /tmp/novamem-kw.yaml
   ```

   Expect changes to the app rollout, HTTPS configuration, certificate, PDB,
   and PVC protection annotations. Database pod specs and volume sizes stay
   unchanged. The image starts at the observed running `sha-ed8b56d` until CI
   records a newly verified build.

5. Prepare the certificate before redirecting clients to HTTPS:

   ```sh
   kubectl --context kw apply --server-side --field-manager=kuvryn-sync \
     -f deploy/overlays/kw/certificate.yaml
   kubectl --context kw -n novamem wait --for=condition=Ready \
     certificate/novamem-tls --timeout=5m
   ```

6. Hand over only the rendered resources, then enable Sync:

   ```sh
   kubectl --context kw apply --server-side --field-manager=kuvryn-sync \
     --force-conflicts -f /tmp/novamem-kw.yaml
   kubectl --context kw -n novamem rollout status deployment/novamem --timeout=10m
   kubectl --context kw apply -f deploy/kuvryn-sync/rbac.yaml \
     -f deploy/kuvryn-sync/repository.yaml \
     -f deploy/kuvryn-sync/application.yaml
   ```

   The explicit handover transfers the reviewed fields from kubectl to
   Kuvryn Sync's field manager. Like Scout, subsequent syncs use
   `conflictPolicy: fail`; they do not silently take fields from other managers.
   There is no Helm release to remove for Novamem. Apply from a checkout of
   the published `main` so the handover matches the first desired revision.
   During the first HTTP-to-HTTPS switch, pods with old/new origin settings
   briefly coexist; subsequent image updates use rolling deployments.

## Verify

```sh
kubectl --context kw -n novamem get repositories.sync.kuvryn.io,applications.sync.kuvryn.io
kubectl --context kw -n novamem get revisions.sync.kuvryn.io --sort-by=.metadata.creationTimestamp
kubectl --context kw -n novamem get pods,certificates
curl --fail https://novamem.kw.watteel.lab/health
```

Verify Application `Synced` / `Healthy`, three ready app replicas, and an actual
MCP initialization/search through HTTPS. The existing console is at
`https://sync.kw.watteel.lab`. No registry credentials are needed for the
public GHCR image.

## Day to day

Merge to main. CI publishes and records the verified image, then Kuvryn Sync
applies it and observes health. Deployment-only pushes are excluded from image
builds, and CI's recording commit uses `[skip ci]`, matching Scout.
Configuration changes go through Git; self-healing reverses direct cluster
edits. The bootstrap objects are maintained separately from the rendered app.

The Application matches Scout's automatic sync, pruning, self-healing,
ten-minute health/rollback timeout, two rollback attempts, ten revisions, and
`deletionPolicy: Orphan`. PVCs additionally carry explicit prune protection.
The namespace-scoped deployer may manage only the kinds this application uses;
it cannot change credentials or resources in other namespaces.

Revert a deployment image commit to roll back. Kuvryn Sync also rolls back
failed rollouts. PostgreSQL and Qdrant image versions remain explicitly managed.
Three API replicas do not make the single-pod databases highly available.
Backups, database HA, and external alert routing remain separate work.
