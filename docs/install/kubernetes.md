# Kubernetes install

Manifests under [`deploy/k8s/`](../../deploy/k8s) target k3s out of the box: single-replica StatefulSets for Postgres, Qdrant, and FalkorDB on `local-path` PVCs, plus a `LoadBalancer` Service that binds 7778 on the node host network via Klipper. They work on any cluster with a default StorageClass and a LoadBalancer provider — swap Klipper for MetalLB / cloud-native LBs without touching the manifests.

For a single host see [Docker Compose](docker.md). For local dev see [Manual](manual.md).

## Layout

```
deploy/k8s/
├── kustomization.yaml   # bundles the rest into namespace `novamem`
├── namespace.yaml
├── secrets.yaml         # NOVAMEM_COOKIE_SECRET + bootstrap admin
├── postgres.yaml        # StatefulSet · Service · PVC
├── qdrant.yaml          # StatefulSet · Service · PVC
├── falkordb.yaml        # StatefulSet · Service · PVC
└── novamem.yaml         # ConfigMap · Deployment · LoadBalancer Service
```

## Image

The manifest pulls a public multi-arch image (`linux/amd64` + `linux/arm64`) from GitHub Container Registry:

```
ghcr.io/azrtydxb/novamem:main         # mutable, rebuilt on every main push by CI
ghcr.io/azrtydxb/novamem:sha-<short>  # immutable per commit, also multi-arch
```

CI builds, scans (Trivy HIGH/CRITICAL with `--ignore-unfixed`), and pushes both tags from the [CI workflow](../../.github/workflows/ci.yml). The `:main` tag updates on every push to the `main` branch; pin `image:` to a `:sha-…` tag in `novamem.yaml` if you want immutability.

To roll forward after a CI publish:

```bash
kubectl -n novamem rollout restart deploy/novamem
```

To build locally and bypass the registry (e.g. in an air-gapped lab) — set `image: novamem:dev` and `imagePullPolicy: Never` in `novamem.yaml`, then:

```bash
docker build -t novamem:dev .
docker save novamem:dev | sudo k3s ctr images import -
```

## Configure

Edit two files before applying:

**`deploy/k8s/novamem.yaml`** (ConfigMap):
- `NOVAMEM_BASE_URL` — set to the URL the browser reaches the API at. Better Auth's trusted-origin check rejects mismatches.
- `NOVAMEM_INSECURE_COOKIES` — `0` once you have TLS in front; `1` for an HTTP-only first run.

**`deploy/k8s/secrets.yaml`** (`stringData`):
- `NOVAMEM_COOKIE_SECRET` — `openssl rand -hex 32`. Rotate before going to production.
- `NOVAMEM_BOOTSTRAP_ADMIN_EMAIL` and `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` — first admin (only consulted when no admin user exists).

## Apply

```bash
kubectl apply -k deploy/k8s/

kubectl -n novamem rollout status statefulset/postgres
kubectl -n novamem rollout status statefulset/qdrant
kubectl -n novamem rollout status statefulset/falkordb
kubectl -n novamem rollout status deploy/novamem
```

## Reach the API

The Service is `type: LoadBalancer`. With Klipper on k3s, that binds port 7778 directly on every node's host network — `http://<node-ip>:7778`. With MetalLB or a cloud LB, watch for an EXTERNAL-IP:

```bash
kubectl -n novamem get svc novamem
```

Sign in at `http://<lb-ip>:7778/admin` with the bootstrap admin email + password.

## Pin `NOVAMEM_BASE_URL` to the public URL

Better Auth's trusted-origin check rejects sign-in if the browser's `Origin` doesn't match `NOVAMEM_BASE_URL`. After the LB lands its IP, update the ConfigMap and roll the deployment:

```bash
kubectl -n novamem edit configmap novamem-config   # set NOVAMEM_BASE_URL
kubectl -n novamem rollout restart deploy/novamem
```

## TLS

The default manifest is HTTP-only with `NOVAMEM_INSECURE_COOKIES=1` so cookies survive a plain-`http://` Origin. To go to production:

1. Put cert-manager + an Ingress (nginx-ingress, Traefik, …) in front of the Service.
2. Flip `NOVAMEM_INSECURE_COOKIES` to `0` and update `NOVAMEM_BASE_URL` to the `https://` URL.
3. Roll the deployment.

## Persistence

Each StatefulSet uses a `volumeClaimTemplates` against the cluster's default StorageClass. On k3s that's `local-path` — node-local, not migratable. For HA storage swap in your CSI provider before first apply.

To back up:

```bash
kubectl -n novamem exec sts/postgres -- pg_dump -U novamem -d novamem -Fc > novamem-warm.dump
kubectl -n novamem exec sts/falkordb -- redis-cli BGSAVE
# Qdrant: kubectl exec into the pod and POST /collections/<name>/snapshots
```

## Updates

`:main` is mutable, so CI publishing a new image + a rollout restart is enough:

```bash
kubectl -n novamem rollout restart deploy/novamem
kubectl -n novamem rollout status  deploy/novamem
```

To pin to a specific commit instead of tracking `:main`:

```bash
kubectl -n novamem set image deploy/novamem novamem=ghcr.io/azrtydxb/novamem:sha-<short>
```

Schema migrations are forward-only — back up Postgres before rolling.

## Troubleshooting

```bash
kubectl -n novamem get pods
kubectl -n novamem logs deploy/novamem
kubectl -n novamem describe pod -l app=novamem
```

- Pod stuck in `CrashLoopBackOff` → almost always missing `NOVAMEM_COOKIE_SECRET` or unreachable Postgres. Check the Secret is mounted (`envFrom` in the Deployment).
- `403 Invalid origin` on sign-in → `NOVAMEM_BASE_URL` doesn't match the browser's URL.
- Slow first search → local embedder is downloading the model. Subsequent calls are fast; the model lives in the pod's ephemeral volume so it re-downloads on every restart unless you mount a PVC for it.
